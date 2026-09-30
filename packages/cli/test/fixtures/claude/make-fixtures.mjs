#!/usr/bin/env node
/**
 * Generates synthetic Claude Code sessions for the adapter tests. Record shapes
 * follow docs/format-claude-code.md exactly; all text is deterministic lorem.
 * Never copy real transcripts here.
 *
 *   node packages/cli/test/fixtures/claude/make-fixtures.mjs
 *
 * Writes, next to this script (this directory plays the role of a
 * ~/.claude/projects/<project-dir>/ folder):
 *   <sessionId>.jsonl                                 main transcripts (3 sessions)
 *   <sessionId>/subagents/agent-<id>.jsonl + .meta.json  child scopes (session 3: async, sync, nested,
 *                                                     queued-attachment delivery, tool_result-embedded delivery)
 *   expected.json                                     numbers the adapter must reproduce
 *
 * The exported SESSIONS / HOME / CWD constants are imported by the tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOME = "/Users/fixture";
export const CWD = `${HOME}/projects/lorem`;
export const VERSION = "2.1.251";
export const SESSIONS = {
  plain: "00000000-0000-4000-8000-000000000001",
  compaction: "00000000-0000-4000-8000-000000000002",
  subagents: "00000000-0000-4000-8000-000000000003",
  harness: "00000000-0000-4000-8000-000000000004",
  tempCopy: "00000000-0000-4000-8000-000000000005",
};
// ADR-005 section 2: temp-isolation working directories (a harness run and a temp copy of a repo with evidence).
export const HARNESS_CWD = "/private/var/folders/zz/T/cez-root-isolation-4";
export const TEMP_COPY_CWD = "/private/var/folders/zz/T/cez-root-lease-5";
/** Repo-relative files the temp-copy session reads; a test repo that contains them attributes the session by path overlap. */
export const TEMP_TARGETS = ["src/index.mjs", "src/api/schema.mjs", "docs/setup.md", "test/index.test.mjs", "packages/api/AGENTS.md", "src/lib/util.mjs"];
/** Exact content of the nested instruction file the temp-copy session loaded (`nested_memory`); a repo file with this content attributes it by hash. */
export const NESTED_MEMORY_PATH = "packages/api/CLAUDE.md";
export const NESTED_MEMORY_TEXT = "# API package\n\nRead `src/api/schema.mjs` before changing a route. Tests live in `test/`.\n";
export const AGENTS = { async: "a0000000000000001", sync: "a0000000000000002", nested: "a0000000000000003", queued: "a0000000000000004", embedded: "a0000000000000005" };
export const EMBEDDED_TASK_ID = "b7654321"; // Monitor task whose notification shares a tool_result with the embedded agent's
// preserved = 2: the Bash tool_result and the reminder that follow the last pre-boundary
// assistant record are preserved; the assistant's tool_use (also in flight) is not.
export const COMPACTION = { trigger: "auto", preTokens: 180_000, postTokens: 9_000, cumulativeDroppedTokens: 171_000, durationMs: 12_345, preserved: 2, tools: ["mcp__lorem-server__lorem_tool", "mcp__lorem-server__other_tool"] };

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(" ");

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class Session {
  constructor(sessionId, { seed, agentId = null, parentUuid = null, mainFile = null, cwd = CWD, entrypoint = "cli" }) {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.cwd = cwd;
    this.entrypoint = entrypoint;
    this.rand = rng(seed);
    this.records = [];
    this.lastUuid = parentUuid;
    this.t = Date.parse("2026-09-01T10:00:00.000Z") + seed * 1000;
    this.msgCounter = 0;
    this.uuidCounter = 0;
    this.toolCounter = 0;
    this.total = 20_000;
    this.expected = { messageIds: new Set(), requests: 0, processedInputTokens: 0, outputTokens: 0, peak: 0, turns: 0, synthetic: 0, toolCalls: 0, compactions: [], handoffBytes: {}, records: 0 };
    this.promptId = null;
  }

  lorem(chars) {
    const parts = [];
    let length = 0;
    while (length < chars) { const w = WORDS[Math.floor(this.rand() * WORDS.length)]; parts.push(w); length += w.length + 1; }
    return parts.join(" ").slice(0, chars);
  }

  numbered(lines) {
    return Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(6)}→${this.lorem(20 + Math.floor(this.rand() * 50))}`).join("\n");
  }

  uuid() { this.uuidCounter += 1; return `${this.sessionId.slice(0, 8)}-${this.agentId ?? "main"}-${String(this.uuidCounter).padStart(6, "0")}`.slice(0, 36); }
  stamp() { this.t += 1_000 + Math.floor(this.rand() * 4_000); return new Date(this.t).toISOString(); }

  base(extra = {}) {
    const uuid = this.uuid();
    const record = { parentUuid: this.lastUuid, isSidechain: this.agentId !== null, ...extra, uuid, timestamp: this.stamp(), userType: "external", entrypoint: this.entrypoint, cwd: this.cwd, sessionId: this.sessionId, version: VERSION, gitBranch: "main" };
    if (this.agentId) record.agentId = this.agentId;
    this.lastUuid = uuid;
    return record;
  }

  push(record) { this.records.push(record); this.expected.records += 1; return record; }

  state(type, fields) { return this.push({ type, ...fields, sessionId: this.sessionId }); }

  prompt(text, extra = {}) {
    this.promptId = `prompt-${this.sessionId.slice(-2)}-${this.uuidCounter + 1}`;
    this.expected.turns += 1;
    return this.push(this.base({ promptId: this.promptId, type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, promptSource: "typed", permissionMode: "auto", ...extra }));
  }

  attachment(attachment) { return this.push(this.base({ type: "attachment", attachment })); }
  reminder() { return this.attachment({ type: "total_tokens_reminder", text: `<total_tokens>${15_000_000 - this.expected.outputTokens} tokens left</total_tokens>` }); }

  /** One API response, written as one assistant record per content block; usage identical except output grows. */
  request(blocks, { model = "claude-sonnet-5", stop = "tool_use", added = 4_000 } = {}) {
    this.msgCounter += 1;
    const id = `msg_${this.sessionId.slice(-2)}${this.agentId ?? ""}_${String(this.msgCounter).padStart(4, "0")}`;
    const requestId = `req_${id}`;
    this.total += added;
    const cacheRead = this.msgCounter === 1 ? 0 : this.total - added - 1;
    const cacheCreation = this.total - cacheRead - 1;
    const output = 30 + Math.floor(this.rand() * 400) + blocks.filter((b) => b.type === "thinking").length * 120;
    const thinking = blocks.some((b) => b.type === "thinking") ? Math.floor(output / 2) : undefined;
    this.expected.messageIds.add(id);
    this.expected.requests += 1;
    this.expected.processedInputTokens += this.total;
    this.expected.outputTokens += output;
    this.expected.peak = Math.max(this.expected.peak, this.total);
    blocks.forEach((block, i) => {
      const last = i === blocks.length - 1;
      const usage = { input_tokens: 1, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead, output_tokens: last ? output : 1 + i, cache_creation: { ephemeral_5m_input_tokens: cacheCreation, ephemeral_1h_input_tokens: 0 }, service_tier: "standard", inference_geo: "not_available" };
      if (thinking !== undefined) usage.output_tokens_details = { thinking_tokens: last ? thinking : 0 };
      if (block.type === "tool_use") this.expected.toolCalls += 1;
      this.push(this.base({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [block], stop_reason: last ? stop : null, stop_sequence: null, stop_details: null, usage }, requestId, apiBlockIndex: i }));
    });
    return { id, requestId };
  }

  synthetic() {
    this.expected.synthetic += 1;
    return this.push(this.base({ type: "assistant", message: { model: "<synthetic>", id: `msg_synth_${this.uuidCounter}`, type: "message", role: "assistant", content: [{ type: "text", text: "API Error: lorem" }], stop_reason: "stop_sequence", stop_sequence: "", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }, isApiErrorMessage: true, error: "server_error", apiErrorStatus: 500 }));
  }

  toolUse(name, input) { this.toolCounter += 1; return { type: "tool_use", id: `toolu_${this.sessionId.slice(-2)}${this.agentId ?? ""}${String(this.toolCounter).padStart(4, "0")}`, name, input }; }

  toolResult(toolUse, content, toolUseResult, extra = {}) {
    const item = { type: "tool_result", tool_use_id: toolUse.id, content, is_error: false, ...extra.item };
    const record = this.base({ promptId: this.promptId, type: "user", message: { role: "user", content: [item] }, sourceToolAssistantUUID: this.records[this.records.length - 1]?.uuid });
    if (toolUseResult !== undefined) record.toolUseResult = toolUseResult;
    return this.push(record);
  }

  compact() {
    const anchor = this.lastUuid;
    const uuids = this.records.filter((r) => r.uuid).slice(-COMPACTION.preserved).map((r) => r.uuid);
    this.total = COMPACTION.postTokens + 30_000;
    const boundary = this.base({ type: "system", subtype: "compact_boundary", level: "info", content: "Conversation compacted", isMeta: false, logicalParentUuid: anchor, compactMetadata: { trigger: COMPACTION.trigger, preTokens: COMPACTION.preTokens, postTokens: COMPACTION.postTokens, cumulativeDroppedTokens: COMPACTION.cumulativeDroppedTokens, durationMs: COMPACTION.durationMs, preCompactDiscoveredTools: COMPACTION.tools, preservedSegment: { headUuid: uuids[0], anchorUuid: anchor, tailUuid: uuids[uuids.length - 1] }, preservedMessages: { anchorUuid: anchor, uuids, allUuids: uuids } } });
    boundary.parentUuid = null;
    this.push(boundary);
    this.expected.compactions.push({ atRequest: this.expected.requests, ...COMPACTION });
    const summary = `This session is being continued from a previous conversation that ran out of context. ${this.lorem(2_800)}`;
    this.push(this.base({ promptId: this.promptId, type: "user", message: { role: "user", content: summary }, isCompactSummary: true, isVisibleInTranscriptOnly: true }));
    this.expected.summaryBytes = Buffer.byteLength(summary);
    this.attachment({ type: "compact_file_reference", filename: `${CWD}/src/app.ts`, displayPath: "src/app.ts" });
    this.attachment({ type: "file", filename: `${CWD}/src/app.ts`, content: this.lorem(1_200), displayPath: "src/app.ts" });
    this.attachment({ type: "invoked_skills", skills: [{ name: "lorem-skill", path: `${HOME}/.claude/skills/lorem-skill/SKILL.md`, content: this.lorem(900) }] });
    this.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__lorem-server__lorem_tool"], addedLines: ["mcp__lorem-server__lorem_tool: lorem ipsum"], removedNames: [], readdedNames: [] });
    this.attachment({ type: "agent_listing_delta", addedTypes: ["Explore"], addedLines: ["Explore: lorem ipsum dolor"], removedTypes: [], isInitial: false, showConcurrencyNote: false });
    this.attachment({ type: "mcp_instructions_delta", addedNames: ["lorem-server"], addedBlocks: [this.lorem(300)], removedNames: [] });
    this.attachment({ type: "hook_success", hookName: "SessionStart:compact", toolUseID: null, hookEvent: "SessionStart", content: "", stdout: this.lorem(150), stderr: "", exitCode: 0, command: "echo lorem", durationMs: 12 });
  }

  turnEnd() { this.push(this.base({ type: "system", subtype: "turn_duration", durationMs: 30_000, messageCount: this.records.length, isMeta: false })); }

  write(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, this.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  summary() {
    const e = this.expected;
    return { records: e.records, requests: e.requests, distinctMessageIds: e.messageIds.size, processedInputTokens: e.processedInputTokens, outputTokens: e.outputTokens, peak: e.peak, turns: e.turns, synthetic: e.synthetic, toolCalls: e.toolCalls, compactions: e.compactions, summaryBytes: e.summaryBytes, skillBytes: e.skillBytes, handoffBytes: e.handoffBytes };
  }
}

/** A common tool-heavy turn used by every session. */
function toolTurn(s, { read = 40, bash = 1_500 } = {}) {
  const readUse = s.toolUse("Read", { file_path: `${CWD}/src/app.ts` });
  s.request([{ type: "thinking", thinking: s.lorem(400), signature: "sig" }, { type: "text", text: s.lorem(120) }, readUse]);
  const content = s.numbered(read);
  s.toolResult(readUse, content, { type: "text", file: { filePath: `${CWD}/src/app.ts`, content: content.replace(/^\s*\d+→/gm, ""), numLines: read, startLine: 1, totalLines: read } });
  s.reminder();
  const bashUse = s.toolUse("Bash", { command: "npm test", description: "Run tests" });
  s.request([bashUse], { added: 2_500 });
  const stdout = s.lorem(bash);
  s.toolResult(bashUse, stdout, { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false });
  s.reminder();
}

function plainSession() {
  const s = new Session(SESSIONS.plain, { seed: 1 });
  s.state("mode", { mode: "normal" });
  s.state("last-prompt", { lastPrompt: "lorem", leafUuid: "none" });
  s.state("ai-title", { aiTitle: "lorem ipsum" });
  s.prompt(s.lorem(300));
  s.attachment({ type: "hook_success", hookName: "UserPromptSubmit", toolUseID: null, hookEvent: "UserPromptSubmit", content: "", stdout: s.lorem(200), stderr: "", exitCode: 0, command: "echo lorem", durationMs: 5 });
  s.reminder();
  toolTurn(s);
  // Parallel tool calls answered in a single user record with two tool_result items.
  const grepUse = s.toolUse("Grep", { pattern: "lorem", path: CWD, output_mode: "content" });
  const editUse = s.toolUse("Edit", { file_path: `${CWD}/src/app.ts`, old_string: "lorem", new_string: "ipsum", replace_all: false });
  s.request([grepUse, editUse], { added: 1_200 });
  const grepOut = s.lorem(600);
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: grepUse.id, content: grepOut, is_error: false },
    { type: "tool_result", tool_use_id: editUse.id, content: "The file has been updated.", is_error: false },
  ] }, toolUseResult: { filePath: `${CWD}/src/app.ts`, oldString: "lorem", newString: "ipsum", originalFile: s.lorem(200), structuredPatch: [], userModified: false, replaceAll: false } }));
  s.reminder();
  // Skill flow: tool_use -> tiny tool_result -> isMeta body -> command_permissions.
  const skillUse = s.toolUse("Skill", { skill: "lorem-skill" });
  s.request([skillUse], { added: 800 });
  s.toolResult(skillUse, "Launching skill: lorem-skill", { success: true, commandName: "lorem-skill" });
  const skillBody = s.lorem(1_500);
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: [{ type: "text", text: skillBody }] }, isMeta: true }));
  s.expected.skillBytes = Buffer.byteLength(skillBody);
  s.attachment({ type: "command_permissions", allowedTools: ["Bash(npm test)"] });
  // Snapshots of the hidden base (system prompt + tool schemas): records, not input; never a block.
  s.attachment({ type: "prompt_snapshot", systemPrompt: [s.lorem(4_000)], tools: [{ name: "Read", description: s.lorem(300), schema: {} }], reminderFold: false });
  s.attachment({ type: "deferred_tools_record", entries: [{ name: "mcp__lorem-server__lorem_tool", description: s.lorem(60), input_schema: {}, defer_loading: true }] });
  s.reminder();
  // MCP tool with array content and array toolUseResult.
  const mcpUse = s.toolUse("mcp__lorem-server__lorem_tool", { query: "lorem" });
  s.request([mcpUse], { added: 900 });
  const mcpText = s.lorem(700);
  s.toolResult(mcpUse, [{ type: "text", text: mcpText }], [{ type: "text", text: mcpText }]);
  s.reminder();
  s.request([{ type: "text", text: s.lorem(500) }], { stop: "end_turn", added: 300 });
  s.turnEnd();
  s.synthetic();
  // Second turn: a prompt containing a raw U+2028 inside the JSON string.
  s.prompt(`${s.lorem(100)} ${s.lorem(100)}`);
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: "<local-command-stdout>lorem</local-command-stdout>" }, isVisibleInTranscriptOnly: true }));
  s.reminder();
  const webUse = s.toolUse("WebFetch", { url: "https://example.com/lorem", prompt: "lorem" });
  s.request([{ type: "text", text: s.lorem(80) }, webUse], { added: 1_000 });
  s.toolResult(webUse, s.lorem(1_100), { bytes: 1100, code: 200, codeText: "OK", result: s.lorem(1_100), durationMs: 300, url: "https://example.com/lorem" });
  s.reminder();
  s.request([{ type: "text", text: s.lorem(300) }], { stop: "end_turn", added: 500 });
  s.turnEnd();
  s.state("queue-operation", { operation: "enqueue", timestamp: new Date(s.t).toISOString(), content: s.lorem(80) });
  s.state("queue-operation", { operation: "dequeue", timestamp: new Date(s.t + 10).toISOString() });
  s.state("last-prompt", { lastPrompt: "lorem", leafUuid: s.lastUuid });
  s.state("cost-state", { totalCostUSD: 1.23, totalAPIDuration: 1000, modelUsage: {} });
  s.write(path.join(DIR, `${SESSIONS.plain}.jsonl`));
  return s.summary();
}

function compactionSession() {
  const s = new Session(SESSIONS.compaction, { seed: 2 });
  s.state("mode", { mode: "normal" });
  s.prompt(s.lorem(400));
  s.reminder();
  toolTurn(s, { read: 120, bash: 3_000 });
  toolTurn(s, { read: 90, bash: 2_000 });
  s.request([{ type: "text", text: s.lorem(600) }], { stop: "end_turn", added: 400 });
  s.turnEnd();
  s.prompt(s.lorem(250));
  s.reminder();
  toolTurn(s, { read: 200, bash: 4_000 });
  s.compact();
  s.reminder();
  toolTurn(s, { read: 30, bash: 900 });
  s.request([{ type: "text", text: s.lorem(400) }], { stop: "end_turn", added: 300 });
  s.turnEnd();
  s.write(path.join(DIR, `${SESSIONS.compaction}.jsonl`));
  return s.summary();
}

function subagentSession() {
  const s = new Session(SESSIONS.subagents, { seed: 3 });
  const subDir = path.join(DIR, SESSIONS.subagents, "subagents");
  s.state("mode", { mode: "normal" });
  s.prompt(s.lorem(500));
  s.reminder();
  toolTurn(s);
  // Async Agent: placeholder tool_result now, <task-notification> later.
  const asyncUse = s.toolUse("Agent", { description: "Explore lorem", prompt: s.lorem(600), subagent_type: "Explore" });
  const { id: launchMsg } = s.request([{ type: "text", text: s.lorem(60) }, asyncUse], { added: 700 });
  const launchedAtRequest = s.expected.requests - 1;
  const placeholder = `Async agent launched successfully. Agent ID: ${AGENTS.async}. ${s.lorem(1_000)}`;
  s.toolResult(asyncUse, [{ type: "text", text: placeholder }], { isAsync: true, status: "async_launched", agentId: AGENTS.async, description: "Explore lorem", resolvedModel: "claude-sonnet-5", prompt: s.lorem(600), outputFile: `/private/tmp/claude-501/lorem/${SESSIONS.subagents}/tasks/${AGENTS.async}.output`, canReadOutputFile: true });
  s.reminder();
  // Sync Agent: the tool_result IS the handoff.
  const syncUse = s.toolUse("Agent", { description: "Audit lorem", prompt: s.lorem(400), subagent_type: "general-purpose" });
  s.request([syncUse], { added: 500 });
  const syncLaunchedAt = s.expected.requests - 1;
  const syncResult = s.lorem(2_000);
  s.toolResult(syncUse, [{ type: "text", text: syncResult }], { isAsync: false, status: "completed", agentId: AGENTS.sync, description: "Audit lorem", totalTokens: 12_345, totalToolUseCount: 7, totalDurationMs: 60_000, content: [{ type: "text", text: syncResult }] });
  s.expected.handoffBytes[AGENTS.sync] = Buffer.byteLength(syncResult);
  const syncDeliveredAt = s.expected.requests;
  s.reminder();
  // A Monitor task notification whose task-id is not an agent: must become an attachment.
  const monitorUse = s.toolUse("Monitor", { command: "tail -f lorem.log", description: "Watch log" });
  s.request([monitorUse], { added: 300 });
  s.toolResult(monitorUse, "Monitoring started", { taskId: "b1234567", timeoutMs: 60_000, persistent: false });
  s.reminder();
  s.request([{ type: "text", text: s.lorem(200) }], { stop: "end_turn", added: 200 });
  s.turnEnd();
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: `<task-notification>\n<task-id>b1234567</task-id>\n<status>completed</status>\n<task-type>local_bash</task-type>\n<summary>${s.lorem(120)}</summary>\n</task-notification>` }, origin: { kind: "task-notification" }, promptSource: "system", queueSkipAttachments: true }));
  s.request([{ type: "text", text: s.lorem(100) }], { stop: "end_turn", added: 150 });
  // The async agent's completion.
  s.state("queue-operation", { operation: "enqueue", timestamp: new Date(s.t).toISOString(), content: s.lorem(100) });
  s.state("queue-operation", { operation: "dequeue", timestamp: new Date(s.t + 5).toISOString() });
  const notification = `<task-notification>\n<task-id>${AGENTS.async}</task-id>\n<tool-use-id>${asyncUse.id}</tool-use-id>\n<output-file>/private/tmp/claude-501/lorem/${SESSIONS.subagents}/tasks/${AGENTS.async}.output</output-file>\n<status>completed</status>\n<summary>${s.lorem(200)}</summary>\n<result>${s.lorem(2_500)}</result>\n<usage><subagent_tokens>45000</subagent_tokens><tool_uses>9</tool_uses><duration_ms>90000</duration_ms></usage>\n</task-notification>`;
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: notification }, origin: { kind: "task-notification" }, promptSource: "system", queueSkipAttachments: true }));
  s.expected.handoffBytes[AGENTS.async] = Buffer.byteLength(notification);
  const asyncDeliveredAt = s.expected.requests;
  s.reminder();
  // Partial reads: a ranged Read and a Bash `sed -n` answered in one user record; a plain Read stays full.
  const rangedRead = s.toolUse("Read", { file_path: `${CWD}/src/app.ts`, offset: 100, limit: 40 });
  const sedRead = s.toolUse("Bash", { command: "sed -n '1,20p' src/app.ts", description: "Peek" });
  s.request([rangedRead, sedRead], { added: 600 });
  const ranged = s.numbered(40);
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: rangedRead.id, content: ranged, is_error: false },
    { type: "tool_result", tool_use_id: sedRead.id, content: s.lorem(500), is_error: false },
  ] }, toolUseResult: { type: "text", file: { filePath: `${CWD}/src/app.ts`, content: ranged, numLines: 40, startLine: 100, totalLines: 400 } } }));
  s.reminder();
  // Two more async agents. The first one's notification is absorbed mid-turn as a queued_command attachment;
  // the second one's arrives inside the tool_result of a blocking Bash call, next to a Monitor notification.
  const queuedUse = s.toolUse("Agent", { description: "Queued lorem", prompt: s.lorem(300), subagent_type: "Explore" });
  const embeddedUse = s.toolUse("Agent", { description: "Embedded lorem", prompt: s.lorem(300), subagent_type: "general-purpose" });
  s.request([queuedUse, embeddedUse], { added: 500 });
  const queuedLaunchedAt = s.expected.requests - 1;
  const embeddedLaunchedAt = queuedLaunchedAt;
  s.push(s.base({ promptId: s.promptId, type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: queuedUse.id, content: [{ type: "text", text: `Async agent launched successfully. Agent ID: ${AGENTS.queued}. ${s.lorem(1_000)}` }], is_error: false },
    { type: "tool_result", tool_use_id: embeddedUse.id, content: [{ type: "text", text: `Async agent launched successfully. Agent ID: ${AGENTS.embedded}. ${s.lorem(1_000)}` }], is_error: false },
  ] }, toolUseResult: { isAsync: true, status: "async_launched", agentId: AGENTS.embedded, description: "Embedded lorem", resolvedModel: "claude-sonnet-5", prompt: s.lorem(300), outputFile: `/private/tmp/claude-501/lorem/${SESSIONS.subagents}/tasks/${AGENTS.embedded}.output`, canReadOutputFile: true } }));
  s.reminder();
  const queuedNotification = `<task-notification>\n<task-id>${AGENTS.queued}</task-id>\n<tool-use-id>${queuedUse.id}</tool-use-id>\n<output-file>/private/tmp/claude-501/lorem/${SESSIONS.subagents}/tasks/${AGENTS.queued}.output</output-file>\n<status>completed</status>\n<summary>${s.lorem(150)}</summary>\n<result>${s.lorem(1_800)}</result>\n<usage><subagent_tokens>21000</subagent_tokens><tool_uses>5</tool_uses><duration_ms>40000</duration_ms></usage>\n</task-notification>`;
  s.state("queue-operation", { operation: "enqueue", timestamp: new Date(s.t).toISOString(), content: queuedNotification });
  s.state("queue-operation", { operation: "remove", timestamp: new Date(s.t + 5).toISOString(), content: queuedNotification, reason: "absorbed_mid_turn" });
  s.attachment({ type: "queued_command", prompt: queuedNotification, commandMode: "task-notification", timestamp: new Date(s.t).toISOString() });
  s.expected.handoffBytes[AGENTS.queued] = Buffer.byteLength(queuedNotification);
  const queuedDeliveredAt = s.expected.requests;
  const waitUse = s.toolUse("Bash", { command: "sleep 30 && echo done", description: "Wait" });
  s.request([waitUse], { added: 400 });
  const embeddedNotification = `<task-notification>\n<task-id>${AGENTS.embedded}</task-id>\n<tool-use-id>${embeddedUse.id}</tool-use-id>\n<output-file>/private/tmp/claude-501/lorem/${SESSIONS.subagents}/tasks/${AGENTS.embedded}.output</output-file>\n<status>completed</status>\n<summary>${s.lorem(120)}</summary>\n<result>${s.lorem(2_200)}</result>\n<usage><subagent_tokens>33000</subagent_tokens><tool_uses>8</tool_uses><duration_ms>70000</duration_ms></usage>\n</task-notification>`;
  const monitorNotification = `<task-notification>\n<task-id>${EMBEDDED_TASK_ID}</task-id>\n<status>completed</status>\n<task-type>local_bash</task-type>\n<summary>${s.lorem(90)}</summary>\n</task-notification>`;
  const waitStdout = `done\n${s.lorem(300)}`;
  s.toolResult(waitUse, `${waitStdout}\n${embeddedNotification}\n${monitorNotification}`, { stdout: waitStdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false });
  s.expected.handoffBytes[AGENTS.embedded] = Buffer.byteLength(embeddedNotification);
  s.expected.embeddedRemainderBytes = Buffer.byteLength(`${waitStdout}\n\n`);
  s.expected.embeddedMonitorBytes = Buffer.byteLength(monitorNotification);
  const embeddedDeliveredAt = s.expected.requests;
  s.reminder();
  s.request([{ type: "text", text: s.lorem(300) }], { stop: "end_turn", added: 800 });
  s.turnEnd();
  s.write(path.join(DIR, `${SESSIONS.subagents}.jsonl`));

  // Child 1: async Explore agent; launches a nested agent whose result arrives synchronously.
  const child = new Session(SESSIONS.subagents, { seed: 31, agentId: AGENTS.async });
  child.prompt(child.lorem(600), { origin: undefined, promptSource: undefined, permissionMode: undefined });
  child.records[child.records.length - 1].parentUuid = null;
  child.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__lorem-server__lorem_tool"], addedLines: ["mcp__lorem-server__lorem_tool: lorem"], removedNames: [], readdedNames: [] });
  child.attachment({ type: "skill_listing", content: child.lorem(2_000), skillCount: 3, isInitial: true, names: ["lorem-skill", "ipsum-skill", "dolor-skill"] });
  toolTurn(child, { read: 50, bash: 1_000 });
  const nestedUse = child.toolUse("Agent", { description: "Nested lorem", prompt: child.lorem(300), subagent_type: "Explore" });
  child.request([nestedUse], { added: 400 });
  const nestedLaunchedAt = child.expected.requests - 1;
  const nestedResult = child.lorem(900);
  child.toolResult(nestedUse, [{ type: "text", text: nestedResult }], { isAsync: false, status: "completed", agentId: AGENTS.nested, description: "Nested lorem", totalTokens: 3_000, totalToolUseCount: 2, totalDurationMs: 20_000 });
  child.expected.handoffBytes[AGENTS.nested] = Buffer.byteLength(nestedResult);
  const nestedDeliveredAt = child.expected.requests;
  child.request([{ type: "text", text: child.lorem(700) }], { stop: "end_turn", added: 300 });
  child.write(path.join(subDir, `agent-${AGENTS.async}.jsonl`));
  fs.writeFileSync(path.join(subDir, `agent-${AGENTS.async}.meta.json`), JSON.stringify({ agentType: "Explore", description: "Explore lorem", toolUseId: asyncUse.id, spawnDepth: 1 }, null, 2));

  // Child 2: sync general-purpose agent.
  const sync = new Session(SESSIONS.subagents, { seed: 32, agentId: AGENTS.sync });
  sync.prompt(sync.lorem(400), { origin: undefined, promptSource: undefined, permissionMode: undefined });
  sync.records[sync.records.length - 1].parentUuid = null;
  sync.attachment({ type: "skill_listing", content: sync.lorem(2_000), skillCount: 3, isInitial: true, names: ["lorem-skill"] });
  toolTurn(sync, { read: 80, bash: 2_500 });
  toolTurn(sync, { read: 20, bash: 500 });
  sync.request([{ type: "text", text: sync.lorem(2_000) }], { stop: "end_turn", added: 600 });
  sync.write(path.join(subDir, `agent-${AGENTS.sync}.jsonl`));
  fs.writeFileSync(path.join(subDir, `agent-${AGENTS.sync}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "Audit lorem " + "x".repeat(100), toolUseId: syncUse.id, spawnDepth: 1, model: "claude-sonnet-5" }, null, 2));

  // Child 3: nested (depth 2) agent spawned by child 1.
  const nested = new Session(SESSIONS.subagents, { seed: 33, agentId: AGENTS.nested });
  nested.prompt(nested.lorem(300), { origin: undefined, promptSource: undefined, permissionMode: undefined });
  nested.records[nested.records.length - 1].parentUuid = null;
  toolTurn(nested, { read: 10, bash: 300 });
  nested.request([{ type: "text", text: nested.lorem(900) }], { stop: "end_turn", added: 200 });
  nested.write(path.join(subDir, `agent-${AGENTS.nested}.jsonl`));
  fs.writeFileSync(path.join(subDir, `agent-${AGENTS.nested}.meta.json`), JSON.stringify({ agentType: "Explore", description: "Nested lorem", toolUseId: nestedUse.id, spawnDepth: 2, parentAgentId: AGENTS.async }, null, 2));

  // Children 4 and 5: the agents delivered through a queued_command attachment and a tool_result.
  const late = {};
  for (const [agentId, seed, agentType, toolUseId] of [[AGENTS.queued, 34, "Explore", queuedUse.id], [AGENTS.embedded, 35, "general-purpose", embeddedUse.id]]) {
    const agent = new Session(SESSIONS.subagents, { seed, agentId });
    agent.prompt(agent.lorem(300), { origin: undefined, promptSource: undefined, permissionMode: undefined });
    agent.records[agent.records.length - 1].parentUuid = null;
    toolTurn(agent, { read: 15, bash: 400 });
    agent.request([{ type: "text", text: agent.lorem(600) }], { stop: "end_turn", added: 200 });
    agent.write(path.join(subDir, `agent-${agentId}.jsonl`));
    fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType, description: `${agentType} lorem`, toolUseId, spawnDepth: 1 }, null, 2));
    late[agentId] = agent.summary();
  }

  return {
    ...s.summary(),
    embeddedRemainderBytes: s.expected.embeddedRemainderBytes,
    embeddedMonitorBytes: s.expected.embeddedMonitorBytes,
    launchMessageId: launchMsg,
    subagents: {
      [AGENTS.async]: { ...child.summary(), launchedAtRequest, deliveredAtRequest: asyncDeliveredAt, parent: "main", depth: 1 },
      [AGENTS.sync]: { ...sync.summary(), launchedAtRequest: syncLaunchedAt, deliveredAtRequest: syncDeliveredAt, parent: "main", depth: 1 },
      [AGENTS.nested]: { ...nested.summary(), launchedAtRequest: nestedLaunchedAt, deliveredAtRequest: nestedDeliveredAt, parent: AGENTS.async, depth: 2 },
      [AGENTS.queued]: { ...late[AGENTS.queued], launchedAtRequest: queuedLaunchedAt, deliveredAtRequest: queuedDeliveredAt, parent: "main", depth: 1, via: "attachment" },
      [AGENTS.embedded]: { ...late[AGENTS.embedded], launchedAtRequest: embeddedLaunchedAt, deliveredAtRequest: embeddedDeliveredAt, parent: "main", depth: 1, via: "tool_result" },
    },
  };
}

