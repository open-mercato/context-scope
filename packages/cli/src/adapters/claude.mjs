/**
 * Claude Code session adapter (ADR-001 sections 3, 3.1, 3.2, 5.3, 5.5;
 * format facts from docs/format-claude-code.md; shapes from src/ir/types.ts).
 *
 * parseClaudeSession(mainFile) streams the main transcript, then every
 * <session>/subagents/agent-*.jsonl (+ .meta.json) as child scopes, builds
 * requests (one per assistant `message.id`, usage deduped across streamed
 * chunks), blocks (sizes + sha1 hashes only, never content), compactions and
 * subagent links, and returns finalizeRun(run).
 *
 * Privacy: no message text, tool output, prompt text, file contents or
 * absolute paths outside `~` enter the Run. Labels are tool names, attachment
 * types, skill names, or repo-relative paths.
 *
 * Deviations from the contract / format doc, all verified on local data:
 * - `total_tokens_reminder` is NOT a context-window signal: it starts at
 *   exactly 15,000,000 and `ctx + remaining` drifts by the cumulative output
 *   tokens, so it is a per-session token budget. It is recorded as
 *   `run.tokenBudget` (extra field) and never used for the window.
 * - The compaction summary record carries both `isCompactSummary` and
 *   `isVisibleInTranscriptOnly`; it is the new context base and is kept as a
 *   `compaction_summary` block. Every other `isVisibleInTranscriptOnly`
 *   record is excluded (counted in `coverage.transcriptOnlyRecordsSkipped`).
 * - Skill bodies (the isMeta user record after a Skill tool_result) arrive as
 *   either a string or a text-block array; both are handled.
 * - `<task-notification>` records whose `<task-id>` is not a known agent id
 *   (Monitor / background Bash tasks) are `attachments` blocks with
 *   attachmentType "task_notification", not handoffs. A notification whose id
 *   becomes a known agent only later in the parse (a launch seen after the
 *   delivery) is promoted to a handoff at the end (pending map).
 * - Handoff delivery paths (ADR-003 section 9, verified on 216 local sessions):
 *   478 agent notifications are standalone `user` records; 106 arrive as an
 *   `attachment` of type `queued_command` with `commandMode:
 *   "task-notification"` (absorbed mid-turn while the parent was busy, the
 *   `queue-operation` records say `absorbed_mid_turn`); 4 agents got both.
 *   Both paths are `subagent_handoff` blocks; the attachment path carries
 *   `via: "attachment"`. A notification embedded in a `tool_result` (a
 *   blocking TaskOutput/Bash returning while the agent finished) is split out
 *   of the result as its own block with `via: "tool_result"` and the rest of
 *   the text stays the tool result; 0 occurrences in the local corpus, covered
 *   by a synthetic fixture only.
 * - `tool.partial`: a `Read` with `limit` or an `offset` past the first line,
 *   or a Bash read through `sed -n` / `head` / `tail` / `rg -m` (argv parsing
 *   shared with the Codex adapter, claude-tools.mjs `partialReadOf`).
 * - Bash `tool.kind` / `tool.target` (ADR-005 section 4): `cat path` is a
 *   `file` read of `path`, `rg foo src` a `search`, a redirect or heredoc write
 *   an `edit`, `curl` a `web` fetch (claude-tools.mjs `classifyBashCommand`);
 *   the tool name stays `Bash` and the result category stays
 *   `tool_result.shell`, so the chart says what the model saw and the kind
 *   says which fix family (H-01, H-02, H-07, B-01) the call belongs to.
 * - Sync (non-async) Agent results never occur in the local corpus (all 734
 *   launches are `async_launched`); the code path exists and is covered by a
 *   synthetic fixture only.
 * - `droppedTokens` for the 2nd+ compaction is the difference of consecutive
 *   `cumulativeDroppedTokens` (derived.exact); the first is observed.vendor.
 *
 * Compaction presence (backend review #2): blocks emitted since the previous
 * request but before a `compact_boundary` (the last assistant's tool_use, the
 * tool_result that answered it, attachments) have `firstRequest ===
 * compaction.atRequest` yet never enter the post-boundary window. They get an
 * empty presence window (lastRequest = atRequest - 1, droppedBy) unless their
 * record uuid is listed in `compactMetadata.preservedMessages.uuids` /
 * `allUuids`; preserved records stay, and a preserved pre-boundary record is
 * marked `preservedBy` so reconciliation keeps it visible after the boundary.
 *
 * Privacy of the project identity (backend review #1): `project.key` is
 * `projectKeyFor(cwd)` from src/ir/project.mjs (basename + 8 hex of sha1),
 * never the `-`-encoded directory name; `source.file` and every scope
 * `source.file` replace the encoded project-dir segment with that key.
 *
 * Sizes: tool results are the tool_result text the model sees (Read output
 * keeps its line-number prefixes; toolUseResult duplicates are not counted),
 * tool_use blocks are JSON.stringify(input), attachments are the payload
 * fields the model receives. Images count `imageTokens` each, not base64
 * size. Every estimator constant (bytes per token, per-block envelope, image
 * tokens, system baseline) lives in src/ir/calibration.json (ADR-002 F); this
 * file carries no numbers. Residual error that sizing cannot fix is named by
 * reconciliation v2 (`unlogged`, `baseChange`), not hidden.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJsonl } from "../ir/jsonl.mjs";
import { byteLength, detectBlockKind, detectKind, estimateTokens, imageTokensFor } from "../ir/estimate.mjs";
import { finalizeRun, roundWindow } from "../ir/finalize.mjs";
import { displaySessionFile, encodedProjectDirToKey, projectKeyFor } from "../ir/project.mjs";
import { classifyBashCommand, classifyTool, partialReadOf, TARGET_INPUT_KEYS } from "./claude-tools.mjs";

// v4 (ADR-005 section 4): Bash calls carry `tool.kind` / `tool.target` from the shared command parser.
export const CLAUDE_ADAPTER_VERSION = "claude-v5";

const MODELS = JSON.parse(fs.readFileSync(new URL("./claude-models.json", import.meta.url), "utf8"));
const VENDOR = "claude";
const MAX_DESCRIPTION = 80;

function calibratedTokens(text, kind, category) {
  return estimateTokens(text, kind, { vendor: VENDOR, category });
}

/** Session-state record types we know about and deliberately ignore (not model input). */
const KNOWN_STATE_TYPES = new Set([
  "queue-operation", "last-prompt", "mode", "ai-title", "permission-mode", "bridge-session", "pr-link",
  "atis-latch", "file-history-delta", "file-history-snapshot", "agent-name", "relocated", "worktree-state",
  "artifact-autoreact-ledger", "frame-link", "artifact-comment-monitor", "cost-state", "fork-context-ref",
  "summary", "progress", "compact",
]);

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

