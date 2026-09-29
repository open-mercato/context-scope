/**
 * Skills, agents, commands and auto-memory inventory (Claude Code layout).
 */
import path from "node:path";
import { estimateTokens } from "../ir/estimate.mjs";
import { parseFrontmatter, asStringList } from "./frontmatter.mjs";
import { displayPath, isDirectory, listEntries, readTextSafe, statSafe, walk } from "./fs.mjs";

const MAX_PLUGIN_SKILLS = 200;

function descriptionOf(data) {
  const value = data?.description;
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function lookup(record, name) {
  if (!record || typeof record !== "object") return 0;
  if (name in record) return Number(record[name]) || 0;
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith(":" + name) || key.endsWith("/" + name)) return Number(value) || 0;
  }
  return 0;
}

async function readSkill(abs, scope, { repoRoot, home, sessionStats }) {
  const read = await readTextSafe(abs, { roots: [repoRoot, home] });
  if (!read) return null;
  const dirName = path.basename(path.dirname(abs));
  const fm = parseFrontmatter(read.text);
  const description = descriptionOf(fm.data);
  const declaredName = typeof fm.data?.name === "string" ? fm.data.name.trim() : "";
  const nameMismatch = Boolean(declaredName) && declaredName !== dirName;
  const skill = {
    name: declaredName || dirName,
    path: displayPath(abs, { repoRoot, home }),
    scope,
    hasDescription: description.length > 0,
    descriptionChars: description.length,
    bodyEstTokens: estimateTokens(fm.body, "prose"),
    frontmatterValid: fm.ok && fm.present && !nameMismatch,
    invocations30d: lookup(sessionStats?.skillInvocations, declaredName || dirName) || lookup(sessionStats?.skillInvocations, dirName),
  };
  if (!fm.present) skill.frontmatterError = "no frontmatter";
  else if (!fm.ok) skill.frontmatterError = fm.error ?? "invalid frontmatter";
  else if (nameMismatch) skill.frontmatterError = `name "${declaredName}" does not match directory "${dirName}"`;
  return skill;
}

async function skillDirs(root) {
  const out = [];
  for (const entry of await listEntries(root)) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name, "SKILL.md");
    if (await statSafe(abs)) out.push(abs);
  }
  return out.sort();
}

export async function collectSkills(ctx) {
  const { repoRoot, home } = ctx;
  const skills = [];
  for (const abs of await skillDirs(path.join(repoRoot, ".claude", "skills"))) {
    const skill = await readSkill(abs, "project", ctx);
    if (skill) skills.push(skill);
  }
  for (const abs of await skillDirs(path.join(home, ".claude", "skills"))) {
    const skill = await readSkill(abs, "user", ctx);
    if (skill) skills.push(skill);
  }
  const pluginRoot = path.join(home, ".claude", "plugins", "cache");
  const pluginSkills = await walk(pluginRoot, { maxDepth: 8, maxFiles: MAX_PLUGIN_SKILLS, accept: (_, name) => name === "SKILL.md" });
  for (const abs of pluginSkills.sort()) {
    const skill = await readSkill(abs, "plugin", ctx);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function readAgent(abs, scope, { repoRoot, home, sessionStats }) {
  const read = await readTextSafe(abs, { roots: [repoRoot, home] });
  if (!read) return null;
  const fm = parseFrontmatter(read.text);
  const fileName = path.basename(abs, ".md");
  const name = typeof fm.data?.name === "string" && fm.data.name.trim() ? fm.data.name.trim() : fileName;
  const agent = {
    name,
    path: displayPath(abs, { repoRoot, home }),
    scope,
    descriptionChars: descriptionOf(fm.data).length,
    runs30d: lookup(sessionStats?.agentRuns, name) || lookup(sessionStats?.agentRuns, fileName),
  };
  if (typeof fm.data?.model === "string") agent.model = fm.data.model;
  const tools = asStringList(fm.data?.tools);
  if (tools.length) agent.tools = tools;
  return agent;
}

export async function collectAgents(ctx) {
  const { repoRoot, home } = ctx;
  const agents = [];
  for (const [root, scope] of [[path.join(repoRoot, ".claude", "agents"), "project"], [path.join(home, ".claude", "agents"), "user"]]) {
    const entries = (await listEntries(root)).filter(e => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries.slice(0, 100)) {
      const agent = await readAgent(path.join(root, entry.name), scope, ctx);
      if (agent) agents.push(agent);
    }
  }
  return agents;
}

export async function collectCommands({ repoRoot }) {
  const root = path.join(repoRoot, ".claude", "commands");
  const files = await walk(root, { maxDepth: 3, maxFiles: 200, accept: (_, name) => name.endsWith(".md") });
  return files.sort().map(abs => ({
    name: path.relative(root, abs).replace(/\.md$/, "").split(path.sep).join(":"),
    path: ".claude/commands/" + path.relative(root, abs).split(path.sep).join("/"),
  }));
}

/** Claude's project key: the absolute path with every non [A-Za-z0-9-] character replaced by "-". */
export function projectKeyCandidates(repoRoot) {
  const plain = repoRoot.replace(/\//g, "-");
  const sanitized = repoRoot.replace(/[^A-Za-z0-9-]/g, "-");
  return [...new Set([plain, sanitized])];
}

export async function collectMemory({ repoRoot, home, repoRootRaw }) {
  const memory = { present: false, bytes: 0, files: 0, indexBytes: 0 };
  const keys = [...new Set([...projectKeyCandidates(repoRoot), ...(repoRootRaw ? projectKeyCandidates(repoRootRaw) : [])])];
  for (const key of keys) {
    const dir = path.join(home, ".claude", "projects", key, "memory");
    if (!(await isDirectory(dir))) continue;
    memory.present = true;
    for (const abs of await walk(dir, { maxDepth: 3, maxFiles: 500 })) {
      const info = await statSafe(abs);
      if (!info) continue;
      memory.files += 1;
      memory.bytes += info.size;
      if (path.basename(abs) === "MEMORY.md" && path.dirname(abs) === dir) memory.indexBytes = info.size;
    }
    break;
  }
  return memory;
}
