import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { appendFile, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createIndex } from "../src/index/index.mjs";
import { indexRoot } from "../src/index/manifest.mjs";
import { rankFirstChange, statsOf, summarizeScope } from "../src/index/entry.mjs";
import { attachRecurrence, groupFindings, recurrenceByRule } from "../src/index/overview.mjs";
import { createByteCache } from "../src/index/reader.mjs";
import { formatTokens, parseSince } from "../src/util/format.mjs";
import { CLAUDE_SESSIONS, CODEX_CHILD, CODEX_PARENT, fakeAdapters, fakeRules, fakeRun, forbiddenKeys, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

test("index parses everything once, then nothing, re-parses touched files, and forgets deleted ones", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    const events = [];
    const first = await index.ensure({ onProgress: (event) => events.push(event) });
    assert.equal(first.parsed, 5);
    assert.equal(first.failed, 0);
    assert.equal(first.skipped, 0);
    assert.equal(first.files, 5);
    assert.equal(events.filter((event) => event.type === "progress").length, 5);
    assert.ok(events.every((event) => event.type !== "progress" || (event.file.startsWith("~") && !event.file.includes(fixture.home))));
    assert.ok(events.filter((event) => event.type === "progress").every((event) => typeof event.runId === "string"));
    assert.deepEqual(events.at(-1).type, "done");

    const root = indexRoot(fixture.home);
    const rootMode = (await stat(root)).mode & 0o777;
    assert.equal(rootMode, 0o700);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.adapterVersions, { claude: "claude-test", codex: "codex-test" });
    assert.equal(typeof manifest.estimatorVersion, "string");
    assert.equal(typeof manifest.calibrationVersion, "string");
    assert.equal(manifest.lastPass.parsed, 5);
    assert.equal(Object.keys(manifest.files).length, 5);
    assert.ok(manifest.vendors.some((row) => row.vendor === "gemini" && row.parsed === false));
    const entry = manifest.files[fixture.files[CLAUDE_SESSIONS[0]]];
    assert.equal(entry.runId, `claude:${CLAUDE_SESSIONS[0]}`);
    assert.equal(entry.findingsCount, 1);
    assert.equal(entry.findingsHigh, 1);
    assert.equal(entry.estimatorVersion, manifest.estimatorVersion);
    assert.equal(entry.topFinding, undefined, "findings are stored once; the entry keeps one head per rule");
    assert.equal(entry.findingHeads.length, 1);
    assert.equal(entry.findingHeads[0].ruleId, "B-01");
    assert.equal(entry.findingHeads[0].evidence, undefined, "heads carry no evidence or prose");
    assert.equal(entry.findingHeads[0].runId, undefined, "runId is re-attached when served");
    assert.ok(entry.summary.topBlocks.length <= 5);
    assert.equal(entry.handoffs.length, 1);
    assert.equal(entry.handoffs[0].ratio, 40);
    assert.equal(entry.stats.skillInvocations.deploy, undefined, "a Skill tool_call is not a skill invocation");
    assert.equal(entry.stats.agentRuns.Explore, 1);
    assert.equal(entry.stats.mcpInvocations.github, 1);
    assert.equal(entry.stats.hookRuns.PreToolUse.runs, 1);
    assert.equal(entry.stats.hookRuns.PreToolUse.unit, "tokens");
    assert.equal(manifest.files[fixture.files[CODEX_CHILD]].parentThreadId, CODEX_PARENT);
    assert.deepEqual(manifest.files[fixture.files[CODEX_PARENT]].handoffsByThread, { [CODEX_CHILD]: { blockId: "main:5", tokens: 3_000, firstRequest: 2 } });

    const started = Date.now();
    const second = await index.ensure();
    assert.equal(second.parsed, 0);
    assert.equal(second.reevaluated, 0);
    assert.equal(second.skipped, 5);
    assert.ok(Date.now() - started < 1000, "unchanged index finishes in under a second");

    const touched = fixture.files[CLAUDE_SESSIONS[1]];
    const future = new Date(Date.now() + 5_000);
    await utimes(touched, future, future);
    const third = await index.ensure();
    assert.equal(third.parsed, 1);
    assert.equal(third.skipped, 4);

    await rm(fixture.files[CODEX_CHILD]);
    const fourth = await index.ensure();
    assert.equal(fourth.parsed, 0);
    assert.equal(fourth.removed, 1);
    const after = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    assert.equal(after.files[fixture.files[CODEX_CHILD]], undefined);
    assert.equal(Object.keys(after.files).length, 4);
    const codexRuns = await readdir(path.join(root, "runs", "codex"), { withFileTypes: true });
    assert.equal(codexRuns.filter((item) => item.isDirectory()).length, 1);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("estimator or calibration version changes re-parse; a stale manifest layout is rebuilt", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const root = indexRoot(fixture.home);
    const manifestFile = path.join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.files[fixture.files[CLAUDE_SESSIONS[0]]].estimatorVersion = "chars-v0";
    manifest.files[fixture.files[CLAUDE_SESSIONS[1]]].calibrationVersion = "old";
    await writeFile(manifestFile, JSON.stringify(manifest));
    const reopened = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    const events = [];
    const result = await reopened.ensure({ onProgress: (event) => events.push(event) });
    assert.equal(result.parsed, 2, "two entries carried an old estimator/calibration version");
    assert.equal(result.estimatorChanged, 2);
    assert.equal(events.find((event) => event.type === "start").estimatorChanged, 2);

    const stale = JSON.parse(await readFile(manifestFile, "utf8"));
    stale.version = 1;
    await writeFile(manifestFile, JSON.stringify(stale));
    const rebuilt = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    const full = await rebuilt.ensure();
    assert.equal(full.parsed, 5, "an older manifest version means a full re-index");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("run storage: shell + per-scope files, no content keys, no visibleBlockIds, responses split main and children", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const root = indexRoot(fixture.home);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    assert.deepEqual([...forbiddenKeys(manifest)], []);
    const files = await walk(path.join(root, "runs"));
    assert.ok(files.some((file) => file.endsWith("shell.json")));
    assert.ok(files.some((file) => file.includes(`${path.sep}scopes${path.sep}`)));
    assert.ok(files.some((file) => file.endsWith("findings.json")));
    for (const file of files) {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual([...forbiddenKeys(parsed)], [], file);
      const text = JSON.stringify(parsed);
      assert.ok(!text.includes(fixture.home), `${file} leaks the absolute home path`);
      assert.ok(!text.includes("visibleBlockIds"), `${file} stores visibleBlockIds`);
    }
    const shellFile = files.find((file) => file.endsWith("shell.json"));
    const shell = JSON.parse(await readFile(shellFile, "utf8"));
    assert.equal(shell.findings, undefined, "findings live in findings.json only");
    assert.ok(shell.scopes.every((scope) => scope.partial === true && scope.requests === undefined && scope.blocks === undefined));
    assert.equal(typeof shell.scopes[0].requestCount, "number");
    assert.ok(Array.isArray(shell.scopes[0].topBlocks) && shell.scopes[0].topBlocks.length <= 5);

    const runId = `claude:${CLAUDE_SESSIONS[0]}`;
    const run = await index.readRun(runId);
    assert.equal(run.scopes.length, 2);
    assert.ok(run.scopes.every((scope) => Array.isArray(scope.requests) && Array.isArray(scope.blocks)));
    assert.equal(run.findings.length, 1);
    assert.deepEqual(run.summary.findingIds, run.findings.map((finding) => finding.id));
    assert.ok(run.scopes[0].requests.every((request) => Array.isArray(request.newBlockIds) && request.visibleBlockIds === undefined));

    const response = await index.readRunResponse(runId);
    assert.equal(response.scopes.length, 2);
    assert.equal(response.scopes[0].partial, undefined);
    assert.ok(Array.isArray(response.scopes[0].blocks));
    assert.equal(response.scopes[1].partial, true);
    assert.equal(response.scopes[1].blocks, undefined);
    assert.equal(response.scopes[1].requestCount, 2);
    assert.equal(response.scopes[1].peak.value, 120_000);
    assert.equal(response.scopes[1].handoff.tokens.value, 3_000);
    assert.equal(response.findings.length, 1);

    const child = await index.readScope(runId, "a1");
    assert.equal(child.id, "a1");
    assert.equal(child.requests.length, 2);
    assert.equal(await index.readScope(runId, "nope"), null);
    assert.equal(await index.readRun("claude:nope"), null);
    assert.equal(await index.readRunResponse("claude:nope"), null);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("overview and session stats come from the manifest only; since/limit/index status; codex handoffs joined", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const now = Date.parse("2026-09-02T00:00:00Z");
    const overview = await index.buildOverview({ repoRoot: fixture.repo, scope: "all", now });
    assert.equal(index.stats.runFilesOpened, 0, "no run file opened for the overview");
    assert.equal(overview.runs.length, 4, "codex child hidden under its parent");
    const parent = overview.runs.find((run) => run.id === `codex:${CODEX_PARENT}`);
    assert.deepEqual(parent.children.map((child) => child.id), [`codex:${CODEX_CHILD}`]);
    assert.equal(parent.children[0].parentRunId, parent.id);
    assert.deepEqual(parent.children[0].handoff, { tokens: 3_000, childPeak: 30_000, ratio: 10 });
    assert.ok(!overview.runs.some((run) => run.id === `codex:${CODEX_CHILD}`));
    for (const run of overview.runs) {
      assert.equal(run.cwd, undefined);
      assert.equal(run.summary.topBlocks, undefined, "rows carry no topBlocks");
      assert.equal(run.summary.findingIds, undefined, "rows carry no findingIds");
      assert.ok(!JSON.stringify(run).includes(fixture.home));
    }
    const all = await index.buildOverview({ repoRoot: fixture.repo, scope: "all", nested: true, now });
    assert.equal(all.runs.length, 5);
    assert.equal(overview.totals.runs, 4);
    assert.equal(overview.totals.subagents, 5 + 1, "one scope subagent per run plus the codex child");
    assert.equal(overview.totals.requests, 25);
    assert.deepEqual(overview.totals.vendors, ["claude", "codex"]);
    assert.equal(overview.trends.days.length, 30);
    assert.equal(overview.trends.requests.reduce((a, b) => a + b, 0), 25);
    assert.equal(overview.topOffenders.largestBlocks[0].estTokens, 9_000);
    assert.equal(overview.topOffenders.fattestHandoffs.length, 6, "five scope handoffs plus the joined codex child");
    assert.ok(overview.topOffenders.fattestHandoffs.some((handoff) => handoff.runId === parent.id && handoff.scopeId === `codex:${CODEX_CHILD}` && handoff.childPeak === 30_000));
    assert.equal(overview.topOffenders.mostCompacted.length, 1);
    assert.equal(overview.topOffenders.mostCompacted[0].runId, `claude:${CLAUDE_SESSIONS[1]}`);
    assert.equal(overview.firstFinding.ruleId, "B-01");
    assert.equal(overview.firstFinding.recurrence, 3, "B-01 fired in all three repo sessions (the codex child folds into its parent, ADR-004 §2)");
    assert.equal(overview.firstFinding.removes.sessions, 3);
    assert.equal(overview.index.state, "idle");
    assert.equal(overview.index.files, 5);
    assert.equal(overview.index.indexed, 5);
    assert.equal(overview.index.failed, 0);
    assert.equal(overview.index.runsInRange, 4);
    assert.equal(overview.index.lastPass.parsed, 5);
    assert.equal(typeof overview.index.lastPass.ms, "number");
    assert.equal(overview.index.total, 5, "deprecated alias: tasks of the last pass");
    assert.equal(overview.index.done, 5);
    assert.ok(overview.vendors.some((row) => row.vendor === "gemini" && row.parsed === false));
    assert.equal(overview.vendors.find((row) => row.vendor === "claude").sessions, 3);

    const limited = await index.buildOverview({ repoRoot: fixture.repo, scope: "all", now, limit: 2 });
    assert.equal(limited.runs.length, 2);
    assert.equal(limited.index.runsInRange, 4, "runsInRange tells the UI there is more");
    assert.equal(limited.totals.runs, 4, "totals cover the whole range");
    const narrow = await index.buildOverview({ repoRoot: fixture.repo, scope: "all", now, since: "12h" });
    assert.equal(narrow.runs.length, 0, "fixture runs ended before the 12 h window");
    assert.equal(narrow.trends.days.length, 1);
    const wide = await index.buildOverview({ repoRoot: fixture.repo, scope: "all", now, since: "2d" });
    assert.equal(wide.runs.length, 4);

    const stats = await index.sessionStatsForRepo({ repoRoot: fixture.repo });
    assert.equal(stats.sessionCount, 3, "two claude sessions + the codex parent; its child rollout is a subagent (ADR-004 §2)");
    assert.equal(stats.agentRuns.Explore, 4);
    assert.deepEqual(stats.mcpToolsObserved.github, ["mcp__github__list_prs"]);
    assert.equal(stats.hookRuns.PreToolUse.stdoutSizes.length, 4);
    assert.equal(stats.hookRuns.PreToolUse.unit, "tokens");
    assert.deepEqual(stats.vendorsWithSessions, ["claude", "codex"]);
    assert.equal(index.stats.runFilesOpened, 0);

    const otherStats = await index.sessionStatsForRepo({ repoRoot: fixture.other });
    assert.equal(otherStats.sessionCount, 1);
    const listed = await index.listRuns({ vendor: "claude" });
    assert.equal(listed.length, 3);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("parse failures are recorded without paths and retried only when the file changes; thresholds re-evaluate without re-parsing", async () => {
  const fixture = await makeFixtureHome();
  try {
    const failing = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters({ failOn: CLAUDE_SESSIONS[2] }), rules: fakeRules(), warn: quiet });
    const result = await failing.ensure();
    assert.equal(result.failed, 1);
    assert.equal(result.parsed, 4);
    const root = indexRoot(fixture.home);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const broken = manifest.files[fixture.files[CLAUDE_SESSIONS[2]]];
    assert.ok(broken.error.includes("synthetic parse failure"));
    assert.ok(!broken.error.includes(fixture.home), "error message carries no path");
    assert.equal(broken.summary, undefined);
    const overview = await failing.buildOverview({ repoRoot: fixture.repo });
    assert.equal(overview.runs.length, 3);
    assert.equal(overview.index.failed, 1);
    assert.equal(overview.index.indexed, 4);
    const retry = await failing.ensure();
    assert.equal(retry.failed, 0, "a poison file is not re-parsed while unchanged");
    assert.equal(retry.skipped, 5);
    const forced = await failing.ensure({ force: true });
    assert.equal(forced.failed, 1, "--refresh retries it");

    let parses = 0;
    const adapters = fakeAdapters();
    const counting = { claude: { ...adapters.claude, parse: async (...a) => { parses += 1; return adapters.claude.parse(...a); } }, codex: adapters.codex };
    const strict = createIndex({ home: fixture.home, env: {}, adapters: counting, rules: fakeRules({ thresholds: { fatToolResultTokens: 100 } }), warn: quiet });
    const future = new Date(Date.now() + 5_000);
    await utimes(fixture.files[CLAUDE_SESSIONS[2]], future, future);
    const re = await strict.ensure();
    assert.equal(re.parsed, 1, "only the touched (previously failed) file is parsed");
    assert.equal(re.reevaluated, 4);
    assert.equal(parses, 1);
    const run = await strict.readRun(`claude:${CLAUDE_SESSIONS[0]}`);
    assert.equal(run.findings.length, 1);
    const entry = (await strict.manifest()).files[fixture.files[CLAUDE_SESSIONS[0]]];
    assert.equal(entry.findingsCount, 1);

    await strict.clear();
    assert.equal(await stat(root).catch(() => null), null);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("ensure({ only }) restricts a pass to the listed files with the same stat-based detection and events", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    assert.equal((await index.ensure()).parsed, 5);

    const first = fixture.files[CLAUDE_SESSIONS[0]];
    const second = fixture.files[CLAUDE_SESSIONS[1]];
    const future = new Date(Date.now() + 5_000);
    await utimes(first, future, future);
    await utimes(second, future, future);

    const events = [];
    const partial = await index.ensure({ only: [first], onProgress: (event) => events.push(event) });
    assert.equal(partial.parsed, 1, "only the listed file is re-parsed");
    assert.equal(partial.skipped, 0, "files outside `only` are neither tasked nor counted");
    assert.equal(partial.removed, 0);
    assert.equal(partial.files, 5, "the manifest keeps every other entry");
    assert.deepEqual(events.map((event) => event.type), ["start", "progress", "done"]);
    assert.equal(events[0].total, 1);
    assert.equal(events[1].runId, `claude:${CLAUDE_SESSIONS[0]}`);
    assert.equal(events[1].total, 1);

    const unchanged = await index.ensure({ only: [first] });
    assert.equal(unchanged.parsed, 0, "an unchanged listed file is skipped by stat");
    assert.equal(unchanged.skipped, 1);

    const rest = await index.ensure();
    assert.equal(rest.parsed, 1, "the other touched file waits for a full pass");
    assert.equal(rest.skipped, 4);

    await rm(fixture.files[CODEX_CHILD]);
    const untouched = await index.ensure({ only: [first] });
    assert.equal(untouched.removed, 0, "a deleted file outside `only` is left to the full pass");
    const dropped = await index.ensure({ only: [fixture.files[CODEX_CHILD]] });
    assert.equal(dropped.removed, 1, "a deleted listed file is dropped");
    assert.equal(dropped.files, 4);
    // Live passes coalesce manifest writes (<= 1 per 5 s): the disk copy still shows the last full pass until close() flushes.
    const before = JSON.parse(await readFile(path.join(indexRoot(fixture.home), "manifest.json"), "utf8"));
    assert.equal(Object.keys(before.files).length, 5, "not yet flushed");
    assert.equal(before.lastLivePass.removed, 0, "the disk copy carries the live pass persisted by the last full pass");
    await index.close();
    const manifest = JSON.parse(await readFile(path.join(indexRoot(fixture.home), "manifest.json"), "utf8"));
    assert.equal(Object.keys(manifest.files).length, 4);
    assert.equal(manifest.lastPass.total, 1, "lastPass describes the last full pass");
    assert.equal(manifest.lastLivePass.total, 0, "the live pass is recorded separately");
    assert.equal(manifest.lastLivePass.removed, 1);
    assert.equal(index.state.lastLivePass.removed, 1);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a live pass does not run discovery: unchanged files keep their metadata without a head read, listed files are stat'ed only", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const first = fixture.files[CLAUDE_SESSIONS[0]];
    const entry = (await index.manifest()).files[first];
    assert.equal(entry.cwd, fixture.repo);
    // Replace the transcript with one that carries no cwd, keeping (size, mtime): a head read would now find nothing.
    const original = await readFile(first, "utf8");
    const originalStat = await stat(first);
    const noCwd = original.replaceAll(`"cwd":"${fixture.repo}"`, `"nop":"${fixture.repo}"`);
    assert.equal(noCwd.length, original.length);
    await writeFile(first, noCwd);
    await utimes(first, originalStat.atime, originalStat.mtime);
    const full = await index.ensure();
    assert.equal(full.parsed, 0, "stat unchanged: nothing re-parsed");
    assert.equal((await index.manifest()).files[first].cwd, fixture.repo, "the full pass reused the entry's cwd instead of reading the head");

    // A live pass on a changed file also reuses the entry's cwd (a cwd never changes mid-session).
    await appendFile(first, "{}\n");
    const live = await index.ensure({ only: [first] });
    assert.equal(live.parsed, 1);
    assert.equal((await index.manifest()).files[first].cwd, fixture.repo);
    assert.equal(index.state.lastPass.total, 0, "lastPass is the full pass");
    assert.equal(index.state.lastLivePass.parsed, 1);
    // A moved (size, mtime) on a full pass re-reads the head: the cwd is now unknown.
    await appendFile(first, "{}\n");
    await index.ensure();
    assert.equal((await index.manifest()).files[first].cwd, null, "changed file: head re-read, no cwd line left");
    await index.close();
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("ensure({ force }) while a pass runs queues exactly one more pass; abort stops the lanes", async () => {
  const fixture = await makeFixtureHome();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const adapters = fakeAdapters();
    const slow = { claude: { ...adapters.claude, parse: async (...a) => { await gate; return adapters.claude.parse(...a); } }, codex: adapters.codex };
    const index = createIndex({ home: fixture.home, env: {}, adapters: slow, rules: fakeRules(), warn: quiet, concurrency: 1 });
    const first = index.ensure();
    assert.equal(index.running, true);
    const same = index.ensure();
    assert.equal(same, first, "a plain ensure joins the running pass");
    const queued = index.ensure({ force: true });
    assert.notEqual(queued, first, "a forced ensure is queued behind the running pass");
    assert.equal(index.ensure({ force: true }), queued, "only one extra pass is queued");
    release();
    const firstResult = await first;
    assert.equal(firstResult.parsed, 5);
    const queuedResult = await queued;
    assert.equal(queuedResult.parsed, 5, "the queued pass re-parsed everything");
    assert.equal(index.running, false);

    let started = 0;
    let unblock;
    const block = new Promise((resolve) => { unblock = resolve; });
    const blocking = { claude: { ...adapters.claude, parse: async (...a) => { started += 1; await block; return adapters.claude.parse(...a); } }, codex: { ...adapters.codex, parse: async (...a) => { started += 1; await block; return adapters.codex.parse(...a); } } };
    const abortable = createIndex({ home: fixture.home, env: {}, adapters: blocking, rules: fakeRules(), warn: quiet, concurrency: 1 });
    const pass = abortable.ensure({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(abortable.abort(), true);
    unblock();
    const aborted = await pass;
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.parsed, 1, "only the task already in flight finished");
    assert.equal(started, 1);
    const manifest = await abortable.manifest();
    assert.equal(manifest.lastPass.aborted, true);
    assert.equal(Object.keys(manifest.files).length, 5, "entries of the previous pass survive an abort");
    assert.equal(abortable.abort(), false, "nothing to abort when idle");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("missing adapter modules are tolerated: the index still completes with empty results", async () => {
  const fixture = await makeFixtureHome();
  try {
    const warnings = [];
    const index = createIndex({ home: fixture.home, env: {}, adapters: {}, rules: fakeRules(), warn: (message) => warnings.push(message) });
    const result = await index.ensure();
    assert.equal(result.parsed, 0);
    assert.equal(result.files, 0);
    const overview = await index.buildOverview({ repoRoot: fixture.repo });
    assert.deepEqual(overview.runs, []);
    assert.equal(overview.index.files, 0);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("statsOf: hooks keyed by event with a matcher split in tokens, skills by name, instructions observed", () => {
  const run = fakeRun("/x/00000000-0000-4000-8000-00000000000a.jsonl", "claude");
  const main = run.scopes[0];
  const seq = main.blocks.length;
  const mk = (i, category, estTokens, extra) => ({ id: `main:${seq + i}`, seq: seq + i, at: "2026-09-01T10:00:00Z", category, bytes: estTokens * 4, estTokens, firstRequest: 1, hash: `hx${i}`, ...extra });
  main.blocks.push(
    mk(0, "attachments", 150, { attachmentType: "hook_success", label: "hook_success:SessionStart:compact" }),
    mk(1, "attachments", 200, { attachmentType: "hook_success", label: "hook_success:UserPromptSubmit" }),
    mk(2, "attachments", 20, { attachmentType: "hook_success", label: "hook_success:SessionStart:startup" }),
    mk(3, "tool_call", 30, { tool: { name: "Skill", kind: "skill", argsHash: "s1", target: "lorem-skill" }, label: "Skill" }),
    mk(4, "skills", 900, { label: "lorem-skill" }),
    mk(5, "skills", 300, { label: "other-skill" }),
    mk(6, "attachments", 400, { attachmentType: "nested_memory", label: "packages/api/CLAUDE.md" }),
    mk(7, "instructions", 500, { attachmentType: "agents_md", label: "AGENTS.md", hash: "i1" }),
  );
  const stats = statsOf(run);
  assert.deepEqual(Object.keys(stats.hookRuns).sort(), ["PreToolUse", "SessionStart", "UserPromptSubmit"]);
  assert.equal(stats.hookRuns.SessionStart.runs, 2);
  assert.equal(stats.hookRuns.SessionStart.unit, "tokens");
  assert.deepEqual(stats.hookRuns.SessionStart.stdoutSizes, [150, 20]);
  assert.deepEqual(stats.hookRuns.SessionStart.byMatcher.compact, { runs: 1, stdoutSizes: [150] });
  assert.deepEqual(stats.hookRuns.UserPromptSubmit.byMatcher, {});
  assert.deepEqual(stats.skillInvocations, { "lorem-skill": 1, "other-skill": 1 });
  assert.deepEqual(stats.instructionFilesObserved.sort(), ["AGENTS.md", "packages/api/CLAUDE.md"]);
  assert.equal(stats.codexInstructionChars, 0, "claude runs report no codex chain");

  const codex = fakeRun("/x/rollout-2026-09-01T11-00-00-019e0000-0000-7000-8000-00000000000b.jsonl", "codex");
  codex.scopes[0].blocks.push(mk(9, "instructions", 500, { attachmentType: "agents_md", label: "AGENTS.md", hash: "i9" }));
  assert.equal(statsOf(codex).codexInstructionChars, 2000, "bytes of distinct instruction blocks when the adapter reports nothing");
  codex.instructionsObserved = { chars: 4321, provenance: "observed.artifact" };
  assert.equal(statsOf(codex).codexInstructionChars, 4321);
});

test("recurrence, grouping and the first change follow the leverage rule", () => {
  const entries = [
    { runId: "claude:1", summary: { findingIds: ["B-01:aaaaaaaaaa", "B-02:bbbbbbbbbb"] } },
    { runId: "claude:2", summary: { findingIds: ["B-01:cccccccccc"] } },
    { runId: "claude:2", summary: { findingIds: ["B-01:cccccccccc"] } },
    { runId: "codex:3", summary: { findingIds: ["B-08:dddddddddd", "B-02:eeeeeeeeee"] } },
    { runId: "codex:4", error: "x" },
  ];
  const recurrence = recurrenceByRule(entries);
  assert.equal(recurrence.get("B-01"), 2);
  assert.equal(recurrence.get("B-02"), 2);
  assert.equal(recurrence.get("B-08"), 1);
  const findings = attachRecurrence([
    { id: "B-08:dddddddddd", ruleId: "B-08", severity: "high", scope: "session", tokensAffected: 18_600_000, fix: { platform: "both", summary: "compact" } },
    { id: "B-02:bbbbbbbbbb", ruleId: "B-02", severity: "high", scope: "session", tokensAffected: 700_000, count: 5, fix: { platform: "claude", summary: "trim", path: "CLAUDE.md" } },
    { id: "B-02:eeeeeeeeee", ruleId: "B-02", severity: "high", scope: "session", tokensAffected: 700_000, count: 4, fix: { platform: "codex", summary: "trim", path: "AGENTS.md" } },
    { id: "B-01:aaaaaaaaaa", ruleId: "B-01", severity: "medium", scope: "session", tokensAffected: 20_000 },
    { id: "S-01:setup00000", ruleId: "S-01", severity: "high", scope: "setup", tokensAffected: 3_400, fix: { platform: "claude", summary: "split", path: "CLAUDE.md" } },
    { id: "S-12:setup00001", ruleId: "S-12", severity: "medium", scope: "setup", tokensAffected: 0, fix: { platform: "codex", summary: "add" } },
  ], recurrence, { sessionCount: 3 });
  assert.equal(findings.find((f) => f.ruleId === "S-01").recurrence, 3, "S-01 applies to every session");
  assert.equal(findings.find((f) => f.ruleId === "S-12").recurrence, 1);
  assert.equal(findings.find((f) => f.ruleId === "B-08").recurrence, 1);
  const first = rankFirstChange(findings);
  assert.equal(first.ruleId, "S-01", "3 × 3 = 9 beats B-02 (3 × 2 = 6) and B-08 (3 × 1 = 3)");
  assert.equal(first.leverage, 9);
  const withoutSetup = rankFirstChange(findings.filter((f) => f.scope !== "setup"));
  assert.equal(withoutSetup.ruleId, "B-02");
  assert.equal(withoutSetup.fix.path, "CLAUDE.md", "no vendor majority (neither finding carries a vendor): the top-ranked finding represents the group");
  assert.equal(withoutSetup.removes.findings, 9, "one group per session rule: both vendors' B-02 findings are the same change (ADR-004 fix 5)");
  assert.equal(withoutSetup.removes.sessions, 2);
  const codexMajority = rankFirstChange(findings.filter((f) => f.scope !== "setup").map((f) => (f.ruleId === "B-02" ? { ...f, vendor: f.fix.platform, runId: f.fix.platform === "codex" ? "codex:3" : "claude:1", rootRunId: f.fix.platform === "codex" ? "codex:3" : "claude:1" } : f)).concat([{ id: "B-02:ffffffffff", ruleId: "B-02", severity: "high", scope: "session", vendor: "codex", runId: "codex:5", rootRunId: "codex:5", recurrence: 2, tokensAffected: 10, count: 1, fix: { platform: "codex", summary: "trim", path: "AGENTS.md" } }]));
  assert.equal(codexMajority.fix.path, "AGENTS.md", "two codex sessions vs one claude: the fix follows the majority vendor");
  assert.equal(codexMajority.vendor, "codex");
  const groups = groupFindings(findings);
  assert.deepEqual(groups.map((g) => g.ruleId), ["B-08", "B-02", "S-01", "B-01", "S-12"], "severity, then summed tokens, then sessions");
  assert.equal(groups.find((g) => g.ruleId === "B-02").occurrences, 9);
  assert.equal(groups.find((g) => g.ruleId === "B-02").sessions, 2);
  assert.equal(groups.find((g) => g.ruleId === "B-02").tokensAffected, 1_400_000);
});

test("scope summaries, byte cache, formatting and since parsing", () => {
  const run = fakeRun("/x/00000000-0000-4000-8000-00000000000c.jsonl", "claude");
  const summary = summarizeScope(run.scopes[0]);
  assert.equal(summary.partial, true);
  assert.equal(summary.requests, undefined);
  assert.equal(summary.blocks, undefined);
  assert.equal(summary.requestCount, 3);
  assert.equal(summary.blockCount, 6);
  assert.equal(summary.topBlocks[0].estTokens, 9_000);
  assert.equal(summary.peak.value, 30_000);

  const cache = createByteCache(100);
  cache.set("a", { bytes: 40 });
  cache.set("b", { bytes: 40 });
  cache.get("a");
  cache.set("c", { bytes: 40 });
  assert.equal(cache.get("b"), undefined, "least recently used entry evicted");
  assert.ok(cache.get("a"));
  assert.equal(cache.bytes, 80);
  cache.set("huge", { bytes: 1000 });
  assert.equal(cache.get("huge"), undefined, "an entry above the budget is not kept");
  cache.deletePrefix("a");
  assert.equal(cache.size, 1);

  // Three significant digits everywhere (ADR-004 fix 9).
  assert.equal(formatTokens(11_100_812_908), "11.1B");
  assert.equal(formatTokens(11_097_000_000), "11.1B");
  assert.equal(formatTokens(18_600_000), "18.6M");
  assert.equal(formatTokens(140_000_000), "140M");
  assert.equal(formatTokens(1_739_210), "1.74M");
  assert.equal(formatTokens(9_876), "9.88k");
  assert.equal(formatTokens(123_456), "123k");
  assert.equal(formatTokens(999_600), "1.00M");
  assert.equal(formatTokens(812), "812");
  const now = Date.parse("2026-09-02T00:00:00Z");
  assert.equal(parseSince("30d", now), now - 30 * 24 * 3600 * 1000);
  assert.equal(parseSince("12h", now), now - 12 * 3600 * 1000);
  assert.equal(parseSince("2026-09-01T00:00:00Z", now), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(parseSince("garbage", now), null);
});

test("statsOf: files reported by the InstructionsLoaded hook (run.instructionFilesObserved) join the observed set", () => {
  const run = fakeRun("hooked");
  run.scopes[0].blocks = [{ id: "main:1", seq: 1, at: "2026-09-01T00:00:00Z", category: "instructions", bytes: 100, estTokens: 25, label: "CLAUDE.md", firstRequest: 0, hash: "h1" }];
  run.instructionFilesObserved = [".claude/rules/security.md", "CLAUDE.md", ""];
  const stats = statsOf(run);
  assert.deepEqual(stats.instructionFilesObserved.sort(), [".claude/rules/security.md", "CLAUDE.md"]);
  assert.deepEqual(statsOf(fakeRun("plain")).instructionFilesObserved, []);
});