/** Context window for a model id from the table; ids containing "[1m]" are 1M. */
export function claudeWindowFor(model) {
  const id = String(model ?? "").toLowerCase();
  if (id.includes("[1m]")) return { value: 1_000_000, provenance: "estimated.local" };
  let best = null;
  for (const entry of MODELS.windows) {
    if (id.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return { value: best ? best.window : MODELS.default, provenance: "estimated.local" };
}

/** Reads <dir>/agent-*.meta.json and pairs each with its .jsonl. Returns [{ agentId, file, metaFile, meta }]. */
export async function readSubagentMeta(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (!match) continue;
    const agentId = match[1];
    const metaFile = path.join(dir, `agent-${agentId}.meta.json`);
    let meta = {};
    try { meta = JSON.parse(await fs.promises.readFile(metaFile, "utf8")); } catch { /* missing or corrupt meta: still a scope */ }
    out.push({ agentId, file: path.join(dir, name), metaFile, meta: meta && typeof meta === "object" ? meta : {} });
  }
  return out;
}

export async function parseClaudeSession(mainFilePath, { home = os.homedir(), instructionTokensEstimate = 0, thresholds } = {}) {
  const absolute = path.resolve(mainFilePath);
  const sessionId = path.basename(absolute, ".jsonl");
  const projectDir = path.dirname(absolute);
  const subagentDir = path.join(projectDir, sessionId, "subagents");
  const metas = await readSubagentMeta(subagentDir);
  const knownAgentIds = new Set(metas.map((m) => m.agentId));

  const coverage = { records: 0, unparsedRecords: 0, unparsedTypes: {}, ignoredTypes: {}, requests: 0, syntheticRecordsSkipped: 0, transcriptOnlyRecordsSkipped: 0, estimatorErrorMedian: 0, estimatorErrorP95: 0, adapterVersion: CLAUDE_ADAPTER_VERSION };
  const shared = { home, coverage, knownAgentIds, mcpTools: new Set(), tokenBudget: null, session: {} };

  const mainStat = await fs.promises.stat(absolute);
  const mainBuilders = await parseFile(absolute, { scopeId: "main", kind: "main", shared });
  const main = mainBuilders.get("main");
  const scopes = [main.toScope()];
  const inFileSidechains = [...mainBuilders.values()].filter((b) => b !== main);

  const childBuilders = [];
  for (const entry of metas) {
    let builders;
    try { builders = await parseFile(entry.file, { scopeId: entry.agentId, kind: "subagent", shared }); } catch { continue; }
    let stat = null;
    try { stat = await fs.promises.stat(entry.file); } catch { /* ignore */ }
    for (const builder of builders.values()) childBuilders.push({ builder, meta: builder.scopeId === entry.agentId ? entry.meta : {}, stat: builder.scopeId === entry.agentId ? stat : null, file: entry.file });
  }
  for (const builder of inFileSidechains) childBuilders.push({ builder, meta: {}, stat: null, file: absolute });

  const byId = new Map([["main", main]]);
  for (const child of childBuilders) byId.set(child.builder.scopeId, child.builder);
  for (const builder of byId.values()) builder.resolvePendingNotifications();

  const session = shared.session;
  const cwd = session.cwd ?? "";
  const projectKey = cwd ? projectKeyFor(cwd) : encodedProjectDirToKey(path.basename(projectDir));
  const displayFile = (file) => displaySessionFile(file, { home, projectDir, projectKey });

  for (const { builder, meta, stat, file } of childBuilders) {
    const scope = builder.toScope();
    const parentId = meta.parentAgentId && byId.has(meta.parentAgentId) ? meta.parentAgentId : "main";
    const parent = byId.get(parentId);
    scope.agentType = meta.agentType;
    if (meta.description) scope.description = String(meta.description).slice(0, MAX_DESCRIPTION);
    scope.parentScopeId = parentId;
    scope.depth = Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : (parent.depth ?? 0) + 1;
    const launch = (meta.toolUseId && parent.agentLaunches.get(meta.toolUseId)) ?? parent.launchesByAgent.get(builder.scopeId) ?? findLaunch(byId, builder.scopeId, meta.toolUseId);
    if (launch) { scope.launchedAtRequest = launch.requestIndex; scope.launchedAt = launch.at; }
    const handoff = parent.handoffs.get(builder.scopeId) ?? findHandoff(byId, builder.scopeId);
    if (handoff) {
      scope.deliveredAtRequest = handoff.requestIndex;
      scope.deliveredAt = handoff.at;
      scope.status = "completed";
      scope.handoff = { blockId: handoff.blockId, tokens: { value: handoff.estTokens, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } };
    } else {
      scope.status = "open";
    }
    if (stat) scope.source = { file: displayFile(file), bytes: stat.size };
    scopes.push(scope);
  }
  // Parents before children (depth order) so scopes[0] stays main and lanes nest predictably.
  const rest = scopes.slice(1).sort((a, b) => (a.depth - b.depth) || ((a.launchedAtRequest ?? 0) - (b.launchedAtRequest ?? 0)));
  scopes.splice(1, scopes.length - 1, ...rest);

  // Window: the largest table value over every model seen in any scope (a
  // session may start on Sonnet and switch to a 1M model); compaction
  // preTokens above the table value raise it to the next documented window.
  const modelsSeen = new Set(scopes.flatMap((scope) => scope.requests.map((request) => request.model)).filter(Boolean));
  let window = claudeWindowFor(main.requests[0]?.model ?? "");
  for (const model of modelsSeen) { const candidate = claudeWindowFor(model); if (candidate.value > window.value) window = candidate; }
  const maxPre = Math.max(0, ...scopes.flatMap((scope) => scope.compactions.map((c) => c.preTokens.value)));
  if (maxPre > window.value) window = roundWindow(maxPre);

  const run = {
    id: `claude:${sessionId}`,
    vendor: "claude",
    sessionId,
    project: {
      key: projectKey,
      displayName: cwd ? path.basename(cwd) : projectKey,
      cwdHash: sha1(cwd).slice(0, 12),
      cwdDisplay: cwd ? displayPath(cwd, home) : undefined,
    },
    startedAt: session.firstTs ?? "",
    endedAt: session.lastTs ?? "",
    activeMs: 0,
    cliVersion: session.version,
    gitBranch: session.gitBranch,
    entrypoint: session.entrypoint,
    window,
    scopes,
    summary: null,
    coverage,
    source: { file: displayFile(absolute), bytes: mainStat.size, mtimeMs: mainStat.mtimeMs, subagentFiles: metas.length },
    mcpToolsObserved: [...shared.mcpTools].sort(),
  };
  if (shared.tokenBudget) run.tokenBudget = shared.tokenBudget;
  return finalizeRun(run, { instructionTokensEstimate, thresholds });
}

function findLaunch(byId, agentId, toolUseId) {
  for (const builder of byId.values()) {
    const hit = (toolUseId && builder.agentLaunches.get(toolUseId)) ?? builder.launchesByAgent.get(agentId);
    if (hit) return hit;
  }
  return null;
}

function findHandoff(byId, agentId) {
  for (const builder of byId.values()) {
    const hit = builder.handoffs.get(agentId);
    if (hit) return hit;
  }
  return null;
}

/** "~/..." for paths under home; basename only otherwise (never an absolute path outside home). */
function displayPath(absolute, home) {
  if (!absolute) return "";
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) return "~" + absolute.slice(home.length).split(path.sep).join("/");
  return path.basename(absolute);
}

