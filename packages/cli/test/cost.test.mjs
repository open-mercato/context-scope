/**
 * Per-tool cost (ADR-005 section 5): the token-requests formula on a
 * hand-computed fixture, the uncached companion, presence windows cut by a
 * compaction, shares that never exceed 1, the summary merge, the `scan` line,
 * the population aggregate, and the `/api/v1/cost` route (a run, a scope, the
 * population; the population answer opens no run file).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createIndex } from "../src/index/index.mjs";
import { createServer } from "../src/server/app.mjs";
import {
  TOOL_COST_CAVEATS, TOOL_COST_HANDOFFS, TOOL_COST_OTHER, TOOL_COST_PROVENANCE, TOOL_COST_TOP, TOOL_COST_UNIT,
  finalizeRun, groupsFromRows, mergeToolCostGroups, rankToolCost, toolCostCacheReadShare, toolCostGroups, toolCostKeyOf, toolCostLine,
} from "../src/ir/finalize.mjs";
import costRoutes, { aggregateToolCost } from "../src/server/routes/cost.mjs";
import { CLAUDE_SESSIONS, fakeAdapters, fakeRules, fakeRun, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};
const TOKEN = "c".repeat(64);

const block = (id, category, estTokens, firstRequest, extra = {}) => ({ id, seq: Number(id.split(":")[1]), at: "2026-09-01T10:00:00Z", category, bytes: estTokens * 4, estTokens, firstRequest, hash: id, ...extra });

/**
 * Three requests with known k and cache reads:
 *   i  total  cacheRead  k     uncached share (1 - cacheRead/total)
 *   0  1000   0          1.0   1.00
 *   1  2000   1500       1.2   0.25
 *   2  4000   3000       0.8   0.25
 */
function handScope() {
  const usage = (total, cacheRead) => ({ input: total - cacheRead, cacheCreation: 0, cacheRead, output: 10, total });
  return {
    id: "main", kind: "main", compactions: [],
    requests: [
      { index: 0, at: "2026-09-01T10:00:00Z", model: "m", turn: 1, usage: usage(1000, 0), scale: 1.0 },
      { index: 1, at: "2026-09-01T10:01:00Z", model: "m", turn: 1, usage: usage(2000, 1500), scale: 1.2 },
      { index: 2, at: "2026-09-01T10:02:00Z", model: "m", turn: 1, usage: usage(4000, 3000), scale: 0.8 },
    ],
    blocks: [
      block("main:0", "user", 400, 0),                                                                             // not a tool: skipped
      block("main:1", "tool_result.file", 100, 0, { tool: { name: "Read", kind: "file", argsHash: "a" } }),        // present 0..2
      block("main:2", "tool_result.shell", 50, 1, { tool: { name: "Bash", kind: "shell", argsHash: "b" }, lastRequest: 1 }), // present at 1 only
      block("main:3", "tool_call", 10, 1, { tool: { name: "Bash", kind: "shell", argsHash: "c" } }),               // present 1..2
      block("main:4", "subagent_handoff", 200, 2, { agentId: "a1" }),                                              // present at 2
      block("main:5", "attachments", 30, 1, { attachmentType: "hook_success", lastRequest: 0 }),                   // never entered the window
      block("main:6", "assistant_thinking", 999, 0),                                                               // never occupancy
      block("main:7", "tool_result.other", 40, 2, { tool: { name: "mcp__github__list_prs", kind: "mcp", server: "github", argsHash: "d" } }), // present at 2
      block("main:8", "attachments", 20, 0, { attachmentType: "task_notification", lastRequest: 0 }),              // present at 0
    ],
  };
}

test("cost: toolCostGroups reproduces the hand-computed token-requests and uncached numbers", () => {
  const groups = toolCostGroups(handScope());
  // Read: 100 x (1.0 + 1.2 + 0.8) = 300; uncached 100 x (1.0 + 0.3 + 0.2) = 150
  assert.deepEqual(round(groups.get("Read")), { name: "Read", kind: "file", blocks: 1, tokenRequests: 300, uncached: 150 });
  // Bash: result 50 x 1.2 = 60 (uncached 50 x 0.3 = 15) + call 10 x (1.2 + 0.8) = 20 (uncached 10 x 0.5 = 5)
  assert.deepEqual(round(groups.get("Bash")), { name: "Bash", kind: "shell", blocks: 2, tokenRequests: 80, uncached: 20 });
  // Handoff: 200 x 0.8 = 160; uncached 200 x 0.2 = 40
  assert.deepEqual(round(groups.get(TOOL_COST_HANDOFFS)), { name: TOOL_COST_HANDOFFS, kind: "agent", blocks: 1, tokenRequests: 160, uncached: 40 });
  // MCP: 40 x 0.8 = 32; uncached 8; keeps the server
  assert.deepEqual(round(groups.get("mcp__github__list_prs")), { name: "mcp__github__list_prs", kind: "mcp", server: "github", blocks: 1, tokenRequests: 32, uncached: 8 });
  // Attachment present at request 0 only: 20 x 1.0 = 20, all uncached
  assert.deepEqual(round(groups.get("task_notification")), { name: "task_notification", kind: "attachment", blocks: 1, tokenRequests: 20, uncached: 20 });
  assert.equal(groups.has("hook_success"), false, "a block that never entered the window accrues nothing");
  assert.equal(groups.size, 5, "user and thinking blocks are not attributed");
});

