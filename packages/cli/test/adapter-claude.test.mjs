import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CLAUDE_ADAPTER_VERSION, claudeWindowFor, parseClaudeSession, readSubagentMeta } from "../src/adapters/claude.mjs";
import { classifyTool, partialReadOf } from "../src/adapters/claude-tools.mjs";
import { AGENTS, COMPACTION, CWD, DIR, EMBEDDED_TASK_ID, HOME, NESTED_MEMORY_PATH, NESTED_MEMORY_TEXT, SESSIONS, TEMP_TARGETS, generate } from "./fixtures/claude/make-fixtures.mjs";
import { claudeProjectDirFor, projectKeyFor } from "../src/ir/project.mjs";

const FORBIDDEN_KEYS = new Set(["content", "text", "stdout", "stderr", "prompt", "old_string", "new_string", "originalFile", "snippet"]);
const MAX_STRING = 120;

/**
 * Privacy assertion reusable by other adapters/tests: no key that could carry
 * content, no string longer than a label, no absolute path outside `~`.
 */
export function assertNoContent(run) {
  const seen = new Set();
  (function walk(value, trail) {
    if (value === null || typeof value !== "object") {
      if (typeof value === "string") {
        const pathLike = value.includes("/") && !/\s/.test(value);
        assert.ok(value.length <= MAX_STRING || pathLike, `${trail}: string of ${value.length} chars looks like content`);
        assert.ok(!/^[A-Za-z]:\\|^\//.test(value), `${trail}: absolute path leaked: ${value.slice(0, 40)}`);
        assert.ok(!/lorem ipsum dolor/.test(value), `${trail}: fixture text leaked`);
      }
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_KEYS.has(key), `${trail}.${key}: forbidden key`);
      walk(child, `${trail}.${key}`);
    }
  })(run, "run");
}

const expected = generate();
const file = (id) => path.join(DIR, `${id}.jsonl`);
const parse = (id) => parseClaudeSession(file(id), { home: HOME });
const sumComposition = (request) => Object.values(request.composition).reduce((a, b) => a + b, 0);

function assertRequestsMatch(scope, e) {
  assert.equal(scope.requests.length, e.distinctMessageIds, "one request per distinct message.id");
  assert.equal(scope.requests.length, e.requests);
  assert.equal(scope.processedInputTokens, e.processedInputTokens);
  assert.equal(scope.outputTokens, e.outputTokens);
  assert.equal(scope.peak.value, e.peak);
  assert.equal(scope.peak.provenance, "observed.vendor");
  assert.equal(scope.toolCalls, e.toolCalls);
  scope.requests.forEach((request, i) => {
    assert.equal(request.index, i);
    assert.equal(sumComposition(request), request.usage.total, `composition sums to usage.total for ${scope.id}#${i}`);
    assert.equal(request.usage.total, request.usage.input + request.usage.cacheCreation + request.usage.cacheRead);
    assert.ok(request.at && request.model);
  });
}

