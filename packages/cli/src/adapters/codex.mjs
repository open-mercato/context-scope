/**
 * OpenAI Codex CLI rollout adapter -> Context IR Run (docs/format-codex.md is the
 * format authority; docs/adr-001-product-architecture.md sections 3, 3.1, 3.2).
 *
 * One rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) = one Run with a
 * single "main" scope. Subagent rollouts (thread_spawn, guardian) are their own
 * Runs with `run.kind = "subagent-run"` and `run.parentThreadId`; the index layer
 * nests them.
 *
 * Measurement rules (verified against 80 local rollouts, CLI 0.128 -> 0.150):
 * - Request = `event_msg.token_count` with non-null `info`. Occupancy
 *   `usage.total = last_token_usage.input_tokens` (cached is a subset of it).
 *   The post-compaction reset marker has `input_tokens: 0` (its `total_tokens`
 *   is NOT zero) and is skipped (coverage.syntheticRecordsSkipped).
 *   `cacheCreation` = `last_token_usage.cache_write_input_tokens` (or any numeric
 *   `cache_write*` / `cache_creation*` field) when present, else undefined.
 *   Present on 0.146.0+ rollouts (0.146.0, 0.146.0-alpha, 0.147.0-alpha, 0.150.1:
 *   71 of 80 local files), absent on 0.128 and 0.132; the value was 0 in all
 *   6,554 records seen. `Usage.total` is unchanged (`input_tokens`), and the
 *   Claude-only `deltaCheck` (input + cacheCreation vs new blocks) is removed
 *   from Codex requests because `input_tokens` is the whole context here.
 * - `tool.partial` (ADR-003): a read through `sed -n`, `head`, `tail` or
 *   `rg`/`grep -m` (codex-tools.mjs classifyCommand).
 * - Blocks come from `response_item` records only (event_msg copies are ignored).
 *   Blocks emitted between requests are input to the next request
 *   (firstRequest = next index); blocks the model produced (reasoning, assistant
 *   text, tool calls) and the tool outputs that follow them are input to the
 *   request after the one that produced them (firstRequest = index + 1).
 * - Compaction = `event_msg.context_compacted`, with the preceding `compacted`
 *   record supplying the replacement history (re-sent instruction/env parts as
 *   new blocks) and the encrypted summary size. A `compacted` record with no
 *   following `context_compacted` still counts (finalised at the next request).
 *   The `compacted` record at the start of a thread_spawn child is the fork
 *   bootstrap: its items become the child's initial blocks, no Compaction.
 *   Blocks that were in flight when the boundary hit get an empty presence
 *   window (firstRequest = atRequest, lastRequest = atRequest - 1, droppedBy).
 * - Hidden base: `session_meta.base_instructions.text` becomes an explicit
 *   `system` block (label "base_instructions") at request 0 and again after each
 *   compaction, plus `dynamic_tools` schemas when present; reconcile's H then
 *   only has to absorb the tool schemas Codex never writes to disk.
 * - Turn = count of `event_msg.user_message`; for subagent threads (which get
 *   `agent_message` items from the parent instead) an incoming agent_message
 *   preceded by `inter_agent_communication_metadata{trigger_turn:true}` counts
 *   as a turn; if neither exists, turn_context records are the fallback.
 * - Handoffs: `agent_message` items whose author is a descendant of this
 *   thread's agent path are what the parent received back (subagent_handoff,
 *   agentId = child thread id when `sub_agent_activity` mapped the path, else the
 *   agent path). `wait_agent` outputs are status phrases in current versions
 *   (tool_result.other); a wait_agent output carrying more than a status phrase
 *   is a handoff when an agent path/thread id can be read from it, otherwise it
 *   stays tool_result.other and is counted in coverage.unresolvedHandoffs.
 *
 * Estimator constants (bytes per token, per-category scale, image tokens,
 * system baseline) live in src/ir/calibration.json (ADR-002 F); this file
 * carries no numbers. Known degenerate case: 0.147 `history_mode: legacy`
 * thread_spawn children (4/80 files) log every token_count but omit most
 * response_items, so k explodes; coverage.requestsWithoutNewBlocks and
 * scope.transcriptIncomplete flag them and calibrate.mjs excludes them.
 *
 * Handoffs (backend review #5): a rollout is one `main` scope and its children
 * are separate rollouts, so the child scope that would carry `scope.handoff`
 * is not in this Run. The parent Run therefore records
 *   run.handoffsByThread = { [childThreadId]: { blockId, tokens, deliveredAtRequest, launchedAtRequest?, blocks } }
 * from its `subagent_handoff` blocks (agentId resolved to a thread id via
 * sub_agent_activity / item_completed; agent paths that never resolved are
 * not included and counted in coverage.unresolvedHandoffs), and the index
 * joins it to the child run `codex:<childThreadId>` (child peak / tokens =
 * compression ratio). When the caller already has the parent's record it can
 * pass `parentHandoffs: { [threadId]: CodexHandoff }` and the child's main
 * scope gets `handoff`, `launchedAtRequest`, `deliveredAtRequest` filled here.
 *
 * Project identity (backend review #1): `project.key = projectKeyFor(cwd)`
 * from src/ir/project.mjs, shared with the Claude adapter.
 *
 * Privacy: labels are tag names, tool names or repo/~-relative paths; block
 * content is hashed (sha1) and sized, never stored.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { readJsonl } from "../ir/jsonl.mjs";
import { byteLength, calibrationFor, detectBlockKind, detectKind, estimateTokens, estimateTokensFromBytes, imageTokensFor } from "../ir/estimate.mjs";
import { finalizeRun } from "../ir/finalize.mjs";
import { projectKeyFor } from "../ir/project.mjs";
import { classifyCodexCall, inspectToolOutput, relativeTarget } from "./codex-tools.mjs";

export const CODEX_ADAPTER_VERSION = "codex-v3";
export const DEFAULT_CODEX_WINDOW = 258_400;
const VENDOR = "codex";
/** Tokens charged for one image part; Codex does not report per-image tokens (from calibration.json). */
export const IMAGE_TOKENS = imageTokensFor(VENDOR);
/** Per-category scale of the shared estimator for Codex (from calibration.json; kept exported for callers). */
export const CODEX_TOKEN_SCALE = calibrationFor(VENDOR).categoryScale;

