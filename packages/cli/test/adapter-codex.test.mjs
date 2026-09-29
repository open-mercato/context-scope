import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_ADAPTER_VERSION, DEFAULT_CODEX_WINDOW, IMAGE_TOKENS, parseCodexRollout } from "../src/adapters/codex.mjs";
import { classifyCodexCall, classifyCommand, extractStringProperty, inspectToolOutput, relativeTarget, splitSegments, tokenize } from "../src/adapters/codex-tools.mjs";
import { readJsonl } from "../src/ir/jsonl.mjs";
import { estimateTokens } from "../src/ir/estimate.mjs";
import { projectKeyFor } from "../src/ir/project.mjs";
import {
  AGENTS_MD_CHARS, BASE_INSTRUCTIONS_CHARS, BOOTSTRAP_SUMMARY_CHARS, COMPACTION_SUMMARY_CHARS, CWD, FIXTURES, HOME,
  THREAD_CHILD, THREAD_DESKTOP, THREAD_PLAIN, WINDOW, writeFixtures,
} from "./fixtures/codex/make-fixtures.mjs";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const fixture = (name) => path.join(fixturesDir, name);

// Regenerate on every run so the checked-in files can never drift from the generator.
writeFixtures(fixturesDir);

const CONTENT_KEYS = ["text", "content", "message", "output", "arguments", "input", "encrypted_content", "stdout", "stderr", "base_instructions", "user_instructions"];