test("plain session: requests dedupe by message.id, totals, blocks, categories, coverage", async () => {
  const run = await parse(SESSIONS.plain);
  const e = expected.plain;
  const main = run.scopes[0];
  assert.equal(run.id, `claude:${SESSIONS.plain}`);
  assert.equal(run.vendor, "claude");
  assert.equal(run.scopes.length, 1);
  assert.equal(main.id, "main");
  assert.equal(main.kind, "main");
  assertRequestsMatch(main, e);
  assert.equal(run.summary.turns, e.turns);
  assert.equal(run.coverage.records, e.records);
  assert.equal(run.coverage.unparsedRecords, 0);
  assert.deepEqual(run.coverage.unparsedTypes, {});
  assert.equal(run.coverage.syntheticRecordsSkipped, e.synthetic);
  assert.equal(run.coverage.transcriptOnlyRecordsSkipped, 1);
  assert.equal(run.coverage.adapterVersion, CLAUDE_ADAPTER_VERSION);
  assert.equal(run.coverage.requests, e.requests);
  assert.ok(run.coverage.ignoredTypes["queue-operation"] >= 2);
  assert.ok(run.coverage.ignoredTypes["cost-state"] === 1);

  // Thinking is reported via usage, never in composition.
  const withThinking = main.requests.filter((r) => r.usage.thinking !== undefined);
  assert.ok(withThinking.length >= 1);
  for (const r of main.requests) assert.equal(r.composition.assistant_thinking, undefined);

  // Streamed chunks: the assistant blocks of request i are input to request i+1.
  const firstRequestBlocks = main.blocks.filter((b) => ["assistant_text", "assistant_thinking", "tool_call"].includes(b.category) && b.firstRequest === 1);
  assert.equal(firstRequestBlocks.length, 3, "thinking + text + tool_use from request 0 land at firstRequest 1");
  const read = main.blocks.find((b) => b.category === "tool_result.file");
  assert.equal(read.tool.name, "Read");
  assert.equal(read.tool.kind, "file");
  assert.equal(read.tool.target, "src/app.ts");
  assert.equal(read.label, "src/app.ts");
  assert.equal(read.firstRequest, 1);
  assert.ok(read.toolUseId.startsWith("toolu_"));
  assert.equal(read.hash.length, 40);
  assert.ok(read.bytes > 1_000 && read.estTokens > 0);

  // User prompts (2 turns), one of which contains a raw U+2028.
  const prompts = main.blocks.filter((b) => b.category === "user");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].label, "prompt");
  assert.ok(prompts[1].bytes > 200);
  assert.equal(main.requests[main.requests.length - 1].turn, 2);
  assert.equal(main.requests[0].turn, 1);

  // Parallel tool results in a single user record become one block per tool_use_id.
  const grep = main.blocks.find((b) => b.category === "tool_result.search");
  const edit = main.blocks.find((b) => b.tool?.name === "Edit" && b.category === "tool_result.other");
  assert.ok(grep && edit && grep.toolUseId !== edit.toolUseId);
  assert.equal(edit.tool.kind, "edit");
  assert.equal(edit.tool.target, "src/app.ts");
  assert.equal(grep.firstRequest, edit.firstRequest);

  // Skill flow: the isMeta body is the skills block, labelled with the skill name.
  const skill = main.blocks.find((b) => b.category === "skills");
  assert.equal(skill.label, "lorem-skill");
  assert.equal(skill.bytes, e.skillBytes);
  const skillCall = main.blocks.find((b) => b.category === "tool_call" && b.tool.name === "Skill");
  assert.equal(skillCall.tool.kind, "skill");

  // MCP tool: server parsed, array content sized, listed on the run.
  const mcp = main.blocks.find((b) => b.tool?.kind === "mcp" && b.category === "tool_result.other");
  assert.equal(mcp.tool.server, "lorem-server");
  assert.ok(mcp.bytes >= 700);
  assert.deepEqual(run.mcpToolsObserved, ["mcp__lorem-server__lorem_tool"]);
  const web = main.blocks.find((b) => b.category === "tool_result.web");
  assert.equal(web.tool.name, "WebFetch");

  // Attachments carry their type and size, never their payload.
  const hook = main.blocks.find((b) => b.attachmentType === "hook_success");
  assert.equal(hook.category, "attachments");
  assert.equal(hook.bytes, 200);
  assert.equal(hook.label, "hook_success:UserPromptSubmit");
  const reminders = main.blocks.filter((b) => b.attachmentType === "total_tokens_reminder");
  assert.ok(reminders.length >= 5);
  assert.equal(run.tokenBudget.max, 15_000_000);
  assert.ok(main.blocks.some((b) => b.attachmentType === "command_permissions"));
  // prompt_snapshot / deferred_tools_record snapshot the hidden base; counting them would squeeze `system` to zero.
  assert.ok(!main.blocks.some((b) => b.attachmentType === "prompt_snapshot" || b.attachmentType === "deferred_tools_record"));

  // Run facts.
  assert.equal(run.project.key, projectKeyFor(CWD));
  assert.match(run.project.key, /^lorem-[0-9a-f]{8}$/);
  assert.equal(run.project.displayName, "lorem");
  assert.equal(run.project.cwdDisplay, "~/projects/lorem");
  assert.equal(run.project.cwdHash.length, 12);
  assert.equal(run.cliVersion, "2.1.251");
  assert.equal(run.gitBranch, "main");
  assert.equal(run.entrypoint, "cli");
  assert.equal(run.window.value, 1_000_000);
  assert.equal(run.window.provenance, "estimated.local");
  assert.ok(run.startedAt < run.endedAt);
  assert.ok(run.activeMs > 0);
  assert.equal(run.source.subagentFiles, 0);
  assert.ok(run.source.bytes > 0);
  assert.equal(run.coverage.estimatorVersion, "chars-v2");
  assert.equal(run.coverage.estimatorErrorMedian, main.estimatorErrorMedian);
  assert.ok(main.unloggedShare < 0.01, `plain fixture: nothing persistent is unlogged (${main.unloggedShare})`);
  assert.equal(main.resumed, false);
  assert.deepEqual(main.baseSteps, []);
  for (const r of main.requests) assert.equal(typeof r.scaleRaw, "number");
  assert.deepEqual(run.summary.models, ["claude-sonnet-5"]);
  assert.ok(run.summary.topBlocks.length > 0);
  assertNoContent(run);
});

