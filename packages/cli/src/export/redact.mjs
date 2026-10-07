/**
 * Label redaction for exports (`--redact-labels`, ADR-004 fix wave 2; names
 * policy ADR-005 section 7).
 *
 * Every user-authored or path-derived label becomes `h:` + 10 hex of a salted
 * sha1, so a reader can still see that two blocks name the same file without
 * learning the file name. The salt is drawn per export and stored as
 * `redaction.salt`: hashes are consistent inside one document and useless as
 * a dictionary across documents. Ids, hashes and numbers are untouched.
 *
 * Names policy (`redaction.names: "vendor-only"`): vendor vocabulary stays
 * readable, everything user-authored is hashed.
 *   readable  built-in tool names (BUILTIN_TOOLS: `Read`, `Bash`, `exec`, …),
 *             vendor agent types (BUILTIN_AGENT_TYPES: `Explore`, `Plan`,
 *             `general-purpose`, …), hook event names (HOOK_EVENTS), model
 *             ids, instruction-file vocabulary (`CLAUDE.md`, `.claude/agents/*.md`)
 *   hashed    MCP server and tool names (`mcp__<server>__<tool>` becomes
 *             `mcp__h:xxxx__h:yyyy`, `tool.server` becomes `h:xxxx`; equal names
 *             stay equal), custom agent types, skill names, hook matchers
 *             (`hook_success:SessionStart:<matcher>` keeps its event), branch
 *             names, `scope.description`, every path-like label
 *
 * Three passes:
 *   1. labels: `block.label`, `block.tool.target`, `topBlocks[].label`,
 *      `scope.description`, `scope.source.file`, evidence `ref` / `label` of
 *      file, block and scope kinds, `fix.path`, `project.displayName` /
 *      `project.key` / `project.cwdDisplay`, `run.source.file`, `gitBranch`,
 *      `run.instructionFilesObserved`; labels are collected from EVERY scope of
 *      the run (the caller passes the ones it did not export) so a child-scope
 *      path quoted in a finding is rewritten too;
 *   2. names: `block.tool.name` / `.server` / `.subtool`, `scope.agentType`,
 *      `topBlocks[].tool`, `toolCost[].name` / `.server` (scope and summary),
 *      `run.mcpToolsObserved`, `run.dynamicTools` through `redactName`;
 *   3. prose: every remaining occurrence of a collected label or user-authored
 *      name, then every path-like token (a slash between name characters, or a
 *      file extension) in finding prose (`title`, `whyItMatters`, `fix.summary`,
 *      `fix.snippet`) and in evidence labels of every kind.
 *
 * `findPathLikeTokens(doc)` is the gate: after redaction no path-like token
 * may survive anywhere in the document, the markdown included.
 */
import { createHash, randomBytes } from "node:crypto";

export function newSalt() {
  return randomBytes(16).toString("hex");
}

export function hashLabel(value, salt = "") {
  return `h:${createHash("sha1").update(`${salt} ${String(value)}`).digest("hex").slice(0, 10)}`;
}

const HASHED = /^h:[0-9a-f]{10}$/;
const REDACTED_EVIDENCE_KINDS = new Set(["file", "block", "scope"]);
const MIN_PROSE_LABEL = 4;
const MIN_PROSE_NAME = 3;

/** Instruction-file and config vocabulary: the product's words, not secrets. */
const VOCABULARY = [
  /^(?:~\/\.claude\/|~\/\.codex\/|~\/\.gemini\/|\.claude\/|\.codex\/)?(?:CLAUDE|AGENTS|GEMINI)(?:\.local)?\.md$/,
  /^(?:~\/)?\.claude\/(?:agents|rules)\/[A-Za-z0-9._<>*:-]+\.md$/,  // `:` so an already-hashed file name stays vocabulary
  /^(?:~\/)?\.claude\/(?:agents|rules)\/?$/,
  /^(?:~\/)?\.claude\/settings(?:\.local)?\.json$/,
  /^~\/\.claude\.json$/,
  /^(?:~\/)?\.codex\/config\.toml$/,
  /^\.mcp\.json$/,
  /^\.contextscope\.json$/,
  /^~\/\.contextscope\/[A-Za-z0-9._/-]*$/,
  /^@?contextscope(?:[./][A-Za-z0-9._/-]*)?$/,
];