const KNOWN_TYPES = new Set(["session_meta", "turn_context", "response_item", "event_msg", "compacted", "world_state", "inter_agent_communication_metadata"]);
const WAIT_STATUS = /^Wait (completed|timed out|interrupted)\.?(\s|$)/;
const AGENT_PATH = /\/root(?:\/[\w.-]+)+/;
const THREAD_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

export async function parseCodexRollout(filePath, { home = os.homedir(), siblingIndex, parentHandoffs, thresholds } = {}) {
  const parser = new CodexRolloutParser(filePath, { home, siblingIndex, parentHandoffs, thresholds });
  for await (const record of readJsonl(filePath)) parser.handle(record);
  const fileStat = await stat(filePath).catch(() => null);
  return parser.finish(fileStat);
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function partText(part) {
  if (!part || typeof part !== "object") return "";
  return typeof part.text === "string" ? part.text : "";
}

function firstLine(text) {
  const end = text.indexOf("\n");
  return (end < 0 ? text : text.slice(0, end)).trim();
}

function leadingTag(text) {
  const match = firstLine(text).match(/^<([A-Za-z][\w-]*(?: [A-Za-z][\w-]*)*)(?:\s[^>]*)?>/);
  return match ? match[1].replace(/\s+/g, "_") : null;
}

function sourceKind(source) {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    const sub = source.subagent;
    if (sub && typeof sub === "object") {
      if (sub.thread_spawn) return "subagent:thread_spawn";
      if (typeof sub.other === "string") return `subagent:${sub.other}`;
      return `subagent:${Object.keys(sub)[0] ?? "unknown"}`;
    }
    return Object.keys(source)[0] ?? "unknown";
  }
  return "unknown";
}

class CodexRolloutParser {
  constructor(filePath, { home, siblingIndex, parentHandoffs, thresholds }) {
    this.filePath = filePath;
    this.home = home;
    this.siblingIndex = siblingIndex;
    this.parentHandoffs = parentHandoffs && typeof parentHandoffs === "object" ? parentHandoffs : null;
    this.thresholds = thresholds;
    this.spawnsByPath = new Map();       // agent path -> spawn_agent tool_call block
    this.meta = null;
    this.parentMeta = null;
    this.records = 0;
    this.unparsedRecords = 0;
    this.unparsedTypes = {};
    this.syntheticSkipped = 0;
    this.requests = [];
    this.blocks = [];
    this.compactions = [];
    this.pending = [];
    this.seq = 0;
    this.turns = 0;
    this.turnContexts = 0;
    this.model = null;
    this.window = null;
    this.cwd = null;
    this.calls = new Map();
    this.agentPathToThread = new Map();
    this.spawnedThreadIds = new Set();
    this.userInstructionsHash = null;
    this.instructionsObserved = null;
    this.pendingCompaction = null;
    this.awaitingPost = null;
    this.firstTimestamp = null;
    this.lastTimestamp = null;
    this.lastTurnEvent = null;
    this.selfPath = "/root";
    this.unresolvedHandoffs = 0;
    this.baseInstructionsTokens = 0;
    this.nextAgentMessageIsTurn = false;
    this.forkBootstrap = false;
    this.truncatedOutputs = 0;
    this.dynamicTools = null;
  }

  handle(record) {
    this.records += 1;
    if (record.error) { this.unparsedRecords += 1; this.count("<invalid-json>"); return; }
    const value = record.value;
    if (!value || typeof value !== "object" || typeof value.type !== "string") { this.unparsedRecords += 1; this.count("<invalid-envelope>"); return; }
    const at = typeof value.timestamp === "string" ? value.timestamp : this.lastTimestamp ?? new Date(0).toISOString();
    if (typeof value.timestamp === "string") { this.firstTimestamp ??= value.timestamp; this.lastTimestamp = value.timestamp; }
    const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
    if (!KNOWN_TYPES.has(value.type)) { this.unparsedRecords += 1; this.count(value.type); return; }
    switch (value.type) {
      case "session_meta": return this.onSessionMeta(payload, at);
      case "turn_context": return this.onTurnContext(payload, at);
      case "response_item": return this.onResponseItem(payload, at, {});
      case "event_msg": return this.onEvent(payload, at);
      case "compacted": return this.onCompacted(payload, at);
      case "world_state": return this.onWorldState(payload);
      case "inter_agent_communication_metadata":
        if (payload.trigger_turn === true) this.nextAgentMessageIsTurn = true;
        return;
      default: return;
    }
  }