/** No content, no content-bearing keys, no absolute paths anywhere in the serialised run. */
function assertNoContent(run) {
  const json = JSON.stringify(run);
  assert.ok(!json.includes("LOREMSENTINEL"), "fixture text leaked into the run");
  assert.ok(!/\b(ipsum|consectetur|adipiscing)\b/.test(json), "lorem words leaked into the run");
  assert.ok(!json.includes(HOME), `home directory leaked: ${HOME}`);
  assert.ok(!json.includes(CWD), `cwd leaked: ${CWD}`);
  assert.ok(!json.includes(fixturesDir), "fixture directory leaked");
  assert.ok(!/"\/(Users|home|private|tmp|var)\//.test(json), "absolute path leaked");
  for (const key of CONTENT_KEYS) assert.ok(!json.includes(`"${key}":"`), `content key "${key}" carries a string in the run`);
}

async function tokenCountsFromFixture(name) {
  const totals = [];
  let withInfo = 0;
  let resets = 0;
  let records = 0;
  let unparsable = 0;
  for await (const record of readJsonl(fixture(name))) {
    records += 1;
    if (record.error) { unparsable += 1; continue; }
    const payload = record.value.payload;
    if (record.value.type !== "event_msg" || payload?.type !== "token_count") continue;
    if (!payload.info) continue;
    withInfo += 1;
    if (payload.info.last_token_usage.input_tokens === 0) { resets += 1; continue; }
    totals.push(payload.info.last_token_usage.input_tokens);
  }
  return { totals, withInfo, resets, records, unparsable };
}

function sumComposition(request) {
  return Object.values(request.composition).reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// plain cli rollout
// ---------------------------------------------------------------------------

test("plain cli rollout: requests, totals, window, identity", async () => {
  const run = await parseCodexRollout(fixture("plain-cli.jsonl"), { home: HOME });
  const expected = await tokenCountsFromFixture("plain-cli.jsonl");
  const scope = run.scopes[0];
  assert.equal(run.id, `codex:${THREAD_PLAIN}`);
  assert.equal(run.vendor, "codex");
  assert.equal(run.sessionId, THREAD_PLAIN);
  assert.equal(run.kind, "main-run");
  assert.equal(run.entrypoint, "cli");
  assert.equal(run.cliVersion, "0.150.1");
  assert.equal(run.gitBranch, "feature/synthetic");
  assert.equal(run.parentThreadId, undefined);
  assert.equal(run.spawnDepth, 0);
  assert.equal(run.coverage.adapterVersion, CODEX_ADAPTER_VERSION);
  assert.equal(scope.requests.length, expected.withInfo - expected.resets);
  assert.equal(scope.requests.length, 6);
  assert.deepEqual(scope.requests.map((request) => request.usage.total), expected.totals);
  for (const request of scope.requests) {
    assert.equal(request.usage.total, request.usage.input, "total must equal input_tokens");
    assert.ok(request.usage.cacheRead <= request.usage.input);
    assert.equal(request.usage.cacheCreation, request.index === 0 ? 7_500 : 0, "cache_write_input_tokens is read when present (0.146+)");
    assert.equal(request.deltaCheck, undefined, "deltaCheck is Claude arithmetic and never set on Codex requests");
    assert.equal(sumComposition(request), request.usage.total, `composition sums to total for request ${request.index}`);
    assert.equal(request.composition.assistant_thinking, undefined);
  }
  assert.deepEqual(run.window, { value: WINDOW, provenance: "observed.vendor" });
  assert.equal(run.summary.peak.value, 32_600);
  assert.equal(run.project.displayName, "orchard");
  assert.equal(run.project.cwdDisplay, "~/work/orchard");
  assert.match(run.project.key, /^orchard-[0-9a-f]{8}$/);
  assert.equal(run.project.key, projectKeyFor(CWD));
  assert.ok(!path.isAbsolute(run.source.file));
  assertNoContent(run);
});

test("plain cli rollout: turns follow user_message events and request ids are synthetic", async () => {
  const run = await parseCodexRollout(fixture("plain-cli.jsonl"), { home: HOME });
  const turns = run.scopes[0].requests.map((request) => request.turn);
  assert.deepEqual(turns, [1, 1, 1, 2, 2, 2]);
  assert.equal(run.scopes[0].requests[0].id, "t1-r0");
  assert.equal(run.summary.turns, 2);
  assert.deepEqual(run.summary.models, ["gpt-5.6-sol"]);
});

test("plain cli rollout: instruction, system and attachment blocks are labelled without content", async () => {
  const run = await parseCodexRollout(fixture("plain-cli.jsonl"), { home: HOME });
  const blocks = run.scopes[0].blocks;
  const system = blocks.filter((block) => block.category === "system");
  assert.equal(system.length, 1, "duplicate session_meta must not duplicate the base_instructions block");
  assert.equal(system[0].label, "base_instructions");
  assert.equal(system[0].firstRequest, 0);
  assert.equal(system[0].estTokens, Math.round(estimateTokens("x".repeat(BASE_INSTRUCTIONS_CHARS), "prose") * 0.95));
  assert.equal(run.baseInstructionsTokens, system[0].estTokens);
  assert.equal(run.coverage.syntheticRecordsSkipped, 2, "duplicate meta + null-info token_count");

  const instructions = blocks.filter((block) => block.category === "instructions");
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].label, "AGENTS.md");
  assert.equal(instructions[0].attachmentType, "agents_md");
  assert.ok(instructions[0].bytes > AGENTS_MD_CHARS);
  assert.equal(instructions[0].firstRequest, 0);
  assert.deepEqual(run.instructionsObserved, { chars: AGENTS_MD_CHARS - 100, provenance: "observed.artifact" });

  const skills = blocks.filter((block) => block.category === "skills");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].attachmentType, "skills_instructions");

  const attachments = blocks.filter((block) => block.category === "attachments").map((block) => block.attachmentType);
  assert.deepEqual(attachments, ["permissions_instructions", "collaboration_mode", "apps_instructions", "plugins_instructions", "environment_context", "image", "image"]);
  const imageBlock = blocks.find((block) => block.attachmentType === "image" && block.estTokens === IMAGE_TOKENS);
  assert.ok(imageBlock, "input_image part uses the fixed image token estimate");

  const user = blocks.filter((block) => block.category === "user");
  assert.equal(user.length, 2);
  assert.equal(user[0].firstRequest, 0);
  assert.equal(user[0].label, "user");
  assert.equal(user[1].firstRequest, 3, "turn-2 prompt is input to the first request of turn 2");
  for (const block of blocks) {
    assert.match(block.hash, /^[0-9a-f]{40}$/);
    assert.ok(block.bytes >= 0);
    assert.ok(!("text" in block));
  }
});

test("plain cli rollout: request/block indexing follows the contract", async () => {
  const run = await parseCodexRollout(fixture("plain-cli.jsonl"), { home: HOME });
  const blocks = run.scopes[0].blocks;
  const thinking = blocks.filter((block) => block.category === "assistant_thinking");
  assert.equal(thinking.length, 4);
  assert.equal(thinking[0].firstRequest, 1, "reasoning produced by request 0 is input to request 1");
  assert.equal(thinking[0].label, "reasoning");
  assert.ok(thinking[0].bytes >= 1400);
  const calls = blocks.filter((block) => block.category === "tool_call");
  assert.equal(calls[0].firstRequest, 1);
  const results = blocks.filter((block) => block.category.startsWith("tool_result."));
  assert.equal(results[0].firstRequest, 1, "tool output that follows the call is input to the next request");
  const finalAnswer = blocks.filter((block) => block.category === "assistant_text").pop();
  assert.equal(finalAnswer.firstRequest, 6, "last assistant message attaches to a request that never came");
  assert.equal(run.scopes[0].requests[1].newBlockIds.length, 4);
  assert.deepEqual(run.summary.topBlocks[0].category, "tool_result.file");
});