/**
 * Built-in tool names of the vendors (Claude Code tools, Codex function and
 * exec subtools). Anything else named as a tool is user-authored (an MCP tool,
 * a custom function) and is hashed under `--redact-labels`.
 */
export const BUILTIN_TOOLS = new Set([
  // Claude Code
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "Bash", "BashOutput", "KillShell", "Monitor", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Agent", "Task", "Skill", "TodoWrite", "TodoRead", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ToolSearch",
  "SlashCommand", "SendMessage", "TaskStop", "TaskOutput", "EnterWorktree", "ExitWorktree", "Artifact", "ListMcpResourcesTool", "ReadMcpResourceTool", "PowerShell",
  // Codex
  "exec", "exec_command", "shell", "shell_command", "local_shell", "apply_patch", "write_stdin", "wait", "update_plan", "view_image", "read_file",
  "web_search", "web_search_call", "spawn_agent", "wait_agent", "send_message", "list_agents", "interrupt_agent", "followup_task", "close_agent",
  "resume_agent", "kill_agent", "js", "function",
]);
/** Vendor agent types (Claude Code built-ins); `.claude/agents/*.md` types are user-authored and hashed. */
export const BUILTIN_AGENT_TYPES = new Set(["Explore", "Plan", "general-purpose", "Bash", "claude-code-guide", "statusline-setup"]);
/** Hook event names (Claude Code hooks reference); readable, their matchers are not. */
export const HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SubagentStart", "SubagentStop",
  "PreCompact", "PostCompact", "InstructionsLoaded", "PermissionRequest", "ConfigChange", "Elicitation", "ElicitationResult", "WorktreeCreate", "WorktreeRemove",
  "TeammateIdle", "TaskCompleted", "FileChanged", "CwdChanged",
]);
/** Matcher values the vendor defines (SessionStart / PreCompact sources, the catch-all); a user's own matcher is hashed. */
const VENDOR_MATCHERS = new Set(["startup", "resume", "clear", "compact", "manual", "auto", "*"]);
const HOOK_LABEL = /^(hook_(?:success|system_message|cancelled|error|failure)):(.+)$/;
/** Row names of the per-tool cost table and adapter block labels that are the product's or the vendor's own words. */
const COST_VOCABULARY = new Set(["Agent handoffs", "other", "attachment", "skill", "skills", "skills_instructions", "user_instructions", "environment_context", "agents_md", "role_prompt", "base_instructions"]);
/** Claude attachment types and Codex developer tags (adapters): vendor vocabulary. */
const ATTACHMENT_TYPES = new Set([
  "hook_success", "hook_system_message", "hook_cancelled", "hook_error", "hook_failure", "total_tokens_reminder", "nested_memory", "file", "directory", "skill_listing",
  "task_reminder", "command_permissions", "queued_command", "edited_text_file", "read_truncation_notice", "deferred_tools_delta", "agent_listing_delta",
  "mcp_instructions_delta", "invoked_skills", "compact_file_reference", "task_notification", "meta", "unknown", "prompt", "assistant", "thinking",
  "permissions_instructions", "apps_instructions", "plugins_instructions", "collaboration_mode", "multi_agent_mode", "app_context", "app-context", "turn_aborted", "model_switch", "recommended_plugins", "in_app_browser_context", "image",
  "compaction summary", "agent result", "agent launched", "task notification",
]);
const VENDOR_PREFIX = /^(?:meta|task):/;