  count(type) {
    this.unparsedTypes[type] = (this.unparsedTypes[type] ?? 0) + 1;
  }

  get threadId() {
    return this.meta?.id ?? this.meta?.session_id ?? null;
  }

  get context() {
    return { cwd: this.cwd, home: this.home };
  }

  // ---- session_meta -------------------------------------------------------

  onSessionMeta(payload, at) {
    if (!this.meta) {
      this.meta = payload;
      this.cwd = typeof payload.cwd === "string" ? payload.cwd : this.cwd;
      if (typeof payload.agent_path === "string") this.selfPath = payload.agent_path;
      else if (typeof payload.source?.subagent?.thread_spawn?.agent_path === "string") this.selfPath = payload.source.subagent.thread_spawn.agent_path;
      this.addBaseBlocks(at);
      return;
    }
    if (payload.id === this.meta.id) { this.syntheticSkipped += 1; return; } // reconnect re-emit
    if (!this.parentMeta && (this.meta.parent_thread_id === payload.id || this.meta.forked_from_id === payload.id)) {
      this.parentMeta = payload;
      if (!this.cwd && typeof payload.cwd === "string") this.cwd = payload.cwd;
      return;
    }
    this.syntheticSkipped += 1;
  }

  addBaseBlocks(at) {
    if (this.baseInstructionsTokens === 0 && Array.isArray(this.meta?.dynamic_tools)) {
      this.dynamicTools = { count: this.meta.dynamic_tools.reduce((sum, ns) => sum + (Array.isArray(ns?.tools) ? ns.tools.length : 0), 0), bytes: byteLength(JSON.stringify(this.meta.dynamic_tools)) };
    }
    const text = this.meta?.base_instructions?.text ?? (typeof this.meta?.base_instructions === "string" ? this.meta.base_instructions : null);
    if (typeof text === "string" && text.length) {
      const block = this.addBlock({ category: "system", text, kind: "prose", label: "base_instructions", side: "input", at });
      this.baseInstructionsTokens = block.estTokens;
    }
    // dynamic_tools (collaboration namespace schemas) is NOT emitted as a block:
    // the on-disk JSON is ~2x what the rendered tool schema costs, so it is left
    // to the derived hidden base H like the built-in tool schemas.
  }

  // ---- turn_context / world_state -----------------------------------------

  onTurnContext(payload, at) {
    this.turnContexts += 1;
    if (typeof payload.model === "string" && payload.model) this.model = payload.model;
    if (!this.cwd && typeof payload.cwd === "string") this.cwd = payload.cwd;
    const instructions = payload.user_instructions;
    if (typeof instructions === "string" && instructions.length) {
      const hash = sha1(instructions);
      if (hash !== this.userInstructionsHash) {
        this.userInstructionsHash = hash;
        this.addBlock({ category: "instructions", text: instructions, kind: "prose", label: "user_instructions", attachmentType: "user_instructions", side: "input", at });
      }
    }
  }

  onWorldState(payload) {
    const state = payload?.state;
    if (!state || typeof state !== "object") return;
    const agentsMd = state.agents_md?.text;
    if (typeof agentsMd === "string" && agentsMd.length) this.instructionsObserved = { chars: agentsMd.length, provenance: "observed.artifact" };
    if (!this.model && typeof state.model === "string") this.model = state.model;
  }

  // ---- event_msg ----------------------------------------------------------

  onEvent(payload, at) {
    switch (payload.type) {
      case "token_count": return this.onTokenCount(payload, at);
      case "user_message": this.turns += 1; return;
      case "context_compacted": return this.onContextCompacted(at);
      case "task_started":
        if (!this.window && Number.isFinite(payload.model_context_window)) this.window = { value: payload.model_context_window, provenance: "observed.vendor" };
        this.lastTurnEvent = "started";
        return;
      case "task_complete": this.lastTurnEvent = "completed"; return;
      case "turn_aborted": this.lastTurnEvent = "aborted"; return;
      case "thread_settings_applied":
        if (typeof payload.thread_settings?.model === "string") this.model = payload.thread_settings.model;
        return;
      case "sub_agent_activity":
        if (typeof payload.agent_thread_id === "string") {
          this.noteSpawned(payload.agent_thread_id);
          if (typeof payload.agent_path === "string") this.agentPathToThread.set(payload.agent_path, payload.agent_thread_id);
        }
        return;
      case "item_completed": {
        const item = payload.item;
        if (item && typeof item === "object") {
          if (typeof item.agent_thread_id === "string") {
            this.noteSpawned(item.agent_thread_id);
            if (typeof item.agent_path === "string") this.agentPathToThread.set(item.agent_path, item.agent_thread_id);
          }
          for (const id of Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []) this.noteSpawned(id);
          if (item.agents_states && typeof item.agents_states === "object") for (const id of Object.keys(item.agents_states)) if (THREAD_ID.test(id)) this.noteSpawned(id);
        }
        return;
      }
      default: return;
    }
  }