test("plain cli rollout: tool calls are classified with repo-relative targets and truncation is detected", async () => {
  const run = await parseCodexRollout(fixture("plain-cli.jsonl"), { home: HOME });
  const blocks = run.scopes[0].blocks;
  const calls = blocks.filter((block) => block.category === "tool_call");
  assert.deepEqual(calls.map((block) => [block.tool.name, block.tool.kind, block.tool.target]), [
    ["exec", "file", "packages/core/src/index.ts"],
    ["exec_command", "search", "packages/core/src"],
    ["web_search", "web", undefined],
    ["exec", "edit", "packages/core/src/index.ts"],
    ["exec", "shell", undefined],
  ]);
  assert.deepEqual(calls.map((block) => block.tool.partial), [true, undefined, undefined, undefined, true], "sed -n and | tail -n are partial reads");
  assert.equal(calls[0].tool.subtool, "exec_command");
  assert.equal(calls[3].tool.subtool, "apply_patch");
  assert.equal(calls[3].tool.files, 1);
  assert.equal(calls[0].toolUseId, "call_1");
  assert.match(calls[0].tool.argsHash, /^[0-9a-f]{40}$/);
  assert.equal(run.scopes[0].toolCalls, 5);

  const fileResult = blocks.find((block) => block.category === "tool_result.file");
  assert.equal(fileResult.toolUseId, "call_1");
  assert.equal(fileResult.tool.truncated, true);
  assert.equal(fileResult.tool.originalTokens, 9000);
  assert.equal(fileResult.tool.target, "packages/core/src/index.ts");
  assert.equal(fileResult.tool.partial, true, "the result carries the call's partial flag");
  assert.equal(fileResult.kind, "code");
  assert.ok(fileResult.bytes > 30_000, "size is the wrapped output the model saw");

  const searchResult = blocks.find((block) => block.category === "tool_result.search");
  assert.equal(searchResult.tool.truncated, true);
  assert.equal(searchResult.tool.originalTokens, 750);
  assert.equal(searchResult.tool.omittedTokens, 350);

  const editResult = blocks.find((block) => block.toolUseId === "call_3" && block.category !== "tool_call");
  assert.equal(editResult.category, "tool_result.other");
  assert.equal(editResult.tool.kind, "edit");

  assert.equal(searchResult.tool.partial, undefined);
  const shellResult = blocks.find((block) => block.category === "tool_result.shell");
  assert.equal(shellResult.tool.partial, true);
  assert.equal(shellResult.tool.isError, true);
  assert.equal(shellResult.tool.truncated, undefined);
  assert.equal(run.coverage.truncatedOutputs, 2);
});

test("plain cli rollout: unknown record types are counted, a trailing partial line and U+2028 never throw", async () => {
  const run = await parseCodexRollout(fixture("plain-cli.jsonl"), { home: HOME });
  const expected = await tokenCountsFromFixture("plain-cli.jsonl");
  assert.equal(run.coverage.unparsedTypes.future_record, 1);
  assert.equal(run.coverage.unparsedTypes["<invalid-json>"], 1);
  assert.equal(expected.unparsable, 1);
  assert.equal(run.coverage.unparsedRecords, 2);
  assert.equal(run.coverage.records, expected.records);
  assert.equal(run.coverage.requests, 6);
  assert.equal(run.coverage.requestsWithoutNewBlocks, 0);
  assert.ok(run.coverage.estimatorErrorP95 >= 0);
  assert.ok(run.activeMs > 0);
  assert.equal(run.scopes[0].status, "completed");
});