/** Repo-relative target for a tool call, or undefined when it is not under cwd. */
function relativeTarget(input, cwd) {
  if (!input || typeof input !== "object") return undefined;
  let raw;
  for (const key of TARGET_INPUT_KEYS) {
    if (typeof input[key] === "string" && input[key]) { raw = input[key]; break; }
  }
  if (!raw) return undefined;
  if (!path.isAbsolute(raw)) return raw.includes("..") ? undefined : raw;
  if (cwd && raw === cwd) return ".";
  if (cwd && raw.startsWith(cwd + path.sep)) return raw.slice(cwd.length + 1).split(path.sep).join("/");
  return undefined;
}

/**
 * Streams one transcript file and routes every record to a ScopeBuilder:
 * the file's own scope, or (for `isSidechain` records carrying a different
 * `agentId`) an in-file sidechain scope keyed by that agentId.
 */
async function parseFile(filePath, { scopeId, kind, shared }) {
  const builders = new Map();
  const builderFor = (id, scopeKind) => {
    let builder = builders.get(id);
    if (!builder) { builder = new ScopeBuilder(id, scopeKind, shared); builders.set(id, builder); }
    return builder;
  };
  builderFor(scopeId, kind);
  const { coverage } = shared;
  for await (const rec of readJsonl(filePath)) {
    coverage.records += 1;
    if (rec.error) { coverage.unparsedRecords += 1; bump(coverage.unparsedTypes, "<parse-error>"); continue; }
    const v = rec.value;
    const type = v && typeof v === "object" ? v.type : undefined;
    if (typeof type !== "string") { coverage.unparsedRecords += 1; bump(coverage.unparsedTypes, "<no-type>"); continue; }
    if (typeof v.timestamp === "string") {
      shared.session.firstTs = minTs(shared.session.firstTs, v.timestamp);
      shared.session.lastTs = maxTs(shared.session.lastTs, v.timestamp);
    }
    const conversation = type === "user" || type === "assistant" || type === "system" || type === "attachment";
    if (!conversation) {
      if (KNOWN_STATE_TYPES.has(type)) bump(coverage.ignoredTypes, type);
      else { coverage.unparsedRecords += 1; bump(coverage.unparsedTypes, type); }
      continue;
    }
    if (kind === "main" && !shared.session.cwd && v.cwd) {
      Object.assign(shared.session, { cwd: v.cwd, version: v.version, gitBranch: v.gitBranch, entrypoint: v.entrypoint });
    }
    const target = v.isSidechain && typeof v.agentId === "string" && v.agentId !== scopeId ? builderFor(v.agentId, "subagent") : builders.get(scopeId);
    target.handle(v, rec.bytes);
  }
  return builders;
}