  noteSpawned(id) {
    if (typeof id !== "string" || !id || id === this.threadId || id === this.meta?.parent_thread_id) return;
    this.spawnedThreadIds.add(id);
  }

  onTokenCount(payload, at) {
    const info = payload.info;
    if (!info || typeof info !== "object") { this.syntheticSkipped += 1; return; }
    const last = info.last_token_usage;
    if (!last || typeof last !== "object") { this.syntheticSkipped += 1; return; }
    if (Number.isFinite(info.model_context_window) && info.model_context_window > 0) this.window = { value: info.model_context_window, provenance: "observed.vendor" };
    const input = Number(last.input_tokens) || 0;
    if (input === 0) { this.syntheticSkipped += 1; return; } // post-compaction reset marker
    if (this.pendingCompaction) this.finalizeCompaction();
    const index = this.requests.length;
    this.assignPending(index);
    const turn = this.turns || this.turnContexts;
    const request = {
      index,
      id: `t${turn}-r${index}`,
      at,
      model: this.model ?? "unknown",
      turn,
      usage: {
        input,
        cacheCreation: cacheWriteOf(last),
        cacheRead: Number(last.cached_input_tokens) || 0,
        output: Number(last.output_tokens) || 0,
        thinking: Number(last.reasoning_output_tokens) || 0,
        total: input,
      },
    };
    if (this.awaitingPost) {
      const compaction = this.awaitingPost;
      request.compactionBefore = compaction.id;
      compaction.postTokens = { value: input, provenance: "derived.exact" };
      compaction.droppedTokens = { value: Math.max(0, compaction.preTokens.value - input), provenance: compaction.preTokens.provenance === "derived.exact" ? "derived.exact" : "unknown" };
      this.awaitingPost = null;
    }
    this.requests.push(request);
  }

  // ---- compaction ---------------------------------------------------------

  onCompacted(payload, at) {
    const history = Array.isArray(payload.replacement_history) ? payload.replacement_history : [];
    const isBootstrap = this.requests.length === 0 && this.compactions.length === 0 && !this.pendingCompaction;
    if (isBootstrap) {
      this.forkBootstrap = true;
      for (const item of history) {
        if (item?.type === "compaction") {
          this.addBlock({ category: "compaction_summary", bytes: byteLength(item.encrypted_content ?? ""), kind: "prose", label: "fork bootstrap (encrypted)", hashSource: item.encrypted_content ?? item.id ?? "", side: "input", at });
        } else {
          this.onResponseItem(item ?? {}, at, { forceInput: true });
        }
      }
      return;
    }
    if (this.pendingCompaction) this.finalizeCompaction();
    const id = `c${this.compactions.length + 1}`;
    const atRequest = this.requests.length;
    this.dropInFlight(atRequest, id);
    const previous = this.requests[this.requests.length - 1];
    const preTokens = previous ? { value: previous.usage.total, provenance: "derived.exact" } : { value: 0, provenance: "unknown" };
    const windowValue = this.window?.value ?? DEFAULT_CODEX_WINDOW;
    this.pendingCompaction = {
      id,
      at,
      atRequest,
      trigger: previous && previous.usage.total >= windowValue * 0.75 ? "auto" : "unknown",
      preTokens,
      postTokens: { value: 0, provenance: "unknown" },
      droppedTokens: { value: 0, provenance: "unknown" },
      windowNumber: Number.isFinite(payload.window_number) ? payload.window_number : undefined,
      preservedMessages: history.filter((item) => item?.type !== "compaction").length,
    };
    this.addBaseBlocks(at);
    for (const item of history) {
      if (item?.type === "compaction") {
        const block = this.addBlock({ category: "compaction_summary", bytes: byteLength(item.encrypted_content ?? ""), kind: "prose", label: "compaction (encrypted)", hashSource: item.encrypted_content ?? item.id ?? "", side: "input", at });
        this.pendingCompaction.summaryBlockId = block.id;
      } else {
        this.onResponseItem(item ?? {}, at, { forceInput: true });
      }
    }
  }

  onContextCompacted(at) {
    if (this.pendingCompaction) { this.finalizeCompaction(); return; }
    const latest = this.compactions[this.compactions.length - 1];
    if (latest && latest.atRequest === this.requests.length) return; // marker for a compaction already recorded
    const id = `c${this.compactions.length + 1}`;
    const atRequest = this.requests.length;
    this.dropInFlight(atRequest, id);
    const previous = this.requests[this.requests.length - 1];
    const windowValue = this.window?.value ?? DEFAULT_CODEX_WINDOW;
    this.pendingCompaction = {
      id,
      at,
      atRequest,
      trigger: previous && previous.usage.total >= windowValue * 0.75 ? "auto" : "unknown",
      preTokens: previous ? { value: previous.usage.total, provenance: "derived.exact" } : { value: 0, provenance: "unknown" },
      postTokens: { value: 0, provenance: "unknown" },
      droppedTokens: { value: 0, provenance: "unknown" },
    };
    this.addBaseBlocks(at);
    this.finalizeCompaction();
  }

