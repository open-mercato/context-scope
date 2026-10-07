import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, rm } from "node:fs/promises";
import { createServer } from "../src/server/app.mjs";
import { buildTail, requestsSignature } from "../src/server/routes/runs.mjs";
import { CLAUDE_SESSIONS, fakeAdapters, fakeRules, fakeRun, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const TOKEN = "t".repeat(64);
const quiet = () => {};

async function waitFor(predicate, { timeoutMs = 3_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

function request(index, total, extra = {}) {
  return { index, at: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`, model: "m", turn: 1, usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 1, total }, composition: { user: total }, ...extra };
}

test("buildTail returns exactly the requests, blocks, closures and compactions after `after`", () => {
  const scope = {
    id: "main", peak: { value: 50_000, provenance: "observed.vendor" }, forecast: { perRequest: 10 },
    requests: [request(0, 10_000), request(1, 20_000), request(2, 30_000), request(3, 40_000), request(4, 50_000)],
    blocks: [
      { id: "main:0", firstRequest: 0, lastRequest: 1 },            // closed before the client's horizon
      { id: "main:1", firstRequest: 0, lastRequest: 2 },            // still present at request 2: closes now
      { id: "main:2", firstRequest: 1, lastRequest: 3, droppedBy: "c1" },
      { id: "main:3", firstRequest: 3 },                            // new
      { id: "main:4", firstRequest: 2 },                            // known, still present
    ],
    compactions: [{ id: "c0", atRequest: 1 }, { id: "c1", atRequest: 4 }],
  };
  const summary = { requests: 5 };
  const tail = buildTail(scope, summary, { after: 2 });
  assert.equal(tail.rebased, false);
  assert.deepEqual(tail.requests.map((r) => r.index), [3, 4]);
  assert.deepEqual(tail.blocks.map((b) => b.id), ["main:3"]);
  assert.deepEqual(tail.closed, [{ id: "main:1", lastRequest: 2, droppedBy: undefined }, { id: "main:2", lastRequest: 3, droppedBy: "c1" }]);
  assert.deepEqual(tail.compactions.map((c) => c.id), ["c1"]);
  assert.equal(tail.summary, summary);
  assert.deepEqual(tail.peak, scope.peak);
  assert.deepEqual(tail.forecast, scope.forecast);
  assert.equal(tail.requestCount, 5);
  assert.equal(buildTail(scope, summary, { after: 2, live: false }).forecast, undefined, "not live: no forecast");

  const everything = buildTail(scope, summary, { after: -1 });
  assert.equal(everything.requests.length, 5);
  assert.equal(everything.blocks.length, 5);
  assert.equal(everything.closed.length, 0);
  assert.equal(everything.compactions.length, 2);

  const nothing = buildTail(scope, summary, { after: 4 });
  assert.deepEqual(nothing.requests, []);
  assert.equal(nothing.rebased, false);
});

test("a signature mismatch (or a horizon past the end) answers rebased with an empty tail", () => {
  const requests = [request(0, 10_000), request(1, 20_000), request(2, 30_000)];
  const scope = { id: "main", requests, blocks: [{ id: "main:0", firstRequest: 2 }], compactions: [], peak: { value: 30_000, provenance: "observed.vendor" } };
  const good = requestsSignature(requests, 1);
  assert.equal(buildTail(scope, {}, { after: 1, sig: good }).rebased, false);
  assert.equal(buildTail(scope, {}, { after: 1, sig: good }).requests.length, 1);
  const moved = requests.map((r, i) => (i === 0 ? { ...r, composition: { user: 5_000, unlogged: 5_000 } } : r));
  const bad = requestsSignature(moved, 1);
  assert.notEqual(bad, good);
  const rebased = buildTail(scope, {}, { after: 1, sig: bad });
  assert.equal(rebased.rebased, true);
  assert.deepEqual(rebased.requests, []);
  assert.deepEqual(rebased.blocks, []);
  assert.equal(buildTail(scope, {}, { after: 7 }).rebased, true, "client ahead of the index");
  assert.equal(requestsSignature(requests, 1), requestsSignature(requests.slice(0, 2), 5), "signature covers requests[0..after] only");
});

test("GET /runs/:vendor/:id/tail serves the new requests through the index and rejects a bad `after`", async () => {
  const fixture = await makeFixtureHome();
  const app = createServer({ home: fixture.home, repoRoot: fixture.repo, token: TOKEN, adapters: fakeAdapters(), rules: fakeRules(), setup: fakeSetup(), consent: false, autoIndex: false, env: {}, warn: quiet });
  try {
    const { port } = await app.listen(0);
    await app.index.ensure();
    const get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const id = CLAUDE_SESSIONS[1];
    const expected = fakeRun(fixture.files[id], "claude").scopes[0];

    const full = await (await get(`/api/v1/runs/claude/${id}/tail`)).json();
    assert.equal(full.rebased, false);
    assert.equal(full.requests.length, expected.requests.length);
    assert.equal(full.requestCount, expected.requests.length);

    const response = await get(`/api/v1/runs/claude/${id}/tail?after=1&scope=main`);
    assert.equal(response.status, 200);
    const tail = await response.json();
    assert.deepEqual(tail.requests.map((r) => r.index), [2]);
    assert.deepEqual(tail.blocks.map((b) => b.id).sort(), expected.blocks.filter((b) => b.firstRequest > 1).map((b) => b.id).sort());
    assert.deepEqual(tail.compactions.map((c) => c.id), ["c1"], "session 2 compacts at request 2");
    assert.equal(tail.summary.requests, expected.requests.length + 2, "summary counts the subagent's requests too");
    assert.deepEqual(tail.peak, expected.peak);
    assert.equal(tail.live, undefined, "not live: nothing re-parsed since start");
    assert.equal(app.watcher !== null, true, "consent: false starts the watcher at construction");

    const sig = requestsSignature(full.requests, 1);
    const same = await (await get(`/api/v1/runs/claude/${id}/tail?after=1&sig=${sig}`)).json();
    assert.equal(same.rebased, false);
    const moved = await (await get(`/api/v1/runs/claude/${id}/tail?after=1&sig=deadbeef`)).json();
    assert.equal(moved.rebased, true);
    assert.deepEqual(moved.requests, []);

    assert.equal((await get(`/api/v1/runs/claude/${id}/tail?after=x`)).status, 400);
    assert.equal((await get(`/api/v1/runs/claude/${id}/tail?scope=nope`)).status, 404);
    assert.equal((await get(`/api/v1/runs/claude/00000000-0000-4000-8000-000000000000/tail`)).status, 404);

    assert.equal(tail.forecast, undefined, "a finished session carries no forecast");
    const opened = app.index.stats.runFilesOpened;
    await get(`/api/v1/runs/claude/${id}/tail?after=1`);
    await get(`/api/v1/runs/claude/${id}/tail?after=2`);
    assert.equal(app.index.stats.runFilesOpened, opened, "the parsed scope is served from the cache");

    // A live re-parse marks the run live in the tail response and refreshes the cached scope once.
    await appendFile(fixture.files[id], "{}\n");
    app.watcher.touch(fixture.files[id]);
    assert.ok(await waitFor(() => app.watcher.passes >= 1), "live pass");
    const live = await (await get(`/api/v1/runs/claude/${id}/tail?after=2`)).json();
    assert.ok(live.live && typeof live.live.at === "string", "live marker after the watcher re-parsed the file");
    const reread = app.index.stats.runFilesOpened;
    assert.ok(reread > opened, "the re-indexed scope was read again");
    await get(`/api/v1/runs/claude/${id}/tail?after=2`);
    assert.equal(app.index.stats.runFilesOpened, reread, "one read per pass");
    const scope = await app.index.readScope(`claude:${id}`, "main");
    assert.equal(app.index.stats.runFilesOpened, reread);
    assert.equal(typeof scope.id, "string");
  } finally {
    await app.close();
    await rm(fixture.home, { recursive: true, force: true });
  }
});