function bump(map, key) { map[key] = (map[key] ?? 0) + 1; }
function minTs(a, b) { return !a || b < a ? b : a; }
function maxTs(a, b) { return !a || b > a ? b : a; }

class ScopeBuilder {
  constructor(scopeId, kind, shared) {
    this.scopeId = scopeId;
    this.kind = kind;
    this.shared = shared;
    this.requests = [];
    this.blocks = [];
    this.compactions = [];
    this.requestByKey = new Map();
    this.toolUses = new Map();          // tool_use id -> { name, input, requestIndex, at, argsHash }
    this.agentLaunches = new Map();     // Agent tool_use id -> { requestIndex, at, agentId? }
    this.launchesByAgent = new Map();   // agentId -> same
    this.handoffs = new Map();          // agentId -> { blockId, requestIndex, at, estTokens }
    this.humanPrompts = 0;
    this.seenPromptIds = new Set();
    this.pendingSkill = null;
    this.depth = kind === "main" ? 0 : 1;
    this.cumulativeDropped = 0;
    this.blocksByUuid = new Map();      // record uuid -> blocks it produced (compaction preservedMessages lookup)
    this.currentUuid = undefined;
    this.pendingNotifications = [];     // { block, taskId }: notifications whose task id was not a known agent when seen
  }

  get nextRequestIndex() { return this.requests.length; }

  get cwd() { return this.shared.session.cwd ?? ""; }

  handle(v, bytes) {
    this.currentUuid = typeof v.uuid === "string" ? v.uuid : undefined;
    switch (v.type) {
      case "assistant": return this.handleAssistant(v);
      case "user": return this.handleUser(v);
      case "system": return this.handleSystem(v);
      case "attachment": return this.handleAttachment(v);
      default: return undefined;
    }
  }

  addBlock({ at, category, content, estTokens, label, extra = {} }) {
    const text = typeof content === "string" ? content : "";
    const blockBytes = byteLength(text);
    // `extra.kind` is a caller's content-type verdict (a binary document read); the heuristic otherwise.
    const kind = extra.kind ?? detectKind(text);
    const seq = this.blocks.length;
    const block = {
      id: `${this.scopeId}:${seq}`,
      seq,
      at: at ?? "",
      category,
      bytes: blockBytes,
      estTokens: estTokens ?? calibratedTokens(text, kind, category),
      kind,
      ...extra,
      label,
      firstRequest: extra.firstRequest ?? this.nextRequestIndex,
      hash: sha1(text),
    };
    this.blocks.push(block);
    if (this.currentUuid) {
      const list = this.blocksByUuid.get(this.currentUuid);
      if (list) list.push(block); else this.blocksByUuid.set(this.currentUuid, [block]);
    }
    return block;
  }