  finalizeCompaction() {
    const compaction = this.pendingCompaction;
    this.pendingCompaction = null;
    if (!compaction) return;
    this.compactions.push(compaction);
    this.awaitingPost = compaction;
  }

  /** Blocks not yet seen by any request when a boundary hits never enter the window. */
  dropInFlight(atRequest, compactionId) {
    for (const block of this.blocks) {
      if (block.firstRequest === -1 || block.firstRequest >= atRequest) {
        block.firstRequest = Math.max(block.firstRequest, atRequest);
        block.lastRequest = atRequest - 1;
        block.droppedBy = compactionId;
      }
    }
    this.pending = [];
  }

  // ---- blocks -------------------------------------------------------------

  addBlock({ category, text, bytes, estTokens, kind, label, attachmentType, tool, toolUseId, agentId, side, at, hashSource, extra }) {
    const resolvedKind = kind ?? (typeof text === "string" ? detectKind(text) : "prose");
    const resolvedBytes = typeof text === "string" ? byteLength(text) : (bytes ?? 0);
    const resolvedTokens = estTokens !== undefined ? estTokens : estimateTokensFromBytes(resolvedBytes, resolvedKind, { vendor: VENDOR, category });
    const block = {
      id: `main:${this.seq}`,
      seq: this.seq,
      at,
      category,
      bytes: resolvedBytes,
      estTokens: resolvedTokens,
      kind: resolvedKind,
      firstRequest: -1,
      hash: sha1(typeof text === "string" ? text : (hashSource ?? `${category}:${resolvedBytes}`)),
    };
    if (tool) block.tool = tool;
    if (toolUseId) block.toolUseId = toolUseId;
    if (agentId) block.agentId = agentId;
    if (attachmentType) block.attachmentType = attachmentType;
    if (label) block.label = label;
    if (extra) Object.assign(block, extra);
    this.seq += 1;
    this.blocks.push(block);
    this.pending.push({ block, side: side ?? "input" });
    return block;
  }

  assignPending(index) {
    const firstModel = this.pending.findIndex((entry) => entry.side === "model");
    this.pending.forEach((entry, position) => {
      entry.block.firstRequest = firstModel >= 0 && position >= firstModel ? index + 1 : index;
    });
    this.pending = [];
  }

  onResponseItem(payload, at, { forceInput }) {
    const modelSide = forceInput ? "input" : "model";
    switch (payload.type) {
      case "message": return this.onMessage(payload, at, forceInput);
      case "reasoning": {
        const summary = Array.isArray(payload.summary) ? payload.summary.map(partText).join("\n") : "";
        const encrypted = typeof payload.encrypted_content === "string" ? payload.encrypted_content : "";
        const bytes = byteLength(summary) + byteLength(encrypted);
        this.addBlock({ category: "assistant_thinking", bytes, kind: "prose", label: "reasoning", hashSource: encrypted || summary || payload.id || "", side: modelSide, at });
        return;
      }
      case "custom_tool_call":
      case "function_call": return this.onToolCall(payload, at, modelSide);
      case "custom_tool_call_output":
      case "function_call_output": return this.onToolOutput(payload, at);
      case "agent_message": return this.onAgentMessage(payload, at);
      case "web_search_call": {
        const args = JSON.stringify(payload.action ?? {});
        this.addBlock({ category: "tool_call", text: args, kind: "code", label: "web_search", tool: { name: "web_search", kind: "web", argsHash: sha1(args) }, toolUseId: payload.id, side: modelSide, at });
        return;
      }
      case "compaction":
        this.addBlock({ category: "compaction_summary", bytes: byteLength(payload.encrypted_content ?? ""), kind: "prose", label: "compaction (encrypted)", hashSource: payload.encrypted_content ?? "", side: "input", at });
        return;
      default:
        this.unparsedRecords += 1;
        this.count(`response_item.${payload.type ?? "unknown"}`);
        return;
    }
  }

  onMessage(payload, at, forceInput) {
    const role = payload.role;
    const parts = Array.isArray(payload.content) ? payload.content : [];
    if (role === "assistant") {
      const text = parts.map(partText).join("\n");
      this.addBlock({ category: "assistant_text", text, label: payload.phase ? `assistant (${payload.phase})` : "assistant", side: forceInput ? "input" : "model", at });
      return;
    }
    for (const part of parts) {
      if (part?.type === "input_image") {
        const source = typeof part.image_url === "string" ? part.image_url : JSON.stringify(part);
        this.addBlock({ category: "attachments", bytes: byteLength(source), estTokens: IMAGE_TOKENS, kind: "prose", label: "image", attachmentType: "image", hashSource: source, side: "input", at });
        continue;
      }
      const text = partText(part);
      if (!text) continue;
      if (role === "developer") this.addDeveloperPart(text, at);
      else this.addUserPart(text, at, role);
    }
  }