test("a raw U+2028 inside a JSON string is one record, not two", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-u2028-"));
  const file = path.join(dir, "rollout-u2028.jsonl");
  const text = `LOREMSENTINEL first line second line ${"lorem ".repeat(50)}`;
  const lines = [
    JSON.stringify({ timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: "u2028", cwd: CWD, source: "cli", cli_version: "0.150.1", base_instructions: { text: "LOREMSENTINEL base" } } }),
    JSON.stringify({ timestamp: "2026-09-01T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
    JSON.stringify({ timestamp: "2026-09-01T10:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 5010 }, model_context_window: 100_000 }, rate_limits: null } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  const run = await parseCodexRollout(file, { home: HOME });
  assert.equal(run.coverage.records, 3);
  assert.equal(run.coverage.unparsedRecords, 0);
  const user = run.scopes[0].blocks.find((block) => block.category === "user");
  assert.equal(user.bytes, Buffer.byteLength(text, "utf8"));
  assert.deepEqual(run.window, { value: 100_000, provenance: "observed.vendor" });
  assertNoContent(run);
});

test("cacheCreation stays undefined when token_count carries no cache_write field (<= 0.132)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-cache-"));
  const file = path.join(dir, "rollout-nocache.jsonl");
  const lines = [
    JSON.stringify({ timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: "nocache", cwd: CWD, source: "cli", cli_version: "0.132.0" } }),
    JSON.stringify({ timestamp: "2026-09-01T10:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 5010 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 5010 }, model_context_window: WINDOW }, rate_limits: null } }),
    JSON.stringify({ timestamp: "2026-09-01T10:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 11000, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 11020 }, last_token_usage: { input_tokens: 6000, cached_input_tokens: 4000, cache_creation_tokens: 250, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 6010 }, model_context_window: WINDOW }, rate_limits: null } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  const run = await parseCodexRollout(file, { home: HOME });
  const [first, second] = run.scopes[0].requests;
  assert.equal(first.usage.cacheCreation, undefined);
  assert.equal(second.usage.cacheCreation, 250, "any numeric cache_creation*/cache_write* field counts");
  assert.equal(first.usage.total, 5000);
  assert.equal(second.usage.total, 6000, "Usage.total is unchanged");
  assert.equal(second.deltaCheck, undefined);
});

test("window falls back to the estimated default when no vendor value exists", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-window-"));
  const file = path.join(dir, "rollout-nowindow.jsonl");
  writeFileSync(file, JSON.stringify({ timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: "nowin", cwd: CWD, source: "cli" } }) + "\n", "utf8");
  const run = await parseCodexRollout(file, { home: HOME });
  assert.deepEqual(run.window, { value: DEFAULT_CODEX_WINDOW, provenance: "estimated.local" });
  assert.equal(run.scopes[0].requests.length, 0);
  assert.equal(run.summary.peak.value, 0);
});

// ---------------------------------------------------------------------------
// desktop rollout with a real compaction and an orchestrated child
// ---------------------------------------------------------------------------

test("compacted desktop rollout: compaction pre/post are derived and the reset marker is skipped", async () => {
  const run = await parseCodexRollout(fixture("compacted-desktop.jsonl"), { home: HOME });
  const expected = await tokenCountsFromFixture("compacted-desktop.jsonl");
  const scope = run.scopes[0];
  assert.equal(expected.resets, 1);
  assert.equal(scope.requests.length, expected.withInfo - expected.resets);
  assert.deepEqual(scope.requests.map((request) => request.usage.total), expected.totals);
  assert.equal(run.entrypoint, "vscode");
  assert.equal(run.gitBranch, "main");
  assert.equal(run.dynamicTools.count, 4);
  assert.equal(scope.blocks.filter((block) => block.label === "dynamic_tools").length, 0);

  assert.equal(scope.compactions.length, 1);
  const [compaction] = scope.compactions;
  assert.equal(compaction.id, "c1");
  assert.equal(compaction.atRequest, 5);
  assert.equal(compaction.trigger, "auto");
  assert.deepEqual(compaction.preTokens, { value: 225_000, provenance: "derived.exact" });
  assert.deepEqual(compaction.postTokens, { value: 30_000, provenance: "derived.exact" });
  assert.deepEqual(compaction.droppedTokens, { value: 195_000, provenance: "derived.exact" });
  assert.equal(compaction.preservedMessages, 2);
  assert.equal(scope.requests[5].compactionBefore, "c1");
  assert.equal(scope.requests[4].compactionBefore, undefined);

  const summary = scope.blocks.find((block) => block.id === compaction.summaryBlockId);
  assert.equal(summary.category, "compaction_summary");
  assert.equal(summary.label, "compaction (encrypted)");
  assert.equal(summary.bytes, COMPACTION_SUMMARY_CHARS);
  assert.equal(summary.firstRequest, 5);
  assert.equal(summary.lastRequest, undefined);
  assert.ok(scope.requests[5].composition.compaction_summary > 0);

  const pre = scope.blocks.filter((block) => block.firstRequest < 5);
  assert.ok(pre.length > 5);
  for (const block of pre) { assert.equal(block.droppedBy, "c1"); assert.equal(block.lastRequest, 4); }
  const inFlight = scope.blocks.filter((block) => block.droppedBy === "c1" && block.firstRequest === 5);
  assert.ok(inFlight.length >= 1, "blocks produced by request 4 never entered the post-compaction window");
  for (const block of inFlight) assert.equal(block.lastRequest, 4);
  assert.equal(scope.requests[5].composition["tool_result.web"], undefined, "pre-compaction web output is gone after the boundary");
  const reSent = scope.blocks.filter((block) => block.firstRequest === 5 && block.lastRequest === undefined).map((block) => block.label);
  assert.deepEqual(reSent, ["base_instructions", "AGENTS.md", "environment_context", "collaboration_mode", "compaction (encrypted)", "user_instructions"]);
  for (const request of scope.requests) assert.equal(sumComposition(request), request.usage.total);
  assertNoContent(run);
});

test("compacted desktop rollout: turn_context.user_instructions only adds a block when its hash changes", async () => {
  const run = await parseCodexRollout(fixture("compacted-desktop.jsonl"), { home: HOME });
  const instructions = run.scopes[0].blocks.filter((block) => block.attachmentType === "user_instructions");
  assert.equal(instructions.length, 2);
  assert.notEqual(instructions[0].hash, instructions[1].hash);
  assert.equal(instructions[0].firstRequest, 0);
  assert.equal(instructions[1].firstRequest, 5);
  assert.equal(instructions[0].category, "instructions");
});

test("compacted desktop rollout: command classification across file/search/web/shell", async () => {
  const run = await parseCodexRollout(fixture("compacted-desktop.jsonl"), { home: HOME });
  const calls = run.scopes[0].blocks.filter((block) => block.category === "tool_call" && block.tool.name === "exec");
  assert.deepEqual(calls.map((block) => `${block.tool.kind}:${block.tool.target ?? "-"}`), [
    "file:packages/core/src/store.ts",
    "search:packages",
    "file:packages/core/src/index.ts",
    "web:-",
    "shell:-",
    "file:packages/core/src/store.ts",
  ]);
  const categories = run.scopes[0].blocks.filter((block) => block.toolUseId?.startsWith("call_10")).filter((block) => block.category !== "tool_call").map((block) => block.category);
  assert.deepEqual(categories, ["tool_result.file", "tool_result.search", "tool_result.file", "tool_result.web", "tool_result.shell"]);
});

test("compacted desktop rollout: agent tools, spawned thread linkage and the handoff block", async () => {
  const siblingIndex = new Map([
    [THREAD_CHILD, { path: "child.jsonl", parentThreadId: THREAD_DESKTOP }],
    ["01a00000-0000-7000-8000-0000000000ff", { path: "other.jsonl", parentThreadId: "someone-else" }],
  ]);
  const run = await parseCodexRollout(fixture("compacted-desktop.jsonl"), { home: HOME, siblingIndex });
  const blocks = run.scopes[0].blocks;
  const agentCalls = blocks.filter((block) => block.category === "tool_call" && block.tool.kind === "agent");
  assert.deepEqual(agentCalls.map((block) => block.tool.name), ["spawn_agent", "wait_agent"]);
  const spawnResult = blocks.find((block) => block.toolUseId === "call_201" && block.category !== "tool_call");
  assert.equal(spawnResult.category, "tool_result.other");
  const waitResult = blocks.find((block) => block.toolUseId === "call_202" && block.category !== "tool_call");
  assert.equal(waitResult.category, "tool_result.other", "a status-only wait_agent output is not a handoff");
  const handoff = blocks.filter((block) => block.category === "subagent_handoff");
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].agentId, THREAD_CHILD, "agent path resolved to the child thread id via sub_agent_activity");
  assert.equal(handoff[0].label, "agent_message");
  assert.ok(handoff[0].bytes >= 3000);
  assert.equal(handoff[0].firstRequest, 8);
  assert.deepEqual(run.spawnedThreadIds, [THREAD_CHILD]);
  assert.equal(run.coverage.unresolvedHandoffs, 0);
  assert.equal(run.summary.turns, 1);
  // Parent-side handoff record for the index to join with the child run (backend #5).
  assert.deepEqual(Object.keys(run.handoffsByThread), [THREAD_CHILD]);
  const record = run.handoffsByThread[THREAD_CHILD];
  assert.equal(record.blockId, handoff[0].id);
  assert.deepEqual(record.tokens, { value: handoff[0].estTokens, provenance: "estimated.local" });
  assert.equal(record.deliveredAtRequest, 8);
  assert.equal(record.blocks, 1);
  const spawnCall = blocks.find((block) => block.toolUseId === "call_201" && block.category === "tool_call");
  assert.equal(record.launchedAtRequest, spawnCall.firstRequest - 1, "launched at the request that produced spawn_agent");
  assertNoContent(run);
});