  handleAssistant(v) {
    const message = v.message ?? {};
    const usage = message.usage ?? {};
    const model = message.model ?? "";
    if (model === "<synthetic>" || v.isApiErrorMessage) { this.shared.coverage.syntheticRecordsSkipped += 1; return; }
    const key = message.id ?? v.requestId ?? v.uuid;
    const input = usage.input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const thinking = usage.output_tokens_details?.thinking_tokens;
    const total = input + cacheCreation + cacheRead;
    let request = key !== undefined ? this.requestByKey.get(key) : undefined;
    if (request) {
      if (output > request.usage.output) request.usage.output = output;
      if (thinking !== undefined && thinking > (request.usage.thinking ?? 0)) request.usage.thinking = thinking;
    } else if (total > 0 || output > 0) {
      request = { index: this.nextRequestIndex, id: key, at: v.timestamp ?? "", model, turn: this.humanPrompts, usage: { input, cacheCreation, cacheRead, output, total } };
      if (thinking !== undefined) request.usage.thinking = thinking;
      this.requests.push(request);
      if (key !== undefined) this.requestByKey.set(key, request);
    } else {
      this.shared.coverage.syntheticRecordsSkipped += 1;
    }
    const firstRequest = request ? request.index + 1 : this.nextRequestIndex;
    const requestIndex = request ? request.index : this.nextRequestIndex;
    const content = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text") {
        this.addBlock({ at: v.timestamp, category: "assistant_text", content: item.text ?? "", label: "assistant", extra: { firstRequest } });
      } else if (item.type === "thinking" || item.type === "redacted_thinking") {
        this.addBlock({ at: v.timestamp, category: "assistant_thinking", content: item.thinking ?? item.data ?? "", label: "thinking", extra: { firstRequest } });
      } else if (item.type === "tool_use") {
        const name = String(item.name ?? "unknown");
        const argsJson = safeStringify(item.input);
        let { kind, server } = classifyTool(name);
        const argsHash = sha1(argsJson);
        let target = relativeTarget(item.input, this.cwd);
        let partial = partialReadOf(name, item.input);
        if (name === "Bash" && typeof item.input?.command === "string") {
          const command = classifyBashCommand(item.input.command, { cwd: this.cwd, home: this.shared.home });
          kind = command.kind;
          if (command.target) target = command.target;
          if (command.partial) partial = true;
        }
        const tool = { name, kind, argsHash };
        if (target) tool.target = target;
        if (server) { tool.server = server; this.shared.mcpTools.add(name); }
        if (partial) tool.partial = true;
        const block = this.addBlock({ at: v.timestamp, category: "tool_call", content: argsJson, label: target ?? name, extra: { firstRequest, tool, toolUseId: item.id } });
        this.toolUses.set(item.id, { name, requestIndex, at: v.timestamp, argsHash, blockId: block.id, target, server, kind, partial });
        if (kind === "agent") this.agentLaunches.set(item.id, { requestIndex, at: v.timestamp ?? "" });
        if (kind === "skill") this.pendingSkill = { name: typeof item.input?.skill === "string" ? item.input.skill : name, toolUseId: item.id };
      } else {
        this.addBlock({ at: v.timestamp, category: "other", content: safeStringify(item), label: String(item.type ?? "unknown"), extra: { firstRequest } });
      }
    }
  }

  handleUser(v) {
    const content = v.message?.content;
    if (v.isCompactSummary) {
      const text = contentText(content).text;
      const block = this.addBlock({ at: v.timestamp, category: "compaction_summary", content: text, label: "compaction summary" });
      const open = [...this.compactions].reverse().find((c) => !c.summaryBlockId);
      if (open) open.summaryBlockId = block.id;
      return;
    }
    if (v.isVisibleInTranscriptOnly) { this.shared.coverage.transcriptOnlyRecordsSkipped += 1; return; }
    const results = Array.isArray(content) ? content.filter((item) => item && item.type === "tool_result") : [];
    if (results.length) {
      for (const item of results) this.handleToolResult(v, item, results.length);
      return;
    }
    const { text, images } = contentText(content);
    const estTokens = images ? calibratedTokens(text, detectKind(text), "user") + images * imageTokensFor(VENDOR) : undefined;
    if (v.isMeta) {
      if (this.pendingSkill) {
        const skill = this.pendingSkill;
        this.pendingSkill = null;
        this.addBlock({ at: v.timestamp, category: "skills", content: text, estTokens, label: skill.name, extra: { toolUseId: skill.toolUseId } });
      } else {
        const tag = /^\s*<([a-z][a-z0-9_-]*)>/i.exec(text)?.[1];
        this.addBlock({ at: v.timestamp, category: "attachments", content: text, estTokens, label: tag ?? "meta", extra: { attachmentType: tag ? `meta:${tag}` : "meta" } });
      }
      return;
    }
    this.pendingSkill = null;
    const isNotification = v.origin?.kind === "task-notification" || /^\s*<task-notification>/.test(text);
    if (isNotification) {
      this.handleNotification(text, { at: v.timestamp, estTokens });
      return;
    }
    // Human prompt (typed, slash command echo, queued, coordinator/peer message).
    const promptId = typeof v.promptId === "string" ? v.promptId : null;
    if (!promptId || !this.seenPromptIds.has(promptId)) {
      this.humanPrompts += 1;
      if (promptId) this.seenPromptIds.add(promptId);
    }
    this.addBlock({ at: v.timestamp, category: "user", content: text, estTokens, label: "prompt" });
  }

  handleToolResult(v, item, siblings) {
    const use = this.toolUses.get(item.tool_use_id);
    const name = use?.name ?? "unknown";
    const classified = classifyTool(name);
    const { category, server } = classified;
    // The call's kind (a Bash `cat` is a file read) wins over the name's; the category stays the name's.
    const kind = use?.kind ?? classified.kind;
    let { text, images } = contentText(item.content);
    // A notification delivered inside a blocking tool's result: each notification span is its own block
    // (handoff when the task id is a known agent), the remaining text stays the tool result.
    const embedded = kind !== "agent" && text.includes("<task-notification>") ? splitNotifications(text) : null;
    if (embedded) text = embedded.remainder;
    const raw = v.toolUseResult;
    const isError = item.is_error === true || (typeof raw === "string" && raw.length > 0) || v.toolDenialKind !== undefined;
    const tool = { name, kind, argsHash: use?.argsHash ?? sha1("") };
    if (use?.target) tool.target = use.target;
    if (use?.partial) tool.partial = true;
    if (isError) tool.isError = true;
    if (server) tool.server = server;
    // Use toolUseResult only for metadata (file path, agent id); its content duplicates the tool_result text.
    if (!tool.target && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const filePath = raw.file?.filePath ?? raw.filePath;
      const target = relativeTarget({ file_path: filePath }, this.cwd);
      if (target) tool.target = target;
    }
    const label = tool.target ?? name;
    const extra = { tool, toolUseId: item.tool_use_id };
    // A PDF / image / office file read (`Read foo.pdf`, `cat logo.png`) reaches the model as a converted
    // document, not as the base64 the transcript carries: the text ratio overshoots by ~10x. Only when the
    // target's extension and the content agree (estimate-core.mjs `detectBinary`) is the block `binary`.
    const blockKind = detectBlockKind(text, { target: tool.target });
    if (blockKind === "binary") extra.kind = "binary";
    const estTokens = images ? calibratedTokens(text, blockKind, category) + images * imageTokensFor(VENDOR) : undefined;

    if (kind === "agent" && raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.agentId === "string") {
      const agentId = raw.agentId;
      this.shared.knownAgentIds.add(agentId);
      const launch = this.agentLaunches.get(item.tool_use_id) ?? { requestIndex: use?.requestIndex ?? this.nextRequestIndex, at: use?.at ?? v.timestamp ?? "" };
      launch.agentId = agentId;
      this.agentLaunches.set(item.tool_use_id, launch);
      this.launchesByAgent.set(agentId, launch);
      const async = raw.isAsync === true || raw.status === "async_launched";
      if (!async) {
        const block = this.addBlock({ at: v.timestamp, category: "subagent_handoff", content: text, estTokens, label: "agent result", extra: { ...extra, agentId } });
        if (!this.handoffs.has(agentId)) this.handoffs.set(agentId, { blockId: block.id, requestIndex: block.firstRequest, at: block.at, estTokens: block.estTokens });
        return;
      }
      this.addBlock({ at: v.timestamp, category: "tool_result.other", content: text, estTokens, label: "agent launched", extra: { ...extra, agentId } });
      return;
    }
    if (this.pendingSkill && (this.pendingSkill.toolUseId !== item.tool_use_id || isError)) this.pendingSkill = null;
    this.addBlock({ at: v.timestamp, category, content: text, estTokens, label, extra });
    for (const notification of embedded?.notifications ?? []) this.handleNotification(notification, { at: v.timestamp, via: "tool_result", extra: { toolUseId: item.tool_use_id } });
  }

  /**
   * One `<task-notification>` text: a `subagent_handoff` block when its task id is a known
   * agent, else a `task_notification` attachment remembered for `resolvePendingNotifications`.
   * `via` records a delivery path other than a standalone user record ("attachment" | "tool_result").
   */
  handleNotification(text, { at, estTokens, via, extra = {} } = {}) {
    const taskId = taskIdOf(text);
    const viaField = via ? { via } : {};
    if (taskId && this.isKnownAgent(taskId)) {
      const block = this.addBlock({ at, category: "subagent_handoff", content: text, estTokens, label: "task notification", extra: { ...extra, ...viaField, agentId: taskId } });
      this.noteHandoff(taskId, block);
      return block;
    }
    const taskType = /<task-type>\s*([^<\s]+)\s*<\/task-type>/.exec(text)?.[1];
    const block = this.addBlock({ at, category: "attachments", content: text, estTokens, label: taskType ? `task:${taskType}` : "task notification", extra: { ...extra, ...viaField, attachmentType: "task_notification" } });
    if (taskId) this.pendingNotifications.push({ block, taskId });
    return block;
  }

  noteHandoff(agentId, block) {
    if (!this.handoffs.has(agentId)) this.handoffs.set(agentId, { blockId: block.id, requestIndex: block.firstRequest, at: block.at, estTokens: block.estTokens });
  }

  /** Promotes notifications whose task id became a known agent after they were seen (same envelope category, so estTokens holds). */
  resolvePendingNotifications() {
    for (const { block, taskId } of this.pendingNotifications) {
      if (!this.isKnownAgent(taskId)) continue;
      block.category = "subagent_handoff";
      block.agentId = taskId;
      block.label = "task notification";
      delete block.attachmentType;
      this.noteHandoff(taskId, block);
    }
    this.pendingNotifications = [];
  }

  isKnownAgent(id) {
    return this.shared.knownAgentIds.has(id) || this.launchesByAgent.has(id);
  }

  handleSystem(v) {
    if (v.subtype !== "compact_boundary") { bump(this.shared.coverage.ignoredTypes, `system/${v.subtype ?? "unknown"}`); return; }
    const meta = v.compactMetadata ?? {};
    const trigger = meta.trigger === "auto" || meta.trigger === "manual" ? meta.trigger : "unknown";
    const pre = Number(meta.preTokens) || 0;
    const post = Number(meta.postTokens) || 0;
    const cumulative = Number(meta.cumulativeDroppedTokens);
    let dropped;
    if (Number.isFinite(cumulative)) {
      const first = this.compactions.length === 0;
      dropped = { value: Math.max(0, cumulative - this.cumulativeDropped), provenance: first ? "observed.vendor" : "derived.exact" };
      this.cumulativeDropped = cumulative;
    } else {
      dropped = { value: Math.max(0, pre - post), provenance: "derived.exact" };
    }
    const compaction = {
      id: `${this.scopeId}:c${this.compactions.length}`,
      at: v.timestamp ?? "",
      atRequest: this.nextRequestIndex,
      trigger,
      preTokens: { value: pre, provenance: "observed.vendor" },
      postTokens: { value: post, provenance: "observed.vendor" },
      droppedTokens: dropped,
    };
    if (Number.isFinite(meta.durationMs)) compaction.durationMs = meta.durationMs;
    const preserved = meta.preservedMessages;
    const preservedUuids = new Set();
    if (preserved && typeof preserved === "object") {
      for (const list of [preserved.uuids, preserved.allUuids]) if (Array.isArray(list)) for (const id of list) if (typeof id === "string") preservedUuids.add(id);
    }
    if (typeof preserved === "number") compaction.preservedMessages = preserved;
    else if (preserved && Array.isArray(preserved.uuids)) compaction.preservedMessages = preserved.uuids.length;
    this.compactions.push(compaction);
    this.applyBoundaryPresence(compaction, preservedUuids);
    for (const name of meta.preCompactDiscoveredTools ?? []) if (typeof name === "string") this.shared.mcpTools.add(name);
  }

  /**
   * Blocks in flight at the boundary (firstRequest === atRequest, emitted
   * before it) never enter the post-boundary window unless the vendor listed
   * their record as preserved; preserved pre-boundary records stay visible.
   */
  applyBoundaryPresence(compaction, preservedUuids) {
    const keep = new Set();
    for (const uuid of preservedUuids) for (const block of this.blocksByUuid.get(uuid) ?? []) keep.add(block);
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i];
      if (block.firstRequest < compaction.atRequest) break;
      if (keep.has(block)) continue;
      block.lastRequest = compaction.atRequest - 1;
      block.droppedBy = compaction.id;
    }
    for (const block of keep) {
      if (block.firstRequest < compaction.atRequest && block.lastRequest === undefined) block.preservedBy = compaction.id;
    }
  }

  handleAttachment(v) {
    const a = v.attachment && typeof v.attachment === "object" ? v.attachment : {};
    const type = typeof a.type === "string" ? a.type : "unknown";
    let content;
    let label = type;
    let estTokens;
    // Records of the hidden base itself (the system prompt and tool schemas the request already carries):
    // counting them as visible blocks double-counts `system` and makes reconciliation squeeze it to zero.
    if (HIDDEN_BASE_RECORDS.has(type)) return;
    switch (type) {
      case "hook_success":
      case "hook_system_message":
      case "hook_cancelled":
        content = (str(a.stdout) + str(a.stderr)) || str(a.content);
        label = typeof a.hookName === "string" ? `${type}:${a.hookName}` : type;
        break;
      case "total_tokens_reminder": {
        content = str(a.text);
        const n = Number(/(\d+)/.exec(content)?.[1]);
        if (Number.isFinite(n)) {
          const budget = this.shared.tokenBudget ?? (this.shared.tokenBudget = { max: 0, last: 0, provenance: "observed.vendor" });
          budget.max = Math.max(budget.max, n);
          budget.last = n;
        }
        break;
      }
      case "nested_memory":
      case "file":
      case "directory":
        content = str(a.content);
        label = safeDisplayPath(a.displayPath ?? a.filename ?? a.path, this.cwd, this.shared.home) ?? type;
        break;
      case "skill_listing":
      case "task_reminder":
      case "command_permissions":
        content = safeStringify(a);
        break;
      case "queued_command": {
        content = str(a.prompt);
        // A task notification absorbed mid-turn: the delivery the parent model saw (see header).
        if (a.commandMode === "task-notification" || /^\s*<task-notification>/.test(content)) { this.handleNotification(content, { at: v.timestamp, via: "attachment" }); return; }
        break;
      }
      case "edited_text_file":
        content = str(a.snippet);
        label = safeDisplayPath(a.filename, this.cwd, this.shared.home) ?? type;
        break;
      case "read_truncation_notice":
        content = str(a.banner);
        break;
      case "deferred_tools_delta":
        content = joinStrings(a.addedLines);
        break;
      case "agent_listing_delta":
        content = joinStrings(a.addedLines);
        break;
      case "mcp_instructions_delta":
        content = joinStrings(a.addedBlocks);
        break;
      case "invoked_skills":
        content = Array.isArray(a.skills) ? a.skills.map((s) => str(s?.content)).join("\n") : "";
        break;
      case "compact_file_reference":
        content = str(a.displayPath ?? a.filename);
        label = safeDisplayPath(a.displayPath ?? a.filename, this.cwd, this.shared.home) ?? type;
        break;
      default:
        content = safeStringify(a);
    }
    this.addBlock({ at: v.timestamp, category: "attachments", content, estTokens, label, extra: { attachmentType: type } });
  }

  toScope() {
    return {
      id: this.scopeId,
      kind: this.kind,
      depth: this.depth,
      status: this.kind === "main" ? "completed" : "unknown",
      models: [],
      requests: this.requests,
      blocks: this.blocks,
      compactions: this.compactions,
      peak: { value: 0, provenance: "observed.vendor" },
      processedInputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    };
  }
}

