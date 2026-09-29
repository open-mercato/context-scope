/**
 * Codex tool classification (adapter helper, no I/O).
 *
 * Codex has two call shapes (docs/format-codex.md section 5):
 *   - `custom_tool_call` with `name: "exec"` whose `input` is a JavaScript snippet
 *     calling `tools.exec_command({"cmd": ...})`, `tools.apply_patch(...)`,
 *     `tools.write_stdin(...)`, `tools.web__run(...)`, `tools.mcp__<server>__<tool>(...)`,
 *     `tools.view_image(...)`, `tools.update_plan(...)` (0.146+), or `name: "apply_patch"`
 *     whose input is the raw patch (<= 0.132).
 *   - `function_call` with `name` in {exec_command, write_stdin, wait, spawn_agent,
 *     wait_agent, send_message, list_agents, interrupt_agent, followup_task, ...}
 *     and JSON `arguments`.
 *
 * The shell command inside is parsed (never executed) into pipeline segments;
 * each segment's command word decides the ToolKind: cat/sed -n/head/tail/nl ->
 * file, rg/grep/find/fd/ls -> search, curl/wget -> web, apply_patch/sed -i/
 * redirects -> edit, agent tools -> agent, else shell. The target is the first
 * path-like argument made repo-relative (or ~-relative, or basename) so no
 * absolute path outside the home directory ever reaches the IR. `partial` is
 * set when any segment reads a range rather than a whole file: `sed -n`,
 * `head`, `tail`, `rg`/`grep` with `-m`/`--max-count` (ADR-003 `tool.partial`).
 */
import path from "node:path";

export const AGENT_TOOLS = new Set([
  "spawn_agent", "wait_agent", "send_message", "list_agents", "interrupt_agent",
  "followup_task", "close_agent", "resume_agent", "kill_agent",
]);

