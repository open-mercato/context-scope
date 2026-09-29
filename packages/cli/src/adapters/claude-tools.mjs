/**
 * Claude Code tool name -> ToolKind + result Category mapping (ADR-001 section 3).
 * Deterministic on the tool name only; never inspects tool output.
 *
 *   Read / NotebookRead / Glob            -> file    -> tool_result.file
 *   Bash / BashOutput / Monitor           -> shell   -> tool_result.shell
 *   Grep / WebSearch                      -> search  -> tool_result.search
 *   WebFetch, browser MCP servers         -> web     -> tool_result.web
 *   Edit / Write / MultiEdit / NotebookEdit -> edit  -> tool_result.other
 *   Agent                                 -> agent   (handoff handled by the adapter)
 *   Skill                                 -> skill   (skill body handled by the adapter)
 *   mcp__<server>__<tool>                 -> mcp     -> tool_result.other (web for browser servers)
 *   everything else                       -> other   -> tool_result.other
 *
 * `partialReadOf(name, input)` (ADR-003 section 9, `tool.partial`): true when a
 * Read asks for a range (`limit`, or `offset` past the first line) or a Bash
 * command reads through `sed -n` / `head` / `tail` / `rg|grep -m` (argv parsing
 * from codex-tools.mjs, shared with the Codex adapter; never executed).
 *
 * `classifyBashCommand(command, { cwd, home })` (ADR-005 section 4): the same
 * parser gives a Bash call its fix family and target: `cat src/big.ts` is a
 * `file` read of `src/big.ts`, `rg foo src` a `search` of `src`, a heredoc or
 * redirect write an `edit`, `curl` a `web` fetch; anything else stays `shell`.
 * The block category stays `tool_result.shell` (what the model saw); only
 * `tool.kind` and `tool.target` are re-keyed so H-01/H-02/H-07 and B-01 group
 * Bash reads with Read and Codex `exec` reads.
 */
import { classifyCommand } from "./codex-tools.mjs";

/** Kinds a Bash command may be re-keyed to; every other parser kind stays `shell`. */
const BASH_KINDS = new Set(["file", "search", "edit", "web"]);

const BY_NAME = {
  Read: ["file", "tool_result.file"],
  NotebookRead: ["file", "tool_result.file"],
  Glob: ["file", "tool_result.file"],
  Bash: ["shell", "tool_result.shell"],
  BashOutput: ["shell", "tool_result.shell"],
  Monitor: ["shell", "tool_result.shell"],
  Grep: ["search", "tool_result.search"],
  WebSearch: ["search", "tool_result.search"],
  WebFetch: ["web", "tool_result.web"],
  Edit: ["edit", "tool_result.other"],
  Write: ["edit", "tool_result.other"],
  MultiEdit: ["edit", "tool_result.other"],
  NotebookEdit: ["edit", "tool_result.other"],
  Agent: ["agent", "tool_result.other"],
  Task: ["agent", "tool_result.other"],
  Skill: ["skill", "tool_result.other"],
};

const BROWSER_SERVER = /(chrome|browser|playwright|puppeteer|selenium)/i;

/** Parses `mcp__<server>__<tool>`; returns { server, tool } or null. */
export function parseMcpName(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const split = rest.indexOf("__");
  if (split < 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/** @returns {{ kind: string, category: string, server?: string }} */
export function classifyTool(name) {
  const known = BY_NAME[name];
  if (known) return { kind: known[0], category: known[1] };
  const mcp = parseMcpName(name);
  if (mcp) {
    return { kind: "mcp", category: BROWSER_SERVER.test(mcp.server) ? "tool_result.web" : "tool_result.other", server: mcp.server };
  }
  return { kind: "other", category: "tool_result.other" };
}

/** Input keys that carry the tool's target path, in priority order. */
export const TARGET_INPUT_KEYS = ["file_path", "notebook_path", "path"];

/** A ranged/limited read (not the whole file): Read with limit/offset, or a Bash read through a range tool. */
export function partialReadOf(name, input) {
  if (!input || typeof input !== "object") return false;
  if (name === "Read" || name === "NotebookRead") {
    if (typeof input.limit === "number" && Number.isFinite(input.limit)) return true;
    return typeof input.offset === "number" && input.offset > 1;
  }
  if (name === "Bash" && typeof input.command === "string" && input.command) return classifyCommand(input.command).partial === true;
  return false;
}

/**
 * `{ kind, target?, partial? }` for a Bash command: `kind` is `file`, `search`,
 * `edit` or `web` when the parser says so, else `shell`; `target` is already
 * repo-relative, `~`-relative or a basename (codex-tools.mjs `relativeTarget`),
 * never an absolute path. Returns `{ kind: "shell" }` for a non-string command.
 */
export function classifyBashCommand(command, { cwd, home } = {}) {
  if (typeof command !== "string" || !command.trim()) return { kind: "shell" };
  const parsed = classifyCommand(command, { cwd: cwd || undefined, home: home || undefined });
  const out = { kind: BASH_KINDS.has(parsed.kind) ? parsed.kind : "shell" };
  if (typeof parsed.target === "string" && parsed.target && parsed.target !== ".") out.target = parsed.target;
  if (parsed.partial === true) out.partial = true;
  return out;
}