  addUserPart(text, at, role) {
    const line = firstLine(text);
    if (line.startsWith("# AGENTS.md instructions for")) {
      const rawPath = line.slice("# AGENTS.md instructions for".length).trim();
      const relative = relativeTarget(rawPath, this.context) ?? ".";
      const label = relative === "." ? "AGENTS.md" : /\.md$/i.test(relative) ? relative : `${relative}/AGENTS.md`;
      this.addBlock({ category: "instructions", text, kind: "prose", label, attachmentType: "agents_md", side: "input", at });
      return;
    }
    const tag = leadingTag(text);
    if (tag === "environment_context") { this.addBlock({ category: "attachments", text, label: tag, attachmentType: tag, side: "input", at }); return; }
    if (tag === "image") { this.addBlock({ category: "attachments", text, label: "image", attachmentType: "image", side: "input", at }); return; }
    if (tag === "skill") { this.addBlock({ category: "skills", text, label: "skill", attachmentType: "skill", side: "input", at }); return; }
    if (tag) { this.addBlock({ category: "attachments", text, label: tag, attachmentType: tag, side: "input", at }); return; }
    this.addBlock({ category: "user", text, label: role === "user" ? "user" : role, side: "input", at });
  }

  addDeveloperPart(text, at) {
    const tag = leadingTag(text);
    if (tag === "skills_instructions") { this.addBlock({ category: "skills", text, label: tag, attachmentType: tag, side: "input", at }); return; }
    if (tag) { this.addBlock({ category: "attachments", text, label: tag, attachmentType: tag, side: "input", at }); return; }
    if (/^You are\b/.test(firstLine(text))) { this.addBlock({ category: "instructions", text, kind: "prose", label: "role_prompt", attachmentType: "role_prompt", side: "input", at }); return; }
    this.addBlock({ category: "attachments", text, label: "developer", attachmentType: "developer", side: "input", at });
  }

