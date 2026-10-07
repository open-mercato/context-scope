/**
 * Before/after per instruction-file edit (ADR-005 §1): windows from a
 * synthetic manifest with two anchors, the hook-observed count, confound
 * detection, bootstrap determinism and its n ≥ 5 gate, the route shape, and
 * the manifest-only guarantee (fs spy: no run file is opened).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rm } from "node:fs/promises";
import {
  CAVEAT_OBSERVATIONAL, CAVEAT_STARTUP, METRICS, MIN_INTERVAL_N,
  anchorsOfFile, bootstrapDifference, buildChange, changesFor, confoundsOf, createRng, observationOf, renderChangesLines, sessionFacts, windowsFor,
} from "../src/index/changes.mjs";
import { createAnalysis } from "../src/server/analysis.mjs";
import { createRoutes } from "../src/server/routes/index.mjs";
import { createIndex } from "../src/index/writer.mjs";
import { fakeAdapters, fakeRules, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};

const REPO = "/nonexistent/repo";

/** A manifest root entry of REPO started on day `day` of Aug 2026. */
function entry(day, { vendor = "claude", h0 = 10_000, model = "claude-m", cli = "2.1.0", peak = 0.5, compactions = 0, activeMs = 3_600_000, processed = 100_000, fat = 0, ratio, rules = [], observed = [], codexChars, id } = {}) {
  const at = `2026-08-${String(day).padStart(2, "0")}T10:00:00Z`;
  return {
    runId: `${vendor}:${id ?? `s${day}`}`, vendor, sessionId: id ?? `s${day}`, projectKey: "repo-key", cwd: REPO, cwdKind: "repo", cwdReversible: true,
    startedAt: at, endedAt: at, activeMs, cliVersion: cli,
    summary: { requests: 10, processedInputTokens: processed, compactions, peakShareOfWindow: peak, findingIds: rules.map((r) => `${r}:abc`) },
    findingHeads: rules.map((r) => ({ id: `${r}:abc`, ruleId: r, severity: "low", scope: "session", title: `Rule ${r}` })),
    stats: { instructionFilesObserved: observed, codexInstructionChars: codexChars ?? 0 },
    habits: { v: 1, fat: fat ? [{ tool: "Read", kind: "file", tokens: 9_000 * fat, n: fat }] : [], fullReads: [], agents: ratio ? [{ type: "Explore", n: 2, ratioP50: ratio }] : [], compaction: { n: compactions }, startup: { h0, model, cliVersion: cli }, mcp: { invoked: [] }, peakShare: peak },
  };
}

const group = (root) => ({ root, descendants: [] });