/** Prose words that carry a slash without naming a file. */
const PROSE_WORDS = new Set(["head/tail", "offset/limit", "and/or", "read/write", "input/output", "on/off", "yes/no", "start/stop", "pre/post", "tool_use/tool_result", "user/assistant", "w/", "w/o", "i/o", "n/a"]);
const EXTENSION = /\.(?:md|mdx|markdown|rst|json|jsonl|json5|jsonc|ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|fish|ps1|bat|yml|yaml|toml|ini|cfg|conf|env|txt|csv|tsv|sql|html|htm|css|scss|sass|less|xml|lock|log|pdf|png|jpe?g|gif|svg|webp|ico|gz|zip|tar|tgz|prisma|graphql|gql|proto|vue|svelte|astro|tf|tfvars|dart|scala|ex|exs|erl|hs|lua|pl|pm|r|sol|wasm|map|snap|ipynb|tex|bib|dockerfile|gradle|properties|plist|xcconfig|pbxproj|storyboard|xib|mdc|cursorrules)$/i;
const SLASHED = /[A-Za-z0-9_.~)\]-]\/[A-Za-z0-9_.~([-]/;
const TOKEN = /[^\s"'`()[\]{}|,;]+/g;
const TRAILING = /[.,:;!?]+$/;

export function isVocabulary(token) {
  return VOCABULARY.some((pattern) => pattern.test(token));
}

/** Vendor vocabulary for names: built-in tools, vendor agent types, hook events, cost-table words. */
export function isVendorName(value) {
  return BUILTIN_TOOLS.has(value) || BUILTIN_AGENT_TYPES.has(value) || HOOK_EVENTS.has(value) || COST_VOCABULARY.has(value) || ATTACHMENT_TYPES.has(value) || VENDOR_PREFIX.test(value);
}

/** Parses `mcp__<server>__<tool>`; `{ server, tool }` or null. */
function parseMcp(value) {
  if (typeof value !== "string" || !value.startsWith("mcp__")) return null;
  const rest = value.slice(5);
  if (!rest) return null;
  const split = rest.indexOf("__");
  return split < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/** True when the value is user-authored under the names policy (would change under `redactName`). */
export function isUserName(value) {
  return typeof value === "string" && value.length > 0 && redactName(value, "") !== value;
}

/**
 * Names policy: vendor vocabulary and instruction-file vocabulary come back
 * unchanged; `mcp__<server>__<tool>` becomes `mcp__h:xxxx__h:yyyy`;
 * `hook_success:<Event>:<matcher>` keeps its event and hashes a user matcher;
 * anything else is hashed. Already-hashed values are left alone.
 */
export function redactName(value, salt) {
  if (typeof value !== "string" || !value) return value;
  if (HASHED.test(value) || isVocabulary(value) || isVendorName(value)) return value;
  const part = (text) => (HASHED.test(text) ? text : hashLabel(text, salt));
  const mcp = parseMcp(value);
  if (mcp) return `mcp__${part(mcp.server)}${mcp.tool ? `__${part(mcp.tool)}` : ""}`;
  const hook = HOOK_LABEL.exec(value);
  if (hook) {
    const [, type, rest] = hook;
    const colon = rest.indexOf(":");
    const event = colon < 0 ? rest : rest.slice(0, colon);
    const matcher = colon < 0 ? "" : rest.slice(colon + 1);
    const eventOut = HOOK_EVENTS.has(event) ? event : part(event);
    if (!matcher) return `${type}:${eventOut}`;
    const matcherOut = VENDOR_MATCHERS.has(matcher) || BUILTIN_TOOLS.has(matcher) ? matcher : parseMcp(matcher) ? redactName(matcher, salt) : part(matcher);
    return `${type}:${eventOut}:${matcherOut}`;
  }
  return hashLabel(value, salt);
}

/**
 * True for a token that could name a file or a directory: a slash between
 * name characters (`src/x`, `~/projects/acme`, `/Users/me`) or a known file
 * extension (`package.json`, `x.ts`). Hashes, vocabulary, templates
 * (`<topic>`, `*`) and pure ratios (`3/4`) are not path-like.
 */
export function isPathLikeToken(token) {
  const core = String(token).replace(TRAILING, "");
  if (core.length < 2 || HASHED.test(core)) return false;
  if (/-Users-|-home-/.test(core)) return true; // the encoded Claude project-directory form
  if (core.includes("<") || core.includes(">") || core.includes("*")) return false;
  if (isVocabulary(core) || PROSE_WORDS.has(core.toLowerCase())) return false;
  if (SLASHED.test(core)) return !/^[\d/.,%-]+$/.test(core);
  return EXTENSION.test(core) && /[A-Za-z]/.test(core.slice(0, core.lastIndexOf(".")));
}

/** Path-like labels (a slash, a dot or a space): the ones that can name a file or a command. */
export function isPathLike(label) {
  return typeof label === "string" && label.length >= MIN_PROSE_LABEL && /[/.\s]/.test(label);
}

/** Replaces every path-like token of `text` with its hash. */
export function scrubTokens(text, salt) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(TOKEN, (token) => {
    if (!isPathLikeToken(token)) return token;
    const trailing = TRAILING.exec(token)?.[0] ?? "";
    return hashLabel(token.slice(0, token.length - trailing.length), salt) + trailing;
  });
}

/** Every string in `value` that still carries a path-like token, as `{ path, token }`. */
export function findPathLikeTokens(value, where = "", out = [], depth = 0) {
  if (depth > 64) return out;
  if (typeof value === "string") {
    for (const token of value.match(TOKEN) ?? []) if (isPathLikeToken(token)) { out.push({ path: where || "$", token: token.replace(TRAILING, "") }); break; }
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { value.forEach((item, i) => findPathLikeTokens(item, `${where}[${i}]`, out, depth + 1)); return out; }
  for (const [key, nested] of Object.entries(value)) findPathLikeTokens(nested, where ? `${where}.${key}` : key, out, depth + 1);
  return out;
}

/**
 * Every user-authored name of a document that must not survive redaction:
 * MCP tool names and their server / tool parts, custom agent types, skill
 * names (skill blocks and `Skill` targets), hook matchers, custom tool names.
 * Tests use it to prove nothing leaked; `redactExport` uses it for the prose pass.
 */
export function collectUserNames(value, out = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 64) return out;
  if (Array.isArray(value)) { for (const item of value) collectUserNames(item, out, depth + 1); return out; }
  const addName = (name) => {
    if (typeof name !== "string" || !name || !isUserName(name)) return;
    const mcp = parseMcp(name);
    if (mcp) { out.add(name); if (mcp.server) out.add(mcp.server); if (mcp.tool) out.add(mcp.tool); return; }
    const hook = HOOK_LABEL.exec(name);
    if (hook) {
      const rest = hook[2];
      const colon = rest.indexOf(":");
      const event = colon < 0 ? rest : rest.slice(0, colon);
      const matcher = colon < 0 ? "" : rest.slice(colon + 1);
      if (!HOOK_EVENTS.has(event)) out.add(event);
      if (matcher && isUserName(matcher)) out.add(matcher);
      return;
    }
    out.add(name);
  };
  if (typeof value.agentType === "string") addName(value.agentType);
  if (value.tool && typeof value.tool === "object") {
    addName(value.tool.name);
    addName(value.tool.server);
    addName(value.tool.subtool);
    if (value.tool.name === "Skill" || value.tool.kind === "skill") addName(value.tool.target);
  }
  if (typeof value.tool === "string") addName(value.tool); // topBlocks[].tool
  if (value.category === "skills" && typeof value.label === "string") addName(value.label);
  if (typeof value.label === "string" && HOOK_LABEL.test(value.label)) addName(value.label);
  if (Array.isArray(value.mcpToolsObserved)) for (const name of value.mcpToolsObserved) addName(name);
  if (Array.isArray(value.dynamicTools)) for (const name of value.dynamicTools) addName(name);
  for (const row of Array.isArray(value.toolCost) ? value.toolCost : []) { if (row && typeof row === "object") { addName(row.name); addName(row.server); } }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "toolCost" || key === "mcpToolsObserved" || key === "dynamicTools" || key === "tool") continue;
    collectUserNames(nested, out, depth + 1);
  }
  return out;
}

/** Adds every label of a scope (blocks, tool targets, top blocks, description, source file) to `seen`. */
export function collectScopeLabels(scope, seen) {
  if (!scope || typeof scope !== "object") return seen;
  const add = (value) => { if (typeof value === "string" && value) seen.add(value); };
  add(scope.description);
  add(scope.source?.file);
  for (const block of scope.blocks ?? []) { add(block.label); add(block.tool?.target); }
  for (const top of scope.topBlocks ?? []) add(top.label);
  return seen;
}

function redactToolCost(rows, salt) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    if (row.name !== undefined) row.name = redactName(row.name, salt);
    if (row.server !== undefined) row.server = redactName(row.server, salt);
  }
}