/** Attachment types that snapshot the system prompt / tool schemas rather than add input (Claude Code 2.1.2xx+). */
const HIDDEN_BASE_RECORDS = new Set(["prompt_snapshot", "deferred_tools_record"]);

function str(value) { return typeof value === "string" ? value : ""; }

const NOTIFICATION_SPAN = /<task-notification>[\s\S]*?(?:<\/task-notification>|$)/g;

function taskIdOf(text) { return /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1]; }

/** Splits every `<task-notification>…</task-notification>` span out of a text; the remainder keeps everything else. */
function splitNotifications(text) {
  const notifications = [];
  const remainder = text.replace(NOTIFICATION_SPAN, (span) => { notifications.push(span); return ""; });
  return { notifications, remainder };
}
function joinStrings(list) { return Array.isArray(list) ? list.filter((x) => typeof x === "string").join("\n") : ""; }
function safeStringify(value) { try { return JSON.stringify(value ?? null) ?? ""; } catch { return ""; } }

/** Text the model sees for a message/tool_result content value, plus the number of image blocks. */
function contentText(content) {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: content == null ? "" : safeStringify(content), images: 0 };
  const parts = [];
  let images = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") parts.push(str(item.text));
    else if (item.type === "image") images += 1;
    else if (item.type === "document" || item.type === "tool_reference") parts.push(safeStringify(item));
    else if (typeof item.text === "string") parts.push(item.text);
  }
  return { text: parts.join("\n"), images };
}

/** A path label that is never an absolute path outside home. */
function safeDisplayPath(value, cwd, home) {
  if (typeof value !== "string" || !value) return undefined;
  if (!path.isAbsolute(value)) return value.includes("..") ? path.basename(value) : value;
  if (cwd && value.startsWith(cwd + path.sep)) return value.slice(cwd.length + 1).split(path.sep).join("/");
  if (home && value.startsWith(home + path.sep)) return "~" + value.slice(home.length).split(path.sep).join("/");
  return path.basename(value);
}
