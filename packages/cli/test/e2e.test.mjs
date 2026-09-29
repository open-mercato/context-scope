import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "../src/server/app.mjs";
import { GZIP_MIN_BYTES, prepareJson } from "../src/server/http.mjs";
import { TOKEN_SCRIPT } from "../src/server/static.mjs";
import { CLAUDE_SESSIONS, CODEX_CHILD, CODEX_PARENT, fakeAdapters, fakeRules, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const TOKEN = "t".repeat(64);
const quiet = () => {};

async function boot({ consent = false } = {}) {
  const fixture = await makeFixtureHome();
  const app = createServer({
    home: fixture.home, repoRoot: fixture.repo, token: TOKEN, adapters: fakeAdapters(), rules: fakeRules(), setup: fakeSetup(),
    consent, env: {}, warn: quiet,
  });
  const { url, port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const get = (route, init = {}) => fetch(base + route, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return {
    fixture, app, url, base, port, get,
    async close() {
      await app.close();
      await rm(fixture.home, { recursive: true, force: true });
    },
  };
}

function raw(base, route, headers, { method = "GET", body } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path: route, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function readSseUntil(response, predicate, timeoutMs = 5000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now())))]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
      }
    }
    if (events.some(predicate)) break;
  }
  await reader.cancel().catch(() => {});
  return events;
}

