/**
 * Repo scoping (ADR-003 section 1): the default population is the launched
 * repo, `scope=all` is the machine, `nested` (alias `all`) shows Codex child
 * rollouts, and sessions that no project can claim are counted as
 * `unattributed`. Two repos on the same machine give different totals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { buildOverviewFromEntries, contextAtSessionEnd, recurrenceByRule } from "../src/index/overview.mjs";
import { HABITS_VERSION } from "../src/index/entry.mjs";
import { cwdKindOf, entryMatchesRepo, entryUnattributed, repoSessions, rootRunIdOf } from "../src/index/reader.mjs";
import { evaluateHabitsDetailed } from "../src/rules/habits.mjs";
import { projectKeyFor } from "../src/ir/project.mjs";
import { createIndex } from "../src/index/writer.mjs";
import { createAnalysis } from "../src/server/analysis.mjs";
import { renderScan, scanReport } from "../src/index/scan.mjs";
import { CLAUDE_SESSIONS, CODEX_CHILD, CODEX_PARENT, fakeAdapters, fakeRules, fakeSetup, FIXTURE_NOW, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};
const NOW = Date.parse("2026-09-02T12:00:00Z");

function entry(id, { vendor = "claude", cwd, projectKey, discoveryKey, parentThreadId, requests = 10, compactions = 0, endedAt = "2026-09-01T10:00:00Z", cwdReversible, findingIds = ["B-01:aaaaaaaaaa"], fat = [] } = {}) {
  const key = projectKey ?? (cwd ? projectKeyFor(cwd) : `enc-${id}`);
  return {
    vendor, runId: `${vendor}:${id}`, sessionId: id, file: `~/x/${id}.jsonl`,
    projectKey: key, discoveryKey: discoveryKey ?? key, projectDisplay: cwd ? path.basename(cwd) : "unknown",
    project: { key, displayName: cwd ? path.basename(cwd) : "unknown", cwdHash: "h" },
    cwd: cwd ?? null, cwdKind: cwdKindOf(cwd ?? null), cwdReversible: cwdReversible ?? Boolean(cwd),
    startedAt: endedAt, endedAt, activeMs: 1000, window: { value: 200_000, provenance: "estimated.local" },
    summary: { requests, turns: 1, processedInputTokens: requests * 1000, outputTokens: 10, cacheReadShare: 0.5, peak: { value: 50_000, provenance: "observed.vendor" }, peakShareOfWindow: 0.25, compactions, subagents: 0, toolCalls: 1, models: ["m"], topBlocks: [{ id: `${id}:1`, scopeId: "main", category: "tool_result.file", estTokens: 9000, firstRequest: 1, label: "src/index.mjs" }], findingIds },
    findingsCount: findingIds.length, findingsHigh: findingIds.length, findingHeads: findingIds.map((fid) => ({ id: fid, ruleId: fid.split(":")[0], severity: "high", scope: "session", title: "Fat tool result", fix: { platform: "both", summary: "read less" }, tokensAffected: 9000, count: 1, occurrences: 1 })),
    handoffs: [], stats: { sessionCount: 1, vendorsWithSessions: [vendor] },
    habits: { v: HABITS_VERSION, fat, fullReads: [], agents: [], compaction: { n: compactions, auto: compactions, requests }, startup: { h0: 12_000, cliVersion: "2.1.0", model: "m" }, mcp: { invoked: [] }, peakShare: 0.25, window: 200_000 },
    parentThreadId,
  };
}

test("one population rule: roots, transitive children, attribution and range on the root, unattributed; a parent elsewhere takes its children with it", () => {
  const repo = "/Users/me/projects/alpha";
  const entries = [
    entry("r1", { cwd: repo }),
    entry("r2", { cwd: repo, vendor: "codex" }),
    entry("c1", { cwd: repo, vendor: "codex", parentThreadId: "r2" }),
    entry("g1", { cwd: repo, vendor: "codex", parentThreadId: "c1" }),
    entry("elsewhere", { cwd: "/Users/me/projects/beta", vendor: "codex" }),
    entry("c-else", { cwd: repo, vendor: "codex", parentThreadId: "elsewhere" }),
    entry("orphan", { cwd: repo, vendor: "codex", parentThreadId: "never-indexed" }),
    entry("old", { cwd: repo, vendor: "codex", endedAt: "2026-06-01T00:00:00Z" }),
    entry("old-kid", { cwd: repo, vendor: "codex", parentThreadId: "old", endedAt: "2026-09-01T10:00:00Z" }),
    entry("t1", { cwd: "/private/var/folders/ab/cez-root-isolation-9" }),
  ];
  const pop = repoSessions({ entries, repoRoot: repo, projectKey: projectKeyFor(repo) });
  assert.deepEqual(pop.roots.map((e) => e.sessionId).sort(), ["old", "orphan", "r1", "r2"], "a child whose parent is not indexed is top-level; a child of a parent elsewhere is not a session here");
  assert.deepEqual(pop.children.get("codex:r2").map((e) => e.sessionId), ["c1", "g1"], "grandchildren fold into the root");
  assert.equal(pop.rootOf(entries[3]), "codex:r2");
  assert.equal(rootRunIdOf(entries[5], pop.byRunId), "codex:elsewhere");
  assert.equal(pop.isChild(entries[2]), true);
  assert.deepEqual(pop.unattributed.map((e) => e.sessionId), ["t1"]);
  assert.equal(pop.entries.length, 7, "4 roots + c1, g1 and old-kid");
  const recent = repoSessions({ entries, repoRoot: repo, projectKey: projectKeyFor(repo), since: NOW - 30 * 24 * 3600 * 1000 });
  assert.deepEqual(recent.roots.map((e) => e.sessionId).sort(), ["orphan", "r1", "r2"], "the range applies to the root: old-kid follows its old parent out of range");
  const machine = repoSessions({ entries });
  assert.equal(machine.roots.length, 6, "machine population: 4 repo roots + elsewhere + temp");
  assert.equal(machine.unattributed.length, 0, "unscoped populations do not classify");
});

test("overview, findings recurrence, habits and scan agree on one number: 3 roots + 2 children + 1 grandchild + 1 unattributed = 3 sessions", async () => {
  const repo = "/Users/me/projects/alpha";
  const fat = [{ tool: "exec", kind: "web", tokens: 12_000, n: 1 }];
  const entries = [
    entry("r1", { cwd: repo, findingIds: ["B-01:aaaaaaaaaa", "B-13:bbbbbbbbbb"], fat }),
    entry("r2", { cwd: repo, vendor: "codex", requests: 20, findingIds: ["B-01:cccccccccc"], fat }),
    entry("r3", { cwd: repo, vendor: "codex", findingIds: [], fat }),
    entry("c1", { cwd: repo, vendor: "codex", parentThreadId: "r2", requests: 5, compactions: 1, findingIds: ["B-13:dddddddddd"], fat }),
    entry("c2", { cwd: repo, vendor: "codex", parentThreadId: "r3", requests: 5, findingIds: ["B-13:eeeeeeeeee"], fat }),
    entry("g1", { cwd: repo, vendor: "codex", parentThreadId: "c1", requests: 5, findingIds: ["B-13:ffffffffff"], fat }),
    entry("u1", { cwd: "/private/var/folders/ab/cez-root-isolation-9", findingIds: ["B-13:0000000000"] }),
  ];
  const overview = buildOverviewFromEntries(entries, { repoRoot: repo, projectKey: projectKeyFor(repo), now: NOW });
  assert.equal(overview.scope.sessions, 3);
  assert.equal(overview.totals.runs, 3);
  assert.equal(overview.scope.machineSessions, 4);
  assert.equal(overview.scope.unattributed, 1);
  assert.equal(overview.totals.subagents, 3, "two children and one grandchild are subagents");
  assert.equal(overview.scope.subagents, 3);
  assert.equal(overview.totals.requests, 10 + 20 + 10 + 5 + 5 + 5);
  assert.equal(overview.totals.compactions, 1);
  assert.deepEqual(overview.totals.sessionsByVendor, { claude: 1, codex: 2 });
  assert.deepEqual(overview.runs.map((run) => run.id).sort(), ["claude:r1", "codex:r2", "codex:r3"], "children are not rows");
  const r2 = overview.runs.find((run) => run.id === "codex:r2");
  assert.deepEqual(r2.children.map((child) => [child.id, child.parentRunId, child.rootRunId]), [["codex:c1", "codex:r2", "codex:r2"], ["codex:g1", "codex:c1", "codex:r2"]], "the grandchild is listed under the root with its direct parent");
  assert.equal(r2.summary.subagents, 2);
  assert.equal(overview.trends.sessions.reduce((a, b) => a + b, 0), 3);
  assert.equal(overview.trends.subagents.reduce((a, b) => a + b, 0), 3);
  assert.deepEqual(overview.topOffenders.mostCompacted, [{ runId: "codex:r2", compactions: 1, processedInputTokens: 30_000 }], "a child's compaction attributes to the root");
  assert.ok(overview.topOffenders.largestBlocks.every((block) => ["claude:r1", "codex:r2", "codex:r3"].includes(block.runId)), "blocks attribute to the root");
  assert.ok(overview.topOffenders.largestBlocks.some((block) => block.runId === "codex:r2" && block.scopeId === "codex:g1" && block.sourceRunId === "codex:g1"));
  // Recurrence: B-01 in r1 + r2 = 2 sessions; B-13 in r1, r2 (via c1/g1), r3 (via c2) = 3 sessions, never 5 and never the unattributed one.
  const pop = repoSessions({ entries, repoRoot: repo, projectKey: projectKeyFor(repo) });
  const recurrence = recurrenceByRule(pop.roots, pop.children);
  assert.equal(recurrence.get("B-01"), 2);
  assert.equal(recurrence.get("B-13"), 3);
  assert.equal(overview.firstFinding.ruleId, "B-13", "B-13 high × 3 sessions beats B-01 high × 2");
  assert.equal(overview.firstFinding.recurrence, 3);
  assert.equal(overview.firstFinding.removes.sessions, 3);
  assert.equal(overview.firstFinding.vendor, "codex", "the fix follows the majority vendor of the recurrence (2 codex sessions, 1 claude), not the top-ranked head's");
  const claudeHeavy = buildOverviewFromEntries([...entries, entry("r4", { cwd: repo, findingIds: ["B-13:1111111111"] }), entry("r5", { cwd: repo, findingIds: ["B-13:2222222222"] })], { repoRoot: repo, projectKey: projectKeyFor(repo), now: NOW });
  assert.equal(claudeHeavy.firstFinding.vendor, "claude", "3 claude sessions vs 2 codex: a codex root with two child heads still counts once");
  // Habits: the web habit is in every root (children fold in): 3 sessions, 6 results.
  const habits = await evaluateHabitsDetailed(pop.entries, { thresholds: { habitMinSessions: 3, habitFatTotalTokens: 30_000 }, rootOf: pop.rootOf });
  assert.equal(habits.sessions, 3);
  assert.equal(habits.subagentRuns, 3);
  const [h01] = habits.findings.filter((f) => f.ruleId === "H-01");
  assert.equal(h01.sessions, 3);
  assert.equal(h01.count, 6);
  // Scan: the header, the Habits title and the first-change line print the same number.
  const analysis = {
    overview: async () => overview,
    findings: async () => ({ findings: [overview.firstFinding], groups: [{ ruleId: "B-13", title: "Session too long", severity: "high", scope: "session", sessions: 3, occurrences: 4, tokensAffected: 0, findings: [] }], firstChange: overview.firstFinding }),
    setup: async () => ({ findings: [] }),
    habits: async () => ({ findings: habits.findings, notes: habits.notes, sessions: habits.sessions }),
  };
  const text = renderScan(await scanReport(analysis, {}), { repoName: "alpha" });
  assert.match(text, /^ContextScope · repo alpha · 3 sessions \(4 on this machine\)/);
  assert.match(text, /Sessions 3 \(claude 1 · codex 2\) · subagents 3 · requests 55 · 1 unattributed on this machine/);
  assert.match(text, /B-13 .* · 3 sessions · /);
  assert.match(text, /Habits \(3 sessions\)/);
  assert.match(text, /H-01 +Recurring fat result: exec \(web\) +high +3 sessions/);
  assert.doesNotMatch(text, /LEVERAGE \d/i, "no leverage score in user-facing output (ADR-001 §6.3)");
});

test("population rule: realpath cwd, then projectKey, then discoveryKey only without a cwd; temp dirs never attribute", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-scope-"));
  try {
    const repo = path.join(base, "repo");
    await mkdir(path.join(repo, ".claude", "worktrees", "wt1"), { recursive: true });
    const link = path.join(base, "repo-link");
    await symlink(repo, link);
    const key = projectKeyFor(repo);
    assert.equal(entryMatchesRepo(entry("a", { cwd: repo }), { repoRoot: repo, projectKey: key }), true);
    assert.equal(entryMatchesRepo(entry("b", { cwd: path.join(repo, ".claude", "worktrees", "wt1") }), { repoRoot: repo, projectKey: key }), true, "worktree under the repo counts");
    assert.equal(entryMatchesRepo(entry("c", { cwd: link }), { repoRoot: repo, projectKey: key }), true, "symlinked cwd resolves to the repo");
    assert.equal(entryMatchesRepo(entry("d", { cwd: repo }), { repoRoot: link, projectKey: projectKeyFor(link) }), true, "symlinked launch root resolves to the cwd");
    assert.equal(entryMatchesRepo(entry("e", { cwd: `${repo}-other` }), { repoRoot: repo, projectKey: key }), false, "a sibling with the same prefix is not under the root");
    assert.equal(entryMatchesRepo(entry("f", { cwd: null, projectKey: key }), { repoRoot: repo, projectKey: key }), true, "projectKey matches");
    assert.equal(entryMatchesRepo(entry("g", { cwd: null, projectKey: "other", discoveryKey: key }), { repoRoot: repo, projectKey: key }), true, "discoveryKey matches only without a cwd");
    assert.equal(entryMatchesRepo(entry("h", { cwd: `${base}/elsewhere`, projectKey: "other", discoveryKey: key }), { repoRoot: repo, projectKey: key }), false, "discoveryKey is ignored when a cwd exists");
    const temp = entry("t", { cwd: "/private/var/folders/zz/cez-root-isolation-1", projectKey: key });
    assert.equal(cwdKindOf(temp.cwd), "temp");
    assert.equal(entryMatchesRepo(temp, { repoRoot: repo, projectKey: key }), false, "a temp isolation dir never attributes through a key");
    assert.equal(entryUnattributed(temp), true);
    assert.equal(entryUnattributed(entry("u", { cwd: null, cwdReversible: false })), true);
    assert.equal(entryUnattributed(entry("v", { cwd: null, cwdReversible: true })), false);
    assert.equal(entryUnattributed(entry("w", { cwd: repo }), { repoRoot: repo }), false, "a temp-dir launch root still claims its own sessions");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("two repos on one machine give different totals; scope=all is the machine; nested alias; unattributed counted", () => {
  const repoA = "/Users/me/projects/alpha";
  const repoB = "/Users/me/projects/beta";
  const entries = [
    entry("a1", { cwd: repoA }), entry("a2", { cwd: `${repoA}/packages/x`, requests: 20 }), entry("a3", { cwd: repoA, vendor: "codex" }),
    entry("b1", { cwd: repoB }), entry("b2", { cwd: repoB, vendor: "codex" }),
    entry("b3", { cwd: repoB, vendor: "codex", parentThreadId: "b2" }),
    entry("t1", { cwd: "/private/var/folders/ab/cez-root-isolation-9" }),
    entry("u1", { cwd: null, cwdReversible: false }),
    entry("old", { cwd: repoA, endedAt: "2026-06-01T00:00:00Z" }),
    // ADR-005 §2: harness runs (SDK entrypoint; a temp cwd with no tool use and one request) are counted, never populated.
    { ...entry("h1", { cwd: "/private/var/folders/ab/cez-root-isolation-1", requests: 1 }), kind: "harness", entrypoint: "sdk-cli" },
    { ...entry("h2", { cwd: repoA, requests: 1 }), kind: "harness", entrypoint: "sdk-cli" },
  ];
  // Repo scope defaults to all time (repo sessions are few); `since: "30d"` is the explicit window; scope=all defaults to 30 d.
  const alphaAll = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), now: NOW });
  const alpha = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), since: "30d", now: NOW });
  const beta = buildOverviewFromEntries(entries, { repoRoot: repoB, projectKey: projectKeyFor(repoB), since: "30d", now: NOW });
  const all = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), scope: "all", now: NOW });

  assert.equal(alphaAll.range, "all");
  assert.equal(alphaAll.since, null, "all time has no lower bound");
  assert.equal(alphaAll.scope.sessions, 4, "the old session counts all time");
  assert.equal(alphaAll.totals.runs, 4);
  assert.equal(alphaAll.totals.requests, 50);
  assert.equal(alphaAll.scope.machineSessions, 8, "the machine line uses the same range");
  assert.ok(alphaAll.runs.some((run) => run.id === "claude:old"));
  assert.ok(alphaAll.trends.days.length >= 90 && alphaAll.trends.days.length <= 365, "all-time trends span the oldest session (>= 30 days, <= 365)");
  assert.equal(alphaAll.trends.sessions.reduce((a, b) => a + b, 0), 4);
  assert.equal(buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), since: "all", now: NOW }).totals.runs, 4, "`since=all` is explicit all time");
  assert.equal(alpha.range, "30d");
  assert.equal(alpha.since, new Date(NOW - 30 * 24 * 3600 * 1000).toISOString());
  assert.equal(all.range, "30d", "scope=all keeps the 30-day default");

  assert.equal(alpha.scope.mode, "repo");
  assert.equal(alpha.scope.repo.name, "alpha");
  assert.equal(alpha.scope.sessions, 3);
  assert.equal(alpha.totals.runs, 3);
  assert.deepEqual(alpha.runs.map((run) => run.id).sort(), ["claude:a1", "claude:a2", "codex:a3"]);
  assert.equal(alpha.totals.requests, 40);
  assert.equal(beta.scope.sessions, 2, "the nested codex child is not a top-level session");
  assert.equal(beta.totals.runs, 2);
  assert.notEqual(alpha.totals.runs, beta.totals.runs);
  assert.notEqual(alpha.totals.requests, beta.totals.requests);
  assert.equal(alpha.scope.machineSessions, 7, "3 alpha + 2 beta + temp + unattributed, child nested, old one out of range");
  assert.equal(alpha.scope.unattributed, 2, "temp isolation dir + unreversible encoded dir; harness runs are not unattributed");
  assert.equal(alpha.scope.harness, 2, "harness runs are counted on the header");
  assert.equal(alpha.scope.attributed, 0);
  assert.equal(beta.scope.machineSessions, 7);
  assert.equal(beta.scope.unattributed, 2);
  assert.ok(!all.runs.some((run) => run.id === "claude:h1" || run.id === "claude:h2"), "harness runs are not rows of the machine view");
  assert.ok(alpha.scope.sessions + beta.scope.sessions <= alpha.scope.machineSessions);

  assert.equal(all.scope.mode, "all");
  assert.equal(all.totals.runs, 7);
  assert.equal(all.runs.length, 7);
  assert.equal(all.scope.sessions, 3, "the repo line stays repo-scoped in all mode");
  assert.ok(!all.runs.some((run) => run.id === "codex:b3"), "children stay nested without nested=1");
  const nested = buildOverviewFromEntries(entries, { repoRoot: repoB, projectKey: projectKeyFor(repoB), nested: true, since: "30d", now: NOW });
  const alias = buildOverviewFromEntries(entries, { repoRoot: repoB, projectKey: projectKeyFor(repoB), all: true, since: "30d", now: NOW });
  assert.equal(nested.runs.length, 3);
  assert.equal(alias.runs.length, 3, "`all: true` is the deprecated alias of `nested: true`");
  assert.equal(nested.totals.runs, 2, "totals count the child as a subagent, not a session");
  assert.equal(nested.totals.subagents, 1);
  assert.ok(JSON.stringify(all).length > JSON.stringify(alpha).length, "the repo payload is smaller than the machine payload");

  // Trends: sessions per day, medians, edit markers in range only.
  assert.equal(alpha.trends.sessions.reduce((a, b) => a + b, 0), 3);
  assert.equal(all.trends.sessions.reduce((a, b) => a + b, 0), 7);
  const day = alpha.trends.days.indexOf("2026-09-01");
  assert.equal(alpha.trends.peakShareMedian[day], 0.25);
  assert.equal(alpha.trends.startupH0Median[day], 12_000);
  const edits = [{ path: "CLAUDE.md", mtime: "2026-08-30T08:00:00Z" }, { path: "old.md", mtime: "2026-01-01T00:00:00Z" }, { path: "bad.md", mtime: "nope" }];
  const withEdits = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), since: "30d", now: NOW, instructionFiles: edits });
  assert.deepEqual(withEdits.trends.instructionEdits, [{ path: "CLAUDE.md", at: "2026-08-30T08:00:00.000Z" }]);
  const allEdits = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), now: NOW, instructionFiles: edits });
  assert.deepEqual(allEdits.trends.instructionEdits.map((edit) => edit.path), ["old.md", "CLAUDE.md"], "all time keeps every dated edit");

  // First change is repo-scoped in both modes and includes habit findings by their session count:
  // B-01 high × 4 repo sessions (the old one counts, all time) = 12; H-01 high × 4 = 12; the fix path breaks the tie.
  const habit = { id: "H-01:0123456789", ruleId: "H-01", severity: "high", scope: "habit", sessions: 4, title: "Recurring fat result: Read x", whyItMatters: "w", evidence: [{ kind: "run", ref: "claude:a1", label: "l", provenance: "estimated.local" }], fix: { platform: "claude", summary: "s", path: "CLAUDE.md" }, thresholdKeys: [], tokensAffected: 40_000 };
  const withHabit = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), scope: "all", habitFindings: [habit], now: NOW });
  assert.equal(withHabit.firstFinding.ruleId, "H-01");
  assert.equal(withHabit.firstFinding.leverage, 12);
  const fewer = buildOverviewFromEntries(entries, { repoRoot: repoA, projectKey: projectKeyFor(repoA), habitFindings: [{ ...habit, sessions: 3 }], now: NOW });
  assert.equal(fewer.firstFinding.ruleId, "B-01", "high × 3 = 9 loses to B-01's 12");
});

test("first change: habit leverage = severity × min(sessions, 10), compared with session recurrence", () => {
  const repo = "/Users/me/projects/gamma";
  const entries = [entry("g1", { cwd: repo }), entry("g2", { cwd: repo })];
  const habit = { id: "H-02:0123456789", ruleId: "H-02", severity: "medium", scope: "habit", sessions: 9, title: "File read whole repeatedly: a.md", whyItMatters: "w", evidence: [{ kind: "run", ref: "claude:g1", label: "l", provenance: "estimated.local" }], fix: { platform: "claude", summary: "s", path: "CLAUDE.md" }, thresholdKeys: [], tokensAffected: 1 };
  const overview = buildOverviewFromEntries(entries, { repoRoot: repo, projectKey: projectKeyFor(repo), habitFindings: [habit], now: NOW });
  // B-01: high (3) × 2 sessions = 6; H-02: medium (2) × 9 = 18.
  assert.equal(overview.firstFinding.ruleId, "H-02");
  assert.equal(overview.firstFinding.leverage, 18);
  assert.equal(overview.firstFinding.recurrence, 9);
});

test("index + analysis: scan totals differ between two --repo values; --all matches the machine; header lines", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const forRepo = createAnalysis({ index, home: fixture.home, repoRoot: fixture.repo, rules: fakeRules(), setup: fakeSetup(), warn: quiet, now: () => FIXTURE_NOW });
    const forOther = createAnalysis({ index, home: fixture.home, repoRoot: fixture.other, rules: fakeRules(), setup: fakeSetup(), warn: quiet, now: () => FIXTURE_NOW });
    const repoReport = await scanReport(forRepo, {});
    const otherReport = await scanReport(forOther, {});
    const allReport = await scanReport(forRepo, { all: true });
    assert.equal(repoReport.overview.totals.runs, 3, "2 claude + codex parent (child nested)");
    assert.equal(otherReport.overview.totals.runs, 1);
    assert.equal(allReport.overview.totals.runs, 4);
    assert.equal(allReport.overview.scope.sessions, 3);
    assert.equal(allReport.overview.scope.machineSessions, 4);
    assert.equal(repoReport.overview.scope.machineSessions, 4);
    assert.equal(index.stats.runFilesOpened, 0, "scan reports come from the manifest");
    const text = renderScan(repoReport, { repoName: "repo" });
    assert.match(text, /^ContextScope · repo repo · 3 sessions \(4 on this machine\)/);
    assert.match(renderScan(allReport, { repoName: "repo" }), /^ContextScope · all projects · 4 sessions · repo repo: 3/);
    assert.match(text, /Habits \(3 sessions\)/, "habit population is the repo's sessions all time (the nested codex child is a subagent)");
    assert.match(text, /Sessions 3 \(claude 2 · codex 1\)/);
    assert.match(text, /H-01 +Recurring fat result: Read src\/index\.mjs/);
    const machine = await forRepo.overview({ scope: "all" });
    assert.equal(machine.runs.length, 4);
    assert.ok(!machine.runs.some((run) => run.id === `codex:${CODEX_CHILD}`));
    const nested = await forRepo.overview({ nested: true });
    assert.equal(nested.runs.length, 4, "repo scope + nested child row");
    assert.ok(nested.runs.some((run) => run.id === `codex:${CODEX_CHILD}`));
    const alias = await forRepo.overview({ all: true });
    assert.equal(alias.runs.length, 4);
    assert.ok(!(await forRepo.overview({})).runs.some((run) => run.id === `claude:${CLAUDE_SESSIONS[2]}`), "the other repo's session is not a row");
    assert.ok(alias.runs.some((run) => run.id === `codex:${CODEX_PARENT}`));
    // Live rows come from the watcher's accessor on the index (index/watch.mjs attaches `index.liveRuns()`).
    index.liveRuns = () => new Map([[`claude:${CLAUDE_SESSIONS[0]}`, { at: "2026-09-02T11:59:00.000Z", vendor: "claude" }]]);
    const live = await forRepo.overview({});
    assert.deepEqual(live.runs.find((run) => run.id === `claude:${CLAUDE_SESSIONS[0]}`).live, { at: "2026-09-02T11:59:00.000Z" });
    assert.ok(live.runs.filter((run) => run.live).length === 1, "only the live run carries the marker");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("contextAtSessionEnd averages per-session shares of the last request, each session weighing the same", () => {
  const result = contextAtSessionEnd([
    { summary: { compositionAtEnd: { system: 100, "tool_result.file": 300 } } },
    { summary: { compositionAtEnd: { system: 500, user: 500, other: 0 } } },
    { summary: { compositionAtPeak: { system: 10 } } }, // indexed before the field existed: skipped, not counted as zero
  ]);
  assert.equal(result.sessions, 2);
  assert.equal(result.meanTotal, 700);
  assert.deepEqual(result.rows.map((row) => [row.category, row.share, row.tokens, row.sessions]), [
    ["system", 0.375, 300, 2],
    ["tool_result.file", 0.375, 150, 1],
    ["user", 0.25, 250, 1],
  ]);
  const shareSum = result.rows.reduce((sum, row) => sum + row.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-6);
  assert.deepEqual(contextAtSessionEnd([]), { sessions: 0, meanTotal: 0, rows: [] });
});
