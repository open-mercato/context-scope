/**
 * Settings, hooks and MCP server inventory from the documented config files.
 * Only key names, hook commands (truncated) and transport kinds are recorded;
 * env values and secrets are never read into the output.
 */
import path from "node:path";
import { estimateTokensFromBytes } from "../ir/estimate.mjs";
import { readTextSafe } from "./fs.mjs";

const COMMAND_MAX = 120;

async function readJson(abs, roots) {
  const read = await readTextSafe(abs, { roots });
  if (!read) return null;
  try {
    const value = JSON.parse(read.text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function truncate(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > COMMAND_MAX ? value.slice(0, COMMAND_MAX - 1) + "…" : value;
}

function transportOf(server) {
  if (!server || typeof server !== "object") return undefined;
  if (typeof server.type === "string") return server.type;
  if (typeof server.transport === "string") return server.transport;
  if (typeof server.url === "string") return /sse/i.test(server.url) ? "sse" : "http";
  if (typeof server.command === "string") return "stdio";
  return undefined;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/**
 * Hook observations matched from sessionStats.hookRuns; returns tokens.
 *
 * The index (index/entry.mjs `statsOf`) keys hook runs by the hook event
 * (`SessionStart`, `PreToolUse`, ...) with a `byMatcher` split taken from the
 * transcript's `hookName` (`SessionStart:compact`), and reports stdout sizes in
 * tokens (`unit: "tokens"`). Legacy or hand-built tables keyed `event:matcher`
 * with byte sizes are still accepted: sizes without a `unit` are bytes.
 */
export function hookRunStats(hook, hookRuns) {
  if (!hookRuns || typeof hookRuns !== "object") return { runs: 0, stdoutTokens: [] };
  const event = String(hook.event ?? "");
  const matcher = hook.matcher === undefined || hook.matcher === null ? "" : String(hook.matcher);
  const exactKey = `${event}:${matcher}`;
  const matches = [];
  const byEvent = hookRuns[event];
  if (byEvent && typeof byEvent === "object" && !Array.isArray(byEvent)) {
    const sub = matcher && byEvent.byMatcher && byEvent.byMatcher[matcher];
    matches.push(sub ? { ...sub, unit: byEvent.unit } : byEvent);
  } else {
    for (const [name, stats] of Object.entries(hookRuns)) {
      if (!stats || typeof stats !== "object") continue;
      const bare = name.replace(/^hook_[a-z_]+:/, "");
      if (bare === exactKey || (matcher === "" && bare === event)) matches.push(stats);
    }
  }
  const stdoutTokens = [];
  let runs = 0;
  for (const stats of matches) {
    runs += Number(stats.runs) || 0;
    const sizes = Array.isArray(stats.stdoutSizes) ? stats.stdoutSizes : [];
    for (const size of sizes) stdoutTokens.push(stats.unit === "tokens" ? Math.round(Number(size) || 0) : estimateTokensFromBytes(size, "prose"));
  }
  return { runs, stdoutTokens };
}

function hooksFromSettings(settings, scope) {
  const out = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = typeof group?.matcher === "string" ? group.matcher : undefined;
      const inner = Array.isArray(group?.hooks) ? group.hooks : [group];
      for (const hook of inner) {
        if (!hook || typeof hook !== "object") continue;
        const command = hook.type && hook.type !== "command" ? `[${hook.type}]` : truncate(hook.command);
        const entry = { event, command, scope };
        if (matcher !== undefined) entry.matcher = matcher;
        out.push(entry);
      }
    }
  }
  return out;
}

/** Minimal TOML section reader: `[mcp_servers.<name>]` headers and their scalar keys. */
export function parseTomlMcpServers(text) {
  const servers = new Map();
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // `[mcp_servers.<name>]` only; dotted unquoted names are sub-tables (e.g. `.env`), not servers.
    const header = line.match(/^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/);
    if (header) {
      const name = header[1] ?? header[2] ?? header[3];
      current = servers.get(name) ?? { name };
      servers.set(name, current);
      continue;
    }
    if (line.startsWith("[")) { current = /^\[\s*mcp_servers\./.test(line) ? current : null; continue; }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (key === "command") current.command = true;
    if (key === "url") current.url = value.replace(/^["']|["'].*$/g, "");
    if (key === "enabled") current.enabled = !/^false$/i.test(value);
  }
  return [...servers.values()];
}

export async function collectSettings({ repoRoot, home }) {
  const roots = [repoRoot, home];
  const sources = [
    { abs: path.join(home, ".claude", "settings.json"), display: "~/.claude/settings.json", scope: "user" },
    { abs: path.join(repoRoot, ".claude", "settings.json"), display: ".claude/settings.json", scope: "project" },
    { abs: path.join(repoRoot, ".claude", "settings.local.json"), display: ".claude/settings.local.json", scope: "local" },
  ];
  const settings = [];
  const hooks = [];
  const mcp = new Map();
  const addServer = (name, scope, transport, vendor = "claude") => {
    if (!name || mcp.has(`${vendor}:${scope}:${name}`)) return;
    const entry = { name: String(name), scope, vendor, toolsObserved: [], invocations30d: 0 };
    if (transport) entry.transport = transport;
    mcp.set(`${vendor}:${scope}:${name}`, entry);
  };
  for (const source of sources) {
    const json = await readJson(source.abs, roots);
    if (!json) continue;
    settings.push({ path: source.display, scope: source.scope, keys: Object.keys(json).slice(0, 60) });
    hooks.push(...hooksFromSettings(json, source.scope));
    if (json.mcpServers && typeof json.mcpServers === "object") {
      for (const [name, server] of Object.entries(json.mcpServers)) addServer(name, source.scope, transportOf(server));
    }
  }
  // Project .mcp.json
  const mcpJson = await readJson(path.join(repoRoot, ".mcp.json"), roots);
  if (mcpJson?.mcpServers && typeof mcpJson.mcpServers === "object") {
    for (const [name, server] of Object.entries(mcpJson.mcpServers)) addServer(name, "project", transportOf(server));
  }
  // ~/.claude.json: user-scope servers plus per-project (local) servers. Names and transport only.
  const claudeJson = await readJson(path.join(home, ".claude.json"), roots);
  if (claudeJson) {
    if (claudeJson.mcpServers && typeof claudeJson.mcpServers === "object") {
      for (const [name, server] of Object.entries(claudeJson.mcpServers)) addServer(name, "user", transportOf(server));
    }
    const project = claudeJson.projects?.[repoRoot];
    if (project?.mcpServers && typeof project.mcpServers === "object") {
      for (const [name, server] of Object.entries(project.mcpServers)) addServer(name, "local", transportOf(server));
    }
  }
  // Codex config.toml (user) and .codex/config.toml (project)
  for (const source of [
    { abs: path.join(home, ".codex", "config.toml"), scope: "user", display: "~/.codex/config.toml" },
    { abs: path.join(repoRoot, ".codex", "config.toml"), scope: "project", display: ".codex/config.toml" },
  ]) {
    const read = await readTextSafe(source.abs, { roots });
    if (!read) continue;
    const servers = parseTomlMcpServers(read.text);
    const keys = [...new Set([...read.text.matchAll(/^\[\s*([A-Za-z0-9_-]+)/gm)].map(m => m[1]))].slice(0, 60);
    settings.push({ path: source.display, scope: source.scope, keys });
    for (const server of servers) {
      if (server.enabled === false) continue;
      addServer(server.name, source.scope, server.url ? (/sse/i.test(server.url) ? "sse" : "http") : server.command ? "stdio" : undefined, "codex");
    }
  }
  return { settings, hooks, mcpServers: [...mcp.values()] };
}

/** Attaches observed usage from sessionStats to hooks and MCP servers (mutates). */
export function attachObservations({ hooks, mcpServers }, sessionStats) {
  for (const hook of hooks) {
    const stats = hookRunStats(hook, sessionStats?.hookRuns);
    hook.runs30d = stats.runs;
    hook.stdoutP50 = percentile(stats.stdoutTokens, 0.5);
    hook.stdoutP95 = percentile(stats.stdoutTokens, 0.95);
  }
  const tools = sessionStats?.mcpToolsObserved ?? {};
  const invocations = sessionStats?.mcpInvocations ?? {};
  for (const server of mcpServers) {
    const observed = tools[server.name];
    server.toolsObserved = Array.isArray(observed) ? [...new Set(observed.map(String))].slice(0, 500) : [];
    server.invocations30d = Number(invocations[server.name]) || 0;
  }
}