test("cost: rankToolCost orders by token-requests, takes shares of the denominator, folds the tail into `other`", () => {
  const scope = handScope();
  const rows = rankToolCost(toolCostGroups(scope), 7000);
  assert.deepEqual(rows.map((row) => row.name), ["Read", TOOL_COST_HANDOFFS, "Bash", "mcp__github__list_prs", "task_notification"]);
  assert.equal(rows[0].share, Number((300 / 7000).toFixed(4)));
  assert.equal(rows[2].share, Number((80 / 7000).toFixed(4)));
  assert.equal(rows[3].server, "github");
  assert.ok(rows.reduce((sum, row) => sum + row.share, 0) <= 1);
  assert.equal(toolCostCacheReadShare(rows[0]), 0.5, "Read: 1 - 150/300");
  assert.equal(toolCostCacheReadShare(rows[2]), 0.75, "Bash: 1 - 20/80");
  const cut = rankToolCost(toolCostGroups(scope), 7000, 2);
  assert.deepEqual(cut.map((row) => row.name), ["Read", TOOL_COST_HANDOFFS, TOOL_COST_OTHER]);
  assert.deepEqual(cut[2], { name: TOOL_COST_OTHER, kind: "other", blocks: 4, tokenRequests: 132, uncached: 48, share: Number((132 / 7000).toFixed(4)) });
  assert.equal(TOOL_COST_TOP, 8);
  assert.equal(rankToolCost(new Map(), 0).length, 0);
  assert.deepEqual(rankToolCost(toolCostGroups(scope), 0).map((row) => row.share), [0, 0, 0, 0, 0], "no denominator, no share");
  assert.equal(toolCostKeyOf({ category: "tool_call" }).name, TOOL_COST_OTHER, "a tool block without a name is `other`");
  assert.equal(toolCostKeyOf({ category: "compaction_summary" }), null, "compaction summaries keep the residue; they are not a tool");
});

test("cost: finalizeRun stores scope.toolCost and summary.toolCost; a block dropped at a compaction stops accruing; shares sum to <= 1", () => {
  const compacted = fakeRun(`/x/${CLAUDE_SESSIONS[1]}.jsonl`, "claude");
  const main = compacted.scopes[0];
  const read = main.blocks.find((b) => b.tool?.name === "Read");
  assert.equal(read.droppedBy, "c1", "the fixture's Read block leaves at the compaction before request 2");
  assert.equal(read.lastRequest, 1);
  const row = main.toolCost.find((r) => r.name === "Read");
  assert.equal(row.tokenRequests, Math.round(9000 * main.requests[1].scale), "accrues over request 1 only");
  const r1 = main.requests[1].usage;
  assert.equal(row.uncached, Math.round(9000 * main.requests[1].scale * (1 - r1.cacheRead / r1.total)));
  assert.equal(row.share, Number((row.tokenRequests / main.processedInputTokens).toFixed(4)));
  assert.ok(main.toolCost.reduce((sum, r) => sum + r.share, 0) <= 1);
  for (const scope of compacted.scopes) assert.ok(Array.isArray(scope.toolCost), `${scope.id} carries toolCost`);

  // Summary: main + subagents merged, shares over the run's processed input.
  const run = fakeRun(`/x/${CLAUDE_SESSIONS[0]}.jsonl`, "claude");
  const summary = run.summary.toolCost;
  assert.ok(Array.isArray(summary) && summary.length > 0);
  const total = run.scopes.reduce((sum, scope) => sum + scope.processedInputTokens, 0);
  const mainRead = run.scopes[0].toolCost.find((r) => r.name === "Read");
  const merged = summary.find((r) => r.name === "Read");
  assert.equal(merged.tokenRequests, mainRead.tokenRequests, "the child scope has no Read block; the merged row equals main's");
  assert.equal(merged.share, Number((mainRead.tokenRequests / total).toFixed(4)));
  assert.ok(summary.some((r) => r.name === TOOL_COST_HANDOFFS && r.kind === "agent"));
  assert.ok(summary.some((r) => r.name === "mcp__github__list_prs" && r.server === "github"));
  assert.ok(summary.reduce((sum, r) => sum + r.share, 0) <= 1);
  assert.equal(TOOL_COST_UNIT, "token-requests");
  assert.equal(TOOL_COST_PROVENANCE, "estimated.local");
  assert.equal(TOOL_COST_CAVEATS.length, 4);
});

