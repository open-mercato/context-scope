/**
 * Hook installer for Claude Code settings files (ADR-003 section 6).
 *
 * Pure parts (`mergeCaptureHooks`, `removeCaptureHooks`, `installedEvents`,
 * `unifiedDiff`) work on parsed settings objects and never touch the disk.
 * `applySettingsChange` does the guarded write: refuses invalid JSON, shows a
 * unified diff, requires `--yes` or an interactive confirmation, copies the
 * current file to `~/.contextscope/backups/<scope>-settings-<timestamp>.json`
 * (mode 0600, never inside the repository, the last 10 per scope kept), then
 * replaces the file atomically. Existing hook groups are left byte-for-byte:
 * our entries are appended as their own matcher-less group and recognised by
 * CAPTURE_MARKER in the command string. The command carries the Node binary
 * resolved at install time (`process.execPath`) with a PATH fallback.
 */
import path from "node:path";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline";
import { CAPTURE_EVENTS, CAPTURE_MARKER, CAPTURE_SCRIPT, captureHookEntry, nodeOfCommand } from "./template.mjs";

export const BACKUPS_KEPT = 10;
export const CAPTURE_MAX_AGE_DAYS = 90;
export const CAPTURE_MAX_FILES = 500;

export const SCOPES = ["user", "project", "local"];

/** Aliases accepted by --events (ADR names) in addition to the raw event names. */
const EVENT_ALIASES = {
  instructions: ["InstructionsLoaded"],
  session: ["SessionStart"],
  subagent: ["SubagentStart", "SubagentStop"],
  subagents: ["SubagentStart", "SubagentStop"],
  compaction: ["PreCompact", "PostCompact"],
  compact: ["PreCompact", "PostCompact"],
};

export function parseEvents(text) {
  if (!text) return [...CAPTURE_EVENTS];
  const out = [];
  for (const raw of String(text).split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const mapped = EVENT_ALIASES[token.toLowerCase()] ?? CAPTURE_EVENTS.filter((event) => event.toLowerCase() === token.toLowerCase());
    if (!mapped.length) throw new Error(`unknown hook event "${token}" (choose from ${CAPTURE_EVENTS.join(", ")})`);
    for (const event of mapped) if (!out.includes(event)) out.push(event);
  }
  return CAPTURE_EVENTS.filter((event) => out.includes(event));
}

/** User scope honours `CLAUDE_CONFIG_DIR` like Claude Code does; project and local live in the repository. */
export function settingsPathFor(scope, { home, repoRoot, env = process.env }) {
  if (scope === "user") return path.join(env?.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude"), "settings.json");
  if (scope === "project") return path.join(repoRoot, ".claude", "settings.json");
  if (scope === "local") return path.join(repoRoot, ".claude", "settings.local.json");
  throw new Error(`unknown scope "${scope}" (user, project or local)`);
}

export function captureScriptPath(home) {
  return path.join(home, ".contextscope", "bin", "capture.mjs");
}

export function backupDir(home) {
  return path.join(home, ".contextscope", "backups");
}

/** The Node binary the hook command will name: the one running the installer, when it exists on disk. */
export async function resolveNode({ execPath = process.execPath } = {}) {
  if (!execPath || !path.isAbsolute(execPath)) return { node: null, source: "PATH" };
  try { await access(execPath, fsConstants.X_OK); return { node: execPath, source: "process.execPath" }; } catch { return { node: null, source: "PATH" }; }
}

/** Whether a bare `node` resolves on the current PATH (what the hook falls back to). */
export async function nodeOnPath(env = process.env) {
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try { await access(path.join(dir, "node"), fsConstants.X_OK); return path.join(dir, "node"); } catch {}
  }
  return null;
}

/** The absolute Node path the installed capture entries name (first one found), or null. */
export function installedNode(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return null;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of groupHooks(group)) if (isCaptureHook(hook)) return nodeOfCommand(hook.command);
  }
  return null;
}

export function isCaptureHook(hook) {
  return Boolean(hook && typeof hook === "object" && typeof hook.command === "string" && hook.command.includes(CAPTURE_MARKER));
}

function groupHooks(group) {
  return Array.isArray(group?.hooks) ? group.hooks : [];
}