  onToolCall(payload, at, side) {
    const name = typeof payload.name === "string" ? payload.name : "unknown";
    const argsText = payload.type === "function_call"
      ? (typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments ?? {}))
      : (typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? ""));
    const classified = classifyCodexCall({ name, input: payload.type === "custom_tool_call" ? argsText : undefined, arguments: payload.type === "function_call" ? argsText : undefined, namespace: payload.namespace }, this.context);
    const tool = { name, kind: classified.kind, argsHash: sha1(argsText) };
    if (classified.target) tool.target = classified.target;
    if (classified.partial) tool.partial = true;
    if (classified.server) tool.server = classified.server;
    if (classified.subtool && classified.subtool !== name) tool.subtool = classified.subtool;
    if (classified.files) tool.files = classified.files;
    const callId = typeof payload.call_id === "string" ? payload.call_id : payload.id;
    const label = tool.target ? `${tool.subtool ?? name} ${tool.target}` : (tool.subtool ?? name);
    const block = this.addBlock({ category: "tool_call", text: argsText, kind: "code", label, tool, toolUseId: callId, side, at });
    if (callId) this.calls.set(callId, { name, tool, blockId: block.id, at });
  }

  onToolOutput(payload, at) {
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    const call = callId ? this.calls.get(callId) : undefined;
    const { text, images } = outputText(payload.output);
    const name = call?.name ?? "unknown";
    const kind = call?.tool.kind ?? "other";
    const inspected = inspectToolOutput(text, estimateTokens(text, detectKind(text)));
    const tool = { name, kind, argsHash: call?.tool.argsHash ?? sha1(""), ...(call?.tool.target ? { target: call.tool.target } : {}), ...(call?.tool.partial ? { partial: true } : {}), ...(call?.tool.server ? { server: call.tool.server } : {}), ...(call?.tool.subtool ? { subtool: call.tool.subtool } : {}) };
    if (inspected.isError) tool.isError = true;
    if (inspected.truncated) { tool.truncated = true; this.truncatedOutputs += 1; }
    if (inspected.originalTokens !== undefined) tool.originalTokens = inspected.originalTokens;
    if (inspected.omittedTokens !== undefined) tool.omittedTokens = inspected.omittedTokens;
    const extraTokens = images * IMAGE_TOKENS;
    let category = `tool_result.${kind}`;
    let agentId;
    if (kind === "agent") {
      const handoff = this.resolveHandoff(name, text);
      if (handoff.isHandoff) { category = "subagent_handoff"; agentId = handoff.agentId; }
      else category = "tool_result.other";
    } else if (!["file", "shell", "search", "web"].includes(kind)) {
      category = "tool_result.other";
    }
    // A `cat`/read of a PDF, image or office file: the model gets a converted document, not these bytes, so
    // the block is `binary` (its own ratio) when the target's extension and the content agree (estimate-core.mjs).
    const detected = detectBlockKind(text, { target: call?.tool.target });
    const block = this.addBlock({
      category, text, kind: detected, label: tool.target ? `${tool.subtool ?? name} ${tool.target}` : (tool.subtool ?? name), tool, toolUseId: callId, agentId, side: "input", at,
    });
    if (images) { block.images = images; block.estTokens += extraTokens; }
    if (name === "spawn_agent" && call) this.noteSpawnOutput(call, text);
  }

  /** spawn_agent output carries the child's agent path; remember which call launched it. */
  noteSpawnOutput(call, text) {
    let agentPath;
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed.task_name === "string") agentPath = parsed.task_name; } catch { /* not JSON */ }
    agentPath ??= text.match(AGENT_PATH)?.[0];
    if (!agentPath) return;
    const block = this.blocks.find((candidate) => candidate.id === call.blockId);
    if (block && !this.spawnsByPath.has(agentPath)) this.spawnsByPath.set(agentPath, block);
  }

  /** Parent-side handoff records keyed by child thread id (see header). */
  handoffsByThread() {
    const out = {};
    const pathByThread = new Map([...this.agentPathToThread].map(([agentPath, thread]) => [thread, agentPath]));
    for (const block of this.blocks) {
      if (block.category !== "subagent_handoff" || !block.agentId) continue;
      const thread = THREAD_ID.test(block.agentId) ? block.agentId : this.agentPathToThread.get(block.agentId);
      if (!thread) continue;
      const entry = out[thread];
      if (entry) { entry.tokens.value += block.estTokens; entry.blocks += 1; continue; }
      const record = { blockId: block.id, tokens: { value: block.estTokens, provenance: "estimated.local" }, deliveredAtRequest: block.firstRequest, blocks: 1 };
      const spawn = this.spawnsByPath.get(pathByThread.get(thread) ?? "");
      if (spawn && spawn.firstRequest >= 0) record.launchedAtRequest = Math.max(0, spawn.firstRequest - 1);
      out[thread] = record;
    }
    return out;
  }

  resolveHandoff(name, text) {
    if (name !== "wait_agent") return { isHandoff: false };
    let message = text;
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed.message === "string") message = parsed.message; } catch { /* plain text */ }
    if (!message || WAIT_STATUS.test(message.trim()) && message.trim().length < 200) return { isHandoff: false };
    const thread = message.match(THREAD_ID)?.[0];
    const agentPath = message.match(AGENT_PATH)?.[0];
    const agentId = thread ?? (agentPath ? this.agentPathToThread.get(agentPath) ?? agentPath : undefined);
    if (!agentId) { this.unresolvedHandoffs += 1; return { isHandoff: false }; }
    return { isHandoff: true, agentId };
  }

  onAgentMessage(payload, at) {
    const author = typeof payload.author === "string" ? payload.author : "";
    const recipient = typeof payload.recipient === "string" ? payload.recipient : "";
    const parts = Array.isArray(payload.content) ? payload.content : [];
    const text = parts.map(partText).join("\n");
    const fromChild = author.startsWith(this.selfPath.endsWith("/") ? this.selfPath : this.selfPath + "/") && (!recipient || recipient === this.selfPath);
    if (fromChild) {
      const agentId = this.agentPathToThread.get(author) ?? author;
      this.addBlock({ category: "subagent_handoff", text, label: "agent_message", attachmentType: "agent_message", agentId, side: "input", at });
      return;
    }
    if (this.nextAgentMessageIsTurn) { this.turns += 1; this.nextAgentMessageIsTurn = false; }
    this.addBlock({ category: "user", text, label: "agent_message", attachmentType: "agent_message", side: "input", at });
  }

  // ---- finish -------------------------------------------------------------

  finish(fileStat) {
    if (this.pendingCompaction) this.finalizeCompaction();
    for (const entry of this.pending) entry.block.firstRequest = this.requests.length;
    this.pending = [];
    const meta = this.meta ?? {};
    const threadId = this.threadId ?? path.basename(this.filePath, ".jsonl");
    const cwd = this.cwd ?? "";
    const cwdHash = sha1(cwd);
    const displayName = cwd ? path.posix.basename(cwd) : "unknown";
    const spawn = meta.source?.subagent?.thread_spawn ?? null;
    const parentThreadId = typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : (typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : undefined);
    const agentType = typeof meta.agent_nickname === "string" ? meta.agent_nickname : (typeof spawn?.agent_nickname === "string" ? spawn.agent_nickname : (typeof meta.source?.subagent?.other === "string" ? meta.source.subagent.other : undefined));
    const agentPath = typeof meta.agent_path === "string" ? meta.agent_path : spawn?.agent_path;
    const depth = Number.isFinite(spawn?.depth) ? spawn.depth : (parentThreadId ? 1 : 0);
    if (this.siblingIndex instanceof Map) {
      for (const [id, entry] of this.siblingIndex) {
        const parent = entry && typeof entry === "object" ? entry.parentThreadId : undefined;
        if (parent === threadId && id !== threadId) this.spawnedThreadIds.add(id);
      }
    }
    const scope = {
      id: "main",
      kind: "main",
      depth,
      status: this.lastTurnEvent === "completed" ? "completed" : this.lastTurnEvent ? "open" : "unknown",
      models: [],
      requests: this.requests,
      blocks: this.blocks,
      compactions: this.compactions,
      peak: { value: 0, provenance: "observed.vendor" },
      processedInputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      source: { file: displayPath(this.filePath, this.home), bytes: fileStat?.size ?? 0 },
    };
    if (agentType) scope.agentType = agentType;
    if (agentPath) scope.description = path.posix.basename(agentPath);
    const run = {
      id: `codex:${threadId}`,
      vendor: "codex",
      sessionId: threadId,
      project: { key: cwd ? projectKeyFor(cwd) : projectKeyFor(`codex:${threadId}`), displayName, cwdHash, cwdDisplay: cwd ? relativeTarget(cwd, { home: this.home }) : undefined },
      startedAt: typeof meta.timestamp === "string" ? meta.timestamp : (this.firstTimestamp ?? ""),
      endedAt: this.lastTimestamp ?? "",
      activeMs: 0,
      cliVersion: typeof meta.cli_version === "string" ? meta.cli_version : undefined,
      gitBranch: typeof meta.git?.branch === "string" ? meta.git.branch : undefined,
      entrypoint: sourceKind(meta.source),
      window: this.window ?? { value: DEFAULT_CODEX_WINDOW, provenance: "estimated.local" },
      scopes: [scope],
      summary: undefined,
      coverage: {
        records: this.records,
        unparsedRecords: this.unparsedRecords,
        unparsedTypes: this.unparsedTypes,
        requests: this.requests.length,
        syntheticRecordsSkipped: this.syntheticSkipped,
        estimatorErrorMedian: 0,
        estimatorErrorP95: 0,
        adapterVersion: CODEX_ADAPTER_VERSION,
        unresolvedHandoffs: this.unresolvedHandoffs,
        truncatedOutputs: this.truncatedOutputs,
      },
      source: { file: displayPath(this.filePath, this.home), bytes: fileStat?.size ?? 0, mtimeMs: fileStat?.mtimeMs ?? 0, subagentFiles: 0 },
      kind: parentThreadId ? "subagent-run" : "main-run",
      parentThreadId,
      spawnDepth: depth,
      spawnedThreadIds: [...this.spawnedThreadIds],
      baseInstructionsTokens: this.baseInstructionsTokens,
      instructionsObserved: this.instructionsObserved ?? undefined,
      threadSource: typeof meta.thread_source === "string" ? meta.thread_source : undefined,
      forkedFromThreadId: typeof meta.forked_from_id === "string" ? meta.forked_from_id : undefined,
      forkBootstrap: this.forkBootstrap || undefined,
      dynamicTools: this.dynamicTools ?? undefined,
    };
    if (cwd && !run.project.cwdDisplay) run.project.cwdDisplay = displayName;
    const handoffs = this.handoffsByThread();
    if (Object.keys(handoffs).length) run.handoffsByThread = handoffs;
    const inbound = this.parentHandoffs?.[threadId];
    if (inbound && typeof inbound === "object" && typeof inbound.blockId === "string") {
      const tokens = Number(inbound.tokens?.value ?? inbound.tokens) || 0;
      scope.handoff = { blockId: inbound.blockId, tokens: { value: tokens, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } };
      if (Number.isInteger(inbound.deliveredAtRequest)) scope.deliveredAtRequest = inbound.deliveredAtRequest;
      if (Number.isInteger(inbound.launchedAtRequest)) scope.launchedAtRequest = inbound.launchedAtRequest;
      if (scope.status === "unknown") scope.status = "completed";
    }
    finalizeRun(run, { instructionTokensEstimate: 0, thresholds: this.thresholds });
    // deltaCheck is Claude arithmetic (input + cacheCreation = the uncached delta); Codex input_tokens is the whole context.
    for (const request of scope.requests) delete request.deltaCheck;
    if (scope.handoff) {
      const tokens = scope.handoff.tokens.value;
      scope.handoff.compressionRatio = { value: tokens > 0 ? Number((scope.peak.value / tokens).toFixed(2)) : 0, provenance: "derived.exact" };
    }
    // Legacy/forked child rollouts (0.147 `history_mode: legacy`) can omit most
    // response_items while still logging every token_count: requests that gained
    // no blocks are counted so the UI can distrust the composition there.
    run.coverage.requestsWithoutNewBlocks = scope.requests.filter((request, index) => index > 0 && request.newBlockIds.length === 0).length;
    return run;
  }
}