test("cost: groupsFromRows + mergeToolCostGroups rebuild a summary from ranked tables; toolCostLine prints the scan line", () => {
  const a = groupsFromRows([{ name: "Bash", kind: "shell", blocks: 2, tokenRequests: 400, uncached: 90, share: 0.4 }, { name: TOOL_COST_OTHER, kind: "other", blocks: 1, tokenRequests: 10, uncached: 1, share: 0.01 }]);
  const b = groupsFromRows([{ name: "Bash", kind: "shell", blocks: 1, tokenRequests: 100, uncached: 10, share: 0.2 }, { name: "Read", kind: "file", blocks: 3, tokenRequests: 220, uncached: 100, share: 0.44 }]);
  const rows = rankToolCost(mergeToolCostGroups([a, b]), 1000);
  assert.deepEqual(rows.map((r) => [r.name, r.blocks, r.tokenRequests, r.uncached, r.share]), [["Bash", 3, 500, 100, 0.5], ["Read", 3, 220, 100, 0.22], [TOOL_COST_OTHER, 1, 10, 1, 0.01]]);
  assert.equal(toolCostLine([{ name: "Bash", kind: "shell", blocks: 1, tokenRequests: 1000, uncached: 220, share: 0.41 }, { name: "Read", kind: "file", blocks: 1, tokenRequests: 500, uncached: 100, share: 0.22 }, { name: TOOL_COST_HANDOFFS, kind: "agent", blocks: 1, tokenRequests: 200, uncached: 50, share: 0.09 }, { name: "Grep", kind: "search", blocks: 1, tokenRequests: 20, uncached: 5, share: 0.01 }, { name: TOOL_COST_OTHER, kind: "other", blocks: 1, tokenRequests: 5, uncached: 1, share: 0.002 }]),
    "Cost by tool: Bash 41% (cache-read 78%) · Read 22% · Agent handoffs 9% — token-requests, estimated");
  assert.equal(toolCostLine([]), "");
  assert.equal(toolCostLine(undefined), "");
});

test("cost: aggregateToolCost sums manifest summaries and counts runs without the field", () => {
  const entries = [
    { runId: "claude:a", summary: { processedInputTokens: 1000, toolCost: [{ name: "Bash", kind: "shell", blocks: 1, tokenRequests: 300, uncached: 30, share: 0.3 }] } },
    { runId: "claude:b", summary: { processedInputTokens: 3000, toolCost: [{ name: "Bash", kind: "shell", blocks: 2, tokenRequests: 900, uncached: 100, share: 0.3 }, { name: "Read", kind: "file", blocks: 1, tokenRequests: 600, uncached: 60, share: 0.2 }] } },
    { runId: "claude:old", summary: { processedInputTokens: 5000 } },
    { runId: "claude:broken" },
  ];
  const aggregate = aggregateToolCost(entries);
  assert.equal(aggregate.denominator, 4000, "runs without the field do not dilute the shares");
  assert.equal(aggregate.runsWithoutCost, 1);
  assert.deepEqual(aggregate.rows.map((r) => [r.name, r.blocks, r.tokenRequests, r.uncached, r.share]), [["Bash", 3, 1200, 130, 0.3], ["Read", 1, 600, 60, 0.15]]);
  const many = Array.from({ length: 250 }, (_, i) => ({ runId: `claude:${i}`, summary: { processedInputTokens: 100_000, toolCost: Array.from({ length: 9 }, (__, j) => ({ name: `tool${(i + j) % 20}`, kind: "other", blocks: 1, tokenRequests: 1000 + j, uncached: 100, share: 0.01 })) } }));
  const started = performance.now();
  aggregateToolCost(many);
  assert.ok(performance.now() - started < 50, "250 entries aggregate quickly");
});