test("every /api/v1 route answers with the token and the right shape", async () => {
  const ctx = await boot();
  try {
    await ctx.app.index.ensure();
    assert.equal(ctx.app.index.lastResult.parsed, 5, "autoIndex ran on listen");

    const overviewResponse = await ctx.get("/api/v1/overview");
    assert.equal(overviewResponse.headers.get("referrer-policy"), "no-referrer");
    const overview = await overviewResponse.json();
    assert.ok(Array.isArray(overview.runs));
    // Default scope is the launched repo (ADR-003 §1): the session from the other cwd is not a row.
    assert.equal(overview.runs.length, 3);
    assert.equal(overview.totals.runs, 3);
    assert.equal(overview.scope.mode, "repo");
    assert.equal(overview.scope.sessions, 3);
    assert.equal(overview.scope.machineSessions, 4);
    assert.equal(overview.index.state, "idle");
    assert.equal(overview.index.files, 5);
    assert.equal(overview.index.runsInRange, 3);
    assert.equal(overview.index.lastPass.parsed, 5);
    assert.equal(overview.trends.days.length, 30);
    assert.ok(overview.runs.every((run) => run.summary.topBlocks === undefined && run.summary.findingIds === undefined));
    // H-01 (habit: Read src/index.mjs fat in every repo session) ties B-01 on leverage and wins on having a fix path.
    assert.equal(overview.firstFinding.ruleId, "H-01");
    assert.equal(overview.firstFinding.recurrence, 3, "sessions are top-level runs; the codex child is its parent's subagent");
    assert.equal(overview.firstFinding.sessions, 3);
    assert.ok(!JSON.stringify(overview).includes(ctx.fixture.home));
    const machine = await (await ctx.get("/api/v1/overview?scope=all")).json();
    assert.equal(machine.runs.length, 4);
    assert.equal(machine.scope.mode, "all");
    const withChildren = await (await ctx.get("/api/v1/overview?scope=all&nested=1")).json();
    assert.equal(withChildren.runs.length, 5);
    const legacyAlias = await (await ctx.get("/api/v1/overview?scope=all&all=1")).json();
    assert.equal(legacyAlias.runs.length, 5, "all=1 stays a deprecated alias of nested=1");
    assert.equal((await ctx.get("/api/v1/overview?scope=nope")).status, 400);
    const limited = await (await ctx.get("/api/v1/overview?limit=1&since=7d")).json();
    assert.equal(limited.runs.length, 1);
    assert.equal(limited.index.runsInRange, 3);
    assert.equal(limited.trends.days.length, 7);
    assert.equal((await ctx.get("/api/v1/overview?since=nonsense")).status, 400);
    const allTime = await (await ctx.get("/api/v1/overview?since=all")).json();
    assert.equal(allTime.range, "all");
    assert.equal(allTime.since, null);
    assert.equal(overview.range, "all", "repo scope defaults to all time");
    assert.equal(machine.range, "30d", "scope=all defaults to the last 30 days");
    assert.equal((await ctx.get("/api/v1/overview?limit=0")).status, 400);

    const runResponse = await ctx.get(`/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}`);
    assert.equal(runResponse.status, 200);
    assert.equal(runResponse.headers.get("vary"), "accept-encoding");
    const run = await runResponse.json();
    assert.equal(run.id, `claude:${CLAUDE_SESSIONS[0]}`);
    assert.equal(run.scopes.length, 2);
    assert.ok(Array.isArray(run.scopes[0].blocks), "the main scope is full");
    assert.equal(run.scopes[0].partial, undefined);
    assert.equal(run.scopes[1].partial, true, "child scopes are summaries");
    assert.equal(run.scopes[1].blocks, undefined);
    assert.equal(run.scopes[1].requestCount, 2);
    assert.ok(Array.isArray(run.scopes[1].topBlocks));
    assert.equal(run.findings.length, 1);
    assert.equal(run.findings[0].recurrence, 3, "three sessions (the codex child is a subagent of its parent)");
    assert.equal((await ctx.get("/api/v1/runs/claude/does-not-exist")).status, 404);
    assert.equal((await ctx.get("/api/v1/runs/claude")).status, 404);
    assert.equal((await ctx.get(`/api/v1/runs/codex/${CODEX_CHILD}`)).status, 200);
    assert.equal((await ctx.get(`/api/v1/runs/codex/${CODEX_PARENT}`)).status, 200);

    const scopeResponse = await ctx.get(`/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}/scopes/a1`);
    assert.equal(scopeResponse.status, 200);
    const scope = await scopeResponse.json();
    assert.equal(scope.id, "a1");
    assert.equal(scope.partial, undefined);
    assert.equal(scope.requests.length, 2);
    assert.equal(scope.blocks.length, 1);
    assert.equal((await ctx.get(`/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}/scopes/nope`)).status, 404);
    assert.equal((await ctx.get(`/api/v1/runs/claude/nope/scopes/a1`)).status, 404);
    assert.equal((await ctx.get(`/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}/scopes`)).status, 404);
    assert.ok(ctx.app.routes.cache.size >= 2, "run and scope payloads are cached");

    // Large payloads are gzipped when the client accepts it; small ones are not.
    const big = await raw(ctx.base, `/api/v1/runs/claude/${CLAUDE_SESSIONS[2]}`, { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip" });
    assert.equal(big.status, 200);
    assert.equal(big.headers["content-encoding"], "gzip");
    const inflated = JSON.parse(gunzipSync(big.body).toString("utf8"));
    assert.equal(inflated.id, `claude:${CLAUDE_SESSIONS[2]}`);
    assert.ok(inflated.scopes[0].blocks.length > 100);
    const plain = await raw(ctx.base, `/api/v1/runs/claude/${CLAUDE_SESSIONS[2]}`, { authorization: `Bearer ${TOKEN}`, "accept-encoding": "identity" });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.ok(plain.body.length > GZIP_MIN_BYTES);
    const small = await raw(ctx.base, `/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}/scopes/a1`, { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip" });
    assert.equal(small.headers["content-encoding"], undefined, "bodies under 8 KB are sent as-is");
    const prepared = await prepareJson({ pad: "x".repeat(20_000) });
    assert.ok(prepared.gzip && prepared.gzip.length < prepared.json.length);

    const setupResponse = await ctx.get("/api/v1/setup");
    assert.equal(setupResponse.status, 200);
    const setup = await setupResponse.json();
    assert.equal(setup.repo.name, "repo");
    assert.equal(setup.findings.length, 1);
    assert.equal(setup.findings[0].scope, "setup");
    assert.equal(setup.findings[0].recurrence, 1, "S-12 does not apply to every session");
    assert.equal(setup.sessionStats.sessionCount, 3, "sessions are top-level runs (ADR-004 §2)");

    const findings = await (await ctx.get("/api/v1/findings")).json();
    assert.equal(findings.findings.length, 6, "1 setup + 4 repo session findings + 1 habit");
    assert.equal(findings.findings[0].severity, "high");
    assert.ok(findings.findings.every((finding) => Array.isArray(finding.evidence) && finding.evidence.length));
    assert.ok(findings.findings.filter((finding) => finding.scope === "session").every((finding) => finding.recurrence === 3), "recurrence counts sessions (root runs)");
    assert.ok(findings.findings.some((finding) => finding.runId === `codex:${CODEX_CHILD}` && finding.rootRunId === `codex:${CODEX_PARENT}`), "a child's finding names its session");
    assert.deepEqual(findings.groups.map((group) => group.ruleId), ["B-01", "H-01", "S-12"]);
    assert.equal(findings.groups[0].sessions, 3);
    assert.equal(findings.groups[0].occurrences, 4);
    assert.equal(findings.groups[1].scope, "habit");
    assert.equal(findings.firstChange.ruleId, "H-01");
    assert.equal(findings.firstChange.removes.sessions, 3);
    const habitOnly = await (await ctx.get("/api/v1/findings?scope=habit")).json();
    assert.equal(habitOnly.findings.length, 1);
    const habits = await (await ctx.get("/api/v1/habits")).json();
    assert.equal(habits.findings.length, 1);
    assert.equal(habits.findings[0].sessions, 3);
    assert.equal(habits.sessions, 3);
    assert.ok(Array.isArray(habits.trends.sessions));
    const setupOnly = await (await ctx.get("/api/v1/findings?scope=setup")).json();
    assert.equal(setupOnly.findings.length, 1);
    const codexOnly = await (await ctx.get("/api/v1/findings?vendor=codex&scope=session")).json();
    assert.equal(codexOnly.findings.length, 2);
    assert.equal((await ctx.get("/api/v1/findings?scope=bogus")).status, 400);

    const thresholds = await (await ctx.get("/api/v1/thresholds")).json();
    assert.equal(thresholds.fatToolResultTokens, 8000);
    const put = await ctx.get("/api/v1/thresholds", { method: "PUT", body: JSON.stringify({ fatToolResultTokens: 5000 }), headers: { "content-type": "application/json" } });
    assert.equal(put.status, 200);
    const written = JSON.parse(await readFile(path.join(ctx.fixture.home, ".contextscope", "thresholds.json"), "utf8"));
    assert.deepEqual(written, { fatToolResultTokens: 5000 });
    const badKey = await ctx.get("/api/v1/thresholds", { method: "PUT", body: JSON.stringify({ nope: 1 }) });
    assert.equal(badKey.status, 400);
    const badValue = await ctx.get("/api/v1/thresholds", { method: "PUT", body: JSON.stringify({ fatToolResultTokens: "big" }) });
    assert.equal(badValue.status, 400);
    const negative = await ctx.get("/api/v1/thresholds", { method: "PUT", body: JSON.stringify({ fatToolResultTokens: -1 }) });
    assert.equal(negative.status, 400, "negative thresholds are rejected");
    assert.deepEqual(JSON.parse(await readFile(path.join(ctx.fixture.home, ".contextscope", "thresholds.json"), "utf8")), { fatToolResultTokens: 5000 });
    const crossOrigin = await ctx.get("/api/v1/thresholds", { method: "PUT", body: "{}", headers: { origin: "http://evil.example" } });
    assert.equal(crossOrigin.status, 403);

    const refresh = await ctx.get("/api/v1/index/refresh", { method: "POST" });
    assert.equal(refresh.status, 200);
    assert.deepEqual((await refresh.json()).ok, true);
    await ctx.app.index.ensure();

    assert.equal((await ctx.get("/api/v1/legacy-probe")).status, 404, "no legacy routes remain");
    assert.equal((await ctx.get("/api/v1/discovery")).status, 404);
    assert.equal((await ctx.get("/api/v1/unknown")).status, 404);
  } finally {
    await ctx.close();
  }
});

test("token policy, host check, static files, index.html token script, and SSE progress", async () => {
  const ctx = await boot();
  try {
    assert.equal((await fetch(`${ctx.base}/api/v1/overview`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/v1/overview`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/v1/overview?token=${TOKEN}`)).status, 401, "the query token is not accepted on data routes");
    assert.equal((await fetch(`${ctx.base}/api/v1/index/events?token=${"x".repeat(64)}`)).status, 401);
    assert.equal((await raw(ctx.base, "/", { host: "evil.example" })).status, 403, "non-loopback Host is rejected");
    assert.equal((await raw(ctx.base, "/", { host: "localhost" })).status, 200);
    assert.equal((await raw(ctx.base, "/", { host: `[::1]:${ctx.port}` })).status, 200, "IPv6 loopback Host is accepted");
    assert.equal((await raw(ctx.base, "/", { host: "[::2]" })).status, 403);

    const page = await fetch(ctx.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const html = await page.text();
    assert.match(html, /<div id="app">/);
    assert.match(html, /app\.js/);
    assert.ok(html.includes(TOKEN_SCRIPT), "index.html moves the token into sessionStorage and rewrites the URL");
    assert.ok(html.indexOf(TOKEN_SCRIPT) < html.indexOf("app.js"), "the token script runs before the bundle");
    const script = await fetch(`${ctx.base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal(script.headers.get("referrer-policy"), "no-referrer");
    const css = await fetch(`${ctx.base}/app.css`);
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.equal((await fetch(`${ctx.base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/src/contextscope.mjs`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/ui`)).status, 404);

    const sse = await fetch(`${ctx.base}/api/v1/index/events?token=${TOKEN}`, { headers: { accept: "text/event-stream" } });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type"), /text\/event-stream/);
    assert.equal(sse.headers.get("referrer-policy"), "no-referrer");
    const events = await readSseUntil(sse, (event) => event.type === "done");
    const done = events.find((event) => event.type === "done");
    assert.ok(done, `expected a done event, got ${JSON.stringify(events)}`);
    assert.equal(typeof done.ms, "number");
    assert.ok(events.some((event) => event.type === "state"));
  } finally {
    await ctx.close();
  }
});

test("consent gate: the consent page needs the launch token and the API answers 409 until authorized", async () => {
  const ctx = await boot({ consent: true });
  try {
    assert.equal((await fetch(`${ctx.base}/`)).status, 401, "no consent page without the token");
    const page = await (await fetch(ctx.url)).text();
    assert.match(page, /Authorize read-only scan/);
    assert.match(page, /location\.replace\('\/\?token='/);
    assert.equal((await ctx.get("/api/v1/overview")).status, 409);
    assert.equal(ctx.app.index.lastResult, null, "nothing indexed before consent");
    assert.equal((await fetch(`${ctx.base}/api/authorize`, { method: "POST" })).status, 401);
    assert.equal((await ctx.get("/api/authorize", { method: "POST" })).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.app.index.ensure();
    assert.equal((await ctx.get("/api/v1/overview")).status, 200);
    assert.match(await (await fetch(ctx.url)).text(), /<div id="app">/);
  } finally {
    await ctx.close();
  }
});

test("close() aborts an in-flight index pass instead of waiting for it", async () => {
  const fixture = await makeFixtureHome();
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const adapters = fakeAdapters();
  const slow = { claude: { ...adapters.claude, parse: async (...a) => { await gate; return adapters.claude.parse(...a); } }, codex: adapters.codex };
  const app = createServer({ home: fixture.home, repoRoot: fixture.repo, token: TOKEN, adapters: slow, rules: fakeRules(), setup: fakeSetup(), consent: false, env: {}, warn: quiet, concurrency: 1 });
  try {
    await app.listen(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.index.running, true);
    const closing = app.close();
    setTimeout(unblock, 20);
    await closing;
    assert.equal(app.index.running, false);
    assert.equal(app.index.lastResult.aborted, true);
    assert.ok(app.index.lastResult.parsed < 5, "the pass stopped early");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

// --- cycle 3 (ADR-005 §6): `status` and `start --json` through the real CLI ---
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { serverFilePath } from "../src/server/server-file.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "contextscope.mjs");

function cliEnv(home) {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.GEMINI_CLI_HOME;
  return env;
}

function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: cliEnv(home), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("contextscope status answers from disk in under 300 ms with no index pass, text and --json", async () => {
  const fixture = await makeFixtureHome();
  try {
    const t0 = Date.now();
    const text = await runCli(["status", "--repo", fixture.repo], { home: fixture.home, cwd: fixture.repo });
    const wall = Date.now() - t0;
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^ContextScope status · repo repo/);
    assert.match(text.stdout, /vendors\s+claude ~\/\.claude\/projects: 3 files · codex ~\/\.codex\/sessions: 2 files · gemini not found/);
    assert.match(text.stdout, /last pass never/);
    assert.match(text.stdout, /companion not running/);
    await assert.rejects(stat(path.join(fixture.home, ".contextscope", "index")), "no index was created");
    const json = await runCli(["status", "--repo", fixture.repo, "--json"], { home: fixture.home, cwd: fixture.repo });
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.index.entries, 0);
    assert.equal(report.server.running, false);
    assert.ok(report.ms < 300, `status report took ${report.ms} ms`);
    assert.ok(wall < 1500, `status process took ${wall} ms (node start-up included)`);
    assert.ok(!json.stdout.includes(fixture.home));
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("start --json prints { url, repo, repoKey } then NDJSON index events ending in `found`; server.json lives and dies with the process", async () => {
  const fixture = await makeFixtureHome();
  const child = spawn(process.execPath, [CLI, "start", "--json", "--yes", "--no-open", "--repo", fixture.repo], { cwd: fixture.repo, env: cliEnv(fixture.home), stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let stderr = "";
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !lines.some((line) => line.includes('"type":"found"'))) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(lines.length >= 2, `expected NDJSON output, got ${JSON.stringify(lines)} / ${stderr}`);
    const head = JSON.parse(lines[0]);
    assert.match(head.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
    assert.equal(head.repo, fixture.repo);
    assert.match(head.repoKey, /^repo-[0-9a-f]{8}$/);
    assert.equal(head.consent, false);
    const events = lines.slice(1).map((line) => JSON.parse(line));
    const types = events.map((event) => event.type);
    assert.ok(types.includes("start"), types.join(","));
    assert.ok(types.includes("done"), types.join(","));
    assert.equal(types.at(-1), "found");
    const found = events.at(-1);
    // Real adapters over the synthetic home: the file count is exact; how many parse into sessions is the adapters' call.
    assert.equal(found.files, 5);
    assert.ok(Number.isInteger(found.sessions) && found.sessions >= 0);
    assert.ok(Number.isInteger(found.machineSessions) && found.machineSessions >= found.sessions);
    assert.ok(Array.isArray(found.composition));
    assert.equal(found.hooksInstalled, false);
    assert.ok(!lines.join("\n").includes(fixture.home + "/.claude"), "no session-file path in the stream");
    const serverFile = JSON.parse(await readFile(serverFilePath(fixture.home), "utf8"));
    assert.equal(serverFile.pid, child.pid);
    assert.equal(serverFile.url, head.url.replace(/\?token=.*$/, ""));
    assert.equal(serverFile.repoRoot, fixture.repo);
    assert.equal(serverFile.token, undefined);
    assert.equal((await stat(serverFilePath(fixture.home))).mode & 0o777, 0o600);
    // `status` from another process sees the running companion.
    const status = await runCli(["status", "--repo", fixture.repo, "--json"], { home: fixture.home, cwd: fixture.repo });
    assert.equal(JSON.parse(status.stdout).server.running, true);
    assert.equal(JSON.parse(status.stdout).server.pid, child.pid);
    child.kill("SIGINT");
    const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "timeout" }), 10_000))]);
    assert.notEqual(exit.signal, "timeout", "the companion stops on SIGINT");
    await assert.rejects(stat(serverFilePath(fixture.home)), "server.json is removed on close");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(fixture.home, { recursive: true, force: true });
  }
});