test("windows: two anchors on one file split sessions into [previous, anchor) and [anchor, next); open at the ends", () => {
  const sessions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((day) => entry(day));
  const anchors = [{ at: "2026-08-04T00:00:00Z", anchor: "commit", commit: "aaaa" }, { at: "2026-08-08T00:00:00Z", anchor: "commit", commit: "bbbb" }];
  const windows = windowsFor(sessions, anchors);
  assert.equal(windows.length, 2, "one window per anchor");
  assert.equal(windows[0].anchor.commit, "bbbb", "newest anchor first");
  assert.deepEqual(windows[0].before.map((s) => s.startedAt.slice(8, 10)), ["04", "05", "06", "07"]);
  assert.deepEqual(windows[0].after.map((s) => s.startedAt.slice(8, 10)), ["08", "09", "10"]);
  assert.deepEqual(windows[1].before.map((s) => s.startedAt.slice(8, 10)), ["01", "02", "03"]);
  assert.deepEqual(windows[1].after.map((s) => s.startedAt.slice(8, 10)), ["04", "05", "06", "07"]);
  // A file without git anchors has its mtime as the one anchor.
  assert.deepEqual(anchorsOfFile({ path: "CLAUDE.md", mtime: "2026-08-04T00:00:00Z", bytes: 12 }), [{ at: "2026-08-04T00:00:00.000Z", anchor: "mtime", bytes: 12 }]);
  assert.equal(anchorsOfFile({ path: "CLAUDE.md", anchors }).length, 2);
  assert.equal(anchorsOfFile({ path: "CLAUDE.md", anchors: Array.from({ length: 30 }, (_, i) => ({ at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` })) }).length, 10, "capped at 10");
});

test("changesFor: a change per anchor with both sides, newest first; empty sides become notes; vendors select sessions; ?file narrows", () => {
  const sessions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((day) => group(entry(day, { h0: day < 8 ? 12_000 : 10_000, rules: day < 8 ? ["B-02"] : [] })));
  sessions.push(group(entry(9, { vendor: "codex", id: "c9", model: "gpt", cli: "0.1" })));
  const files = [
    { path: "CLAUDE.md", vendors: ["claude"], bytes: 100, mtime: "2026-08-08T00:00:00Z", anchors: [{ at: "2026-08-04T00:00:00Z", anchor: "commit", commit: "aaaa" }, { at: "2026-08-08T00:00:00Z", anchor: "commit", commit: "bbbb", bytes: 100 }] },
    { path: "AGENTS.md", vendors: ["codex"], bytes: 50, mtime: "2026-08-30T00:00:00Z" },
  ];
  const { changes, notes } = changesFor({ files, sessions, titleOf: (ruleId) => (ruleId === "B-02" ? "Shell output rule" : undefined), now: Date.parse("2026-09-02T00:00:00Z") });
  assert.equal(changes.length, 2);
  assert.equal(changes[0].file, "CLAUDE.md");
  assert.equal(changes[0].commit, "bbbb");
  assert.equal(changes[0].anchor, "commit");
  assert.deepEqual(changes[0].n, { before: 4, after: 3, afterObserved: 0 }, "the codex session does not count for a claude file");
  assert.equal(changes[0].before.startupH0.value, 12_000);
  assert.equal(changes[0].after.startupH0.value, 10_000);
  assert.equal(changes[0].delta.startupH0, -2_000);
  assert.equal(changes[0].delta.startupH0Ratio, 0.833);
  assert.equal(changes[0].before.startupH0.provenance, "estimated.local");
  assert.equal(changes[0].after.processedInputTokens.provenance, "observed.vendor");
  assert.equal(changes[0].ci, undefined, "no interval below 5 per side");
  assert.equal(changes[0].claim, "observational");
  assert.deepEqual(changes[0].findingsByRule, [{ ruleId: "B-02", title: "Shell output rule", before: { sessions: 4, of: 4 }, after: { sessions: 0, of: 3 } }]);
  assert.deepEqual(changes[0].caveats.slice(0, 4), [CAVEAT_OBSERVATIONAL, "4 before / 3 after", "model/CLI confound: none", CAVEAT_STARTUP]);
  assert.ok(changes[0].caveats.some((c) => c.startsWith("n small")));
  assert.equal(changes[1].commit, "aaaa");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].file, "AGENTS.md");
  assert.equal(notes[0].reason, "AGENTS.md edited 2026-08-30: no session since");
  assert.equal(changesFor({ files, sessions, file: "AGENTS.md" }).changes.length, 0);
  assert.equal(changesFor({ files, sessions, file: "CLAUDE.md" }).changes.length, 2);
  const text = JSON.stringify({ changes, notes });
  for (const word of ["improved", "better", "worse", "caused", "because"]) assert.ok(!text.includes(word), `no causal wording: ${word}`);
});

test("observation: hook InstructionsLoaded names the file; a codex session counts when its instruction chars match the anchor's size within 2 %", () => {
  assert.equal(observationOf(entry(1, { observed: ["CLAUDE.md"] }), { file: "CLAUDE.md" }), "observed");
  assert.equal(observationOf(entry(1, { observed: ["packages/x/CLAUDE.md"] }), { file: "CLAUDE.md" }), "observed", "a nested copy of the same name counts");
  assert.equal(observationOf(entry(1, { observed: ["AGENTS.md"] }), { file: "CLAUDE.md" }), "expected");
  assert.equal(observationOf(entry(1, { vendor: "codex", codexChars: 1010 }), { file: "AGENTS.md", bytes: 1000 }), "observed");
  assert.equal(observationOf(entry(1, { vendor: "codex", codexChars: 1500 }), { file: "AGENTS.md", bytes: 1000 }), "unverified");
  assert.equal(observationOf(entry(1, { vendor: "codex", codexChars: 1500 }), { file: "AGENTS.md" }), "unverified", "no known size: unverified");
  const before = [1, 2].map((d) => group(entry(d, { vendor: "codex", model: "gpt", cli: "0.1" })));
  const after = [5, 6, 7].map((d) => group(entry(d, { vendor: "codex", model: "gpt", cli: "0.1", codexChars: d === 5 ? 1000 : 2000, observed: d === 6 ? ["AGENTS.md"] : [] })));
  const change = buildChange({ file: "AGENTS.md", at: "2026-08-04T00:00:00Z", anchor: "commit", before, after, observationOf: (root) => observationOf(root, { file: "AGENTS.md", bytes: 1000 }) });
  assert.deepEqual(change.n, { before: 2, after: 3, afterObserved: 2, unverified: 1 });
});

test("confounds: dominant model or CLI-version set differing marks the row confounded with the reason; the row still renders", () => {
  const before = [1, 2, 3].map((d) => group(entry(d, { model: "opus", cli: "2.1.0" })));
  const sameAfter = [5, 6, 7].map((d) => group(entry(d, { model: "opus", cli: "2.1.0" })));
  assert.deepEqual(confoundsOf(before.map((g) => sessionFacts(g.root)), sameAfter.map((g) => sessionFacts(g.root))), { models: { before: "opus", after: "opus" }, cliVersions: { before: ["2.1.0"], after: ["2.1.0"] }, confounded: false });
  const modelAfter = [5, 6, 7].map((d) => group(entry(d, { model: d === 5 ? "opus" : "sonnet", cli: "2.1.0" })));
  const confounded = buildChange({ file: "CLAUDE.md", at: "2026-08-04T00:00:00Z", before, after: modelAfter });
  assert.equal(confounded.confounds.confounded, true);
  assert.equal(confounded.confounds.reason, "dominant model changed (opus → sonnet)");
  assert.equal(confounded.caveats[2], "model/CLI confound: dominant model changed (opus → sonnet)");
  assert.equal(typeof confounded.delta.startupH0, "number", "the row still renders");
  const cliAfter = [5, 6, 7].map((d) => group(entry(d, { model: "opus", cli: d === 7 ? "2.2.0" : "2.1.0" })));
  const upgraded = buildChange({ file: "CLAUDE.md", at: "2026-08-04T00:00:00Z", before, after: cliAfter });
  assert.equal(upgraded.confounds.reason, "CLI version changed (2.1.0 → 2.1.0, 2.2.0)");
});

test("interval: seeded bootstrap is deterministic (same anchor, same interval) and gated at n ≥ 5 per side", () => {
  const rng = createRng(42);
  const sequence = [rng(), rng(), rng()];
  const again = createRng(42);
  assert.deepEqual([again(), again(), again()], sequence);
  assert.ok(sequence.every((v) => v >= 0 && v < 1));
  const before = [1, 2, 3, 4, 5].map((d) => group(entry(d, { h0: 12_000 + d * 100, processed: 200_000 + d * 1000 })));
  const after = [6, 7, 8, 9, 10].map((d) => group(entry(d, { h0: 10_000 + d * 100, processed: 150_000 + d * 1000 })));
  const first = buildChange({ file: "CLAUDE.md", at: "2026-08-06T00:00:00Z", before, after });
  const second = buildChange({ file: "CLAUDE.md", at: "2026-08-06T00:00:00Z", before, after });
  assert.ok(first.ci, "an interval at 5 per side");
  assert.deepEqual(first.ci, second.ci, "same seed, same interval");
  assert.equal(first.ci.startupH0.level, 0.9);
  assert.equal(first.ci.startupH0.provenance, "derived.exact");
  assert.equal(first.ci.startupH0.claim, "observational");
  assert.ok(first.ci.startupH0.low <= first.delta.startupH0 && first.delta.startupH0 <= first.ci.startupH0.high, "the point delta lies in its interval");
  assert.ok(first.ci.startupH0.high < 0, "a −2k shift with tiny spread excludes zero");
  assert.ok(!first.caveats.some((c) => c.startsWith("n small")));
  const gated = buildChange({ file: "CLAUDE.md", at: "2026-08-06T00:00:00Z", before: before.slice(1), after });
  assert.equal(gated.ci, undefined, `no interval below ${MIN_INTERVAL_N} on a side`);
  assert.ok(gated.caveats.some((c) => c.startsWith("n small")));
  const direct = bootstrapDifference([1, 2, 3, 4, 5], [11, 12, 13, 14, 15], { seed: 7, resamples: 200 });
  assert.deepEqual(direct, bootstrapDifference([1, 2, 3, 4, 5], [11, 12, 13, 14, 15], { seed: 7, resamples: 200 }));
  assert.ok(direct.low >= 6 && direct.high <= 14);
});

test("session facts: metrics sum root + descendants, medians per side, handoff ratio weighted by n, fat results from habits", () => {
  const root = entry(1, { compactions: 1, activeMs: 1_800_000, processed: 100_000, fat: 2, ratio: 4 });
  const child = { ...entry(1, { id: "child", compactions: 1, activeMs: 1_800_000, processed: 50_000, fat: 1, ratio: 8 }), parentThreadId: "s1" };
  const facts = sessionFacts(root, [child]);
  assert.equal(facts.metrics.compactionsPerHour, 2);
  assert.equal(facts.metrics.processedInputTokens, 150_000);
  assert.equal(facts.metrics.fatResults, 3);
  assert.equal(facts.metrics.handoffRatio, 6, "weighted median of 4 (n=2) and 8 (n=2)");
  assert.equal(facts.metrics.startupH0, 10_000);
  assert.equal(facts.metrics.peakShare, 0.5);
  assert.deepEqual(METRICS.map((m) => m.key), ["startupH0", "peakShare", "compactionsPerHour", "processedInputTokens", "fatResults", "handoffRatio"]);
});

test("renderChangesLines: the scan block names the file, the anchor, N vs M, startup, a rule row, compactions and says observational", () => {
  const sessions = [1, 2, 3, 4, 5, 6, 7].map((day) => group(entry(day, { h0: day < 5 ? 12_100 : 10_900, rules: day < 5 ? ["B-02"] : [], compactions: day < 5 ? 1 : 0, activeMs: 3_600_000 })));
  const response = changesFor({ files: [{ path: "CLAUDE.md", vendors: ["claude"], mtime: "2026-08-05T00:00:00Z" }, { path: "AGENTS.md", vendors: ["codex"], mtime: "2026-09-01T00:00:00Z" }], sessions, now: Date.parse("2026-09-02T00:00:00Z") });
  const lines = renderChangesLines(response);
  assert.equal(lines[0], "Since the last instruction edits (observational: sessions are different tasks)");
  assert.equal(lines[1], "  Since CLAUDE.md (Aug 5, mtime): 3 sessions vs 4 before · startup 12.1k → 10.9k · B-02 in 0/3 (was 4/4) · compactions/h 1 → 0 · n small · observational");
  assert.equal(lines[2], "  AGENTS.md edited 2026-09-01: no session since");
  assert.deepEqual(renderChangesLines({ changes: [], notes: [] }), []);
});

test("route: GET /api/v1/changes answers { changes, notes, since, sessions, files } from the manifest only (fake index, readFindings never called)", async () => {
  const entries = [1, 2, 3, 4, 5, 6].map((day) => entry(day, { h0: day < 4 ? 12_000 : 10_000 }));
  let findingsReads = 0;
  const index = { state: { lastRunAt: "x" }, entries: async () => entries, manifest: async () => ({ vendors: [] }), readFindings: async () => { findingsReads += 1; throw new Error("no run file"); } };
  const setup = { buildSetupInventory: async () => ({ repo: { name: "repo", root: "cwd", git: false }, vendorsDetected: ["claude"], instructionFiles: [{ path: "CLAUDE.md", scope: "project", vendors: ["claude"], bytes: 10, estTokens: 3, precedence: 1, mtime: "2026-08-04T00:00:00Z", loadState: "expected.load", brokenRefs: [] }], skills: [], agents: [], hooks: [], mcpServers: [], commands: [], memory: { present: false, bytes: 0, files: 0, indexBytes: 0 }, settings: [], startupBudget: {} }) };
  const rules = { ...fakeRules(), loadRules: async () => [{ id: "B-02", title: "Shell output" }] };
  const routes = createRoutes({ index, home: "/nonexistent/home", repoRoot: REPO, rules, setup, warn: quiet });
  try {
    assert.ok(routes.match("GET", "/api/v1/changes"));
    const calls = [];
    const response = { writeHead: (status, headers) => calls.push({ status, headers }), end: (body) => calls.push({ body: String(body) }) };
    await routes.handle({ method: "GET", headers: {} }, response, new URL("http://127.0.0.1/api/v1/changes?since=all"));
    assert.equal(calls[0].status, 200);
    const payload = JSON.parse(calls[1].body);
    assert.equal(payload.since, "all");
    assert.equal(payload.sessions, 6);
    assert.equal(payload.files, 1);
    assert.equal(payload.changes.length, 1);
    assert.deepEqual(payload.changes[0].n, { before: 3, after: 3, afterObserved: 0 });
    assert.equal(payload.changes[0].anchor, "mtime");
    assert.equal(findingsReads, 0, "the route reads finding heads from the manifest, never findings.json");
    const bad = [];
    await routes.handle({ method: "GET", headers: {} }, { writeHead: (status) => bad.push(status), end: () => {} }, new URL("http://127.0.0.1/api/v1/changes?since=nope"));
    assert.equal(bad[0], 400);
    const narrowed = [];
    await routes.handle({ method: "GET", headers: {} }, { writeHead: () => {}, end: (body) => narrowed.push(JSON.parse(String(body))) }, new URL("http://127.0.0.1/api/v1/changes?file=AGENTS.md"));
    assert.equal(narrowed[0].changes.length, 0);
  } finally {
    routes.close();
  }
});

test("manifest-only proof: analysis.changes() over a real index opens no run file (fs spy + stubbed readers)", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const opened = [];
    for (const method of ["readRunShell", "readScope", "readRun", "readRunResponse", "readFindings"]) {
      index[method] = async (...args) => { opened.push([method, ...args]); throw new Error(`${method} must not be called while building changes`); };
    }
    const setup = { buildSetupInventory: async () => ({ repo: { name: "repo", root: "cwd", git: false }, vendorsDetected: ["claude", "codex"], instructionFiles: [{ path: "AGENTS.md", scope: "project", vendors: ["codex", "claude"], bytes: 10, estTokens: 3, precedence: 1, mtime: "2026-09-01T09:00:00Z", loadState: "expected.load", brokenRefs: [] }], skills: [], agents: [], hooks: [], mcpServers: [], commands: [], memory: { present: false, bytes: 0, files: 0, indexBytes: 0 }, settings: [], startupBudget: {} }) };
    const analysis = createAnalysis({ index, home: fixture.home, repoRoot: fixture.repo, rules: fakeRules(), setup, warn: quiet });
    const result = await analysis.changes({});
    assert.deepEqual(opened, []);
    assert.equal(index.stats.runFilesOpened, 0, "no run file opened for /changes");
    assert.equal(result.sessions, 3, "the repo's sessions: 2 claude + the codex parent");
    assert.equal(result.files, 1);
    assert.equal(result.changes.length + result.notes.length, 1, "one anchor: a change or a note, never silence");
    assert.ok(!JSON.stringify(result).includes(fixture.home), "no absolute path in the response");
    const again = await analysis.changes({ since: "30d" });
    assert.deepEqual(opened, []);
    assert.equal(again.since, "30d");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