/** Events (of any name) whose hook list contains one of our entries. */
export function installedEvents(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((group) => groupHooks(group).some(isCaptureHook))) out.push(event);
  }
  return out;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Returns a new settings object with our capture entry present under each event (idempotent). `node` is the resolved binary. */
export function mergeCaptureHooks(settings, events = CAPTURE_EVENTS, { node } = {}) {
  const next = settings && typeof settings === "object" && !Array.isArray(settings) ? clone(settings) : {};
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) next.hooks = {};
  for (const event of events) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    if (groups.some((group) => groupHooks(group).some(isCaptureHook))) { next.hooks[event] = groups; continue; }
    groups.push({ hooks: [captureHookEntry({ node })] });
    next.hooks[event] = groups;
  }
  return next;
}

/** Returns a new settings object without any of our entries; empty groups, event lists and `hooks` are dropped. */
export function removeCaptureHooks(settings) {
  const next = settings && typeof settings === "object" && !Array.isArray(settings) ? clone(settings) : {};
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return next;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      if (!group.hooks.some(isCaptureHook)) { kept.push(group); continue; }
      const rest = group.hooks.filter((hook) => !isCaptureHook(hook));
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

// --- unified diff (small files; plain LCS) ---

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Unified diff of two texts (whole file as one hunk; enough for settings files). */
export function unifiedDiff(before, after, name = "settings.json") {
  if (before === after) return "";
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const table = a.length * b.length > 4_000_000 ? null : lcsTable(a, b);
  const ops = [];
  if (!table) {
    for (const line of a) ops.push(["-", line]);
    for (const line of b) ops.push(["+", line]);
  } else {
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([" ", a[i]]); i += 1; j += 1; }
      else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) { ops.push(["+", b[j]]); j += 1; }
      else { ops.push(["-", a[i]]); i += 1; }
    }
  }
  const lines = [`--- ${name}`, `+++ ${name}`, `@@ -1,${a.length} +1,${b.length} @@`];
  for (const [sign, line] of ops) lines.push(`${sign}${line}`);
  return lines.join("\n") + "\n";
}

// --- guarded file write ---

export async function readSettingsFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, text: "", settings: {} };
    throw error;
  }
  let settings;
  try {
    settings = text.trim() === "" ? {} : JSON.parse(text);
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON (${error.message}); fix it or restore a backup before installing hooks`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${path.basename(file)} must contain a JSON object`);
  return { exists: true, text, settings };
}

function detectIndent(text) {
  const match = /\n([ \t]+)"/.exec(text);
  return match ? match[1] : "  ";
}

export function renderSettings(settings, previousText = "") {
  const indent = detectIndent(previousText);
  const body = JSON.stringify(settings, null, indent);
  return previousText === "" || previousText.endsWith("\n") ? body + "\n" : body;
}

/** `~/.contextscope/backups/<scope>-settings-<timestamp>.json`; `scope` is derived from the file name when not given. */
export function backupNameFor(file, now = new Date(), { home, scope } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23); // to the millisecond: two writes in one second keep both backups
  const label = scope ?? (path.basename(file) === "settings.local.json" ? "local" : "settings");
  return path.join(backupDir(home ?? process.env.HOME ?? ""), `${label}-settings-${stamp}.json`);
}

/** Keeps the newest `keep` backups of one scope; returns the removed file names. */
export async function pruneBackups({ home, scope, keep = BACKUPS_KEPT }) {
  let names = [];
  try { names = await readdir(backupDir(home)); } catch { return []; }
  const mine = names.filter((name) => name.startsWith(`${scope}-settings-`) && name.endsWith(".json")).sort();
  const stale = mine.slice(0, Math.max(0, mine.length - keep));
  for (const name of stale) await rm(path.join(backupDir(home), name), { force: true });
  return stale;
}