const FILE_COMMANDS = new Set(["cat", "head", "tail", "nl", "less", "more", "bat", "sed", "awk", "wc", "stat", "file", "od", "hexdump", "xxd", "jq", "diff", "strings", "view_image", "read_file"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "find", "fd", "fdfind", "ls", "tree", "which", "locate", "whereis", "glob"]);
const WEB_COMMANDS = new Set(["curl", "wget", "http", "https", "httpie"]);
const EDIT_COMMANDS = new Set(["apply_patch", "tee", "patch"]);
const PASSTHROUGH = new Set(["sudo", "env", "time", "command", "exec", "nohup", "nice", "builtin"]);
const SKIP_SEGMENT = new Set(["cd", "pushd", "popd", "export", "set", "unset", "true", "false", "echo", "printf", "pwd", "source"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
const RANGE_COMMANDS = new Set(["head", "tail"]);
const MAX_COUNT_FLAG = /^(?:-[a-zA-Z]*m(?:\d+)?|--max-count(?:=\d+)?)$/;
const SEGMENT_OPERATORS = ["&&", "||", ";", "|", "\n"];
const MAX_TARGET_LENGTH = 120;

/** Classify one Codex call (custom_tool_call or function_call payload). */
export function classifyCodexCall({ name, input, arguments: argsText, namespace }, context = {}) {
  if (AGENT_TOOLS.has(name) || namespace === "collaboration") return { kind: "agent", subtool: name };
  let args = null;
  if (typeof argsText === "string" && argsText) {
    try { args = JSON.parse(argsText); } catch { args = null; }
  }
  if (name === "exec_command") {
    return { ...classifyCommand(String(args?.cmd ?? ""), { ...context, workdir: args?.workdir }), subtool: "exec_command" };
  }
  if (name === "write_stdin" || name === "wait") return { kind: "shell", subtool: name };
  if (name === "apply_patch") return { kind: "edit", subtool: "apply_patch", ...patchTargets(String(input ?? args?.input ?? ""), context) };
  if (name === "exec") return classifyExecScript(String(input ?? ""), context);
  if (name === "web_search" || name === "web_search_call") return { kind: "web", subtool: name };
  if (name === "view_image" || name === "read_file") return { kind: "file", subtool: name, ...maybeTarget(args?.path, context) };
  if (name === "update_plan") return { kind: "other", subtool: name };
  if (/^mcp__/.test(name)) return { kind: "mcp", server: name.split("__")[1], subtool: name };
  return { kind: "other", subtool: name };
}

/**
 * The `exec` custom tool input is JavaScript. We only pattern-match
 * `tools.<name>(` occurrences and the string literal that carries the command;
 * the snippet is never evaluated.
 */
export function classifyExecScript(script, context = {}) {
  const calls = [];
  const re = /tools\.([A-Za-z0-9_]+)\s*\(/g;
  let match;
  while ((match = re.exec(script))) calls.push({ name: match[1], at: match.index + match[0].length });
  if (!calls.length) return { kind: "shell", subtool: "js" };
  const results = [];
  for (const call of calls) {
    const tool = call.name;
    if (tool === "exec_command") {
      const cmd = extractStringProperty(script, "cmd", call.at);
      const workdir = extractStringProperty(script, "workdir", call.at);
      results.push({ ...classifyCommand(cmd ?? "", { ...context, workdir: workdir ?? context.workdir }), subtool: tool });
    } else if (tool === "apply_patch") {
      results.push({ kind: "edit", subtool: tool, ...patchTargets(script, context) });
    } else if (tool === "write_stdin" || tool === "wait") {
      results.push({ kind: "shell", subtool: tool });
    } else if (/^web__/.test(tool)) {
      results.push({ kind: "web", subtool: tool });
    } else if (/^mcp__/.test(tool)) {
      results.push({ kind: "mcp", server: tool.split("__")[1], subtool: tool });
    } else if (tool === "view_image" || tool === "read_file") {
      results.push({ kind: "file", subtool: tool, ...maybeTarget(extractStringProperty(script, "path", call.at), context) });
    } else if (AGENT_TOOLS.has(tool)) {
      results.push({ kind: "agent", subtool: tool });
    } else if (/__/.test(tool)) {
      results.push({ kind: "mcp", server: tool.split("__")[0], subtool: tool });
    } else {
      results.push({ kind: "other", subtool: tool });
    }
  }
  return mergeKinds(results);
}

/** Classify a shell command string. Returns { kind, target?, segments }. */
export function classifyCommand(command, context = {}) {
  const segments = splitSegments(stripHeredocs(command));
  const results = [];
  for (const segment of segments) {
    const tokens = tokenize(segment);
    const classified = classifySegment(tokens, context);
    if (classified) results.push(classified);
  }
  if (!results.length) return { kind: "shell" };
  return mergeKinds(results);
}

function classifySegment(rawTokens, context) {
  let tokens = rawTokens.filter((token) => token.length);
  // Drop env assignments and passthrough wrappers (sudo, env, time ...).
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || PASSTHROUGH.has(tokens[0]))) tokens = tokens.slice(1);
  if (tokens[0] === "timeout" && tokens.length > 2) tokens = tokens.slice(2);
  if (!tokens.length) return null;
  const word = path.posix.basename(tokens[0]);
  if (SKIP_SEGMENT.has(word)) return hasWriteRedirect(tokens) ? { kind: "edit", ...redirectTarget(tokens, context) } : null;
  if (SHELLS.has(word)) {
    const flagIndex = tokens.findIndex((token, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
    if (flagIndex > 0 && tokens[flagIndex + 1]) return classifyCommand(tokens[flagIndex + 1], context);
    return { kind: "shell" };
  }
  if (hasWriteRedirect(tokens)) return { kind: "edit", ...redirectTarget(tokens, context) };
  if (word === "sed" && tokens.some((token) => /^-[a-zA-Z]*i/.test(token))) return { kind: "edit", ...firstPathTarget(dropScriptArgument(tokens.slice(1)), context) };
  if (word === "git" && (tokens[1] === "grep" || tokens[1] === "ls-files")) return { kind: "search", ...lastPathTarget(tokens[1] === "grep" ? dropPattern(tokens.slice(2).filter((token) => token !== "--")) : tokens.slice(2), context, { allowBare: true }) };
  if (FILE_COMMANDS.has(word)) {
    const args = tokens.slice(1);
    const partial = RANGE_COMMANDS.has(word) || (word === "sed" && args.some((token) => /^-[a-zA-Z]*n/.test(token)));
    return { kind: "file", ...firstPathTarget(word === "sed" || word === "awk" ? dropScriptArgument(args) : args, context), ...(partial ? { partial: true } : {}) };
  }
  if (SEARCH_COMMANDS.has(word)) {
    // Search roots are often bare directory names (`rg foo src`), so bare words are accepted here.
    const args = tokens.slice(1);
    if (word === "find" || word === "fd" || word === "fdfind" || word === "ls" || word === "tree") return { kind: "search", ...firstPathTarget(args, context, { allowBare: true }) };
    const partial = (word === "rg" || word === "grep" || word === "egrep" || word === "fgrep") && args.some((token) => MAX_COUNT_FLAG.test(token));
    return { kind: "search", ...lastPathTarget(dropPattern(args), context, { allowBare: true }), ...(partial ? { partial: true } : {}) };
  }
  if (WEB_COMMANDS.has(word)) return { kind: "web" };
  if (EDIT_COMMANDS.has(word)) return { kind: "edit", ...firstPathTarget(tokens.slice(1), context) };
  return { kind: "shell" };
}

const KIND_PRIORITY = ["shell", "edit", "web", "mcp", "agent"];

function mergeKinds(results) {
  const kinds = results.map((result) => result.kind);
  const partial = results.some((result) => result.partial) ? { partial: true } : {};
  for (const kind of KIND_PRIORITY) {
    if (kinds.includes(kind)) {
      const winner = results.find((result) => result.kind === kind);
      const withTarget = results.find((result) => result.kind === kind && result.target) ?? winner;
      return { ...withTarget, ...partial, segments: results.length };
    }
  }
  const first = results.find((result) => result.kind === "file" || result.kind === "search") ?? results[0];
  const targeted = results.find((result) => result.kind === first.kind && result.target) ?? first;
  return { ...targeted, ...partial, segments: results.length };
}

const WRITE_REDIRECT = /^\d?>>?$/;

function hasWriteRedirect(tokens) {
  return tokens.some((token, index) => WRITE_REDIRECT.test(token) && tokens[index + 1] !== undefined);
}

function redirectTarget(tokens, context) {
  const index = tokens.findIndex((token) => WRITE_REDIRECT.test(token));
  return maybeTarget(tokens[index + 1], context);
}

function dropScriptArgument(args) {
  const index = args.findIndex((token) => !token.startsWith("-"));
  if (index < 0) return args;
  return [...args.slice(0, index), ...args.slice(index + 1)];
}

function dropPattern(args) {
  if (args.includes("--files")) return args; // rg --files lists paths, there is no pattern argument
  const explicit = args.findIndex((token) => token === "-e" || token === "--regexp");
  if (explicit >= 0) return [...args.slice(0, explicit), ...args.slice(explicit + 2)];
  const index = args.findIndex((token) => !token.startsWith("-"));
  if (index < 0) return args;
  return [...args.slice(0, index), ...args.slice(index + 1)];
}

function firstPathTarget(args, context, options = {}) {
  for (const token of args) {
    if (isPathLike(token, options)) return maybeTarget(token, context);
  }
  return {};
}

function lastPathTarget(args, context, options = {}) {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    if (isPathLike(args[i], options)) return maybeTarget(args[i], context);
  }
  return {};
}

function isPathLike(token, { allowBare = false } = {}) {
  if (!token || token.startsWith("-") || token.length > 400) return false;
  if (/^\d+(,\d+)?[a-z]?$/.test(token)) return false;
  if (token === "." || token === "..") return true;
  if (/\s/.test(token) || /^\d?[<>]/.test(token)) return false;
  if (token.includes("/") || /^[\w@+~.-]+\.[A-Za-z0-9]{1,8}$/.test(token) || /^~/.test(token)) return true;
  return allowBare && /^[\w@+.-]+$/.test(token);
}

function maybeTarget(value, context) {
  if (typeof value !== "string" || !value.trim()) return {};
  const target = relativeTarget(value.trim(), context);
  return target ? { target } : {};
}

/**
 * Make a path safe for the IR: repo-relative when under cwd (resolving
 * relative paths against workdir when given), ~-relative when under home,
 * otherwise the basename only.
 */
export function relativeTarget(value, { cwd, workdir, home } = {}) {
  if (typeof value !== "string" || !value) return undefined;
  let candidate = value.replace(/^["']|["']$/g, "");
  if (!candidate) return undefined;
  let result;
  if (candidate.startsWith("~")) {
    result = candidate;
  } else if (path.posix.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
    result = relativeToRoots(normalized, cwd, home);
  } else {
    const normalized = path.posix.normalize(candidate);
    if (workdir && cwd && workdir !== cwd) {
      const absolute = path.posix.normalize(path.posix.join(workdir, normalized));
      result = relativeToRoots(absolute, cwd, home);
    } else {
      result = normalized.startsWith("./") ? normalized.slice(2) : normalized;
    }
  }
  if (!result) return undefined;
  return result.length > MAX_TARGET_LENGTH ? result.slice(0, MAX_TARGET_LENGTH - 1) + "…" : result;
}

function relativeToRoots(absolute, cwd, home) {
  if (cwd && (absolute === cwd || absolute.startsWith(cwd.endsWith("/") ? cwd : cwd + "/"))) {
    return path.posix.relative(cwd, absolute) || ".";
  }
  if (home && (absolute === home || absolute.startsWith(home.endsWith("/") ? home : home + "/"))) {
    return "~/" + path.posix.relative(home, absolute);
  }
  return path.posix.basename(absolute);
}

/** Extract `*** Update|Add|Delete File: <path>` targets from an apply_patch body (raw or JSON-escaped). */
export function patchTargets(text, context = {}) {
  const files = [];
  const re = /\*\*\* (?:Update|Add|Delete|Move to) File: ([^\n"\\]+)/g;
  let match;
  while ((match = re.exec(text))) {
    const target = relativeTarget(match[1].trim(), context);
    if (target && !files.includes(target)) files.push(target);
  }
  if (!files.length) return {};
  return { target: files[0], files: files.length };
}

/**
 * Find `"key": <string literal>` (or `key: <literal>`) after `from` in a JS
 * snippet and return the decoded literal. Handles "…", '…' and `…` with
 * backslash escapes; returns null when absent.
 */
export function extractStringProperty(script, key, from = 0) {
  const re = new RegExp(`(?:"${key}"|'${key}'|\\b${key})\\s*:\\s*`, "g");
  re.lastIndex = from;
  const match = re.exec(script);
  if (!match) return null;
  let i = match.index + match[0].length;
  const quote = script[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let j = i + 1;
  let out = "";
  while (j < script.length) {
    const ch = script[j];
    if (ch === "\\" && j + 1 < script.length) {
      const next = script[j + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(script.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(script.slice(j + 2, j + 6), 16)); j += 4; }
      else out += next;
      j += 2;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
    j += 1;
  }
  return out;
}

/** Remove heredoc bodies (`<<EOF` ... `EOF`) so their lines are not parsed as commands. */
export function stripHeredocs(command) {
  let out = "";
  let rest = command;
  for (;;) {
    const match = rest.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/);
    if (!match) return out + rest;
    const delimiter = match[1] ?? match[2] ?? match[3];
    const lineEnd = rest.indexOf("\n", match.index + match[0].length);
    if (lineEnd < 0) return out + rest;
    out += rest.slice(0, lineEnd);
    const body = rest.slice(lineEnd + 1);
    const terminator = new RegExp(`^\\t*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m");
    const end = body.match(terminator);
    rest = end ? body.slice(end.index + end[0].length) : "";
  }
}

/** Split a shell command on &&, ||, ;, | and newlines outside quotes. */
export function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote !== "'" && i + 1 < command.length) { current += command[i + 1]; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; current += ch; continue; }
    if (ch === "\\" && i + 1 < command.length) { current += ch + command[i + 1]; i += 1; continue; }
    if (ch === "(" || ch === "{") depth += 1;
    if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const op = SEGMENT_OPERATORS.find((candidate) => command.startsWith(candidate, i));
      if (op) { segments.push(current); current = ""; i += op.length - 1; continue; }
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Whitespace tokenizer that keeps quoted spans together and strips the quotes. */
export function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hadQuote = false;
  const flush = () => { if (current.length || hadQuote) tokens.push(current); current = ""; hadQuote = false; };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote !== "'" && i + 1 < segment.length) { current += segment[i + 1]; i += 1; continue; }
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; hadQuote = true; continue; }
    if (ch === "\\" && i + 1 < segment.length) { current += segment[i + 1]; i += 1; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === ">" || ch === "<") {
      // Redirection operator token: [fd]>, [fd]>>, [fd]>&fd, <, <<; keep it whole so `2>&1` is never a write target.
      if (!/^\d?$/.test(current)) flush();
      current += ch;
      if (segment[i + 1] === ch) { current += ch; i += 1; }
      if (segment[i + 1] === "&") { current += "&"; i += 1; while (/\d/.test(segment[i + 1] ?? "")) { current += segment[i + 1]; i += 1; } }
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/** Truncation and error markers in Codex tool output text (docs/format-codex.md section 5.1). */
export function inspectToolOutput(text, estTokens = 0) {
  const result = {};
  if (typeof text !== "string" || !text) return result;
  const head = text.slice(0, 600);
  const warning = head.match(/Warning: truncated output \(original token count: (\d+)\)/);
  if (warning) { result.truncated = true; result.originalTokens = Number(warning[1]); }
  let omitted = 0;
  for (const match of text.matchAll(/…(\d+) tokens truncated…/g)) omitted += Number(match[1]);
  for (const match of text.matchAll(/<truncated omitted_approx_tokens=(\d+)>/g)) omitted += Number(match[1]);
  if (omitted > 0) { result.truncated = true; result.omittedTokens = omitted; }
  const original = head.match(/^Original token count: (\d+)$/m);
  if (original) {
    const count = Number(original[1]);
    if (result.originalTokens === undefined) result.originalTokens = count;
    if (!result.truncated && estTokens > 0 && count > estTokens * 2 + 200) result.truncated = true;
  }
  if (/^Script failed/m.test(head) || /^Process exited with code [1-9]\d*/m.test(head) || /^collab tool failed/.test(head)) result.isError = true;
  return result;
}
