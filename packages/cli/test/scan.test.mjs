/** `scan` rendering: the cycle-3 mounts (header tail, cost line, changes block) and the first-run "what we found" block. */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createIndex } from "../src/index/writer.mjs";
import { createAnalysis } from "../src/server/analysis.mjs";
import { compositionAtPeak, firstRunReport, renderCostLine, renderFirstRun, renderScan, scanJson, scanReport } from "../src/index/scan.mjs";
import { fakeAdapters, fakeRules, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};

function baseOverview(extra = {}) {
  return {
    scope: { mode: "repo", repo: { name: "repo", key: "k" }, sessions: 3, machineSessions: 189, unattributed: 3, ...extra.scope },
    runs: [],
    totals: { runs: 3, subagents: 2, requests: 40, processedInputTokens: 1_000_000, cacheReadShare: 0.8, compactions: 1, sessionsByVendor: { claude: 3 }, sessionsHot: 1 },
    vendors: [],
    index: { state: "idle", files: 5, lastPass: { parsed: 5, reevaluated: 0, failed: 0 } },
    range: "all",
    since: null,
    trends: {},
    topOffenders: { largestBlocks: [], fattestHandoffs: [], mostCompacted: [] },
  };
}

test("header: harness runs, unattributed and path-overlap attribution appear only when the overview carries them", () => {
  const plain = renderScan({ overview: baseOverview(), groups: [], findings: [], habits: { findings: [], notes: [] } }, { repoName: "repo" });
  assert.match(plain, /Sessions 3 \(claude 3\) · subagents 2 · requests 40 · 3 unattributed on this machine/);
  assert.ok(!plain.includes("harness"));
  const cycle3 = renderScan({ overview: baseOverview({ scope: { attributed: 1, harness: 56 } }), groups: [], findings: [], habits: { findings: [], notes: [] } }, { repoName: "repo" });
  assert.match(cycle3, /Sessions 3 \(claude 3; 1 attributed by path overlap\) · subagents 2 · requests 40 · 56 harness runs and 3 unattributed on this machine/);
});

test("cost line: top rows with the cache-read share of the first, nothing without data", () => {
  assert.equal(renderCostLine(null), null);
  assert.equal(renderCostLine({ rows: [] }), null);
  const line = renderCostLine({ rows: [
    { name: "Bash", share: 0.41, tokenRequests: 1000, uncached: 220 },
    { name: "Read", share: 0.22, tokenRequests: 500, uncached: 100 },
    { name: "Agent handoffs", share: 0.09, tokenRequests: 200, uncached: 50 },
  ], scope: { runsWithoutCost: 2 } });
  assert.equal(line, "Cost by tool: Bash 41% (cache-read 78%) · Read 22% · Agent handoffs 9% — token-requests, estimated; 2 runs indexed before the field existed");
  const rendered = renderScan({ overview: baseOverview(), groups: [], findings: [], habits: { findings: [], notes: [] }, cost: { rows: [{ name: "Read", share: 0.5, tokenRequests: 10, uncached: 10 }] } }, { repoName: "repo" });
  assert.match(rendered, /\nCost by tool: Read 50% \(cache-read 0%\) — token-requests, estimated\n/);
});

test("scan --json carries changes and cost only when present", () => {
  const report = { overview: baseOverview(), groups: [], findings: [], firstChange: null, habits: {}, setup: {} };
  assert.deepEqual(Object.keys(scanJson(report)), ["overview", "groups", "findings", "firstChange", "habits", "setup"]);
  assert.deepEqual(Object.keys(scanJson({ ...report, changes: { changes: [] }, cost: { rows: [] } })).slice(-2), ["changes", "cost"]);
});

test("composition at peak sums each session's peak composition and names the top categories", () => {
  const runs = [
    { summary: { compositionAtPeak: { "tool_result.file": 600, system: 300, instructions: 100 } } },
    { summary: { compositionAtPeak: { "tool_result.file": 400, system: 100, user: 500 } } },
    { summary: {} },
  ];
  const rows = compositionAtPeak(runs);
  assert.deepEqual(rows.map((row) => [row.label, Number(row.share.toFixed(2))]), [["file reads", 0.5], ["user messages", 0.25], ["system prompt", 0.2]]);
  assert.deepEqual(compositionAtPeak([]), []);
});

