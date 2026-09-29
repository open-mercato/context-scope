/** `contextscope status` (ADR-005 §6): answers from what exists on disk, never runs a pass, well under 300 ms. */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createIndex } from "../src/index/writer.mjs";
import { createServer } from "../src/server/app.mjs";
import { processAlive, readServerFile, removeServerFile, serverFilePath, writeServerFile } from "../src/server/server-file.mjs";
import { probeWatchCapability } from "../src/index/watch.mjs";
import { renderStatus, statusReport } from "../src/commands/status.mjs";
import { CLAUDE_SESSIONS, fakeAdapters, fakeRules, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};

test("status on a fresh home: vendors, no index, no hooks, no companion; nothing is written", async () => {
  const fixture = await makeFixtureHome();
  try {
    const report = await statusReport({ home: fixture.home, repoRoot: fixture.repo, env: {} });
    assert.deepEqual(report.vendors.map((row) => [row.vendor, row.detected, row.files]), [["claude", true, 3], ["codex", true, 2], ["gemini", false, 0]]);
    assert.equal(report.index.entries, 0);
    assert.equal(report.index.lastPass, null);
    assert.equal(report.index.bytes, 0);
    assert.equal(report.repo.sessions, 0);
    assert.equal(report.repo.machineSessions, 0);
    assert.equal(report.hooks.scopes.length, 3);
    assert.ok(report.hooks.scopes.every((scope) => scope.installed.length === 0));
    assert.equal(report.server.running, false);
    assert.equal(report.server.stale, false);
    assert.equal(report.watcher.mode, "watch");
    assert.ok(!JSON.stringify(report).includes(fixture.home), "paths are ~-relative");
    await assert.rejects(stat(path.join(fixture.home, ".contextscope", "index")), "status never creates the index");
    const text = renderStatus(report);
    assert.match(text, /vendors\s+claude ~\/\.claude\/projects: 3 files · codex ~\/\.codex\/sessions: 2 files · gemini not found/);
    assert.match(text, /last pass\s+never/);
    assert.match(text, /hooks\s+user no settings file · project no settings file · local no settings file/);
    assert.match(text, /not installed: contextscope hooks install --scope user/);
    assert.match(text, /companion\s+not running/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("status after a pass: entries, bytes, versions, repo sessions, hooks per scope, companion from server.json; no pass runs", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    await index.close?.();
    await writeFile(path.join(fixture.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: "sh -c 'node \"$HOME/.contextscope/bin/capture.mjs\" || true'" }] }] } }));
    await writeServerFile(fixture.home, { pid: process.pid, port: 4321, url: "http://127.0.0.1:4321/", repoRoot: fixture.repo });
    const before = await readFile(path.join(fixture.home, ".contextscope", "index", "v1", "manifest.json"), "utf8");

    const t0 = performance.now();
    const report = await statusReport({ home: fixture.home, repoRoot: fixture.repo, env: {} });
    const ms = performance.now() - t0;
    assert.ok(ms < 300, `status took ${ms.toFixed(0)} ms`);
    assert.equal(await readFile(path.join(fixture.home, ".contextscope", "index", "v1", "manifest.json"), "utf8"), before, "the manifest is untouched: no pass ran");

    assert.equal(report.index.entries, 5);
    assert.ok(report.index.bytes > 0 && report.index.files >= 6, "run files and the manifest are counted");
    assert.equal(report.index.lastPass.parsed, 5);
    assert.equal(report.index.adapterVersions.claude, "claude-test");
    assert.equal(report.repo.sessions, 3, "top-level runs of the repo (the codex child is a subagent)");
    assert.equal(report.repo.subagents, 1);
    assert.equal(report.repo.machineSessions, 4);
    assert.deepEqual(report.repo.sessionsByVendor, { claude: 2, codex: 1 });
    const user = report.hooks.scopes.find((scope) => scope.scope === "user");
    assert.deepEqual(user.installed, ["PreCompact"]);
    assert.equal(report.server.running, true);
    assert.equal(report.server.pid, process.pid);
    assert.equal(report.server.url, "http://127.0.0.1:4321/");
    assert.equal(report.server.repoRoot, "~/work/repo");
    const text = renderStatus(report);
    assert.match(text, /sessions\s+3 in this repo \(claude 2, codex 1\) · 1 subagents · 4 on this machine/);
    assert.match(text, /index\s+~\/\.contextscope\/index\/v1 · 5 entries · .* · adapters claude-test, codex-test/);
    assert.match(text, /hooks\s+user installed: PreCompact/);
    assert.match(text, /companion\s+running · pid \d+ · http:\/\/127\.0\.0\.1:4321\/ · repo ~\/work\/repo/);
    assert.ok(!text.includes(fixture.home));

    // A dead pid is reported as stale, never as running.
    await writeServerFile(fixture.home, { pid: 2 ** 22 - 1, port: 1, url: "http://127.0.0.1:1/", repoRoot: fixture.repo });
    const stale = await statusReport({ home: fixture.home, repoRoot: fixture.repo, env: {} });
    assert.equal(stale.server.running, false);
    assert.equal(stale.server.stale, true);
    assert.match(renderStatus(stale), /companion\s+stale/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("server.json: written 0600 without the token on listen, removed on close, left alone when another pid owns it", async () => {
  const fixture = await makeFixtureHome();
  const app = createServer({ home: fixture.home, repoRoot: fixture.repo, token: "t".repeat(64), adapters: fakeAdapters(), rules: fakeRules(), setup: fakeSetup(), consent: false, autoIndex: false, env: {}, warn: quiet, version: "0.11.0-test" });
  try {
    const { port } = await app.listen(0);
    const file = serverFilePath(fixture.home);
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("t".repeat(64)), "the token is never written");
    const info = JSON.parse(text);
    assert.equal(info.pid, process.pid);
    assert.equal(info.port, port);
    assert.equal(info.url, `http://127.0.0.1:${port}/`);
    assert.equal(info.repoRoot, fixture.repo);
    assert.equal(info.version, "0.11.0-test");
    assert.ok(Number.isFinite(Date.parse(info.startedAt)));
    const read = await readServerFile(fixture.home);
    assert.equal(read.present, true);
    assert.equal(read.alive, true);
    await app.close();
    await assert.rejects(stat(file), "removed on close");
    // Another companion's file survives our close.
    await writeServerFile(fixture.home, { pid: process.pid + 100_000, port: 1, url: "http://127.0.0.1:1/", repoRoot: fixture.repo });
    assert.equal(await removeServerFile(fixture.home), false);
    await stat(file);
    assert.equal(processAlive(0), false);
    assert.equal((await readServerFile(path.join(fixture.home, "nope"))).present, false);
  } finally {
    await app.close().catch(() => {});
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("the watcher capability probe reports watch, poll (when fs.watch throws) or none", async () => {
  const fixture = await makeFixtureHome();
  try {
    const ok = await probeWatchCapability({ home: fixture.home, env: {} });
    assert.equal(ok.mode, "watch");
    assert.equal(ok.dir, path.join(fixture.home, ".claude", "projects"));
    const poll = await probeWatchCapability({ home: fixture.home, env: {}, watchFn: () => { throw Object.assign(new Error("too many"), { code: "EMFILE" }); } });
    assert.equal(poll.mode, "poll");
    assert.equal(poll.reason, "EMFILE");
    const none = await probeWatchCapability({ home: path.join(fixture.home, "empty"), env: {} });
    assert.equal(none.mode, "none");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("status degrades section by section: an unreadable settings file or index dir never fails the command", async () => {
  const fixture = await makeFixtureHome();
  try {
    await mkdir(path.join(fixture.home, ".claude"), { recursive: true });
    await writeFile(path.join(fixture.home, ".claude", "settings.json"), "{ not json");
    await mkdir(path.dirname(serverFilePath(fixture.home)), { recursive: true });
    await writeFile(serverFilePath(fixture.home), "garbage");
    const report = await statusReport({ home: fixture.home, repoRoot: fixture.repo, env: {} });
    assert.ok(report.hooks.scopes.find((scope) => scope.scope === "user").error, "invalid JSON is reported, not thrown");
    assert.equal(report.server.present, undefined);
    assert.equal(report.server.running, false);
    assert.match(renderStatus(report), /user invalid JSON/);
    assert.ok(CLAUDE_SESSIONS.length);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