test("cost: the population route opens no run file", async () => {
  const opened = [];
  const entries = [
    { runId: "claude:a", vendor: "claude", startedAt: "2026-09-01T10:00:00Z", endedAt: "2026-09-01T11:00:00Z", summary: { processedInputTokens: 1000, toolCost: [{ name: "Bash", kind: "shell", blocks: 1, tokenRequests: 300, uncached: 30, share: 0.3 }] } },
    { runId: "claude:b", vendor: "claude", startedAt: "2026-09-01T10:00:00Z", endedAt: "2026-09-01T11:00:00Z", summary: { processedInputTokens: 1000, toolCost: [{ name: "Read", kind: "file", blocks: 1, tokenRequests: 100, uncached: 10, share: 0.1 }] } },
  ];
  const index = {
    entries: async () => entries,
    readRunShell: async (id) => { opened.push(id); return null; },
    readScope: async (id) => { opened.push(id); return null; },
  };
  const analysis = { population: async () => ({ entries, roots: entries }) };
  const [route] = costRoutes({ index, analysis, repoRoot: "/repo" });
  assert.equal(route.pattern, "/api/v1/cost");
  const answer = async (search) => {
    let sent;
    const response = { writeHead(status) { sent = { status }; }, end(body) { sent.body = JSON.parse(Buffer.from(body).toString("utf8")); } };
    await route.handler({ response, url: new URL(`http://x/api/v1/cost${search}`) });
    return sent;
  };
  for (const search of ["", "?scope=repo", "?scope=all&since=all"]) {
    const { status, body } = await answer(search);
    assert.equal(status, 200, search);
    assert.equal(body.unit, TOOL_COST_UNIT);
    assert.equal(body.provenance, TOOL_COST_PROVENANCE);
    assert.equal(body.scope.sessions, 2);
    assert.equal(body.scope.runsWithoutCost, 0);
    assert.equal(body.denominator, 2000);
    assert.deepEqual(body.rows.map((r) => r.name), ["Bash", "Read"]);
    assert.deepEqual(body.caveats, [...TOOL_COST_CAVEATS]);
  }
  assert.deepEqual(opened, [], "the population answer is manifest-only");
  assert.equal((await answer("?scope=nope")).status, 400);
  assert.equal((await answer("?since=yesterday")).status, 400);
  assert.equal((await answer("?run=nocolon")).status, 400);
  assert.equal((await answer("?run=claude:missing")).status, 404);
  assert.deepEqual(opened, ["claude:missing"], "a run query reads that run's shell only");
});

test("cost: GET /api/v1/cost serves a run, one of its scopes and the population over the fixture index", async () => {
  const fixture = await makeFixtureHome();
  const app = createServer({ home: fixture.home, repoRoot: fixture.repo, token: TOKEN, adapters: fakeAdapters(), rules: fakeRules(), setup: fakeSetup(), consent: false, env: {}, warn: quiet });
  try {
    const { port } = await app.listen(0);
    await app.index.ensure();
    const get = async (search) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/cost${search}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return { status: response.status, body: await response.json() };
    };
    const runId = `claude:${CLAUDE_SESSIONS[0]}`;
    const run = await get(`?run=${encodeURIComponent(runId)}`);
    assert.equal(run.status, 200);
    assert.deepEqual(run.body.scope, { mode: "run", runId });
    assert.ok(run.body.rows.some((r) => r.name === "Read"));
    assert.ok(run.body.rows.some((r) => r.name === TOOL_COST_HANDOFFS));
    assert.ok(run.body.denominator > 0);
    const scope = await get(`?run=${encodeURIComponent(runId)}&scope=a1`);
    assert.equal(scope.status, 200);
    assert.deepEqual(scope.body.scope, { mode: "run", runId, scopeId: "a1" });
    assert.deepEqual(scope.body.rows, [], "the child scope carries only a user block");
    assert.equal((await get(`?run=${encodeURIComponent(runId)}&scope=zz`)).status, 404);
    const repo = await get("?scope=repo");
    assert.equal(repo.status, 200);
    assert.equal(repo.body.scope.mode, "repo");
    assert.ok(repo.body.scope.sessions >= 2, "the repo has at least two claude sessions plus codex");
    assert.equal(repo.body.scope.runsWithoutCost, 0);
    assert.ok(repo.body.rows[0].tokenRequests > 0);
    assert.ok(repo.body.rows.reduce((sum, r) => sum + r.share, 0) <= 1);
    const all = await get("?scope=all&since=all");
    assert.equal(all.status, 200);
    assert.ok(all.body.scope.sessions >= repo.body.scope.sessions);
    const gated = await fetch(`http://127.0.0.1:${port}/api/v1/cost`);
    assert.notEqual(gated.status, 200, "the route needs the launch token");
  } finally {
    await app.close();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

function round(row) {
  if (!row) return row;
  const out = { ...row, tokenRequests: Number(row.tokenRequests.toFixed(6)), uncached: Number(row.uncached.toFixed(6)) };
  return out;
}