test("the first-run block answers the three questions in one line each, with the fix and the hooks state", () => {
  const found = {
    files: 250, ms: 1900, machineSessions: 189, repo: "context-viewer", sessions: 3, sessionsByVendor: { claude: 3 }, subagents: 45,
    composition: [{ label: "file reads", share: 0.52 }, { label: "system prompt", share: 0.18 }, { label: "instructions", share: 0.09 }],
    handoff: { agentType: "Explore", handoffTokens: 38_200, childPeak: 120_000, ratio: 0.31, startedAt: "2026-09-01T10:03:00Z" },
    firstChange: { severity: "high", ruleId: "H-01", title: "Recurring fat Read", recurrence: 3, fix: { platform: "both", path: "CLAUDE.md", summary: "Read with limit" } },
    hooksInstalled: false, captureRecords: 0,
  };
  const text = renderFirstRun(found, { url: "http://127.0.0.1:1/?token=x" });
  const lines = text.split("\n");
  assert.equal(lines[0], "What we found: 250 session files · 189 sessions on this machine · 3 in context-viewer (claude 3) · 45 subagents · 1.9 s");
  assert.match(lines[1], /^  Where the context went: at peak, file reads 52% · system prompt 18% · instructions 9% \(3 sessions, all time\)$/);
  assert.match(lines[2], /^  What subagents cost: fattest handoff Explore 38\.2k tokens back from a 120k-token peak, ratio 0\.31 \(session Sep 1, \d\d:\d\d\)$/);
  assert.equal(lines[3], "  Change first: [HIGH] H-01 Recurring fat Read · 3 sessions");
  assert.equal(lines[4], "    Fix (both) → CLAUDE.md: Read with limit");
  assert.equal(lines[5], "  hooks: not installed (contextscope hooks install --scope user) · runtime evidence for the Setup screen");
  assert.equal(lines[6], "  Open: http://127.0.0.1:1/?token=x");

  const empty = renderFirstRun({ ...found, sessions: 0, sessionsByVendor: {}, subagents: 0, composition: [], handoff: null, firstChange: null, hooksInstalled: true, captureRecords: 12 });
  assert.match(empty, /No session of context-viewer yet: run claude or codex inside it/);
  assert.match(empty, /The 189 sessions on this machine belong to other directories; contextscope --repo <path>/);
  assert.match(empty, /hooks: installed · 12 records captured/);
  assert.ok(!empty.includes("Open:"));
});

test("firstRunReport and scanReport over the fixture home: numbers match the overview, no absolute path leaks", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    const pass = await index.ensure();
    const analysis = createAnalysis({ index, home: fixture.home, repoRoot: fixture.repo, rules: fakeRules(), setup: fakeSetup(), warn: quiet });
    const found = await firstRunReport(analysis, { pass, hooks: { scopes: [{ installed: [] }], capture: { records: 0 } } });
    assert.equal(found.files, 5);
    assert.equal(found.sessions, 3);
    assert.equal(found.machineSessions, 4);
    assert.equal(found.repo, "repo");
    assert.deepEqual(found.sessionsByVendor, { claude: 2, codex: 1 });
    assert.equal(found.firstChange.ruleId, "H-01");
    assert.equal(found.hooksInstalled, false);
    const text = renderFirstRun(found, { url: "http://127.0.0.1:1/" });
    assert.match(text, /^What we found: 5 session files · 4 sessions on this machine · 3 in repo \(claude 2, codex 1\) · \d+ subagents? · \d+\.\d s$/m);
    assert.match(text, /Change first: \[HIGH\] H-01/);
    assert.ok(!text.includes(fixture.home));

    const report = await scanReport(analysis, {});
    const rendered = renderScan(report, { repoName: "repo" });
    assert.match(rendered, /^ContextScope · repo repo · 3 sessions \(4 on this machine\)/);
    assert.match(rendered, /One change to make first/);
    assert.ok(!rendered.includes(fixture.home));
    const json = scanJson(report);
    assert.equal(json.overview.totals.runs, 3);
    await index.close?.();
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
