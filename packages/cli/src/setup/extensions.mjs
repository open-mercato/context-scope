/**
 * Skills, agents, commands and auto-memory inventory (Claude Code layout).
 */
import path from "node:path";
import { estimateByVendor, pickEstimate } from "../ir/estimate.mjs";
import { parseFrontmatter, asStringList } from "./frontmatter.mjs";
import { realpath } from "node:fs/promises";
import { displayPath, isDirectory, isInside, listEntries, readTextSafe, statSafe, walk } from "./fs.mjs";

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
  // What the startup prompt carries is the description (estTokensBy / estTokens); the body loads on
  // invocation (bodyEstTokensBy / bodyEstTokens). Both per vendor, settled once the vendor set is final.
  const body = estimateByVendor(fm.body, { kind: "prose" });
  const { estKind: _descKind, ...descriptionEstimate } = estimateByVendor(description, { kind: "prose" });
  const skill = {
    name: declaredName || dirName,
    path: displayPath(abs, { repoRoot, home }),
    scope,
    hasDescription: description.length > 0,
    descriptionChars: description.length,
    bodyEstTokens: body.estTokens,
    bodyEstTokensBy: body.estTokensBy,
    ...descriptionEstimate,
    frontmatterValid: fm.ok && fm.present && !nameMismatch,
    invocations30d: lookup(sessionStats?.skillInvocations, declaredName || dirName) || lookup(sessionStats?.skillInvocations, dirName),
  };
  if (!fm.present) skill.frontmatterError = "no frontmatter";
  else if (!fm.ok) skill.frontmatterError = fm.error ?? "invalid frontmatter";
  else if (nameMismatch) skill.frontmatterError = `name "${declaredName}" does not match directory "${dirName}"`;
  return skill;
}

/**
 * `<root>/<name>/SKILL.md` for every skill folder, including symlinked folders
 * (`.claude/skills/x -> ../../.agents/skills/x` is the common shared layout).
 * A link is followed only when its target stays inside the repository or home.
 */
async function skillDirs(root, roots) {
  const out = [];
  for (const entry of await listEntries(root)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(dir).catch(() => null);
      if (!target || !roots.some((base) => base && isInside(base, target)) || !(await isDirectory(target))) continue;
    }
    const abs = path.join(dir, "SKILL.md");
    if (await statSafe(abs)) out.push(abs);
  }
  return out.sort();
}

// Where each vendor looks for skills. Claude Code: .claude/skills (project) and ~/.claude/skills;
// Codex: .agents/skills (project) and ~/.agents/skills (https://learn.chatgpt.com/docs/build-skills).
const SKILL_LOCATIONS = [
  { base: "repo", dir: [".claude", "skills"], scope: "project", vendor: "claude" },
  { base: "repo", dir: [".agents", "skills"], scope: "project", vendor: "codex" },
  { base: "home", dir: [".claude", "skills"], scope: "user", vendor: "claude" },
  { base: "home", dir: [".agents", "skills"], scope: "user", vendor: "codex" },
];

export async function collectSkills(ctx) {
  const { repoRoot, home } = ctx;
  const roots = [repoRoot, home].filter(Boolean);
  const skills = [];
  // One row per physical skill: a symlink in .claude/skills and its target in .agents/skills are the
  // same skill, visible to both vendors, listed under its real location with the link as an alias.
  const byReal = new Map();
  for (const location of SKILL_LOCATIONS) {
    const base = location.base === "repo" ? repoRoot : home;
    if (!base) continue;
    for (const abs of await skillDirs(path.join(base, ...location.dir), roots)) {
      const real = (await realpath(abs).catch(() => abs));
      const existing = byReal.get(real);
      if (existing) {
        if (!existing.vendors.includes(location.vendor)) existing.vendors.push(location.vendor);
        const alias = displayPath(abs, { repoRoot, home });
        if (alias !== existing.path && !existing.aliases.includes(alias)) existing.aliases.push(alias);
        continue;
      }
      const skill = await readSkill(real, location.scope, ctx);
      if (!skill) continue;
      skill.vendors = [location.vendor];
      skill.aliases = [];
      const shown = displayPath(abs, { repoRoot, home });
      if (shown !== skill.path) skill.aliases.push(shown);
      byReal.set(real, skill);
      skills.push(skill);
    }
  }
  const pluginRoot = path.join(home, ".claude", "plugins", "cache");
  const pluginSkills = await walk(pluginRoot, { maxDepth: 8, maxFiles: MAX_PLUGIN_SKILLS, accept: (_, name) => name === "SKILL.md" });
  for (const abs of pluginSkills.sort()) {
    const skill = await readSkill(abs, "plugin", ctx);
    if (skill) skills.push({ ...skill, vendors: ["claude"], aliases: [] });
  }
  for (const skill of skills) settleEstimate(skill);
  return skills;
}

/** `estTokens` / `estBasis` for the vendors that see the row (the description and, for skills, the body). */
function settleEstimate(row) {
  Object.assign(row, pickEstimate(row.estTokensBy, row.vendors));
  if (row.bodyEstTokensBy) row.bodyEstTokens = pickEstimate(row.bodyEstTokensBy, row.vendors).estTokens;
  return row;
}

async function readAgent(abs, scope, { repoRoot, home, sessionStats }) {
  const read = await readTextSafe(abs, { roots: [repoRoot, home] });
  if (!read) return null;
  const fm = parseFrontmatter(read.text);
  const fileName = path.basename(abs, ".md");
  const name = typeof fm.data?.name === "string" && fm.data.name.trim() ? fm.data.name.trim() : fileName;
  const description = descriptionOf(fm.data);
  const { estKind: _descKind, ...descriptionEstimate } = estimateByVendor(description, { vendors: ["claude"], kind: "prose" });
  const agent = {
    name,
    path: displayPath(abs, { repoRoot, home }),
    scope,
    descriptionChars: description.length,
    // Agents are a Claude Code feature: the description enters every Claude request.
    ...descriptionEstimate,
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