function redactScope(scope, seen, salt) {
  if (!scope || typeof scope !== "object") return;
  const take = (value) => { if (typeof value === "string" && value) { seen.add(value); return redactName(value, salt); } return value; };
  if (scope.description !== undefined) scope.description = take(scope.description);
  if (scope.source?.file !== undefined) scope.source.file = take(scope.source.file);
  if (scope.agentType !== undefined) scope.agentType = redactName(scope.agentType, salt);
  for (const block of scope.blocks ?? []) {
    if (block.label !== undefined) block.label = take(block.label);
    if (block.tool) {
      if (block.tool.target !== undefined) block.tool.target = take(block.tool.target);
      if (block.tool.name !== undefined) block.tool.name = redactName(block.tool.name, salt);
      if (block.tool.server !== undefined) block.tool.server = redactName(block.tool.server, salt);
      if (block.tool.subtool !== undefined) block.tool.subtool = redactName(block.tool.subtool, salt);
    }
  }
  for (const top of scope.topBlocks ?? []) {
    if (top.label !== undefined) top.label = take(top.label);
    if (top.tool !== undefined) top.tool = redactName(top.tool, salt);
  }
  redactToolCost(scope.toolCost, salt);
}

/**
 * `.claude/agents/<name>.md` and `.claude/rules/<name>.md`: the convention is
 * the product's word and stays; the file name is the user's and hashes unless
 * it names a vendor built-in (`Explore.md`).
 */