/** Removes capture files older than `maxAgeDays` and beyond the newest `maxFiles`; returns { removed, kept }. */
export async function pruneCaptureFiles({ home, maxAgeDays = CAPTURE_MAX_AGE_DAYS, maxFiles = CAPTURE_MAX_FILES, now = Date.now() } = {}) {
  const dir = path.join(home, ".contextscope", "capture");
  let names = [];
  try { names = await readdir(dir); } catch { return { removed: 0, kept: 0 }; }
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try { const info = await stat(path.join(dir, name)); if (info.isFile()) files.push({ name, mtimeMs: info.mtimeMs }); } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = now - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const [i, file] of files.entries()) {
    if (i < maxFiles && file.mtimeMs >= cutoff) continue;
    await rm(path.join(dir, file.name), { force: true });
    removed += 1;
  }
  return { removed, kept: files.length - removed };
}

async function askYesNo(question, input = process.stdin, output = process.stderr) {
  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * Computes the change for `file` with `transform(settings)`, prints the diff,
 * and writes it when allowed. Returns { changed, written, backup, diff, path,
 * reformatted }. `confirm` decides when neither --yes nor --dry-run is given:
 * defaults to a TTY prompt and refuses otherwise. The backup goes to
 * `~/.contextscope/backups/<scope>-settings-<timestamp>.json` (0600).
 */
export async function applySettingsChange({ file, transform, dryRun = false, yes = false, confirm, out = (line) => process.stdout.write(line + "\n"), now = new Date(), home = process.env.HOME, scope }) {
  const current = await readSettingsFile(file);
  const next = transform(current.settings);
  const nextText = renderSettings(next, current.text);
  const diff = unifiedDiff(current.text, nextText, displayName(file));
  // "Byte-for-byte" holds for JSON.stringify-shaped files; anything else is re-serialised (review #29).
  const reformatted = current.exists && current.text !== "" && renderSettings(current.settings, current.text) !== current.text;
  const result = { path: file, changed: diff !== "", written: false, backup: null, diff, reformatted };
  if (!result.changed) { out(`${displayName(file)}: no changes.`); return result; }
  if (reformatted) out(`Note: ${displayName(file)} is re-serialised (${detectIndent(current.text).length}-space indent); existing entries keep their content, not their byte layout.`);
  out(diff.trimEnd());
  if (dryRun) { out(`(dry run) ${displayName(file)} not written.`); return result; }
  if (!yes) {
    const decide = confirm ?? (async () => {
      if (!process.stdin.isTTY) throw new Error(`refusing to write ${displayName(file)} without --yes (stdin is not a terminal)`);
      return askYesNo(`Apply this change to ${displayName(file)}? [y/N] `);
    });
    if (!(await decide(result))) { out("Aborted; nothing written."); return result; }
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (current.exists) {
    result.backup = backupNameFor(file, now, { home, scope });
    await mkdir(path.dirname(result.backup), { recursive: true, mode: 0o700 });
    await copyFile(file, result.backup);
    await chmod(result.backup, 0o600).catch(() => {});
    if (scope) result.pruned = await pruneBackups({ home, scope });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const mode = current.exists ? (await stat(file)).mode & 0o777 : 0o644;
  await writeFile(tmp, nextText, { mode });
  await rename(tmp, file);
  result.written = true;
  out(`Wrote ${displayName(file)}${result.backup ? ` (backup: ${displayName(result.backup, home)})` : " (new file, nothing to back up)"}.`);
  return result;
}

export function displayName(file, home = process.env.HOME) {
  if (home && file.startsWith(home + path.sep)) return "~" + file.slice(home.length).split(path.sep).join("/");
  return file;
}

/** Writes ~/.contextscope/bin/capture.mjs (0700) when missing or different. Returns { path, written, upToDate }. */
export async function ensureCaptureScript({ home }) {
  const file = captureScriptPath(home);
  let existing = null;
  try { existing = await readFile(file, "utf8"); } catch {}
  if (existing === CAPTURE_SCRIPT) {
    await chmod(file, 0o700).catch(() => {});
    return { path: file, written: false, upToDate: true };
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, CAPTURE_SCRIPT, { mode: 0o700 });
  await rename(tmp, file);
  await chmod(file, 0o700).catch(() => {});
  return { path: file, written: true, upToDate: false };
}

/** { present, upToDate } for the installed script. */
export async function captureScriptStatus({ home }) {
  try {
    const text = await readFile(captureScriptPath(home), "utf8");
    return { present: true, upToDate: text === CAPTURE_SCRIPT };
  } catch {
    return { present: false, upToDate: false };
  }
}