test("thread_spawn child: a parent handoff record fills scope.handoff with the child's compression ratio", async () => {
  const parent = await parseCodexRollout(fixture("compacted-desktop.jsonl"), { home: HOME });
  const child = await parseCodexRollout(fixture("thread-spawn-child.jsonl"), { home: HOME, parentHandoffs: parent.handoffsByThread });
  const scope = child.scopes[0];
  const record = parent.handoffsByThread[THREAD_CHILD];
  assert.equal(scope.handoff.blockId, record.blockId);
  assert.equal(scope.handoff.tokens.value, record.tokens.value);
  assert.equal(scope.handoff.compressionRatio.value, Number((scope.peak.value / record.tokens.value).toFixed(2)));
  assert.equal(scope.handoff.compressionRatio.provenance, "derived.exact");
  assert.equal(scope.deliveredAtRequest, record.deliveredAtRequest);
  assert.equal(scope.launchedAtRequest, record.launchedAtRequest);
  assert.equal(child.handoffsByThread, undefined, "the child received no handoffs itself");
  const plain = await parseCodexRollout(fixture("thread-spawn-child.jsonl"), { home: HOME });
  assert.equal(plain.scopes[0].handoff, undefined);
  assertNoContent(child);
});

// ---------------------------------------------------------------------------
// thread_spawn child with a fork bootstrap
// ---------------------------------------------------------------------------