/** `cache_write_input_tokens` (0.146+), or any numeric cache_write* / cache_creation* field; undefined when absent. */
function cacheWriteOf(last) {
  if (typeof last.cache_write_input_tokens === "number" && Number.isFinite(last.cache_write_input_tokens)) return last.cache_write_input_tokens;
  for (const [key, value] of Object.entries(last)) {
    if (/^cache_(?:write|creation)/.test(key) && typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function outputText(output) {
  if (typeof output === "string") return { text: output, images: 0 };
  if (Array.isArray(output)) {
    let images = 0;
    const texts = [];
    for (const part of output) {
      if (part?.type === "input_image" || part?.type === "image") images += 1;
      else if (typeof part?.text === "string") texts.push(part.text);
      else if (typeof part === "string") texts.push(part);
      else if (part && typeof part === "object") texts.push(JSON.stringify(part));
    }
    return { text: texts.join("\n"), images };
  }
  if (output && typeof output === "object") return { text: JSON.stringify(output), images: 0 };
  return { text: output == null ? "" : String(output), images: 0 };
}

function displayPath(filePath, home) {
  const normalized = filePath.replace(/\\/g, "/");
  const root = (home ?? "").replace(/\\/g, "/");
  if (root && (normalized === root || normalized.startsWith(root.endsWith("/") ? root : root + "/"))) return "~/" + path.posix.relative(root, normalized);
  return path.posix.basename(normalized);
}

