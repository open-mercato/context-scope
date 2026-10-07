import assert from "node:assert/strict";
import test from "node:test";
import { RECONCILE_DEFAULTS, applyCompactionPresence, reconcileScope } from "../src/ir/reconcile.mjs";
import { finalizeRun, roundWindow } from "../src/ir/finalize.mjs";

function block(id, category, estTokens, firstRequest, extra = {}) {
  return { id, seq: Number(id.split(":")[1]), at: "2026-09-01T10:00:00Z", category, bytes: estTokens * 4, estTokens, firstRequest, hash: id, ...extra };
}

function request(index, total, extra = {}) {
  return { index, at: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`, model: "m", turn: 1, usage: { input: 100, cacheCreation: 200, cacheRead: total - 300, output: 50, total }, ...extra };
}

const sum = (composition) => Object.values(composition).reduce((a, b) => a + b, 0);

function assertExact(scope) {
  for (const r of scope.requests) {
    assert.equal(sum(r.composition), r.usage.total, `request ${r.index} sums to usage.total`);
    for (const [category, value] of Object.entries(r.composition)) assert.ok(value >= 0, `request ${r.index} ${category} is never negative (${value})`);
    assert.equal(r.composition.assistant_thinking, undefined);
  }
}

// Small numbers: make the step detector work at fixture scale.
const SMALL = { reconcileStepMinTokens: 1_000, reconcileStepWindowShare: 0 };

test("composition always sums to the exact vendor total and H is split into system / instructions / unlogged", () => {
  const scope = {
    id: "main", kind: "main", compactions: [],
    requests: [request(0, 20_000), request(1, 26_000), request(2, 30_000)],
    blocks: [block("main:0", "user", 1_000, 0), block("main:1", "tool_result.file", 5_000, 1), block("main:2", "assistant_thinking", 9_000, 1), block("main:3", "tool_result.shell", 4_000, 2)],
  };
  const { errors, unloggedShare } = reconcileScope(scope, { instructionTokensEstimate: 4_000, systemBaseline: 15_000 });
  assert.equal(scope.requests[0].hiddenBase.value, 19_000);
  assert.equal(scope.requests[0].composition.instructions, 4_000);
  assert.equal(scope.requests[0].composition.system, 15_000);
  assert.equal(scope.requests[0].composition.unlogged, undefined, "plain fixture has no unlogged mass");
  assert.equal(unloggedShare, 0);
  assert.equal(scope.unloggedShare, 0);
  assert.equal(scope.resumed, false);
  assertExact(scope);
  assert.equal(scope.requests[1].newBlockIds.length, 2);
  assert.equal(scope.requests[1].scaleRaw, Number(((26_000 - 19_000) / 6_000).toFixed(4)));
  assert.equal(scope.requests[1].scale, scope.requests[1].scaleRaw, "inside the band k is not clamped");
  assert.equal(errors.length, 2, "segment-start requests are not part of the error series");
  assert.deepEqual(errors.map((e) => Number(e.toFixed(4))), [0.1667, 0.1]);
  assert.equal(scope.estimatorErrorMedian, 0.1);
  assert.equal(scope.estimatorErrorP95, 0.1667);
  assert.equal(scope.requests[0].deltaCheck, undefined);
  assert.equal(scope.requests[1].deltaCheck, 300 - 5_000);
});

test("the system baseline caps `system`; the rest of a resumed base is `unlogged` and the scope is flagged resumed", () => {
  const scope = {
    id: "main", kind: "main", compactions: [],
    requests: [request(0, 200_000), request(1, 204_000), request(2, 209_000)],
    blocks: [block("main:0", "tool_result.file", 4_000, 1), block("main:1", "tool_result.shell", 5_000, 2)],
  };
  reconcileScope(scope, { instructionTokensEstimate: 3_000, systemBaseline: 25_000, window: 1_000_000 });
  const first = scope.requests[0].composition;
  assert.equal(first.system, 25_000);
  assert.equal(first.instructions, 3_000);
  assert.equal(first.unlogged, 172_000);
  assert.equal(scope.requests[0].hiddenBase.value, 200_000);
  assert.equal(scope.resumed, true);
  assert.ok(scope.unloggedShare > 0.8);
  assert.equal(scope.transcriptIncomplete, false, "requests do gain blocks");
  assertExact(scope);
});

test("k is clamped to [0.6, 1.5] and the remainder is named `unlogged`, counted as clamped, not averaged into the error", () => {
  const scope = {
    id: "main", kind: "main", compactions: [],
    requests: [request(0, 10_000), request(1, 30_000), request(2, 15_500)],
    blocks: [block("main:0", "user", 1_000, 0), block("main:1", "tool_result.file", 5_000, 1), block("main:2", "user", 500, 2)],
  };
  const { errors, clamped } = reconcileScope(scope, { systemBaseline: 25_000, window: 200_000 });
  const r1 = scope.requests[1];
  assert.equal(r1.scale, RECONCILE_DEFAULTS.reconcileScaleMax);
  assert.ok(r1.scaleRaw > 3);
  assert.equal(r1.composition.unlogged, 30_000 - 9_000 - Math.round(1.5 * 6_000));
  assert.equal(clamped, 1);
  assert.equal(scope.clampedRequests, 1);
  assert.deepEqual(errors, [0], "only the unclamped request 2 contributes an error");
  assert.equal(scope.requests[2].composition.unlogged, undefined);
  assertExact(scope);
});

test("three agreeing residual steps re-derive the base (up), record baseChange and baseSteps, and recompute the run", () => {
  const scope = {
    id: "a1", kind: "subagent", compactions: [],
    requests: [request(0, 10_000), request(1, 45_000), request(2, 47_000), request(3, 49_000), request(4, 51_000)],
    blocks: [block("a1:0", "user", 1_000, 0), block("a1:1", "tool_result.file", 2_000, 1), block("a1:2", "tool_result.file", 2_000, 2), block("a1:3", "tool_result.file", 2_000, 3), block("a1:4", "tool_result.file", 2_000, 4)],
  };
  reconcileScope(scope, { systemBaseline: 25_000, window: 1_000_000, thresholds: SMALL });
  assert.deepEqual(scope.baseSteps.map((s) => s.atRequest), [1]);
  const step = scope.baseSteps[0].delta;
  // The injection is 33k; residuals are measured at the reference k (1 before any in-band request).
  assert.equal(step, 33_000);
  assert.deepEqual(scope.requests[1].baseChange, { tokens: step, provenance: "derived.exact" });
  assert.equal(scope.requests[2].baseChange, undefined);
  assert.equal(scope.requests[0].composition.unlogged, undefined);
  for (const r of scope.requests.slice(1)) {
    assert.equal(r.scaleRaw, 1, `request ${r.index} sits on k = 1 after the rebase`);
    assert.equal(r.composition.unlogged, step, "unlogged carries the step");
  }
  assert.equal(scope.clampedRequests, 0);
  assert.equal(scope.estimatorErrorP95, 0);
  assertExact(scope);
});

test("a persistent drop after a model switch steps the base down: unlogged goes to 0, then system shrinks", () => {
  const scope = {
    id: "main", kind: "main", compactions: [],
    requests: [request(0, 60_000, { model: "a" }), request(1, 62_000, { model: "a" }), request(2, 20_000, { model: "b" }), request(3, 21_000, { model: "b" }), request(4, 22_000, { model: "b" }), request(5, 23_000, { model: "b" })],
    blocks: [block("main:0", "user", 1_000, 0), block("main:1", "tool_result.file", 1_000, 1), block("main:2", "tool_result.file", 1_000, 2), block("main:3", "tool_result.file", 1_000, 3), block("main:4", "tool_result.file", 1_000, 4), block("main:5", "tool_result.file", 1_000, 5)],
  };
  reconcileScope(scope, { instructionTokensEstimate: 4_000, systemBaseline: 25_000, window: 200_000, thresholds: SMALL });
  assert.equal(scope.requests[0].composition.unlogged, 30_000);
  assert.equal(scope.baseSteps.length, 1);
  assert.equal(scope.baseSteps[0].atRequest, 2);
  assert.ok(scope.baseSteps[0].delta < -35_000, `delta ${scope.baseSteps[0].delta}`);
  const after = scope.requests[3].composition;
  assert.equal(after.unlogged, undefined, "hidden mass fell below the baseline: unlogged is gone");
  assert.ok(after.system > 0 && after.system < 25_000, `system shrank to ${after.system}`);
  assert.equal(after.instructions, 4_000);
  assertExact(scope);
});

test("a one-off total below the hidden base rebases the request instead of producing a negative category (backend #3)", () => {
  const scope = {
    id: "main", kind: "main", compactions: [],
    requests: [request(0, 5_000), request(1, 4_000), request(2, 5_600)],
    blocks: [block("main:0", "user", 100, 0), block("main:1", "tool_result.file", 300, 1), block("main:2", "tool_call", 300, 1), block("main:3", "assistant_text", 300, 1)],
  };
  reconcileScope(scope, { instructionTokensEstimate: 1_000, systemBaseline: 25_000, window: 200_000 });
  const r1 = scope.requests[1];
  assertExact(scope);
  assert.equal(r1.reconciled, undefined, "the shortfall fits inside system: no rebase needed");
  assert.equal(r1.composition.unlogged, undefined);
  assert.ok(r1.composition.system < 3_900);
  // Now a total so small that system, instructions and the clamp cannot absorb it.
  scope.requests[1].usage.total = 500;
  reconcileScope(scope, { instructionTokensEstimate: 1_000, systemBaseline: 25_000, window: 200_000 });
  const rebased = scope.requests[1];
  assert.equal(rebased.reconciled, "rebased");
  assert.equal(rebased.composition.system, undefined);
  assert.equal(rebased.composition.instructions, undefined);
  assert.equal(rebased.hiddenBase.value, 0);
  assert.ok(rebased.scale < 0.6);
  assertExact(scope);
  assert.equal(scope.requests[2].reconciled, undefined, "the next request is back on the segment base");
});

test("compaction drops earlier blocks, keeps the summary and preserved blocks, and recomputes H", () => {
  const scope = {
    id: "main", kind: "main",
    compactions: [{ id: "c1", at: "2026-09-01T10:02:30Z", atRequest: 3, trigger: "auto", preTokens: { value: 90_000, provenance: "observed.vendor" }, postTokens: { value: 8_000, provenance: "observed.vendor" }, droppedTokens: { value: 82_000, provenance: "observed.vendor" }, summaryBlockId: "main:4" }],
    requests: [request(0, 20_000), request(1, 60_000), request(2, 90_000), request(3, 40_000), request(4, 45_000)],
    blocks: [block("main:0", "user", 1_000, 0), block("main:1", "tool_result.file", 40_000, 1), block("main:2", "tool_result.shell", 30_000, 2), block("main:3", "user", 500, 2, { preservedBy: "c1" }), block("main:4", "compaction_summary", 6_000, 3), block("main:5", "tool_result.search", 5_000, 4), block("main:6", "tool_call", 700, 3, { lastRequest: 2, droppedBy: "c1" })],
  };
  reconcileScope(scope, { systemBaseline: 25_000, window: 200_000 });
  assert.equal(scope.blocks[1].lastRequest, 2);
  assert.equal(scope.blocks[1].droppedBy, "c1");
  assert.equal(scope.blocks[3].lastRequest, undefined, "preserved block stays");
  assert.equal(scope.blocks[4].lastRequest, undefined);
  assert.equal(scope.requests[3].hiddenBase.value, 40_000 - 6_500);
  assert.equal(scope.requests[3].composition.compaction_summary, 6_000);
  assert.equal(scope.requests[3].composition.user, 500);
  assert.equal(scope.requests[3].composition.tool_call, undefined, "a block in flight at the boundary never enters the window");
  assert.equal(scope.requests[4].composition["tool_result.file"], undefined);
  assert.equal(scope.requests[3].deltaCheck, undefined, "segment starts have no delta check");
  assertExact(scope);
});

test("applyCompactionPresence never touches summary or preserved blocks", () => {
  const scope = { compactions: [{ id: "c1", atRequest: 2, summaryBlockId: "s" }], blocks: [block("s", "compaction_summary", 10, 2), block("p", "user", 10, 0, { preservedBy: "c1" }), block("d", "user", 10, 0)] };
  applyCompactionPresence(scope);
  assert.equal(scope.blocks[0].lastRequest, undefined);
  assert.equal(scope.blocks[1].lastRequest, undefined);
  assert.equal(scope.blocks[2].lastRequest, 1);
});

test("codex legacy children: unlogged everywhere and no new blocks flag transcriptIncomplete", () => {
  const scope = {
    id: "main", kind: "main", compactions: [],
    requests: Array.from({ length: 10 }, (_, i) => request(i, 50_000 + i * 1_000)),
    blocks: [block("main:0", "system", 2_000, 0, { label: "base_instructions" })],
  };
  reconcileScope(scope, { vendor: "codex", window: 258_400 });
  assert.equal(scope.requests[0].composition.system, 2_000, "codex baseline is 0 when base_instructions is a block");
  assert.equal(scope.requests[0].composition.unlogged, 48_000);
  assert.equal(scope.transcriptIncomplete, true);
  assert.ok(scope.unloggedShare > 0.9);
  assertExact(scope);
});

test("dense request indices are required", () => {
  const scope = { id: "main", kind: "main", compactions: [], requests: [request(0, 10), request(2, 20)], blocks: [] };
  assert.throws(() => reconcileScope(scope), /dense/);
});

test("finalizeRun computes peaks, summary, handoff ratio, main-scope coverage and the documented window", () => {
  const run = {
    id: "claude:s1", vendor: "claude", sessionId: "s1", project: { key: "p", displayName: "p", cwdHash: "h" }, startedAt: "", endedAt: "",
    window: { value: 200_000, provenance: "estimated.local" }, coverage: { records: 10, unparsedRecords: 0, unparsedTypes: {}, syntheticRecordsSkipped: 0, adapterVersion: "test" }, source: { file: "x", bytes: 1, mtimeMs: 1, subagentFiles: 1 },
    scopes: [
      { id: "main", kind: "main", compactions: [], requests: [request(0, 20_000), request(1, 30_000)], blocks: [block("main:0", "user", 1_000, 0), block("main:1", "tool_call", 100, 1, { tool: { name: "Agent", kind: "agent", argsHash: "a" } }), block("main:2", "subagent_handoff", 3_000, 1, { agentId: "a1" })] },
      { id: "a1", kind: "subagent", parentScopeId: "main", compactions: [], requests: [request(0, 50_000), request(1, 320_000)], blocks: [block("a1:0", "user", 800, 0)], handoff: { blockId: "main:2", tokens: { value: 3_000, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } } },
    ],
  };
  finalizeRun(run);
  assert.equal(run.scopes[0].peak.value, 30_000);
  assert.equal(run.scopes[1].peak.value, 320_000);
  assert.equal(run.scopes[1].handoff.compressionRatio.value, Number((320_000 / 3_000).toFixed(2)));
  assert.equal(run.summary.subagents, 1);
  assert.equal(run.summary.processedInputTokens, 420_000);
  assert.equal(run.summary.peak.value, 30_000);
  assert.equal(run.coverage.requests, 4);
  assert.equal(run.coverage.estimatorErrorMedian, run.scopes[0].estimatorErrorMedian, "run-level error is the main scope's");
  assert.equal(run.coverage.estimatorErrorP95, run.scopes[0].estimatorErrorP95);
  assert.equal(run.coverage.unloggedShare, run.scopes[0].unloggedShare);
  assert.equal(run.coverage.estimatorVersion, "chars-v2");
  assert.ok(run.coverage.calibrationVersion);
  assert.deepEqual(run.window, { value: 1_000_000, provenance: "derived.exact", lowerBound: 320_000 }, "a peak above the table picks the next documented window");
});

test("roundWindow never invents a window above 1M", () => {
  assert.deepEqual(roundWindow(150_000), { value: 200_000, provenance: "derived.exact", lowerBound: 150_000 });
  assert.deepEqual(roundWindow(998_998), { value: 1_000_000, provenance: "derived.exact", lowerBound: 998_998 });
  assert.deepEqual(roundWindow(1_200_000), { value: 1_200_000, provenance: "unknown", lowerBound: 1_200_000 });
});