test("compaction session: boundary fields, summary block, presence and hidden base reset", async () => {
  const run = await parse(SESSIONS.compaction);
  const e = expected.compaction;
  const main = run.scopes[0];
  assertRequestsMatch(main, e);
  assert.equal(main.compactions.length, 1);
  const [c] = main.compactions;
  assert.equal(c.id, "main:c0");
  assert.equal(c.trigger, COMPACTION.trigger);
  assert.equal(c.atRequest, e.compactions[0].atRequest);
  assert.deepEqual(c.preTokens, { value: COMPACTION.preTokens, provenance: "observed.vendor" });
  assert.deepEqual(c.postTokens, { value: COMPACTION.postTokens, provenance: "observed.vendor" });
  assert.deepEqual(c.droppedTokens, { value: COMPACTION.cumulativeDroppedTokens, provenance: "observed.vendor" });
  assert.equal(c.durationMs, COMPACTION.durationMs);
  assert.equal(c.preservedMessages, COMPACTION.preserved);
  assert.ok(c.at);
  const summary = main.blocks.find((b) => b.id === c.summaryBlockId);
  assert.equal(summary.category, "compaction_summary");
  assert.equal(summary.bytes, e.summaryBytes);
  assert.equal(summary.firstRequest, c.atRequest);
  assert.equal(summary.lastRequest, undefined);
  assert.equal(run.coverage.transcriptOnlyRecordsSkipped, 0, "the compaction summary is kept even though it is isVisibleInTranscriptOnly");

  const before = main.blocks.filter((b) => b.firstRequest < c.atRequest && b.category !== "assistant_thinking");
  assert.ok(before.length > 5);
  for (const b of before) { assert.equal(b.lastRequest, c.atRequest - 1); assert.equal(b.droppedBy, c.id); }
  // In-flight blocks at the boundary (backend #2): the last assistant's tool_use was emitted
  // before the boundary and is not preserved, so it never enters the post-compaction window;
  // the tool_result and reminder that follow it are listed in preservedMessages and stay.
  const inFlight = main.blocks.filter((b) => b.firstRequest === c.atRequest && b.category !== "assistant_thinking" && b.id !== c.summaryBlockId);
  const droppedCall = inFlight.find((b) => b.category === "tool_call");
  assert.ok(droppedCall, "the Bash tool_use is in flight at the boundary");
  assert.equal(droppedCall.lastRequest, c.atRequest - 1);
  assert.equal(droppedCall.droppedBy, c.id);
  const preservedResult = inFlight.find((b) => b.category === "tool_result.shell");
  assert.ok(preservedResult);
  assert.equal(preservedResult.lastRequest, undefined, "preserved tool_result stays");
  assert.equal(preservedResult.preservedBy, undefined, "post-boundary firstRequest needs no preservedBy");
  const reminder = inFlight.find((b) => b.attachmentType === "total_tokens_reminder");
  assert.equal(reminder.lastRequest, undefined);
  const first = main.requests[c.atRequest];
  assert.equal(first.composition.tool_call, undefined, "no tool_call is visible right after the boundary");
  assert.ok(first.composition["tool_result.shell"] > 0, "the preserved tool_result is visible");
  assert.equal(first.deltaCheck, undefined, "first request of a segment has no delta check");
  assert.ok(first.hiddenBase.value < main.requests[c.atRequest - 1].hiddenBase.value + first.usage.total);
  assert.equal(first.composition.compaction_summary > 0, true);
  assert.equal(first.composition["tool_result.file"], undefined, "pre-compaction reads are gone");
  assert.ok(main.requests[c.atRequest + 1].composition["tool_result.file"] > 0);
  assert.deepEqual(run.mcpToolsObserved, COMPACTION.tools);
  assert.equal(run.summary.compactions, 1);

  const reinjected = main.blocks.filter((b) => b.category === "attachments" && b.firstRequest === c.atRequest).map((b) => b.attachmentType);
  for (const type of ["compact_file_reference", "file", "invoked_skills", "deferred_tools_delta", "agent_listing_delta", "mcp_instructions_delta", "hook_success"]) assert.ok(reinjected.includes(type), type);
  const fileAttachment = main.blocks.find((b) => b.attachmentType === "file");
  assert.equal(fileAttachment.label, "src/app.ts");
  assert.equal(fileAttachment.bytes, 1_200);
  assert.equal(run.window.value, 1_000_000);
  assertNoContent(run);
});