test("thread_spawn child: identity comes from the child meta, the bootstrap is not a compaction", async () => {
  const run = await parseCodexRollout(fixture("thread-spawn-child.jsonl"), { home: HOME });
  const scope = run.scopes[0];
  assert.equal(run.id, `codex:${THREAD_CHILD}`);
  assert.equal(run.kind, "subagent-run");
  assert.equal(run.entrypoint, "subagent:thread_spawn");
  assert.equal(run.parentThreadId, THREAD_DESKTOP);
  assert.equal(run.forkedFromThreadId, THREAD_DESKTOP);
  assert.equal(run.spawnDepth, 1);
  assert.equal(run.forkBootstrap, true);
  assert.equal(run.threadSource, "subagent");
  assert.equal(scope.agentType, "Darwin");
  assert.equal(scope.description, "worker_a");
  assert.equal(scope.depth, 1);
  assert.equal(scope.compactions.length, 0);
  assert.equal(run.coverage.syntheticRecordsSkipped, 0, "the parent meta copy is recorded, not counted as a duplicate");
  assert.equal(scope.blocks.filter((block) => block.category === "system").length, 1);

  const bootstrap = scope.blocks.find((block) => block.category === "compaction_summary");
  assert.equal(bootstrap.label, "fork bootstrap (encrypted)");
  assert.equal(bootstrap.bytes, BOOTSTRAP_SUMMARY_CHARS);
  assert.equal(bootstrap.firstRequest, 0);
  assert.equal(bootstrap.droppedBy, undefined);

  const instructions = scope.blocks.filter((block) => block.category === "instructions").map((block) => [block.label, block.attachmentType]);
  assert.deepEqual(instructions, [["AGENTS.md", "agents_md"], ["role_prompt", "role_prompt"]]);
  assert.deepEqual(scope.blocks.filter((block) => block.category === "attachments").map((block) => block.attachmentType), ["environment_context", "multi_agent_mode"]);

  const prompt = scope.blocks.find((block) => block.category === "user");
  assert.equal(prompt.attachmentType, "agent_message");
  assert.equal(prompt.firstRequest, 0);
  assert.deepEqual(scope.requests.map((request) => request.turn), [1, 1]);
  assert.deepEqual(scope.requests.map((request) => request.usage.total), [24_000, 25_300]);
  assert.equal(scope.requests[0].hiddenBase.provenance, "estimated.local");
  for (const request of scope.requests) assert.equal(sumComposition(request), request.usage.total);

  const patch = scope.blocks.find((block) => block.category === "tool_call" && block.tool.subtool === "apply_patch");
  assert.equal(patch.tool.kind, "edit");
  assert.equal(patch.tool.target, "src/a.ts");
  assert.equal(patch.tool.files, 2);
  const send = scope.blocks.find((block) => block.category === "tool_call" && block.tool.name === "send_message");
  assert.equal(send.tool.kind, "agent");
  const sendResult = scope.blocks.find((block) => block.toolUseId === "call_301" && block.category !== "tool_call");
  assert.equal(sendResult.category, "tool_result.other");
  assert.equal(sendResult.bytes, 0);
  assert.equal(scope.status, "completed");
  assert.equal(run.spawnedThreadIds.length, 0);
  assertNoContent(run);
});

test("every fixture serialises without content and with the adapter version", async () => {
  for (const name of Object.keys(FIXTURES)) {
    const run = await parseCodexRollout(fixture(name), { home: HOME });
    assert.equal(run.coverage.adapterVersion, "codex-v3");
    assert.equal(run.coverage.estimatorVersion, "chars-v2");
    assert.equal(run.scopes.length, 1);
    assert.equal(run.scopes[0].id, "main");
    assertNoContent(run);
    JSON.parse(JSON.stringify(run));
  }
});

// ---------------------------------------------------------------------------
// codex-tools unit tests
// ---------------------------------------------------------------------------

const ctx = { cwd: CWD, home: HOME };

