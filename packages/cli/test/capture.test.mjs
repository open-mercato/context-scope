/**
 * Capture script (template), reader, join and the inventory's observed.loaded
 * path. The script is written to a temp file and run with a temp HOME.
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CAPTURE_EVENTS, CAPTURE_SCRIPT } from "../src/capture/template.mjs";
import { captureStats, parseCaptureText, readCaptureRecords, readRecentCaptureRecords } from "../src/capture/reader.mjs";
import { agentIdCandidates, joinCapture } from "../src/capture/join.mjs";
import { finalizeRun, refinalizeRun } from "../src/ir/finalize.mjs";
import { wasObserved } from "../src/setup/instructions.mjs";
import { resolveObservedFile } from "../src/setup/inventory.mjs";
import { projectKeyFor, claudeProjectDirFor } from "../src/ir/project.mjs";
import { buildSetupInventory } from "../src/setup/inventory.mjs";

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "capture");
const SESSION = "11111111-1111-4111-8111-111111111111";

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-capture-"));
  const cwd = path.join(home, "work", "repo");
  await mkdir(cwd, { recursive: true });
  const script = path.join(home, "capture.mjs");
  await writeFile(script, CAPTURE_SCRIPT, { mode: 0o700 });
  return { home, cwd, script, encoded: claudeProjectDirFor(cwd) };
}

async function payload(name, { home, cwd, encoded }) {
  const text = await readFile(path.join(FIXTURES, `${name}.json`), "utf8");
  return text.replaceAll("$HOME", home).replaceAll("$CWD", cwd).replaceAll("$ENCODED", encoded);
}

function runScript(ctx, input, extra = {}) {
  return new Promise((resolve) => {
    const child = execFileCb(process.execPath, [ctx.script], { env: { ...process.env, HOME: ctx.home }, ...extra }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    // The script stops reading past its stdin cap and exits, so a large write can hit EPIPE: that is the behaviour under test.
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function records(ctx) {
  return readCaptureRecords({ home: ctx.home, sessionId: SESSION });
}

test("capture script: every event yields one whitelisted record without absolute paths or prompt fields", async () => {
  const ctx = await makeHome();
  for (const event of CAPTURE_EVENTS) {
    const result = await runScript(ctx, await payload(event, ctx));
    assert.equal(result.code, 0, `${event} exits 0`);
  }
  const file = path.join(ctx.home, ".contextscope", "capture", `${SESSION}.jsonl`);
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes("NEVER-STORE"), "dropped prompt/summary/message fields");
  assert.ok(!text.includes(ctx.home), "no absolute home path");
  assert.ok(!text.includes(ctx.encoded), "no encoded project directory");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);

  const list = await records(ctx);
  assert.deepEqual(list.map((record) => record.event), CAPTURE_EVENTS);
  const by = Object.fromEntries(list.map((record) => [record.event, record]));
  const key = projectKeyFor(ctx.cwd);
  for (const record of list) {
    assert.equal(record.v, 1);
    assert.equal(record.sessionId, SESSION);
    assert.equal(record.cwdKey, key);
    assert.equal(record.transcript, `~/.claude/projects/${key}/${SESSION}.jsonl`);
    assert.ok(Number.isFinite(Date.parse(record.at)));
    for (const value of Object.values(record)) assert.ok(typeof value !== "string" || !path.isAbsolute(value), `no absolute value: ${value}`);
  }
  assert.equal(by.InstructionsLoaded.file, ".claude/rules/security.md");
  assert.equal(by.InstructionsLoaded.loadReason, "session_start");
  assert.equal(by.InstructionsLoaded.memoryType, "project");
  assert.equal(by.SessionStart.source, "startup");
  assert.equal(by.PreCompact.trigger, "auto");
  assert.equal(by.PostCompact.trigger, "auto");
  assert.equal(by.SubagentStart.agentId, "a1ee861386cb26b5b");
  assert.equal(by.SubagentStart.agentType, "Explore");
  assert.equal(by.SubagentStop.agentTranscript, `~/.claude/projects/${key}/${SESSION}/subagents/agent-a1ee861386cb26b5b.jsonl`);
  assert.equal(by.SubagentStop.last_assistant_message, undefined);
});

test("capture script: unknown events, malformed input and missing stdin write nothing and exit 0", async () => {
  const ctx = await makeHome();
  assert.equal((await runScript(ctx, await payload("PreToolUse", ctx))).code, 0);
  assert.equal((await runScript(ctx, "not json at all")).code, 0);
  assert.equal((await runScript(ctx, "")).code, 0);
  assert.equal((await runScript(ctx, JSON.stringify({ hook_event_name: "InstructionsLoaded", session_id: "../../etc/passwd", cwd: ctx.cwd, file_path: "/x" }))).code, 0);
  assert.equal((await runScript(ctx, undefined, { stdio: ["ignore", "pipe", "pipe"] })).code, 0);
  let entries = [];
  try { entries = await readdir(path.join(ctx.home, ".contextscope", "capture")); } catch {}
  assert.deepEqual(entries, []);
});

test("capture script: paths outside cwd and home become a basename; a large stdin is capped", async () => {
  const ctx = await makeHome();
  const big = { hook_event_name: "InstructionsLoaded", session_id: SESSION, cwd: ctx.cwd, transcript_path: "/elsewhere/t.jsonl", file_path: "/etc/CLAUDE.md", reason: "include", padding: "p".repeat(300 * 1024) };
  assert.equal((await runScript(ctx, JSON.stringify(big))).code, 0);
  assert.equal((await records(ctx)).length, 0, "over-size payload is dropped");
  delete big.padding;
  assert.equal((await runScript(ctx, JSON.stringify(big))).code, 0);
  const [record] = await records(ctx);
  assert.equal(record.file, "CLAUDE.md");
  assert.equal(record.transcript, "t.jsonl");
});

test("reader: malformed lines and foreign shapes are skipped; bounds hold", () => {
  const good = JSON.stringify({ v: 1, at: "2026-09-01T10:00:00Z", event: "SessionStart", sessionId: SESSION, cwdKey: "k", transcript: "", source: "startup", extra: "dropped" });
  const text = [good, "{not json", JSON.stringify({ v: 2, event: "x" }), JSON.stringify({ v: 1, at: "nope", event: "x", sessionId: SESSION }), "x".repeat(5000), good].join("\n");
  const parsed = parseCaptureText(text);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.malformed, 4);
  assert.equal(parsed.records[0].extra, undefined);
  assert.equal(parseCaptureText(text, { limit: 1 }).records.length, 1);
});

function fixtureRun() {
  const request = (index, at) => ({ index, at, model: "m", turn: 1, usage: { input: 100, cacheCreation: 0, cacheRead: 0, output: 10, total: 110 } });
  return {
    id: `claude:${SESSION}`, vendor: "claude", sessionId: SESSION,
    project: { key: "repo-00000000", displayName: "repo", cwdHash: "c".repeat(8) },
    coverage: { records: 3 },
    scopes: [
      { id: "main", kind: "main", depth: 0, status: "completed", requests: [request(0, "2026-09-01T10:00:00Z"), request(1, "2026-09-01T10:05:00Z")], blocks: [], compactions: [{ id: "main:c0", at: "2026-09-01T10:04:00Z", atRequest: 1, trigger: "unknown", preTokens: { value: 100, provenance: "observed.vendor" }, postTokens: { value: 10, provenance: "observed.vendor" }, droppedTokens: { value: 90, provenance: "derived.exact" } }] },
      { id: "a1ee861386cb26b5b", kind: "subagent", depth: 1, parentScopeId: "main", status: "open", requests: [request(0, "2026-09-01T10:02:00Z")], blocks: [], compactions: [] },
    ],
  };
}

function record(event, at, extra = {}) {
  return { v: 1, at, event, sessionId: SESSION, cwdKey: "repo-00000000", transcript: "", ...extra };
}

test("join: instruction files, compaction confirmation and subagent timing land on the run", () => {
  const run = fixtureRun();
  joinCapture(run, [
    record("SessionStart", "2026-09-01T09:59:59Z", { source: "startup" }),
    record("InstructionsLoaded", "2026-09-01T10:00:00Z", { file: "CLAUDE.md", loadReason: "session_start" }),
    record("InstructionsLoaded", "2026-09-01T10:00:00Z", { file: ".claude/rules/security.md", loadReason: "session_start" }),
    record("InstructionsLoaded", "2026-09-01T10:00:01Z", { file: "CLAUDE.md", loadReason: "compact" }),
    record("SubagentStart", "2026-09-01T10:01:30Z", { agentId: "agent-a1ee861386cb26b5b", agentType: "Explore" }),
    record("PreCompact", "2026-09-01T10:03:50Z", { trigger: "auto" }),
    record("PostCompact", "2026-09-01T10:04:05Z", { trigger: "auto" }),
    record("SubagentStop", "2026-09-01T10:03:00Z", { agentId: "a1ee861386cb26b5b", agentType: "Explore" }),
    record("PostCompact", "2026-09-01T12:00:00Z", { trigger: "manual" }), // no compaction near it
    record("SubagentStop", "2026-09-01T10:03:00Z", { agentId: "unknown-agent" }),
    { ...record("InstructionsLoaded", "2026-09-01T10:00:00Z", { file: "OTHER.md" }), sessionId: "other-session" },
  ]);
  assert.deepEqual(run.instructionFilesObserved, ["CLAUDE.md", ".claude/rules/security.md"]);
  const [main, child] = run.scopes;
  assert.equal(main.compactions[0].hookObserved, true);
  assert.equal(main.compactions[0].trigger, "auto");
  assert.equal(child.launchedAt, "2026-09-01T10:01:30Z");
  assert.equal(child.deliveredAt, "2026-09-01T10:03:00Z");
  assert.equal(child.status, "completed");
  assert.equal(child.agentType, "Explore");
  assert.deepEqual(child.capture, { records: 2 });
  assert.equal(main.capture.records, 8);
  assert.deepEqual(run.coverage.capture, { records: 10, unmatchedCompactions: 1, unmatchedAgents: 1, applied: 6 });
});

test("join: a subagent record resolves through the transcript basename when agent_id does not match", () => {
  const run = fixtureRun();
  joinCapture(run, [
    record("SubagentStop", "2026-09-01T10:03:00Z", { agentId: "toolu_01XYZ", agentType: "Explore", agentTranscript: `~/.claude/projects/repo-00000000/${SESSION}/subagents/agent-a1ee861386cb26b5b.jsonl` }),
  ]);
  const child = run.scopes[1];
  assert.equal(child.status, "completed");
  assert.equal(child.deliveredAt, "2026-09-01T10:03:00Z");
  assert.equal(run.coverage.capture.unmatchedAgents, 0);
  assert.deepEqual(agentIdCandidates({ agentId: "agent-abc" }), ["agent-abc", "abc"]);
  assert.deepEqual(agentIdCandidates({ agentTranscript: "x/agent-abc.jsonl" }), ["agent-abc", "abc"]);
  assert.deepEqual(agentIdCandidates({}), []);
});

test("join before the summary: a joined trigger reaches the forecast's auto-compaction filter after refinalizeRun", () => {
  const request = (index, total) => ({ index, at: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`, model: "m", turn: 1, usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 1, total } });
  const run = {
    id: `claude:${SESSION}`, vendor: "claude", sessionId: SESSION, project: { key: "k", displayName: "repo", cwdHash: "c" }, startedAt: "", endedAt: "", activeMs: 0,
    window: { value: 1_000_000, provenance: "estimated.local" }, coverage: { records: 1 }, source: { file: "x", bytes: 1, mtimeMs: 1, subagentFiles: 0 },
    scopes: [{
      id: "main", kind: "main", depth: 0, status: "completed", blocks: [],
      requests: [...Array.from({ length: 5 }, (_, i) => request(i, 900_000 + i * 10_000)), ...Array.from({ length: 12 }, (_, i) => request(5 + i, 100_000 + i * 8_000))],
      compactions: [{ id: "main:c0", at: "2026-09-01T10:04:30Z", atRequest: 5, trigger: "unknown", preTokens: { value: 950_000, provenance: "observed.vendor" }, postTokens: { value: 100_000, provenance: "observed.vendor" }, droppedTokens: { value: 850_000, provenance: "derived.exact" } }],
    }],
  };
  finalizeRun(run);
  assert.equal(run.scopes[0].forecast.threshold.basis.kind, "calibration", "unknown trigger: calibrated threshold");
  joinCapture(run, [record("PostCompact", "2026-09-01T10:04:40Z", { trigger: "auto" })]);
  assert.equal(run.coverage.capture.applied, 2);
  refinalizeRun(run);
  assert.equal(run.scopes[0].forecast.threshold.basis.kind, "own-compactions", "the joined auto trigger now sets the threshold");
  assert.equal(run.scopes[0].forecast.threshold.value, 950_000);
  assert.equal(run.summary.compactions, 1);
});

test("join: no records or no matching session leaves the run untouched", () => {
  const run = fixtureRun();
  const before = JSON.stringify(run);
  joinCapture(run, []);
  joinCapture(run, [{ ...record("PostCompact", "2026-09-01T10:04:00Z", { trigger: "auto" }), sessionId: "zzz" }]);
  assert.equal(JSON.stringify(run), before);
});

test("inventory: InstructionsLoaded capture records mark files observed.loaded and the budget observed.artifact", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-inv-"));
  const repo = path.join(home, "work", "repo");
  await mkdir(path.join(repo, ".claude", "rules"), { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(path.join(repo, "CLAUDE.md"), "# Repo\n\nConventions in prose.\n");
  await writeFile(path.join(repo, "CLAUDE.local.md"), "# Local\n\nNever loaded in practice.\n");
  await writeFile(path.join(repo, ".claude", "rules", "api.md"), "# API\n\nRules for the api.\n");
  const key = projectKeyFor(await realpath(repo));
  const captureDir = path.join(home, ".contextscope", "capture");
  await mkdir(captureDir, { recursive: true });
  const lines = [
    record("InstructionsLoaded", "2026-09-01T10:00:00Z", { cwdKey: key, file: "CLAUDE.md", loadReason: "session_start" }),
    record("InstructionsLoaded", "2026-09-01T10:00:00Z", { cwdKey: key, file: ".claude/rules/api.md", loadReason: "session_start" }),
    record("InstructionsLoaded", "2026-09-01T10:00:00Z", { cwdKey: "other-11111111", file: "CLAUDE.local.md" }),
  ];
  await writeFile(path.join(captureDir, `${SESSION}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const recent = await readRecentCaptureRecords({ home, cwdKey: key, events: ["InstructionsLoaded"] });
  assert.equal(recent.length, 2);
  const stats = await captureStats({ home });
  assert.equal(stats.files, 1);
  assert.equal(stats.byEvent.InstructionsLoaded, 3);

  const inventory = await buildSetupInventory({ repoRoot: repo, home });
  const byPath = Object.fromEntries(inventory.instructionFiles.map((file) => [file.path, file]));
  assert.equal(byPath["CLAUDE.md"].loadState, "observed.loaded");
  assert.equal(byPath[".claude/rules/api.md"].loadState, "observed.loaded");
  assert.equal(byPath["CLAUDE.local.md"].loadState, "expected.load", "another repo's record does not count");
  // CLAUDE.local.md is expected and unobserved: the chain is only partly observed, so the budget stays an estimate.
  assert.equal(inventory.startupBudget.claude.instructions.provenance, "estimated.local");
  assert.equal(inventory.startupBudget.claude.instructions.value, byPath["CLAUDE.md"].estTokens + byPath[".claude/rules/api.md"].estTokens + byPath["CLAUDE.local.md"].estTokens);

  // A session launched in a subdirectory (cwdKey of packages/cli) counts for the repo; its files resolve against that directory.
  await mkdir(path.join(repo, "packages", "cli"), { recursive: true });
  await writeFile(path.join(repo, "packages", "cli", "CLAUDE.md"), "# CLI\n\nNested guidance for the cli.\n");
  const subKey = projectKeyFor(await realpath(path.join(repo, "packages", "cli")));
  const more = [
    record("InstructionsLoaded", "2026-09-01T11:00:00Z", { cwdKey: subKey, file: `~/${path.relative(home, path.join(repo, "CLAUDE.local.md")).split(path.sep).join("/")}`, loadReason: "session_start" }),
    record("InstructionsLoaded", "2026-09-01T11:00:00Z", { cwdKey: subKey, file: "CLAUDE.md", loadReason: "session_start" }),
  ];
  await writeFile(path.join(captureDir, "22222222-2222-4222-8222-222222222222.jsonl"), more.map((line) => JSON.stringify({ ...line, sessionId: "22222222-2222-4222-8222-222222222222" })).join("\n") + "\n");
  const whole = await buildSetupInventory({ repoRoot: repo, home });
  const wholeBy = Object.fromEntries(whole.instructionFiles.map((file) => [file.path, file]));
  assert.equal(wholeBy["CLAUDE.local.md"].loadState, "observed.loaded", "a ~/ record from a descendant cwd names the root file");
  assert.equal(wholeBy["packages/cli/CLAUDE.md"].loadState, "observed.loaded", "`CLAUDE.md` recorded from packages/cli is the nested file");
  assert.equal(wholeBy["CLAUDE.md"].loadState, "observed.loaded");
  assert.equal(whole.startupBudget.claude.instructions.provenance, "observed.artifact", "the whole expected chain is observed");
  assert.equal(whole.startupBudget.claude.instructions.value, whole.instructionFiles.filter((file) => file.vendors.includes("claude") && file.loadState === "observed.loaded").reduce((sum, file) => sum + file.estTokens, 0));

  const silent = await buildSetupInventory({ repoRoot: repo, home, capture: false });
  assert.equal(silent.instructionFiles.find((file) => file.path === "CLAUDE.md").loadState, "expected.load");
  assert.equal(silent.startupBudget.claude.instructions.provenance, "estimated.local");
});

test("observed.loaded is exact: a user-level or nested CLAUDE.md never marks the root file", () => {
  const home = "/h";
  const abs = "/h/work/repo/CLAUDE.md";
  assert.equal(wasObserved(new Set(["~/.claude/CLAUDE.md"]), "CLAUDE.md", abs, { home }), false);
  assert.equal(wasObserved(new Set(["packages/api/CLAUDE.md"]), "CLAUDE.md", abs, { home }), false);
  assert.equal(wasObserved(new Set(["CLAUDE.md"]), "CLAUDE.md", abs, { home }), true);
  assert.equal(wasObserved(new Set(["~/work/repo/CLAUDE.md"]), "CLAUDE.md", abs, { home }), true, "the ~/ form of the absolute path");
  assert.equal(wasObserved(new Set([abs]), "CLAUDE.md", abs, { home }), true);
  assert.equal(wasObserved(new Set(["~/.claude/CLAUDE.md"]), "~/.claude/CLAUDE.md", "/h/.claude/CLAUDE.md", { home }), true);
  assert.equal(resolveObservedFile("CLAUDE.md", { dir: "/h/work/repo/packages/cli", repoRoot: "/h/work/repo" }), "packages/cli/CLAUDE.md");
  assert.equal(resolveObservedFile("../../CLAUDE.md", { dir: "/h/work/repo/packages/cli", repoRoot: "/h/work/repo" }), "CLAUDE.md");
  assert.equal(resolveObservedFile("../../../elsewhere/CLAUDE.md", { dir: "/h/work/repo/packages/cli", repoRoot: "/h/work/repo" }), null);
  assert.equal(resolveObservedFile("~/.claude/CLAUDE.md", { dir: "/h/work/repo", repoRoot: "/h/work/repo" }), "~/.claude/CLAUDE.md");
});