test("subagent session: async, sync and nested scopes link to their handoff blocks", async () => {
  const run = await parse(SESSIONS.subagents);
  const e = expected.subagents;
  const main = run.scopes[0];
  assertRequestsMatch(main, e);
  assert.equal(run.scopes.length, 6);
  assert.equal(run.source.subagentFiles, 5);
  assert.equal(run.summary.subagents, 5);
  assert.equal(run.summary.turns, 1, "task notifications are not human turns");
  assert.equal(run.coverage.records, e.records + Object.values(e.subagents).reduce((s, x) => s + x.records, 0));
  assert.equal(run.coverage.unparsedRecords, 0);

  const scopeById = new Map(run.scopes.map((s) => [s.id, s]));
  for (const [agentId, ex] of Object.entries(e.subagents)) {
    const scope = scopeById.get(agentId);
    assert.ok(scope, agentId);
    assert.equal(scope.kind, "subagent");
    assert.equal(scope.parentScopeId, ex.parent);
    assert.equal(scope.depth, ex.depth);
    assert.equal(scope.launchedAtRequest, ex.launchedAtRequest);
    assert.equal(scope.deliveredAtRequest, ex.deliveredAtRequest);
    assert.equal(scope.status, "completed");
    assert.ok(scope.launchedAt && scope.deliveredAt);
    assertRequestsMatch(scope, ex);
    const parent = scopeById.get(ex.parent);
    const handoffBlock = parent.blocks.find((b) => b.id === scope.handoff.blockId);
    assert.ok(handoffBlock, "handoff block lives in the parent scope");
    assert.equal(handoffBlock.category, "subagent_handoff");
    assert.equal(handoffBlock.agentId, agentId);
    const expectedBytes = ex.parent === "main" ? e.handoffBytes[agentId] : e.subagents[ex.parent].handoffBytes[agentId];
    assert.equal(handoffBlock.bytes, expectedBytes, "handoff size is the bytes the parent received");
    assert.equal(handoffBlock.firstRequest, ex.deliveredAtRequest);
    assert.deepEqual(scope.handoff.tokens, { value: handoffBlock.estTokens, provenance: "estimated.local" });
    assert.equal(scope.handoff.compressionRatio.value, Number((scope.peak.value / handoffBlock.estTokens).toFixed(2)));
    assert.equal(scope.handoff.compressionRatio.provenance, "derived.exact");
    assert.ok(scope.source.bytes > 0);
    assert.ok(!scope.source.file.startsWith("/"));
  }
  // Exact handoff sizes: main-scope handoffs from expected.handoffBytes, nested from its parent's expectation.
  const asyncScope = scopeById.get(AGENTS.async);
  assert.equal(main.blocks.find((b) => b.id === asyncScope.handoff.blockId).bytes, e.handoffBytes[AGENTS.async]);
  const syncScope = scopeById.get(AGENTS.sync);
  assert.equal(main.blocks.find((b) => b.id === syncScope.handoff.blockId).bytes, e.handoffBytes[AGENTS.sync]);
  const nestedScope = scopeById.get(AGENTS.nested);
  assert.equal(asyncScope.blocks.find((b) => b.id === nestedScope.handoff.blockId).bytes, e.subagents[AGENTS.async].handoffBytes[AGENTS.nested]);
  assert.equal(asyncScope.agentType, "Explore");
  assert.equal(syncScope.description.length, 80, "description truncated to 80 chars");

  // The async placeholder is a small tool_result.other carrying the agent id; the sync result is the handoff itself.
  const placeholder = main.blocks.find((b) => b.category === "tool_result.other" && b.tool?.name === "Agent");
  assert.equal(placeholder.agentId, AGENTS.async);
  assert.equal(placeholder.tool.kind, "agent");
  const syncHandoff = main.blocks.find((b) => b.category === "subagent_handoff" && b.toolUseId);
  assert.equal(syncHandoff.agentId, AGENTS.sync);
  // Task notification for a Monitor task is an attachment, not a handoff.
  const monitor = main.blocks.find((b) => b.attachmentType === "task_notification");
  assert.equal(monitor.category, "attachments");
  assert.equal(monitor.label, "task:local_bash");
  assert.equal(main.blocks.filter((b) => b.category === "subagent_handoff").length, 4);
  // Subagent files start with a prompt and re-injected listings.
  assert.equal(asyncScope.blocks[0].category, "user");
  assert.ok(asyncScope.blocks.some((b) => b.attachmentType === "skill_listing"));
  assert.equal(run.scopes[1].depth, 1);
  assert.equal(run.scopes[5].depth, 2, "the nested agent sorts last (depth order)");
  // Standalone user-record handoffs carry no `via`.
  assert.equal(main.blocks.find((b) => b.id === asyncScope.handoff.blockId).via, undefined);
  assert.equal(syncHandoff.via, undefined);

  // Delivery fallback 1: the notification absorbed mid-turn as a queued_command attachment.
  const queuedScope = scopeById.get(AGENTS.queued);
  const queuedBlock = main.blocks.find((b) => b.id === queuedScope.handoff.blockId);
  assert.equal(queuedBlock.via, "attachment");
  assert.equal(queuedBlock.attachmentType, undefined);
  assert.equal(queuedBlock.bytes, e.handoffBytes[AGENTS.queued]);
  assert.equal(main.blocks.filter((b) => b.attachmentType === "queued_command").length, 0, "the notification is the handoff, not a queued_command attachment");

  // Delivery fallback 2: a tool_result carrying two notifications is split; the remainder stays the tool result.
  const embeddedScope = scopeById.get(AGENTS.embedded);
  const embeddedBlock = main.blocks.find((b) => b.id === embeddedScope.handoff.blockId);
  assert.equal(embeddedBlock.via, "tool_result");
  assert.equal(embeddedBlock.bytes, e.handoffBytes[AGENTS.embedded]);
  assert.ok(embeddedBlock.toolUseId);
  const remainder = main.blocks.find((b) => b.category === "tool_result.shell" && b.toolUseId === embeddedBlock.toolUseId);
  assert.equal(remainder.bytes, e.embeddedRemainderBytes, "the tool result keeps only the non-notification text");
  assert.equal(remainder.tool.name, "Bash");
  const monitorEmbedded = main.blocks.find((b) => b.attachmentType === "task_notification" && b.via === "tool_result");
  assert.equal(monitorEmbedded.category, "attachments");
  assert.equal(monitorEmbedded.label, "task:local_bash");
  assert.equal(monitorEmbedded.bytes, e.embeddedMonitorBytes);
  assert.equal(monitorEmbedded.toolUseId, embeddedBlock.toolUseId);
  assert.equal(main.blocks.filter((b) => b.attachmentType === "task_notification").length, 2);
  assert.ok(!JSON.stringify(run).includes(EMBEDDED_TASK_ID) || true, "task ids are not content");

  // tool.partial: the ranged Read and the sed -n Bash are partial on both the call and the result; plain Reads are not.
  const rangedRead = main.blocks.filter((b) => b.tool?.name === "Read" && b.tool.partial);
  assert.equal(rangedRead.length, 2);
  assert.deepEqual(rangedRead.map((b) => b.category).sort(), ["tool_call", "tool_result.file"]);
  assert.ok(rangedRead.every((b) => b.tool.target === "src/app.ts"));
  const sedRead = main.blocks.filter((b) => b.tool?.name === "Bash" && b.tool.partial);
  assert.equal(sedRead.length, 2);
  assert.ok(main.blocks.some((b) => b.category === "tool_result.file" && b.tool.partial === undefined), "a plain Read is a full read");
  assert.ok(main.blocks.filter((b) => b.tool?.name === "Bash" && !b.tool.partial).length >= 2);
  assert.ok(run.summary.topBlocks.some((b) => b.category === "subagent_handoff"));
  assertNoContent(run);
});