test("classifyCommand: read-style commands are file, search tools are search, mixed pipelines fall back to shell", () => {
  assert.deepEqual(pick(classifyCommand("sed -n '1,260p' packages/cli/src/index.mjs", ctx)), ["file", "packages/cli/src/index.mjs"]);
  assert.deepEqual(pick(classifyCommand("cat ./README.md", ctx)), ["file", "README.md"]);
  assert.deepEqual(pick(classifyCommand(`head -n 50 ${CWD}/docs/adr.md`, ctx)), ["file", "docs/adr.md"]);
  assert.deepEqual(pick(classifyCommand("nl -ba src/a.ts | head -100", ctx)), ["file", "src/a.ts"]);
  assert.deepEqual(pick(classifyCommand("rg -n \"needle\" src", ctx)), ["search", "src"]);
  assert.deepEqual(pick(classifyCommand("rg --files | head", ctx)), ["search", undefined]);
  assert.deepEqual(pick(classifyCommand("grep -rn pattern packages/ui/src", ctx)), ["search", "packages/ui/src"]);
  assert.deepEqual(pick(classifyCommand("find . -name '*.ts' -not -path './node_modules/*'", ctx)), ["search", "."]);
  assert.deepEqual(pick(classifyCommand("ls -la packages", ctx)), ["search", "packages"]);
  assert.deepEqual(pick(classifyCommand("git grep -n foo -- src", ctx)), ["search", "src"]);
  assert.deepEqual(pick(classifyCommand("curl -s https://example.invalid/x.json", ctx)), ["web", undefined]);
  assert.deepEqual(pick(classifyCommand("git status && git diff --stat", ctx)), ["shell", undefined]);
  assert.deepEqual(pick(classifyCommand("cd packages/cli && cat package.json", ctx)), ["file", "package.json"]);
  assert.deepEqual(pick(classifyCommand("yarn test 2>&1 | tail -n 40", ctx)), ["shell", undefined]);
  assert.deepEqual(pick(classifyCommand("sed -i '' 's/a/b/' src/x.ts", ctx)), ["edit", "src/x.ts"]);
  assert.deepEqual(pick(classifyCommand("echo hi > notes.txt", ctx)), ["edit", "notes.txt"]);
  assert.deepEqual(pick(classifyCommand("cat <<'EOF' > out/x.md\nhello\nEOF", ctx)), ["edit", "out/x.md"]);
  assert.deepEqual(pick(classifyCommand("bash -lc 'rg -n foo src/lib'", ctx)), ["search", "src/lib"]);
  assert.deepEqual(pick(classifyCommand("FOO=1 sudo cat /etc/hosts", ctx)), ["file", "hosts"]);
  assert.deepEqual(pick(classifyCommand(`cat ${HOME}/notes/todo.md`, ctx)), ["file", "~/notes/todo.md"]);
  assert.deepEqual(pick(classifyCommand("", ctx)), ["shell", undefined]);
  // partial: range reads
  const partial = (command) => classifyCommand(command, ctx).partial;
  assert.equal(partial("sed -n '1,260p' packages/cli/src/index.mjs"), true);
  assert.equal(partial("sed -ne '5p' a.ts"), true);
  assert.equal(partial("head -n 50 docs/adr.md"), true);
  assert.equal(partial("tail -n 40 log.txt"), true);
  assert.equal(partial("nl -ba src/a.ts | head -100"), true);
  assert.equal(partial("yarn test 2>&1 | tail -n 40"), true);
  assert.equal(partial("rg -m 5 needle src"), true);
  assert.equal(partial("rg -nm3 needle src"), true);
  assert.equal(partial("grep --max-count=2 -rn needle src"), true);
  assert.equal(partial("cat ./README.md"), undefined);
  assert.equal(partial("rg -n needle src"), undefined);
  assert.equal(partial("sed -i '' 's/a/b/' src/x.ts"), undefined);
  assert.equal(partial("git status"), undefined);
});