/**
 * An SDK-driven harness call as seen 56 times on the reference machine (ADR-005 section 2): `entrypoint: sdk-cli`,
 * a Haiku model, one prompt, listings re-injected, one request (thinking + text), no tool call, temp cwd.
 */
function harnessSession() {
  const s = new Session(SESSIONS.harness, { seed: 4, cwd: HARNESS_CWD, entrypoint: "sdk-cli" });
  s.prompt(s.lorem(900));
  s.attachment({ type: "deferred_tools_delta", addedNames: ["mcp__lorem-server__lorem_tool"], addedLines: ["mcp__lorem-server__lorem_tool: lorem"], removedNames: [], readdedNames: [] });
  s.attachment({ type: "agent_listing_delta", addedTypes: ["Explore"], addedLines: ["Explore: lorem ipsum dolor"], removedTypes: [], isInitial: true, showConcurrencyNote: false });
  s.attachment({ type: "skill_listing", content: s.lorem(1_500), skillCount: 2, isInitial: true, names: ["lorem-skill", "ipsum-skill"] });
  s.reminder();
  s.request([{ type: "thinking", thinking: s.lorem(300), signature: "sig" }, { type: "text", text: s.lorem(700) }], { model: "claude-haiku-4-5", stop: "end_turn", added: 3_000 });
  s.turnEnd();
  s.write(path.join(DIR, `${SESSIONS.harness}.jsonl`));
  return s.summary();
}