const CONVENTION_PATH = /^((?:~\/)?\.claude\/(?:agents|rules)\/)([A-Za-z0-9._<>*-]+)\.md$/;
export function redactConventionPath(value, salt) {
  const match = typeof value === "string" ? CONVENTION_PATH.exec(value) : null;
  if (!match) return null;
  const name = match[2];
  return isVendorName(name) ? value : `${match[1]}${hashLabel(name, salt)}.md`;
}

function redactFinding(finding, seen, salt) {
  const take = (value) => { if (typeof value === "string" && value) { seen.add(value); return redactName(value, salt); } return value; };
  for (const evidence of finding.evidence ?? []) {
    if (!REDACTED_EVIDENCE_KINDS.has(evidence.kind)) continue;
    if (evidence.kind === "file" && evidence.ref !== undefined) evidence.ref = take(evidence.ref);
    if (evidence.label !== undefined) evidence.label = take(evidence.label);
  }
  if (finding.fix?.path !== undefined) {
    const convention = redactConventionPath(finding.fix.path, salt);
    if (convention !== null) { seen.add(finding.fix.path); finding.fix.path = convention; }
    else finding.fix.path = take(finding.fix.path);
  }
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites the findings' prose and evidence labels of every kind: first the
 * collected path-like labels (one alternation, longest first), then the
 * collected user-authored names (word-bounded, longest first), then any
 * path-like token that remains.
 */
function scrubProse(findings, seen, names, salt) {
  const labels = [...seen].filter((label) => isPathLike(label) && !isVocabulary(label)).sort((a, b) => b.length - a.length);
  const alternation = labels.length ? new RegExp(labels.map(escapeRegExp).join("|"), "g") : null;
  const words = [...names].filter((name) => name.length >= MIN_PROSE_NAME && !isPathLike(name)).sort((a, b) => b.length - a.length);
  const nameAlternation = words.length ? new RegExp(`(?<![A-Za-z0-9_-])(?:${words.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`, "g") : null;
  const apply = (value) => {
    if (typeof value !== "string" || !value) return value;
    // Instruction-file vocabulary stays readable (`CLAUDE.md`,
    // `.claude/agents/Explore.md`) unless the file name itself carries a
    // user-authored name, which hashes like every other one.
    if (isVocabulary(value)) return redactConventionPath(value, salt) ?? value;
    let replaced = alternation ? value.replace(alternation, (label) => hashLabel(label, salt)) : value;
    if (nameAlternation) replaced = replaced.replace(nameAlternation, (name) => redactName(name, salt));
    return scrubTokens(replaced, salt);
  };
  for (const finding of findings) {
    finding.title = apply(finding.title);
    finding.whyItMatters = apply(finding.whyItMatters);
    if (finding.fix) {
      finding.fix.summary = apply(finding.fix.summary);
      if (finding.fix.snippet !== undefined) finding.fix.snippet = apply(finding.fix.snippet);
      if (finding.fix.path !== undefined) finding.fix.path = apply(finding.fix.path);
    }
    for (const evidence of finding.evidence ?? []) {
      if (evidence.label !== undefined) evidence.label = apply(evidence.label);
      if (evidence.kind === "file" && evidence.ref !== undefined) evidence.ref = apply(evidence.ref);
    }
  }
}

/**
 * Redacts an export document in place and sets `redaction` to
 * `{ labels: "sha1-10", project: "hashed", names: "vendor-only", salt }`.
 * `extraScopes` are scopes of the run that are not part of the document
 * (their labels and names are collected so the prose pass knows them).
 * Returns the set of plain labels that were seen (tests use it to prove
 * nothing leaked).
 */
export function redactExport(doc, { salt = newSalt(), extraScopes = [] } = {}) {
  const seen = new Set();
  const run = doc.run;
  const names = collectUserNames({ run, scopes: doc.scopes, extraScopes });
  for (const scope of extraScopes) collectScopeLabels(scope, seen);
  if (run?.project) {
    const project = run.project;
    for (const key of ["displayName", "key", "cwdDisplay"]) if (typeof project[key] === "string" && project[key]) { seen.add(project[key]); project[key] = hashLabel(project[key], salt); }
    project.cwdHash = project.cwdHash ?? project.key;
  }
  if (run?.source?.file) { seen.add(run.source.file); run.source.file = hashLabel(run.source.file, salt); }
  if (run?.gitBranch) { seen.add(run.gitBranch); run.gitBranch = hashLabel(run.gitBranch, salt); }
  if (Array.isArray(run?.instructionFilesObserved)) run.instructionFilesObserved = run.instructionFilesObserved.map((file) => { if (typeof file === "string" && file) { seen.add(file); return redactName(file, salt); } return file; });
  if (Array.isArray(run?.mcpToolsObserved)) run.mcpToolsObserved = run.mcpToolsObserved.map((name) => redactName(name, salt));
  if (Array.isArray(run?.dynamicTools)) run.dynamicTools = run.dynamicTools.map((name) => redactName(name, salt));
  for (const scope of run?.scopes ?? []) redactScope(scope, seen, salt);
  for (const top of run?.summary?.topBlocks ?? []) {
    if (top.label !== undefined) { seen.add(top.label); top.label = redactName(top.label, salt); }
    if (top.tool !== undefined) top.tool = redactName(top.tool, salt);
  }
  redactToolCost(run?.summary?.toolCost, salt);
  for (const scope of Object.values(doc.scopes ?? {})) redactScope(scope, seen, salt);
  for (const finding of run?.findings ?? []) redactFinding(finding, seen, salt);
  scrubProse(run?.findings ?? [], seen, names, salt);
  doc.redaction = { labels: "sha1-10", project: "hashed", names: "vendor-only", salt };
  return seen;
}
