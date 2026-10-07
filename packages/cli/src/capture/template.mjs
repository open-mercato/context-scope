/**
 * Source of the installed capture hook, `~/.contextscope/bin/capture.mjs`
 * (ADR-003 section 6). The script is self-contained (node builtins only), so it
 * is kept here as a string and written verbatim by the installer; `hooks status`
 * compares the installed file against `CAPTURE_SCRIPT` to report drift.
 *
 * Runtime contract of the installed script:
 *   - reads one hook payload from stdin (<= 256 KB, 500 ms self-timeout);
 *   - keeps only whitelisted fields per event; unknown events write nothing;
 *   - never stores prompt text, summaries or absolute paths (paths become
 *     cwd-relative, `~`-relative only under `~/.claude` or `~/.codex`, or a
 *     basename, so a record for one repository never names another one; the
 *     Claude project directory segment of the transcript path is replaced by
 *     the project key);
 *   - appends one JSON line to ~/.contextscope/capture/<sessionId>.jsonl
 *     (dir 0700, file 0600) and exits 0 on every path.
 */

export const CAPTURE_VERSION = "capture/v1";

/** Marker present in every hook command we install; uninstall and status match on it. */
export const CAPTURE_MARKER = ".contextscope/bin/capture.mjs";

/** Events the hook is attached to, in the order they are shown. */
export const CAPTURE_EVENTS = ["InstructionsLoaded", "SessionStart", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop"];

/**
 * Whitelist: hook stdin field -> record field. `path` values are relativized,
 * `enum` values are kept only when they are short identifiers. Anything not
 * listed here (custom_instructions, last_assistant_message, prompt, env,
 * permission_mode, prompt_id...) never reaches disk.
 *
 * Field names checked against the Claude Code hooks reference (2026-09) and
 * against CLI 2.1.258 payloads:
 *   documented   InstructionsLoaded { file_path, load_reason }, SessionStart { source },
 *                PreCompact / PostCompact { trigger }, SubagentStart / SubagentStop { agent_id, agent_type }
 *   alias        `reason` (older builds used it for source / trigger / load_reason; accepted, same record field)
 *   observed,    `memory_type` (InstructionsLoaded: "project" | "user" | "local" | ...),
 *   undocumented `is_global_instructions` (InstructionsLoaded, boolean; recorded as memoryType user/project
 *                when `memory_type` is absent), `agent_transcript_path` (SubagentStop; relativized like
 *                `transcript_path`). An absent field writes nothing, so a vendor rename only costs
 *                coverage, never privacy; `hooks status` shows per-event counts to make a silent drop visible.
 */
export const CAPTURE_WHITELIST = {
  InstructionsLoaded: [
    ["file_path", "file", "path"],
    ["reason", "loadReason", "enum"],
    ["load_reason", "loadReason", "enum"],
    ["memory_type", "memoryType", "enum"],
    ["is_global_instructions", "memoryType", "globalFlag"],
  ],
  SessionStart: [
    ["reason", "source", "enum"],
    ["source", "source", "enum"],
  ],
  PreCompact: [
    ["reason", "trigger", "enum"],
    ["trigger", "trigger", "enum"],
  ],
  PostCompact: [
    ["reason", "trigger", "enum"],
    ["trigger", "trigger", "enum"],
  ],
  SubagentStart: [
    ["agent_id", "agentId", "enum"],
    ["agent_type", "agentType", "enum"],
  ],
  SubagentStop: [
    ["agent_id", "agentId", "enum"],
    ["agent_type", "agentType", "enum"],
    ["agent_transcript_path", "agentTranscript", "path"],
  ],
};

export const CAPTURE_SCRIPT = `#!/usr/bin/env node
// ContextScope capture hook (${CAPTURE_VERSION}). Installed by \`contextscope hooks install\`.
// Reads one Claude Code hook payload from stdin and appends a metadata-only
// record to ~/.contextscope/capture/<sessionId>.jsonl. No prompt text, no
// absolute paths. Exits 0 on every path so the hook can never block Claude.
// Remove with \`contextscope hooks uninstall\` or delete this file.
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";

const WHITELIST = ${JSON.stringify(CAPTURE_WHITELIST)};
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 500;
const ID = /^[A-Za-z0-9._-]{1,128}$/;

function projectKeyFor(cwd) {
  const normalized = String(cwd ?? "").replace(/\\\\/g, "/").replace(/\\/+$/, "");
  const base = (normalized.split("/").filter(Boolean).pop() || normalized || "unknown").replace(/[\\\\/]/g, "-").slice(0, 80);
  return base + "-" + createHash("sha1").update(normalized).digest("hex").slice(0, 8);
}

function relativize(value, cwd, home, cwdKey) {
  const text = String(value).replace(/\\\\/g, "/");
  if (!isAbsolute(text)) return text.split("/").some((p) => p === "..") ? basename(text) : text;
  const under = (root) => root && (text === root || text.startsWith(root + "/"));
  if (cwd && under(cwd)) return relative(cwd, text).split("\\\\").join("/") || ".";
  if (home && (under(home + "/.claude") || under(home + "/.codex"))) {
    const rel = "~/" + relative(home, text).split("\\\\").join("/");
    // ~/.claude/projects/<encoded cwd>/... -> replace the encoded segment with the project key.
    return rel.replace(/(\\/projects\\/)(-[^/]*)(?=\\/|$)/, (m, head, seg) => head + (seg === cwdKey ? seg : cwdKey || ("dir-" + createHash("sha1").update(seg).digest("hex").slice(0, 8))));
  }
  // Anywhere else (another project under home, /tmp, a mounted volume): the basename only.
  return basename(text);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } };
    const timer = setTimeout(finish, TIMEOUT_MS);
    timer.unref();
    process.stdin.on("data", (chunk) => {
      if (size + chunk.length > MAX_BYTES) { finish(); return; }
      chunks.push(chunk); size += chunk.length;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.on("close", finish);
  });
}

function build(payload) {
  if (!payload || typeof payload !== "object") return null;
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const keep = WHITELIST[event];
  if (!keep) return null;
  const sessionId = typeof payload.session_id === "string" && ID.test(payload.session_id) ? payload.session_id : "";
  if (!sessionId) return null;
  const home = homedir().replace(/\\\\/g, "/").replace(/\\/+$/, "");
  const cwd = typeof payload.cwd === "string" ? payload.cwd.replace(/\\\\/g, "/").replace(/\\/+$/, "") : "";
  const cwdKey = cwd ? projectKeyFor(cwd) : "unknown";
  const record = { v: 1, at: new Date().toISOString(), event, sessionId, cwdKey, transcript: typeof payload.transcript_path === "string" ? relativize(payload.transcript_path, cwd, home, cwdKey) : "" };
  for (const [from, to, kind] of keep) {
    const value = payload[from];
    if (value === undefined || value === null || record[to] !== undefined) continue;
    if (kind === "path" && typeof value === "string") record[to] = relativize(value, cwd, home, cwdKey).slice(0, 300);
    else if (kind === "enum" && typeof value === "string" && ID.test(value)) record[to] = value;
    else if (kind === "globalFlag" && typeof value === "boolean") record[to] = value ? "user" : "project";
  }
  return record;
}

async function main() {
  const text = await readStdin();
  let payload;
  try { payload = JSON.parse(text); } catch { return; }
  const record = build(payload);
  if (!record) return;
  const dir = join(homedir(), ".contextscope", "capture");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, record.sessionId + ".jsonl"), JSON.stringify(record) + "\\n", { mode: 0o600 });
}

main().catch(() => {}).finally(() => process.exit(0));
`;

/** The script path as it appears in the installed command (expanded by the hook's shell, not by us). */
export const CAPTURE_SCRIPT_REF = `"$HOME/${CAPTURE_MARKER}"`;

/**
 * The settings.json hook entry (fail-open: the shell wrapper swallows every
 * failure). `node` is the absolute Node binary resolved at install time
 * (Claude Code may run from a GUI or a shell without nvm/asdf on PATH, where a
 * bare `node` resolves to nothing and the hook would be a silent no-op); the
 * command falls back to `node` on PATH, then to `true`. A path with a single
 * quote cannot be embedded in the `sh -c '…'` wrapper and degrades to PATH only.
 */
export function captureHookEntry({ node } = {}) {
  const viaPath = `node ${CAPTURE_SCRIPT_REF} 2>/dev/null`;
  const resolved = typeof node === "string" && node && !node.includes("'") && node !== "node" ? `"${node.replace(/"/g, "")}" ${CAPTURE_SCRIPT_REF} 2>/dev/null || ` : "";
  return { type: "command", command: `sh -c '${resolved}${viaPath} || true'`, timeout: 5 };
}

/** The absolute Node path an installed command carries, or null when it relies on PATH only. */
export function nodeOfCommand(command) {
  const match = /^sh -c '"([^"]+)" "\$HOME\//.exec(String(command ?? ""));
  return match ? match[1] : null;
}