/**
 * An interactive session in a temp copy of a repo (ADR-005 section 2): a `nested_memory` instruction file
 * (NESTED_MEMORY_TEXT), six whole-file Reads of TEMP_TARGETS and a Bash `cat` of the sixth; the evidence a
 * launched repo can be matched against (nested-hash, path-overlap). Not a harness run: it calls tools.
 */
function tempCopySession() {
  const s = new Session(SESSIONS.tempCopy, { seed: 5, cwd: TEMP_COPY_CWD });
  s.state("mode", { mode: "normal" });
  s.prompt(s.lorem(400));
  s.attachment({ type: "nested_memory", path: `${TEMP_COPY_CWD}/${NESTED_MEMORY_PATH}`, content: NESTED_MEMORY_TEXT, displayPath: NESTED_MEMORY_PATH });
  s.reminder();
  for (const target of TEMP_TARGETS.slice(0, 5)) {
    const readUse = s.toolUse("Read", { file_path: `${TEMP_COPY_CWD}/${target}` });
    s.request([{ type: "text", text: s.lorem(60) }, readUse], { added: 900 });
    const content = s.numbered(12);
    s.toolResult(readUse, content, { type: "text", file: { filePath: `${TEMP_COPY_CWD}/${target}`, content: content.replace(/^\s*\d+→/gm, ""), numLines: 12, startLine: 1, totalLines: 12 } });
    s.reminder();
  }
  const catUse = s.toolUse("Bash", { command: `cat ${TEMP_TARGETS[5]}`, description: "Read util" });
  s.request([catUse], { added: 500 });
  const stdout = s.lorem(600);
  s.toolResult(catUse, stdout, { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false });
  s.reminder();
  s.request([{ type: "text", text: s.lorem(300) }], { stop: "end_turn", added: 300 });
  s.turnEnd();
  s.write(path.join(DIR, `${SESSIONS.tempCopy}.jsonl`));
  return s.summary();
}

export function generate() {
  fs.rmSync(path.join(DIR, SESSIONS.subagents), { recursive: true, force: true });
  const expected = { plain: plainSession(), compaction: compactionSession(), subagents: subagentSession(), harness: harnessSession(), tempCopy: tempCopySession() };
  fs.writeFileSync(path.join(DIR, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = generate();
  for (const [name, e] of Object.entries(expected)) console.log(`${name}: ${e.records} records, ${e.requests} requests, ${e.compactions.length} compactions`);
}
