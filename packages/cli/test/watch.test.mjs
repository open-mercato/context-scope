import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createIndex } from "../src/index/index.mjs";
import { discoverWatchSet, mainFileFor, startWatcher } from "../src/index/watch.mjs";
import { createSseHub } from "../src/server/sse.mjs";
import { CLAUDE_SESSIONS, CODEX_PARENT, fakeAdapters, fakeRules, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};

function sseSpy() {
  const events = [];
  const sticky = new Map();
  return {
    events,
    sticky,
    broadcast(event, { sticky: key } = {}) { events.push(event); if (key) sticky.set(key, event); },
    forget(key) { sticky.delete(key); },
  };
}

async function waitFor(predicate, { timeoutMs = 3_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

function spyEnsure(index) {
  const calls = [];
  const original = index.ensure;
  index.ensure = (options = {}) => { calls.push(options); return original.call(index, options); };
  return calls;
}

test("mainFileFor maps main, subagent and codex files inside the roots and nothing else", () => {
  const allow = { claudeProjects: "/h/.claude/projects", codexSessions: "/h/.codex/sessions" };
  const main = `/h/.claude/projects/-h-repo/${CLAUDE_SESSIONS[0]}.jsonl`;
  assert.equal(mainFileFor(main, allow), main);
  assert.equal(mainFileFor(`/h/.claude/projects/-h-repo/${CLAUDE_SESSIONS[0]}/subagents/agent-abc123.jsonl`, allow), main);
  assert.equal(mainFileFor(`/h/.claude/projects/-h-repo/${CLAUDE_SESSIONS[0]}/subagents/agent-abc123.meta.json`, allow), null);
  assert.equal(mainFileFor("/h/.claude/projects/-h-repo/notes.jsonl", allow), null);
  const codex = `/h/.codex/sessions/2026/09/01/rollout-2026-09-01T11-00-00-${CODEX_PARENT}.jsonl`;
  assert.equal(mainFileFor(codex, allow), codex);
  assert.equal(mainFileFor("/h/.codex/sessions/2026/09/rollout-x.jsonl", allow), null);
  assert.equal(mainFileFor(`/h/other/${CLAUDE_SESSIONS[0]}.jsonl`, allow), null);
  assert.equal(mainFileFor("/h/.claude/projects/../../etc/passwd.jsonl", allow), null);
});

test("discoverWatchSet lists project, subagent and day directories newest first and caps them", async () => {
  const fixture = await makeFixtureHome();
  try {
    const allow = { claudeProjects: path.join(fixture.home, ".claude", "projects"), codexSessions: path.join(fixture.home, ".codex", "sessions") };
    const set = await discoverWatchSet(allow, { now: Date.now(), liveWindowMs: 60 * 60_000 });
    assert.ok(set.dirs.includes(fixture.projectDir));
    assert.ok(set.dirs.includes(path.join(fixture.projectDir, CLAUDE_SESSIONS[0], "subagents")), "subagent dir of a recent session");
    assert.ok(set.dirs.includes(fixture.codexDir));
    assert.ok(set.dirs.every((dir) => dir.startsWith(fixture.home)));
    assert.equal(set.files.size, 7, "three claude sessions, the tiny one, one subagent file and two rollouts are recent");
    assert.equal(set.files.get(path.join(fixture.projectDir, CLAUDE_SESSIONS[0], "subagents", "agent-a1ee861386cb26b5b.jsonl"))?.main, fixture.files[CLAUDE_SESSIONS[0]]);
    const capped = await discoverWatchSet(allow, { now: Date.now(), maxDirs: 2 });
    assert.equal(capped.dirs.length, 2);
    const stale = await discoverWatchSet(allow, { now: Date.now() + 2 * 60 * 60_000, liveWindowMs: 60 * 60_000 });
    assert.equal(stale.files.size, 0, "nothing in the active set once every file is older than the live window");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("appending to a session file triggers one ensure({ only }) and one live event, then live-idle", async () => {
  const fixture = await makeFixtureHome();
  const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
  const sse = sseSpy();
  let watcher = null;
  try {
    await index.ensure();
    const calls = spyEnsure(index);
    const tagged = [];
    index.events.on("event", (event) => { if (event.live) tagged.push(event.type); });
    watcher = startWatcher({ index, sse, home: fixture.home, env: {}, warn: quiet, debounceMs: 150, idleMs: 600, pollMs: 100, rescanMs: 60_000 });
    await watcher.rescan();
    assert.equal(watcher.mode, "watch");
    assert.equal(typeof index.liveRuns, "function", "accessor attached for the overview");
    assert.equal(index.liveRuns().size, 0);

    const file = fixture.files[CLAUDE_SESSIONS[1]];
    const started = Date.now();
    await appendFile(file, `${JSON.stringify({ type: "user", uuid: "u9", sessionId: CLAUDE_SESSIONS[1], cwd: fixture.repo, timestamp: "2026-09-01T10:09:00.000Z", message: { role: "user", content: "x".repeat(400) } })}\n`);
    assert.ok(await waitFor(() => sse.events.some((event) => event.type === "live")), "live event within 3 s");
    const latency = Date.now() - started;
    assert.ok(latency < 3_000, `live after ${latency} ms`);
    const live = sse.events.find((event) => event.type === "live");
    assert.equal(live.runId, `claude:${CLAUDE_SESSIONS[1]}`);
    assert.equal(live.vendor, "claude");
    assert.equal(typeof live.requests, "number");
    assert.equal(typeof live.peak, "number");
    assert.equal(typeof live.parseMs, "number");
    assert.ok(!live.file.includes(fixture.home), "no absolute path in the event");
    assert.equal(sse.sticky.get(`live:${live.runId}`), live, "live events are sticky per run");
    assert.equal(calls.length, 1, "one ensure for one burst of writes");
    assert.deepEqual(calls[0].only, [file]);
    assert.ok(tagged.includes("done"), "index events of the live pass are tagged live");
    assert.equal(index.liveRuns().get(live.runId)?.at, live.at);
    assert.equal(index.state.lastPass.total, 5, "a live pass never overwrites lastPass (the last full pass)");
    assert.equal(index.state.lastLivePass.total, 1);
    assert.equal(index.state.lastLivePass.parsed, 1);
    assert.equal(watcher.passes, 1);
    assert.ok(latency < 1_000, `leading edge: the first change is parsed at once (live after ${latency} ms, debounce 150 ms)`);

    assert.ok(await waitFor(() => sse.events.some((event) => event.type === "live-idle"), { timeoutMs: 2_000 }), "live-idle after the idle timeout");
    assert.equal(sse.events.filter((event) => event.type === "live").length, 1, "still exactly one live event");
    assert.equal(index.liveRuns().size, 0);
    assert.equal(sse.sticky.size, 0);
  } finally {
    await watcher?.stop();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a sustained write burst is re-parsed every debounce interval, not only when it ends", async () => {
  const fixture = await makeFixtureHome();
  const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
  const sse = sseSpy();
  let watcher = null;
  try {
    await index.ensure();
    const calls = spyEnsure(index);
    watcher = startWatcher({ index, sse, home: fixture.home, env: {}, warn: quiet, debounceMs: 200, idleMs: 60_000, pollMs: 50, rescanMs: 60_000 });
    await watcher.rescan();
    const file = fixture.files[CLAUDE_SESSIONS[1]];
    const started = Date.now();
    // Nine appends 60 ms apart (~540 ms): a trailing-only debounce of 200 ms would parse once, after the burst.
    for (let i = 0; i < 9; i += 1) {
      await appendFile(file, `${JSON.stringify({ type: "user", uuid: `b${i}`, sessionId: CLAUDE_SESSIONS[1], cwd: fixture.repo, timestamp: "2026-09-01T10:09:00.000Z", message: { role: "user", content: "y".repeat(200) } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    assert.ok(await waitFor(() => watcher.passes >= 3 && !calls.length === false, { timeoutMs: 3_000 }), `several passes during and after the burst (${watcher.passes})`);
    const firstLive = sse.events.find((event) => event.type === "live");
    assert.ok(firstLive && Date.parse(firstLive.at) - started < 400, "the first parse landed during the burst");
    assert.ok(watcher.passes >= 3 && watcher.passes <= 6, `bounded by the debounce (${watcher.passes} passes for 9 writes)`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settled = watcher.passes;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(watcher.passes, settled, "no passes once the file is quiet");
    assert.ok(calls.every((options) => Array.isArray(options.only) && options.only.length === 1));
  } finally {
    await watcher?.stop();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a subagent file change re-parses the parent main file", async () => {
  const fixture = await makeFixtureHome();
  const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
  const sse = sseSpy();
  let watcher = null;
  try {
    await index.ensure();
    const calls = spyEnsure(index);
    watcher = startWatcher({ index, sse, home: fixture.home, env: {}, warn: quiet, debounceMs: 100, idleMs: 60_000, pollMs: 100, rescanMs: 60_000 });
    await watcher.rescan();
    const subagents = path.join(fixture.projectDir, CLAUDE_SESSIONS[0], "subagents");
    await appendFile(path.join(subagents, "agent-a1ee861386cb26b5b.jsonl"), "{}\n");
    assert.ok(await waitFor(() => sse.events.some((event) => event.type === "live")));
    assert.deepEqual(calls[0].only, [fixture.files[CLAUDE_SESSIONS[0]]]);
    assert.equal(sse.events.find((event) => event.type === "live").runId, `claude:${CLAUDE_SESSIONS[0]}`);
  } finally {
    await watcher?.stop();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("when fs.watch throws the watcher polls the active set and still emits live", async () => {
  const fixture = await makeFixtureHome();
  const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
  const sse = sseSpy();
  const warnings = [];
  let watcher = null;
  try {
    await index.ensure();
    const calls = spyEnsure(index);
    watcher = startWatcher({
      index, sse, home: fixture.home, env: {}, warn: (message) => warnings.push(message),
      watchFn: () => { const error = new Error("too many open files"); error.code = "EMFILE"; throw error; },
      debounceMs: 100, idleMs: 60_000, pollMs: 100, rescanMs: 60_000,
    });
    await watcher.rescan();
    assert.equal(watcher.mode, "poll");
    assert.equal(watcher.watchedDirs.length, 0);
    assert.ok(warnings.some((message) => message.includes("EMFILE")));
    assert.ok(watcher.activeFiles.includes(fixture.files[CODEX_PARENT]));
    await appendFile(fixture.files[CODEX_PARENT], "{}\n");
    assert.ok(await waitFor(() => sse.events.some((event) => event.type === "live")), "polling catches the change");
    assert.deepEqual(calls[0].only, [fixture.files[CODEX_PARENT]]);
    assert.equal(sse.events.find((event) => event.type === "live").vendor, "codex");
  } finally {
    await watcher?.stop();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a change is ignored while isLive() is false and outside the roots", async () => {
  const fixture = await makeFixtureHome();
  const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
  const sse = sseSpy();
  let watcher = null;
  try {
    await index.ensure();
    const calls = spyEnsure(index);
    watcher = startWatcher({ index, sse, home: fixture.home, env: {}, warn: quiet, isLive: () => false, debounceMs: 50, idleMs: 60_000, pollMs: 50, rescanMs: 60_000 });
    await watcher.rescan();
    await appendFile(fixture.files[CLAUDE_SESSIONS[1]], "{}\n");
    const elsewhere = path.join(fixture.home, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, `${CLAUDE_SESSIONS[2]}.jsonl`), "{}\n");
    watcher.touch(path.join(elsewhere, `${CLAUDE_SESSIONS[2]}.jsonl`));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(calls.length, 0);
    assert.equal(sse.events.length, 0);
    await watcher.stop();
    assert.equal(index.liveRuns, undefined, "stop removes the accessor it attached");
  } finally {
    await watcher?.stop();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("the SSE hub replays sticky live events to new subscribers and forgets them on idle", () => {
  const hub = createSseHub({ heartbeatMs: 60_000 });
  const written = [];
  const response = { writeHead() {}, write(chunk) { written.push(String(chunk)); }, on() {}, end() {} };
  const request = { on() {}, socket: null };
  hub.broadcast({ type: "live", runId: "claude:x", at: "2026-09-02T00:00:00.000Z" }, { sticky: "live:claude:x" });
  hub.broadcast({ type: "progress", runId: "claude:x" });
  assert.equal(hub.stickyEvents.length, 1);
  assert.ok(hub.subscribe(request, response, [{ type: "state" }]));
  const events = written.filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6).trim()));
  assert.deepEqual(events.map((event) => event.type), ["state", "live"], "the sticky live event follows the initial snapshot; progress is not replayed");
  hub.forget("live:claude:x");
  hub.broadcast({ type: "live-idle", runId: "claude:x" });
  assert.equal(hub.stickyEvents.length, 0);
  assert.equal(written.filter((chunk) => chunk.includes("live-idle")).length, 1);
  hub.close();
});