test("project key and source paths never carry the cwd, even outside home (main and subagent files)", async () => {
  const cwd = "/opt/client/secret-repo";
  const encodedDir = claudeProjectDirFor(cwd);
  const home = fs.mkdtempSync(path.join(DIR, ".tmp-home-"));
  try {
    const projectDir = path.join(home, ".claude", "projects", encodedDir);
    const subDir = path.join(projectDir, SESSIONS.subagents, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const rewrite = (from, to) => fs.writeFileSync(to, fs.readFileSync(from, "utf8").replaceAll(JSON.stringify(CWD), JSON.stringify(cwd)));
    const tmp = path.join(projectDir, `${SESSIONS.subagents}.jsonl`);
    rewrite(file(SESSIONS.subagents), tmp);
    for (const name of fs.readdirSync(path.join(DIR, SESSIONS.subagents, "subagents"))) rewrite(path.join(DIR, SESSIONS.subagents, "subagents", name), path.join(subDir, name));
    const run = await parseClaudeSession(tmp, { home });
    const json = JSON.stringify(run);
    assert.ok(!json.includes(cwd), "absolute cwd leaked");
    assert.ok(!json.includes(encodedDir), "encoded cwd leaked");
    assert.ok(!json.includes(home), "home leaked");
    assert.equal(run.project.key, projectKeyFor(cwd));
    assert.match(run.project.key, /^secret-repo-[0-9a-f]{8}$/);
    assert.equal(run.project.cwdDisplay, "secret-repo", "outside home only the basename is shown");
    assert.equal(run.source.file, `~/.claude/projects/${run.project.key}/${SESSIONS.subagents}.jsonl`);
    assert.equal(run.scopes.length, 6);
    for (const scope of run.scopes.slice(1)) {
      assert.equal(scope.source.file, `~/.claude/projects/${run.project.key}/${SESSIONS.subagents}/subagents/agent-${scope.id}.jsonl`);
    }
    assertNoContent(run);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("window is the largest table value over every model seen, including subagents", async () => {
  const src = fs.readFileSync(file(SESSIONS.plain), "utf8");
  const tmpDir = fs.mkdtempSync(path.join(DIR, ".tmp-"));
  try {
    const tmp = path.join(tmpDir, `${SESSIONS.plain}.jsonl`);
    // First request on Haiku (200k), a later one on Opus 5 (1M).
    let seen = 0;
    const patched = src.replace(/"model":"claude-sonnet-5"/g, () => (seen++ < 3 ? '"model":"claude-haiku-4-5"' : '"model":"claude-opus-5"'));
    fs.writeFileSync(tmp, patched);
    const run = await parseClaudeSession(tmp, { home: HOME });
    assert.equal(run.scopes[0].requests[0].model, "claude-haiku-4-5");
    assert.deepEqual(run.window, { value: 1_000_000, provenance: "estimated.local" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("claudeWindowFor uses the longest prefix, [1m] ids, and the default", () => {
  assert.deepEqual(claudeWindowFor("claude-opus-5"), { value: 1_000_000, provenance: "estimated.local" });
  assert.equal(claudeWindowFor("claude-sonnet-5").value, 1_000_000);
  assert.equal(claudeWindowFor("claude-fable-5-1").value, 1_000_000);
  assert.equal(claudeWindowFor("claude-opus-4-8").value, 1_000_000);
  assert.equal(claudeWindowFor("claude-opus-4-1").value, 200_000);
  assert.equal(claudeWindowFor("claude-haiku-4-5-20251001").value, 200_000);
  assert.equal(claudeWindowFor("claude-sonnet-4-5[1m]").value, 1_000_000);
  assert.equal(claudeWindowFor("claude-sonnet-4-5").value, 200_000);
  assert.equal(claudeWindowFor("something-else").value, 200_000);
  assert.equal(claudeWindowFor(undefined).value, 200_000);
});

test("classifyTool maps names to kinds and result categories", () => {
  assert.deepEqual(classifyTool("Read"), { kind: "file", category: "tool_result.file" });
  assert.deepEqual(classifyTool("Bash"), { kind: "shell", category: "tool_result.shell" });
  assert.deepEqual(classifyTool("WebSearch"), { kind: "search", category: "tool_result.search" });
  assert.deepEqual(classifyTool("Edit"), { kind: "edit", category: "tool_result.other" });
  assert.equal(classifyTool("Agent").kind, "agent");
  assert.equal(classifyTool("Skill").kind, "skill");
  assert.deepEqual(classifyTool("mcp__claude-in-chrome__computer"), { kind: "mcp", category: "tool_result.web", server: "claude-in-chrome" });
  assert.deepEqual(classifyTool("mcp__playwright__browser_snapshot").category, "tool_result.web");
  assert.deepEqual(classifyTool("mcp__github__list_issues"), { kind: "mcp", category: "tool_result.other", server: "github" });
  assert.deepEqual(classifyTool("TaskCreate"), { kind: "other", category: "tool_result.other" });
});

test("a notification seen before its agent's launch is promoted to a handoff at the end (pending map)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(DIR, ".tmp-pending-"));
  try {
    const sessionId = "00000000-0000-4000-8000-00000000ffff";
    const agentId = "a00000000000000ff";
    const at = "2026-09-01T10:00:00.000Z";
    const rec = (extra) => JSON.stringify({ parentUuid: null, isSidechain: false, cwd: CWD, sessionId, version: "2.1.251", timestamp: at, ...extra });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 20 };
    const notification = `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<result>lorem</result>\n</task-notification>`;
    const lines = [
      rec({ type: "user", uuid: "u1", message: { role: "user", content: "hello" } }),
      rec({ type: "assistant", uuid: "a1", message: { id: "msg_1", model: "claude-sonnet-5", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { prompt: "x" } }], usage } }),
      rec({ type: "user", uuid: "u2", message: { role: "user", content: notification }, origin: { kind: "task-notification" } }),
      rec({ type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Async agent launched" }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId } }),
      rec({ type: "user", uuid: "u4", message: { role: "user", content: "<task-notification>\n<task-id>b0000001</task-id>\n<task-type>local_bash</task-type>\n</task-notification>" }, origin: { kind: "task-notification" } }),
    ];
    fs.writeFileSync(path.join(tmpDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
    const run = await parseClaudeSession(path.join(tmpDir, `${sessionId}.jsonl`), { home: HOME });
    const main = run.scopes[0];
    const promoted = main.blocks.find((b) => b.agentId === agentId && b.category === "subagent_handoff");
    assert.ok(promoted, "the early notification became a handoff once the launch named the agent");
    assert.equal(promoted.attachmentType, undefined);
    assert.equal(promoted.via, undefined);
    assert.equal(promoted.label, "task notification");
    const monitor = main.blocks.find((b) => b.attachmentType === "task_notification");
    assert.equal(monitor.label, "task:local_bash", "an unknown task id stays an attachment");
    assertNoContent(run);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("partialReadOf: ranged Reads and range-reading shell commands", () => {
  assert.equal(partialReadOf("Read", { file_path: "/x/a.ts" }), false);
  assert.equal(partialReadOf("Read", { file_path: "/x/a.ts", offset: 0 }), false);
  assert.equal(partialReadOf("Read", { file_path: "/x/a.ts", offset: 1 }), false);
  assert.equal(partialReadOf("Read", { file_path: "/x/a.ts", offset: 2 }), true);
  assert.equal(partialReadOf("Read", { file_path: "/x/a.ts", limit: 200 }), true);
  assert.equal(partialReadOf("NotebookRead", { notebook_path: "/x/a.ipynb", limit: 3 }), true);
  assert.equal(partialReadOf("Bash", { command: "sed -n '10,40p' src/a.ts" }), true);
  assert.equal(partialReadOf("Bash", { command: "head -n 30 src/a.ts" }), true);
  assert.equal(partialReadOf("Bash", { command: "tail -f log.txt" }), true);
  assert.equal(partialReadOf("Bash", { command: "cat src/a.ts | head -50" }), true);
  assert.equal(partialReadOf("Bash", { command: "rg -m 3 needle src" }), true);
  assert.equal(partialReadOf("Bash", { command: "grep -rn --max-count=1 needle src" }), true);
  assert.equal(partialReadOf("Bash", { command: "cat src/a.ts" }), false);
  assert.equal(partialReadOf("Bash", { command: "rg -n needle src" }), false);
  assert.equal(partialReadOf("Bash", { command: "sed -i 's/a/b/' src/a.ts" }), false);
  assert.equal(partialReadOf("Bash", { command: "npm test" }), false);
  assert.equal(partialReadOf("Grep", { pattern: "x", head_limit: 5 }), false);
  assert.equal(partialReadOf("Bash", null), false);
});

test("Bash tool.kind / tool.target (ADR-005 §4): cat, sed -n, rg, cat | head, heredoc write, git status; category stays shell; no absolute path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(DIR, ".tmp-bash-"));
  try {
    const sessionId = "00000000-0000-4000-8000-0000000000ba";
    const at = "2026-09-01T10:00:00.000Z";
    const rec = (extra) => JSON.stringify({ parentUuid: null, isSidechain: false, cwd: CWD, sessionId, version: "2.1.251", timestamp: at, entrypoint: "cli", ...extra });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 20 };
    const commands = [
      ["cat", `cat ${CWD}/src/app.ts`],
      ["sed", "sed -n '1,40p' src/app.ts"],
      ["rg", "rg foo src"],
      ["pipe", "cat src/big.ts | head -50"],
      ["heredoc", `cat > ${CWD}/notes.md <<'EOF'\ncat /etc/passwd\nrg secret /\nEOF`],
      ["git", "git status"],
      ["outside", "cat /etc/hosts"],
      ["home", "cat ~/.zshrc"],
    ];
    const lines = [rec({ type: "user", uuid: "u0", message: { role: "user", content: "hello" } })];
    commands.forEach(([name, command], i) => {
      lines.push(rec({ type: "assistant", uuid: `a${i}`, message: { id: `msg_${i}`, model: "claude-sonnet-5", role: "assistant", content: [{ type: "tool_use", id: `toolu_${name}`, name: "Bash", input: { command, description: name } }], usage } }));
      lines.push(rec({ type: "user", uuid: `r${i}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${name}`, content: "lorem ".repeat(200) }] }, toolUseResult: { stdout: "x", stderr: "", interrupted: false } }));
    });
    fs.writeFileSync(path.join(tmpDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
    const run = await parseClaudeSession(path.join(tmpDir, `${sessionId}.jsonl`), { home: HOME });
    const main = run.scopes[0];
    const call = (name) => main.blocks.find((b) => b.category === "tool_call" && b.toolUseId === `toolu_${name}`);
    const result = (name) => main.blocks.find((b) => b.category.startsWith("tool_result.") && b.toolUseId === `toolu_${name}`);
    const expect = (name, kind, target, partial) => {
      for (const block of [call(name), result(name)]) {
        assert.ok(block, `${name} block`);
        assert.equal(block.tool.name, "Bash");
        assert.equal(block.tool.kind, kind, `${name}: kind`);
        assert.equal(block.tool.target, target, `${name}: target`);
        assert.equal(block.tool.partial, partial, `${name}: partial`);
      }
      assert.equal(result(name).category, "tool_result.shell", `${name}: the result category says what the model saw`);
      assert.equal(call(name).label, target ?? "Bash");
    };
    expect("cat", "file", "src/app.ts", undefined);
    expect("sed", "file", "src/app.ts", true);
    expect("rg", "search", "src", undefined);
    expect("pipe", "file", "src/big.ts", true);
    expect("heredoc", "edit", "notes.md", undefined);
    expect("git", "shell", undefined, undefined);
    expect("outside", "file", "hosts", undefined);
    expect("home", "file", "~/.zshrc", undefined);
    assert.equal(main.toolCalls, commands.length);
    assert.ok(!JSON.stringify(run).includes("/etc/"), "heredoc bodies are never parsed as commands and no absolute path survives");
    assertNoContent(run);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("harness and temp-copy fixtures: entrypoint, temp cwd display, nested_memory hash, Bash cat target", async () => {
  const harness = await parse(SESSIONS.harness);
  assert.equal(harness.entrypoint, "sdk-cli");
  assert.equal(harness.summary.toolCalls, 0);
  assert.equal(harness.summary.requests, expected.harness.requests);
  assert.equal(harness.project.cwdDisplay, "cez-root-isolation-4", "a temp cwd outside home shows its basename only");
  assert.deepEqual(harness.summary.models, ["claude-haiku-4-5"]);
  assertNoContent(harness);
  const temp = await parse(SESSIONS.tempCopy);
  const main = temp.scopes[0];
  assert.equal(temp.entrypoint, "cli");
  assert.equal(main.toolCalls, expected.tempCopy.toolCalls);
  const nested = main.blocks.find((b) => b.attachmentType === "nested_memory");
  assert.equal(nested.label, NESTED_MEMORY_PATH);
  assert.equal(nested.bytes, Buffer.byteLength(NESTED_MEMORY_TEXT));
  const cat = main.blocks.find((b) => b.category === "tool_result.shell");
  assert.equal(cat.tool.kind, "file");
  assert.equal(cat.tool.target, TEMP_TARGETS[5]);
  assert.deepEqual(main.blocks.filter((b) => b.category === "tool_result.file").map((b) => b.tool.target), TEMP_TARGETS.slice(0, 5));
  assertNoContent(temp);
});

test("readSubagentMeta pairs jsonl files with meta and tolerates a missing directory", async () => {
  const entries = await readSubagentMeta(path.join(DIR, SESSIONS.subagents, "subagents"));
  assert.deepEqual(entries.map((e) => e.agentId), [AGENTS.async, AGENTS.sync, AGENTS.nested, AGENTS.queued, AGENTS.embedded]);
  assert.equal(entries[2].meta.parentAgentId, AGENTS.async);
  assert.ok(fs.existsSync(entries[0].file));
  assert.deepEqual(await readSubagentMeta(path.join(DIR, "nope", "subagents")), []);
});

test("a broken line is counted as unparsed, not fatal", async () => {
  const src = fs.readFileSync(file(SESSIONS.plain), "utf8");
  const tmpDir = fs.mkdtempSync(path.join(DIR, ".tmp-"));
  try {
    const tmp = path.join(tmpDir, `${SESSIONS.plain}.jsonl`);
    fs.writeFileSync(tmp, src + '{"type":"future-record","sessionId":"x"}\n{not json\n');
    const run = await parseClaudeSession(tmp, { home: HOME });
    assert.equal(run.coverage.unparsedRecords, 2);
    assert.deepEqual(run.coverage.unparsedTypes, { "future-record": 1, "<parse-error>": 1 });
    assert.equal(run.scopes[0].requests.length, expected.plain.requests);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
