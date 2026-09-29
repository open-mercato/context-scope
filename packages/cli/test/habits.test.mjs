/**
 * Habit rules H-01..H-06 (ADR-003 section 2) over synthetic habit records, and
 * the manifest-only guarantee: building /habits never opens a run file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { evaluateHabits, evaluateHabitsDetailed, habitRecordOf, loadHabitRules, mergeHabitRecords } from "../src/rules/habits.mjs";
import { HABITS_VERSION, habitsOf } from "../src/index/entry.mjs";
import { loadThresholds } from "../src/rules/index.mjs";
import { createIndex } from "../src/index/writer.mjs";
import { createAnalysis } from "../src/server/analysis.mjs";
import { fakeAdapters, fakeRules, fakeRun, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};
const thresholds = await loadThresholds({ home: "/nonexistent", onWarning: false });

function record(i, { vendor = "claude", fat = [], fullReads = [], agents = [], compactions = 0, requests = 100, h0 = 10_000, cliVersion = "2.1.0", model = "m", mcp = [], day, parentRunId, v = HABITS_VERSION } = {}) {
  const at = `2026-08-${String(day ?? (1 + i)).padStart(2, "0")}T10:00:00Z`;
  return {
    runId: `${vendor}:s${i}`, vendor, startedAt: at, endedAt: at, activeMs: 1000, cliVersion, requests, compactions, parentRunId,
    habits: { v, fat, fullReads, agents, compaction: { n: compactions, auto: compactions, requests }, startup: { h0, cliVersion, model }, mcp: { invoked: mcp }, peakShare: 0.5, window: 200_000 },
  };
}

const fatRead = (tokens = 9_000, n = 1) => ({ tool: "Read", kind: "file", label: "package-lock.json", tokens: tokens * n, n });
const fatBash = (tokens = 9_000, n = 1) => ({ tool: "Bash", kind: "shell", tokens: tokens * n, n });

test("rule modules load with the habit shape", async () => {
  const rules = await loadHabitRules({ onWarning: (message) => { throw new Error(message); } });
  assert.deepEqual(rules.map((rule) => rule.id), ["H-01", "H-02", "H-03", "H-04", "H-05", "H-06", "H-07"]);
  for (const rule of rules) assert.equal(rule.scope, "habit");
  for (const rule of rules) assert.ok(rule.needs(thresholds) >= 3, `${rule.id} declares the sessions it needs`);
});

test("H-01 fires on the same (tool, label) in ≥ 3 sessions, names tool + label + sessions, and stays quiet below", async () => {
  const records = [record(1, { fat: [fatRead()] }), record(2, { fat: [fatRead(12_000, 2)] }), record(3, { fat: [fatRead()] }), record(4, { fat: [fatBash()] }), record(5, { fat: [fatBash()] })];
  const findings = (await evaluateHabits(records, { thresholds })).filter((f) => f.ruleId === "H-01");
  assert.equal(findings.length, 1, "Bash in 2 sessions does not fire");
  const [finding] = findings;
  assert.equal(finding.scope, "habit");
  assert.equal(finding.sessions, 3);
  assert.equal(finding.title, "Recurring fat result: Read package-lock.json");
  assert.equal(finding.count, 4);
  assert.equal(finding.tokensAffected, 42_000);
  assert.equal(finding.vendor, "claude");
  assert.equal(finding.fix.path, "CLAUDE.md");
  assert.match(finding.fix.snippet, /offset/);
  assert.equal(finding.evidence.filter((e) => e.kind === "run").length, 3);
  assert.equal(finding.evidence[0].kind, "metric");
  assert.match(finding.evidence[0].label, /in 3 sessions/);
  const bashOnly = [record(1, { fat: [fatBash()] }), record(2, { fat: [fatBash()] }), record(3, { fat: [fatBash()] }), record(4, { vendor: "codex", fat: [fatBash()] })];
  const [bash] = await evaluateHabits(bashOnly, { thresholds });
  assert.equal(bash.ruleId, "H-01");
  assert.equal(bash.sessions, 4);
  assert.equal(bash.vendor, "claude", "majority vendor");
  assert.match(bash.fix.snippet, /head -c 8000/);
  const mixed = [record(1, { fat: [fatBash()] }), record(2, { fat: [fatBash()] }), record(3, { vendor: "codex", fat: [fatBash()] }), record(4, { vendor: "codex", fat: [fatBash()] })];
  const [both] = await evaluateHabits(mixed, { thresholds });
  assert.equal(both.vendor, undefined);
  assert.equal(both.fix.platform, "both");
  assert.equal((await evaluateHabits([record(1, { fat: [fatRead()] }), record(2, { fat: [fatRead()] })], { thresholds })).length, 0, "two sessions are not a habit");
  const floor = [record(1, { fat: [fatRead(8_000)] }), record(2, { fat: [fatRead(8_000)] }), record(3, { fat: [fatRead(8_000)] })];
  assert.equal((await evaluateHabits(floor, { thresholds })).filter((f) => f.ruleId === "H-01").length, 0, "three results at the 8k floor (24k) are below habitFatTotalTokens (30k)");
});

test("H-01 groups by tool kind and target, not tool name: codex `exec` web fetches get the web rule, Bash `cat` gets the file rule, fat Write payloads get the writing rule", async () => {
  const web = (tool) => ({ tool, kind: "web", tokens: 12_000, n: 1 });
  const records = [record(1, { vendor: "codex", fat: [web("exec")] }), record(2, { vendor: "codex", fat: [web("exec")] }), record(3, { vendor: "codex", fat: [web("exec")] }), record(4, { fat: [web("WebFetch")] })];
  const [finding] = (await evaluateHabits(records, { thresholds })).filter((f) => f.ruleId === "H-01");
  assert.equal(finding.sessions, 4, "exec web__run and WebFetch are one web habit");
  assert.equal(finding.title, "Recurring fat result: exec (web)");
  assert.match(finding.fix.snippet, /extract only the facts you need/);
  assert.doesNotMatch(finding.fix.snippet, /head -c/);
  assert.equal(finding.fix.path, "AGENTS.md");
  const cat = (label) => ({ tool: "Bash", kind: "file", label, tokens: 11_000, n: 1 });
  const bashFiles = [record(1, { fat: [cat("logs/app.log")] }), record(2, { fat: [cat("logs/app.log")] }), record(3, { fat: [cat("logs/app.log")] }), record(4, { fat: [cat("other.txt")] })];
  const [byTarget] = (await evaluateHabits(bashFiles, { thresholds })).filter((f) => f.ruleId === "H-01");
  assert.equal(byTarget.sessions, 3, "Bash results group by target, not into one shell bucket");
  assert.match(byTarget.fix.snippet, /Read `logs\/app\.log` in ranges/);
  const write = (label) => ({ tool: "Write", kind: "edit", label, tokens: 15_000, n: 1, call: true });
  const calls = [record(1, { fat: [write("src/gen.ts")] }), record(2, { fat: [write("src/gen.ts")] }), record(3, { fat: [write("src/gen.ts")] })];
  const [payload] = (await evaluateHabits(calls, { thresholds })).filter((f) => f.ruleId === "H-01");
  assert.equal(payload.title, "Recurring fat tool call: Write arguments for src/gen.ts");
  assert.match(payload.fix.snippet, /in chunks/);
});

test("H-02 fires when a file is read whole in ≥ 3 sessions above the per-read budget", async () => {
  const read = (tokens, n = 1) => ({ label: "src/big.ts", tokens: tokens * n, n });
  const fire = [record(1, { fullReads: [read(3000)] }), record(2, { fullReads: [read(2500, 2)] }), record(3, { fullReads: [read(4000)] })];
  const [finding] = (await evaluateHabits(fire, { thresholds })).filter((f) => f.ruleId === "H-02");
  assert.ok(finding);
  assert.equal(finding.sessions, 3);
  assert.equal(finding.count, 4);
  assert.equal(finding.tokensAffected, 12_000);
  assert.match(finding.fix.snippet, /src\/big\.ts/);
  const small = [record(1, { fullReads: [read(500)] }), record(2, { fullReads: [read(500)] }), record(3, { fullReads: [read(500)] })];
  assert.equal((await evaluateHabits(small, { thresholds })).filter((f) => f.ruleId === "H-02").length, 0, "small reads do not fire");
  const lock = [record(1, { fullReads: [{ label: "package-lock.json", tokens: 30_000, n: 1 }] }), record(2, { fullReads: [{ label: "package-lock.json", tokens: 30_000, n: 1 }] }), record(3, { fullReads: [{ label: "package-lock.json", tokens: 30_000, n: 1 }] })];
  const [generated] = await evaluateHabits(lock, { thresholds });
  assert.match(generated.fix.snippet, /Never read/);
});

test("H-03 fires on an agent type with fat handoffs across ≥ 3 sessions; fix path from the setup inventory", async () => {
  const explore = (handoffP50, n = 1, ratioP50 = 5) => ({ type: "Explore", n, handoffP50, handoffMax: handoffP50, ratioP50, peakP50: 50_000 });
  const records = [record(1, { agents: [explore(6000)] }), record(2, { agents: [explore(5000, 2)] }), record(3, { agents: [explore(7000)] })];
  const [finding] = await evaluateHabits(records, { thresholds, setup: { agents: [{ name: "Explore", path: ".claude/agents/Explore.md" }] } });
  assert.equal(finding.ruleId, "H-03");
  assert.equal(finding.sessions, 3);
  assert.equal(finding.count, 4);
  assert.equal(finding.fix.path, ".claude/agents/Explore.md");
  assert.equal(finding.tokensAffected, 6000 + 10_000 + 7000);
  const [noFile] = await evaluateHabits(records, { thresholds });
  assert.equal(noFile.fix.path, "CLAUDE.md", "Explore is a built-in agent type: no .claude/agents/Explore.md exists");
  assert.match(noFile.fix.snippet, /When delegating to Explore/);
  const custom = (handoffP50) => ({ type: "reviewer", n: 1, handoffP50, handoffMax: handoffP50, ratioP50: 5, peakP50: 50_000 });
  const [userAgent] = await evaluateHabits([record(1, { agents: [custom(6000)] }), record(2, { agents: [custom(6000)] }), record(3, { agents: [custom(6000)] })], { thresholds });
  assert.equal(userAgent.fix.path, ".claude/agents/reviewer.md", "a user-defined type keeps its definition path");
  const thin = [record(1, { agents: [explore(500)] }), record(2, { agents: [explore(500)] }), record(3, { agents: [explore(500)] })];
  assert.equal((await evaluateHabits(thin, { thresholds })).length, 0);
  const tinyLowRatio = [record(1, { agents: [explore(500, 1, 1.5)] }), record(2, { agents: [explore(500, 1, 1.2)] }), record(3, { agents: [explore(500, 1, 2)] })];
  assert.equal((await evaluateHabits(tinyLowRatio, { thresholds })).length, 0, "a 500-token handoff is not fat whatever its compression");
  const lowRatio = [record(1, { agents: [explore(2500, 1, 1.5)] }), record(2, { agents: [explore(2500, 1, 1.2)] }), record(3, { agents: [explore(2500, 1, 2)] })];
  assert.equal((await evaluateHabits(lowRatio, { thresholds })).length, 1, "compression below 3x fires from half the fat bar");
});

test("H-04: exact ratio of compactions per 1k requests, last 10 sessions vs the previous 10", async () => {
  const previous = Array.from({ length: 10 }, (_, i) => record(i + 1, { requests: 100, compactions: i < 2 ? 1 : 0 })); // 2 / 1000 → 2.0
  const recent = Array.from({ length: 10 }, (_, i) => record(i + 11, { requests: 100, compactions: i < 6 ? 1 : 0 })); // 6 / 1000 → 6.0
  const [finding] = (await evaluateHabits([...previous, ...recent], { thresholds })).filter((f) => f.ruleId === "H-04");
  assert.ok(finding);
  assert.equal(finding.sessions, 10);
  assert.equal(finding.title, "Compaction frequency rising (3.0x)");
  assert.equal(finding.evidence[0].value, 3);
  assert.equal(finding.evidence[0].unit, "ratio");
  assert.equal(finding.count, 6);
  const flat = Array.from({ length: 20 }, (_, i) => record(i + 1, { requests: 100, compactions: i % 3 === 0 ? 1 : 0 }));
  assert.equal((await evaluateHabits(flat, { thresholds })).filter((f) => f.ruleId === "H-04").length, 0);
  const few = Array.from({ length: 20 }, (_, i) => record(i + 1, { requests: 100, compactions: i >= 18 ? 1 : 0 }));
  assert.equal((await evaluateHabits(few, { thresholds })).filter((f) => f.ruleId === "H-04").length, 0, "fewer than 3 recent compactions do not fire");
});

test("H-05: startup cost before/after an instruction edit; suppressed with a note on a CLI-version change", async () => {
  const before = [record(1, { h0: 10_000 }), record(2, { h0: 10_400 }), record(3, { h0: 9_800 })];
  const after = [record(6, { h0: 14_000 }), record(7, { h0: 13_500 }), record(8, { h0: 14_200 })];
  const setup = { instructionFiles: [{ path: "CLAUDE.md", mtime: "2026-08-04T12:00:00Z" }] };
  const { findings, notes } = await evaluateHabitsDetailed([...before, ...after], { thresholds, setup });
  const [finding] = findings.filter((f) => f.ruleId === "H-05");
  assert.ok(finding);
  assert.equal(finding.sessions, 6);
  assert.equal(finding.title, "Startup cost rose 4,000 tok after editing CLAUDE.md");
  assert.equal(finding.fix.path, "CLAUDE.md");
  assert.equal(finding.evidence[0].provenance, "estimated.local");
  assert.equal(finding.evidence[0].value, 4_000);
  assert.equal(notes.length, 0);
  const upgraded = [...before, ...after.map((r) => ({ ...r, cliVersion: "2.2.0", habits: { ...r.habits, startup: { ...r.habits.startup, cliVersion: "2.2.0" } } }))];
  const confounded = await evaluateHabitsDetailed(upgraded, { thresholds, setup });
  assert.equal(confounded.findings.filter((f) => f.ruleId === "H-05").length, 0);
  assert.equal(confounded.notes.length, 1);
  assert.match(confounded.notes[0].reason, /confounded by a CLI upgrade/);
  const down = [...before.map((r) => ({ ...r, habits: { ...r.habits, startup: { ...r.habits.startup, h0: 20_000 } } })), ...after];
  const [fell] = (await evaluateHabits(down, { thresholds, setup })).filter((f) => f.ruleId === "H-05");
  assert.match(fell.title, /fell/);
  assert.match(fell.fix.summary, /Keep the change/);
  const tiny = [...before, ...after.map((r) => ({ ...r, habits: { ...r.habits, startup: { ...r.habits.startup, h0: 10_500 } } }))];
  assert.equal((await evaluateHabits(tiny, { thresholds, setup })).filter((f) => f.ruleId === "H-05").length, 0, "|Δ| below max(1000, 15%) is silent");
});

test("H-06: a configured MCP server with no call in ≥ 5 sessions; quiet when any session used it or the population is small", async () => {
  const setup = { mcpServers: [{ name: "github", scope: "user", vendor: "claude" }, { name: "linear", scope: "project", vendor: "claude" }] };
  const records = Array.from({ length: 6 }, (_, i) => record(i + 1, { mcp: i === 0 ? ["linear"] : [] }));
  const findings = (await evaluateHabits(records, { thresholds, setup })).filter((f) => f.ruleId === "H-06");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, "MCP server never invoked: github");
  assert.equal(findings[0].sessions, 6);
  assert.equal(findings[0].evidence.filter((e) => e.kind === "run").length, 5);
  assert.equal(findings[0].fix.path, "~/.claude.json", "a user-scope server is removed with claude mcp remove, not disabledMcpjsonServers");
  assert.equal(findings[0].fix.snippet, "claude mcp remove -s user github");
  const projectOnly = { mcpServers: [{ name: "linear", scope: "project", vendor: "claude" }] };
  const [project] = await evaluateHabits(records.map((r) => ({ ...r, habits: { ...r.habits, mcp: { invoked: [] } } })), { thresholds, setup: projectOnly });
  assert.equal(project.fix.path, ".claude/settings.local.json", "a .mcp.json server is disabled with disabledMcpjsonServers");
  assert.match(project.fix.snippet, /disabledMcpjsonServers/);
  const { notes } = await evaluateHabitsDetailed(records.slice(0, 4), { thresholds, setup });
  assert.equal((await evaluateHabits(records.slice(0, 4), { thresholds, setup })).filter((f) => f.ruleId === "H-06").length, 0);
  assert.deepEqual(notes.filter((n) => n.ruleId === "H-06").map((n) => n.reason), ["needs 5 sessions, this repo has 4"], "a starved rule says so");
});

test("H-07: the same file read whole in >= 3 sessions (between the re-read floor and H-02's per-read bar); docs get a summary fix; generated files skipped", async () => {
  const read = (label, tokens = 1_200) => ({ label, tokens, n: 1 });
  const fire = [record(1, { fullReads: [read("docs/adr-001.md")] }), record(2, { fullReads: [read("docs/adr-001.md")] }), record(3, { fullReads: [read("docs/adr-001.md")] })];
  const findings = await evaluateHabits(fire, { thresholds });
  const [h07] = findings.filter((f) => f.ruleId === "H-07");
  assert.ok(h07, `H-07 fires: ${findings.map((f) => f.ruleId)}`);
  assert.equal(h07.sessions, 3);
  assert.equal(h07.severity, "low");
  assert.equal(h07.fix.path, "CLAUDE.md");
  assert.match(h07.fix.summary, /Summarise .* docs\/adr-001\.md .* auto-memory/);
  assert.match(h07.fix.snippet, /docs\/adr-001\.md/);
  assert.equal(findings.filter((f) => f.ruleId === "H-02").length, 0, "1.2k per read is below H-02's bar");
  const big = [record(1, { fullReads: [read("src/big.ts", 3000)] }), record(2, { fullReads: [read("src/big.ts", 3000)] }), record(3, { fullReads: [read("src/big.ts", 3000)] })];
  const bigFindings = await evaluateHabits(big, { thresholds });
  assert.equal(bigFindings.filter((f) => f.ruleId === "H-07").length, 0, "big reads are H-02's case");
  assert.equal(bigFindings.filter((f) => f.ruleId === "H-02").length, 1);
  const tiny = [record(1, { fullReads: [read("package.json", 200)] }), record(2, { fullReads: [read("package.json", 200)] }), record(3, { fullReads: [read("package.json", 200)] })];
  assert.equal((await evaluateHabits(tiny, { thresholds })).length, 0, "tiny files are cheap to re-read");
  const lock = [record(1, { fullReads: [read("package-lock.json")] }), record(2, { fullReads: [read("package-lock.json")] }), record(3, { fullReads: [read("package-lock.json")] })];
  assert.equal((await evaluateHabits(lock, { thresholds })).filter((f) => f.ruleId === "H-07").length, 0, "generated files skipped");
  assert.equal((await evaluateHabits(fire.slice(0, 2), { thresholds })).length, 0);
});

test("population: child records merge into their root (fat, full reads, agents, compactions, mcp); sessions = roots; stale records noted", async () => {
  const root = record(1, { vendor: "codex", fat: [fatBash(9_000)], fullReads: [{ label: "a.md", tokens: 1_000, n: 1 }], agents: [{ type: "worker", n: 1, handoffP50: 5000, handoffMax: 5000, ratioP50: 4, peakP50: 40_000 }], compactions: 1, requests: 100, mcp: ["github"] });
  const child = { ...record(2, { vendor: "codex", fat: [fatBash(9_000), fatRead(9_000)], fullReads: [{ label: "a.md", tokens: 1_200, n: 1 }], agents: [{ type: "worker", n: 1, handoffP50: 7000, handoffMax: 7000, ratioP50: 2, peakP50: 60_000 }], compactions: 2, requests: 50, mcp: ["linear"], parentRunId: "codex:s1" }) };
  const grandchild = { ...record(3, { vendor: "codex", fat: [fatBash(9_000)], compactions: 1, requests: 10, parentRunId: "codex:s2", v: 1 }) };
  const merged = mergeHabitRecords(root, [child, grandchild]);
  assert.equal(merged.runId, "codex:s1");
  assert.equal(merged.subagentRuns, 2);
  assert.equal(merged.requests, 160);
  assert.equal(merged.compactions, 4);
  assert.equal(merged.habits.compaction.n, 4);
  assert.deepEqual(merged.habits.fat.map((f) => [f.kind, f.label, f.tokens, f.n]), [["shell", undefined, 27_000, 3], ["file", "package-lock.json", 9_000, 1]]);
  assert.deepEqual(merged.habits.fullReads, [{ label: "a.md", tokens: 2_200, n: 2 }]);
  assert.deepEqual(merged.habits.agents.map((a) => [a.type, a.n, a.handoffP50, a.handoffMax]), [["worker", 2, 6000, 7000]]);
  assert.deepEqual(merged.habits.mcp.invoked, ["github", "linear"]);
  assert.equal(merged.stale, true, "a stale descendant marks the merged record");
  const others = [record(4), record(5), record(6)];
  const { findings, notes, sessions, subagentRuns, stale } = await evaluateHabitsDetailed([root, child, grandchild, ...others], { thresholds });
  assert.equal(sessions, 4, "1 root with 2 descendants + 3 plain sessions");
  assert.equal(subagentRuns, 2);
  assert.equal(stale, 1);
  assert.ok(notes.some((n) => n.kind === "stale" && /older habits version/.test(n.reason)));
  assert.equal(findings.filter((f) => f.ruleId === "H-01").length, 0, "the shell habit is one session (27k in a root + children), not three");
  // Root resolution through the caller's `rootOf` (the whole manifest) when the records are manifest entries.
  const entries = [root, child, grandchild].map((r) => ({ runId: r.runId, vendor: r.vendor, startedAt: r.startedAt, endedAt: r.endedAt, summary: { requests: r.requests, compactions: r.compactions }, habits: r.habits, parentThreadId: r.parentRunId?.slice(6) }));
  const resolved = await evaluateHabitsDetailed(entries, { thresholds, rootOf: () => "codex:s1" });
  assert.equal(resolved.sessions, 1);
  assert.equal(resolved.subagentRuns, 2);
  const orphan = await evaluateHabitsDetailed([child, grandchild], { thresholds });
  assert.equal(orphan.sessions, 1, "a child whose parent is not indexed is the best top-level run we have; its own child folds into it");
});

test("habitsOf: bounded record from a Run (fat by tool+label, full reads by target, agents, startup, mcp) under 1.5 KB", () => {
  const run = fakeRun("/x/11111111-1111-4111-8111-111111111111.jsonl", "claude");
  run.scopes[0].blocks.push(
    { id: "main:90", seq: 90, at: "2026-09-01T10:00:00Z", category: "tool_result.file", bytes: 40_000, estTokens: 10_000, firstRequest: 1, hash: "h90", tool: { name: "Read", kind: "file", argsHash: "r1", target: "docs/big.md" }, label: "docs/big.md" },
    { id: "main:91", seq: 91, at: "2026-09-01T10:00:00Z", category: "tool_result.file", bytes: 4_000, estTokens: 1_000, firstRequest: 1, hash: "h91", tool: { name: "Read", kind: "file", argsHash: "r2", target: "docs/big.md", partial: true }, label: "docs/big.md" },
  );
  const habits = habitsOf(run, { fatToolResultTokens: 8000 });
  assert.equal(habits.v, HABITS_VERSION);
  assert.deepEqual(habits.fat.map((f) => [f.tool, f.kind, f.label, f.tokens, f.n]), [[ "Read", "file", "docs/big.md", 10_000, 1 ], ["Read", "file", "src/index.mjs", 9_000, 1]]);
  run.scopes[0].blocks.push({ id: "main:92", seq: 92, at: "2026-09-01T10:00:00Z", category: "tool_call", bytes: 48_000, estTokens: 12_000, firstRequest: 2, hash: "h92", tool: { name: "Write", kind: "edit", argsHash: "w1", target: "src/gen.ts" }, label: "src/gen.ts" });
  const withCall = habitsOf(run, { fatToolResultTokens: 8000 });
  assert.deepEqual(withCall.fat.find((f) => f.call), { tool: "Write", kind: "edit", label: "src/gen.ts", tokens: 12_000, n: 1, call: true }, "fat tool-call payloads are recorded with call: true");
  assert.deepEqual(habits.fullReads, [{ label: "docs/big.md", tokens: 10_000, n: 1 }], "the partial read and the target-less fixture read do not count as full reads");
  assert.equal(habits.agents[0].type, "Explore");
  assert.equal(habits.agents[0].handoffP50, 3_000);
  assert.deepEqual(habits.mcp.invoked, ["github"]);
  assert.equal(habits.startup.h0 > 0, true);
  assert.equal(habits.compaction.n, 0);
  assert.ok(JSON.stringify(habits).length < 1500, `habits record is ${JSON.stringify(habits).length} bytes`);
  const projected = habitRecordOf({ runId: run.id, vendor: "claude", startedAt: "2026-09-01T10:00:00Z", summary: { requests: 3, compactions: 0 }, habits });
  assert.equal(projected.requests, 3);
  assert.equal(habitRecordOf({ runId: "x", error: "boom" }), null);
});

test("manifest-only proof: /habits and the overview open no run file (fs spy + stubbed readers)", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const opened = [];
    for (const method of ["readRunShell", "readScope", "readRun", "readRunResponse", "readFindings"]) {
      index[method] = async (...args) => { opened.push([method, ...args]); throw new Error(`${method} must not be called while building habits`); };
    }
    const analysis = createAnalysis({ index, home: fixture.home, repoRoot: fixture.repo, rules: fakeRules(), setup: fakeSetup(), warn: quiet });
    const habits = await analysis.habits({});
    assert.deepEqual(opened, []);
    assert.equal(index.stats.runFilesOpened, 0);
    assert.equal(habits.sessions, 3, "the repo's sessions all time: 2 claude + the codex parent (its child is a subagent)");
    assert.equal(habits.evaluated, 3);
    assert.equal(habits.findings.length, 1);
    assert.equal(habits.findings[0].ruleId, "H-01");
    assert.equal(habits.findings[0].sessions, 3);
    assert.equal(habits.findings[0].recurrence, 3, "leverage input");
    assert.ok(habits.notes.some((n) => n.ruleId === "H-04" && n.kind === "starved" && n.reason === "needs 6 sessions, this repo has 3"), JSON.stringify(habits.notes));
    assert.ok(Array.isArray(habits.trends.sessions) && habits.trends.sessions.length === 30);
    assert.ok(Array.isArray(habits.trends.instructionEdits));
    assert.ok(!JSON.stringify(habits).includes(fixture.home));
    const overview = await analysis.overview({});
    assert.deepEqual(opened, []);
    assert.equal(overview.firstFinding.ruleId, "H-01");
    const habitFindings = await analysis.findings({ scope: "habit" });
    assert.equal(habitFindings.findings.length, 1);
    assert.equal(habitFindings.groups[0].scope, "habit");
    assert.deepEqual(opened, []);
    await assert.rejects(analysis.findings({ scope: "nope" }), /habit/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("PUT thresholds re-evaluates the index: saveThresholds writes the file, schedules ensure() and answers { thresholds, reevaluating: true }", async () => {
  const fixture = await makeFixtureHome();
  try {
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
    await index.ensure();
    const calls = [];
    const original = index.ensure;
    let resolveEnsure;
    const pending = new Promise((resolve) => { resolveEnsure = resolve; });
    index.ensure = async (options) => { calls.push(options); const result = await original.call(index, options); resolveEnsure(result); return result; };
    const analysis = createAnalysis({ index, home: fixture.home, repoRoot: fixture.repo, rules: fakeRules(), setup: fakeSetup(), warn: quiet });
    const response = await analysis.saveThresholds({ fatToolResultTokens: 9500 });
    assert.equal(response.reevaluating, true);
    assert.ok(response.thresholds && typeof response.thresholds === "object", "the response wraps the thresholds");
    const written = JSON.parse(await readFile(path.join(fixture.home, ".contextscope", "thresholds.json"), "utf8"));
    assert.equal(written.fatToolResultTokens, 9500);
    await pending;
    assert.deepEqual(calls, [{ force: false }], "one pass without forcing a re-parse");
    await original.call(index);
  } finally {
    await rm(fixture.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