test("classifyCodexCall: exec JS wrappers, function calls and collaboration tools", () => {
  const exec = (cmd, workdir = CWD) => classifyCodexCall({ name: "exec", input: `const r = await tools.exec_command(${JSON.stringify({ cmd, workdir, max_output_tokens: 12000 })});\nreturn r;` }, ctx);
  assert.deepEqual(pick(exec("sed -n '1,40p' src/a.ts")), ["file", "src/a.ts"]);
  assert.deepEqual(pick(exec("cat lib/b.ts", `${CWD}/packages/cli`)), ["file", "packages/cli/lib/b.ts"]);
  assert.equal(classifyCodexCall({ name: "exec", input: "const r = await tools.write_stdin({\"session_id\": 1, \"chars\": \"y\\n\"});" }, ctx).kind, "shell");
  assert.equal(classifyCodexCall({ name: "exec", input: "const r = await tools.web__run({\"query\": \"x\"});" }, ctx).kind, "web");
  const mcp = classifyCodexCall({ name: "exec", input: "const r = await tools.mcp__node_repl__js({\"code\": \"1\"});" }, ctx);
  assert.deepEqual([mcp.kind, mcp.server], ["mcp", "node_repl"]);
  assert.deepEqual(pick(classifyCodexCall({ name: "exec", input: "const matches = ALL_TOOLS.filter(t => t.name);\nreturn matches;" }, ctx)), ["shell", undefined]);
  const patch = classifyCodexCall({ name: "exec", input: 'const patch = "*** Begin Patch\\n*** Update File: src/x.ts\\n@@\\n-a\\n+b\\n*** End Patch\\n";\nconst r = await tools.apply_patch({ input: patch });' }, ctx);
  assert.deepEqual([patch.kind, patch.target, patch.files], ["edit", "src/x.ts", 1]);
  const both = classifyCodexCall({ name: "exec", input: 'await tools.apply_patch({ input: "*** Begin Patch\\n*** Add File: a.ts\\n*** End Patch" }); const r = await tools.exec_command({"cmd":"yarn test"});' }, ctx);
  assert.equal(both.kind, "shell");
  assert.deepEqual(pick(classifyCodexCall({ name: "apply_patch", input: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch" }, ctx)), ["edit", "old.ts"]);
  assert.deepEqual(pick(classifyCodexCall({ name: "exec_command", arguments: JSON.stringify({ cmd: "rg foo packages", workdir: CWD }) }, ctx)), ["search", "packages"]);
  assert.equal(classifyCodexCall({ name: "spawn_agent", arguments: "{}", namespace: "collaboration" }, ctx).kind, "agent");
  assert.equal(classifyCodexCall({ name: "custom_thing", arguments: "{}", namespace: "collaboration" }, ctx).kind, "agent");
  assert.equal(classifyCodexCall({ name: "wait", arguments: "{}" }, ctx).kind, "shell");
  assert.equal(classifyCodexCall({ name: "update_plan", arguments: "{}" }, ctx).kind, "other");
  assert.equal(classifyCodexCall({ name: "exec_command", arguments: "not json" }, ctx).kind, "shell");
});

test("relativeTarget never returns an absolute path outside home", () => {
  assert.equal(relativeTarget(`${CWD}/src/a.ts`, ctx), "src/a.ts");
  assert.equal(relativeTarget(CWD, ctx), ".");
  assert.equal(relativeTarget(`${HOME}/other/repo/x.ts`, ctx), "~/other/repo/x.ts");
  assert.equal(relativeTarget("/etc/hosts", ctx), "hosts");
  assert.equal(relativeTarget("/Users/someone/secret/file.txt", ctx), "file.txt");
  assert.equal(relativeTarget("./src/../lib/b.ts", ctx), "lib/b.ts");
  assert.equal(relativeTarget("a".repeat(300), ctx).length, 120);
  assert.equal(relativeTarget("", ctx), undefined);
});

test("inspectToolOutput reads Codex truncation and error markers", () => {
  assert.deepEqual(inspectToolOutput("Warning: truncated output (original token count: 12345)\nTotal output lines: 9\nbody"), { truncated: true, originalTokens: 12345 });
  assert.deepEqual(inspectToolOutput("head\n…4200 tokens truncated…\ntail"), { truncated: true, omittedTokens: 4200 });
  assert.deepEqual(inspectToolOutput("x <truncated omitted_approx_tokens=77> y <truncated omitted_approx_tokens=3>"), { truncated: true, omittedTokens: 80 });
  assert.deepEqual(inspectToolOutput("Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 2\nOriginal token count: 50\nOutput:\nboom", 30), { originalTokens: 50, isError: true });
  assert.deepEqual(inspectToolOutput("Chunk ID: 1\nProcess exited with code 0\nOriginal token count: 50000\nOutput:\nshort", 100), { originalTokens: 50000, truncated: true });
  assert.deepEqual(inspectToolOutput("Script failed\nWall time 1 seconds\nOutput:\n"), { isError: true });
  assert.deepEqual(inspectToolOutput(""), {});
});

test("shell parsing helpers", () => {
  assert.deepEqual(splitSegments("a && b | c; d || e\nf"), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(splitSegments("echo 'a && b' | cat"), ["echo 'a && b'", "cat"]);
  assert.deepEqual(splitSegments("x=$(a | b) && c"), ["x=$(a | b)", "c"]);
  assert.deepEqual(tokenize("sed -n '1,20p' \"my file.ts\" > out"), ["sed", "-n", "1,20p", "my file.ts", ">", "out"]);
  assert.deepEqual(tokenize("yarn test 2>&1"), ["yarn", "test", "2>&1"]);
  assert.deepEqual(tokenize("cmd >>log.txt"), ["cmd", ">>", "log.txt"]);
  assert.equal(extractStringProperty('tools.exec_command({"cmd":"echo \\"hi\\"","workdir":"/x"})', "cmd"), 'echo "hi"');
  assert.equal(extractStringProperty("tools.exec_command({ cmd: `ls -la`, workdir: '/x' })", "cmd"), "ls -la");
  assert.equal(extractStringProperty("nothing here", "cmd"), null);
});

function pick(result) {
  return [result.kind, result.target];
}
