/**
 * `contextscope experiment` (ADR-005 §3): snapshot fields and the refusal on
 * an unchanged chain; assignment by time; `verified` from a Codex entry whose
 * instructions hash matches; the markdown's observational sentence; nothing
 * absolute in the stored file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "../src/commands/args.mjs";
import { run as experiment } from "../src/commands/experiment.mjs";
import { assertName, buildSnapshot, chainDiff, experimentFile, loadExperiment, sameChain, sha1 } from "../src/experiment/snapshot.mjs";
import { assignSessions, compareExperiment, verificationOf } from "../src/experiment/compare.mjs";
import { OBSERVATIONAL_SENTENCE, renderCompareMarkdown } from "../src/experiment/markdown.mjs";
import { projectKeyFor } from "../src/adapters/discover.mjs";

const NOW = "2026-09-02T12:00:00Z";

function root(id, startedAt, { vendor = "claude", h0 = 10_000, model = "m", cli = "2.1.0", instructionHash, nestedHashes, cwd } = {}) {
  return {
    runId: `${vendor}:${id}`, sessionId: id, vendor, startedAt, endedAt: startedAt, activeMs: 3_600_000, cliVersion: cli, cwd, cwdKind: "repo", cwdReversible: true, projectKey: "k",
    summary: { requests: 5, processedInputTokens: 50_000, compactions: 0, peakShareOfWindow: 0.4, findingIds: [] }, findingHeads: [], stats: { instructionFilesObserved: [], codexInstructionChars: 0 },
    habits: { v: 1, fat: [], fullReads: [], agents: [], compaction: { n: 0 }, startup: { h0, model, cliVersion: cli }, mcp: { invoked: [] }, peakShare: 0.4 },
    ...(instructionHash ? { instructionHash } : {}), ...(nestedHashes ? { nestedHashes } : {}),
  };
}

async function tempRepo() {
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-exp-home-"));
  const repo = path.join(home, "work", "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "AGENTS.md"), "# Agents\nRead less.\n");
  await writeFile(path.join(repo, "CLAUDE.md"), "# Claude\nUse sed -n.\n");
  return { home, repo };
}

function inventoryOf(repo, files = ["AGENTS.md", "CLAUDE.md"]) {
  return {
    repo: { name: path.basename(repo), root: "cwd", git: false }, vendorsDetected: ["claude", "codex"],
    instructionFiles: files.map((p, i) => ({ path: p, scope: "project", vendors: p.startsWith("AGENTS") ? ["codex", "claude"] : ["claude"], bytes: 1, estTokens: 1, precedence: i + 1, mtime: NOW, loadState: "expected.load", brokenRefs: [] })),
    skills: [], agents: [], hooks: [], mcpServers: [], commands: [], memory: { present: false, bytes: 0, files: 0, indexBytes: 0 }, settings: [], startupBudget: {},
  };
}

test("snapshot: chain {path, hash, bytes}, rules/thresholds hashes, repo key and vendors; identical chains are refused; the diff names changed files", async () => {
  const { home, repo } = await tempRepo();
  try {
    const snapshot = await buildSnapshot({ inventory: inventoryOf(repo), repoRoot: repo, home, rulesHash: "r1", thresholds: { a: 1 }, now: new Date(NOW) });
    assert.equal(snapshot.at, NOW.replace("Z", ".000Z"));
    assert.deepEqual(snapshot.chain.map((f) => f.path), ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(snapshot.chain[0].hash, sha1(await readFile(path.join(repo, "AGENTS.md"))));
    assert.equal(snapshot.chain[0].bytes, (await stat(path.join(repo, "AGENTS.md"))).size);
    assert.equal(snapshot.rulesHash, "r1");
    assert.equal(typeof snapshot.thresholdsHash, "string");
    assert.deepEqual(snapshot.repo, { name: "repo", key: projectKeyFor(repo) });
    assert.deepEqual(snapshot.vendors, ["claude", "codex"]);
    assert.ok(!JSON.stringify(snapshot).includes(home), "no absolute path in a snapshot");
    const same = await buildSnapshot({ inventory: inventoryOf(repo), repoRoot: repo, home, now: new Date(NOW) });
    assert.equal(sameChain(snapshot, same), true);
    assert.deepEqual(chainDiff(snapshot, same), []);
    await writeFile(path.join(repo, "AGENTS.md"), "# Agents\nRead less. Use sed -n for big files.\n");
    const edited = await buildSnapshot({ inventory: inventoryOf(repo), repoRoot: repo, home, now: new Date(NOW) });
    assert.equal(sameChain(snapshot, edited), false);
    const diff = chainDiff(snapshot, edited);
    assert.equal(diff.length, 1);
    assert.equal(diff[0].path, "AGENTS.md");
    assert.equal(diff[0].state, "changed");
    assert.ok(diff[0].bytesTo > diff[0].bytesFrom);
    // An inventory that already carries `hash` (ADR-005 §2) is trusted without reading the file.
    const trusted = await buildSnapshot({ inventory: { ...inventoryOf(repo, ["missing.md"]), instructionFiles: [{ path: "missing.md", hash: "abc", bytes: 3, vendors: ["claude"] }] }, repoRoot: repo, home, now: new Date(NOW) });
    assert.deepEqual(trusted.chain, [{ path: "missing.md", hash: "abc", bytes: 3, vendors: ["claude"] }]);
    assert.throws(() => assertName("../x"), /experiment name/);
    assert.throws(() => assertName(""), /experiment name/);
    assert.equal(assertName("cycle3.a-b_c"), "cycle3.a-b_c");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("assignment by time: [baseline, candidate) is the baseline, [candidate, now) the candidate; earlier and future sessions are out", () => {
  const sessions = ["2026-08-01T10:00:00Z", "2026-08-10T10:00:00Z", "2026-08-15T10:00:00Z", "2026-08-20T10:00:00Z", "2026-09-05T10:00:00Z"].map((at, i) => ({ root: root(`s${i}`, at), descendants: [] }));
  const { baseline, candidate } = assignSessions(sessions, { baselineAt: "2026-08-05T00:00:00Z", candidateAt: "2026-08-18T00:00:00Z", now: Date.parse(NOW) });
  assert.deepEqual(baseline.map((s) => s.root.sessionId), ["s1", "s2"]);
  assert.deepEqual(candidate.map((s) => s.root.sessionId), ["s3"]);
});

test("compare: verified from a Codex entry whose instructions hash matches the snapshot; comparable = same vendor, model, CLI; the report is a Change with anchor experiment", () => {
  const agentsHash = sha1("agents-v2");
  const claudeHash = sha1("claude-v1");
  const experiment = {
    version: 1, name: "x", repo: { name: "repo", key: "k" }, createdAt: "2026-08-05T00:00:00Z",
    baseline: { at: "2026-08-05T00:00:00Z", chain: [{ path: "AGENTS.md", hash: sha1("agents-v1"), bytes: 9, vendors: ["codex", "claude"] }, { path: "CLAUDE.md", hash: claudeHash, bytes: 9, vendors: ["claude"] }], chainHash: "b", rulesHash: "r", thresholdsHash: "t", vendors: ["claude", "codex"] },
    candidate: { at: "2026-08-18T00:00:00Z", chain: [{ path: "AGENTS.md", hash: agentsHash, bytes: 9, vendors: ["codex", "claude"] }, { path: "CLAUDE.md", hash: claudeHash, bytes: 9, vendors: ["claude"] }], chainHash: "c", rulesHash: "r", thresholdsHash: "t", vendors: ["claude", "codex"] },
  };
  const sessions = [
    root("b1", "2026-08-06T10:00:00Z", { vendor: "codex", model: "gpt", cli: "0.1", h0: 12_000, instructionHash: sha1("agents-v1") }),
    root("b2", "2026-08-07T10:00:00Z", { vendor: "codex", model: "gpt", cli: "0.1", h0: 12_500 }),
    root("b3", "2026-08-08T10:00:00Z", { vendor: "codex", model: "gpt", cli: "0.2", h0: 12_500 }),
    root("b4", "2026-08-09T10:00:00Z", { vendor: "codex", model: "other", cli: "0.1", h0: 12_500 }),
    root("c1", "2026-08-19T10:00:00Z", { vendor: "codex", model: "gpt", cli: "0.1", h0: 10_000, instructionHash: agentsHash }),
    root("c2", "2026-08-20T10:00:00Z", { vendor: "claude", model: "gpt", cli: "0.1", h0: 10_000, nestedHashes: [claudeHash] }),
    root("c3", "2026-08-21T10:00:00Z", { vendor: "gemini", model: "gpt", cli: "0.1", h0: 10_000 }),
  ].map((r) => ({ root: r, descendants: [] }));
  assert.equal(verificationOf(sessions[0].root, experiment.baseline), "observed");
  assert.equal(verificationOf(sessions[0].root, experiment.candidate), "expected", "the old hash does not verify the candidate");
  assert.equal(verificationOf(sessions[5].root, experiment.candidate), "observed", "a nested CLAUDE.md hash verifies a Claude session");
  const report = compareExperiment(experiment, sessions, { now: Date.parse(NOW), titleOf: () => undefined });
  assert.equal(report.anchor, "experiment");
  assert.equal(report.file, "x");
  assert.equal(report.at, "2026-08-18T00:00:00Z");
  assert.deepEqual(report.n, { before: 2, after: 2, afterObserved: 2, baseline: 2, candidate: 2 });
  assert.deepEqual(report.experiment.verified, { baseline: 1, candidate: 2 });
  assert.deepEqual(report.experiment.excluded, { vendor: 1, model: 1, cliVersion: 1 });
  assert.deepEqual(report.experiment.comparable, { vendors: ["claude", "codex"], model: "gpt", cliVersion: "0.1" });
  assert.deepEqual(report.experiment.changedFiles.map((f) => `${f.path}:${f.state}`), ["AGENTS.md:changed"]);
  assert.equal(report.before.startupH0.value, 12_250);
  assert.equal(report.after.startupH0.value, 10_000);
  assert.equal(report.delta.startupH0, -2_250);
  assert.equal(report.ci, undefined, "no interval below 5 per side");
  assert.equal(report.experiment.enough, true);
  assert.equal(report.caveats[1], "2 baseline / 2 candidate");
  assert.equal(report.claim, "observational");
  const markdown = renderCompareMarkdown(report);
  assert.ok(markdown.includes(OBSERVATIONAL_SENTENCE));
  assert.ok(markdown.includes("n = {baseline: 2, candidate: 2}"));
  assert.ok(markdown.includes("| startup H0 | estimated.local | 12.3k | 10.0k | −2.25k (0.82x) | 2 / 2 |"), markdown);
  assert.ok(markdown.includes("Interval: none (n small"));
  assert.equal(markdown, renderCompareMarkdown(compareExperiment(experiment, sessions, { now: Date.parse(NOW), titleOf: () => undefined })), "stable markdown");
  for (const word of ["improved", "helped", "caused", "significant"]) assert.ok(!markdown.includes(word), `no causal wording: ${word}`);
  const thin = compareExperiment(experiment, sessions.slice(0, 5), { now: Date.parse(NOW), minSessions: 2 });
  assert.equal(thin.experiment.enough, false);
  assert.ok(renderCompareMarkdown(thin).includes("Not enough sessions"));
  assert.ok(renderCompareMarkdown(thin).includes("n < 2"));
  assert.throws(() => compareExperiment({ name: "y", baseline: experiment.baseline }, sessions), /no candidate yet/);
});

test("command: start writes a 0600 file without absolute paths, candidate refuses an unchanged chain then accepts an edit, compare prints the table with n and no interval, list/show/delete", async () => {
  const { home, repo } = await tempRepo();
  const lines = [];
  const context = {
    home, cwd: repo, stdout: (line) => lines.push(line), now: NOW,
    index: { state: {}, entries: async () => [root("s1", "2026-09-02T12:30:00Z", { cwd: repo })], manifest: async () => ({}), readFindings: async () => [] },
    setup: { buildSetupInventory: async () => inventoryOf(repo) },
    rules: { loadThresholds: async () => ({ fatToolResultTokens: 8000 }), rulesHash: async () => "rules-1", evaluateSetup: async () => [], loadRules: async () => [] },
  };
  try {
    await experiment(parseArgs(["experiment", "start", "trial"]), context);
    const file = experimentFile(home, "trial");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.name, "trial");
    assert.equal(stored.baseline.chain.length, 2);
    assert.equal(stored.baseline.rulesHash, "rules-1");
    assert.ok(!JSON.stringify(stored).includes(home), "nothing absolute in the stored file");
    assert.ok(lines[0].startsWith("Baseline for trial: 2 instruction file(s) in repo at 2026-09-02T12:00:00.000Z"));
    await assert.rejects(experiment(parseArgs(["experiment", "start", "trial"]), context), /already exists/);
    await assert.rejects(experiment(parseArgs(["experiment", "candidate", "trial"]), context), /Nothing changed/);
    await assert.rejects(experiment(parseArgs(["experiment", "compare", "trial"]), context), /no candidate yet/);
    await writeFile(path.join(repo, "AGENTS.md"), "# Agents\nRead less, then less again.\n");
    await experiment(parseArgs(["experiment", "candidate", "trial"]), { ...context, now: "2026-09-02T12:15:00Z" });
    assert.ok(lines.at(-2).startsWith("Candidate for trial: AGENTS.md (changed) at 2026-09-02T12:15:00.000Z"));
    const saved = await loadExperiment(home, "trial");
    assert.ok(saved.candidate);
    assert.notEqual(saved.candidate.chainHash, saved.baseline.chainHash);
    lines.length = 0;
    const report = await experiment(parseArgs(["experiment", "compare", "trial", "--min-sessions", "1"]), { ...context, now: "2026-09-02T13:00:00Z" });
    assert.deepEqual(report.n, { before: 0, after: 1, afterObserved: 0, baseline: 0, candidate: 1 });
    assert.equal(report.ci, undefined);
    const markdown = lines.join("\n");
    assert.ok(markdown.includes("n = {baseline: 0, candidate: 1}"));
    assert.ok(markdown.includes(OBSERVATIONAL_SENTENCE));
    assert.ok(markdown.includes("| Metric | Provenance | Baseline | Candidate |"));
    lines.length = 0;
    await experiment(parseArgs(["experiment", "compare", "trial", "--json"]), { ...context, now: "2026-09-02T13:00:00Z" });
    const json = JSON.parse(lines.join("\n"));
    assert.equal(json.experiment.name, "trial");
    assert.equal(json.experiment.enough, false, "candidate has 1 session, the default minimum is 2");
    assert.equal(json.anchor, "experiment");
    lines.length = 0;
    await experiment(parseArgs(["experiment", "list"]), context);
    assert.match(lines[0], /^trial {2}repo repo {2}baseline 2026-09-02T12:00 {2}candidate 2026-09-02T12:15$/);
    lines.length = 0;
    await experiment(parseArgs(["experiment", "show", "trial"]), context);
    assert.equal(JSON.parse(lines.join("\n")).name, "trial");
    lines.length = 0;
    await experiment(parseArgs(["experiment", "delete", "trial"]), context);
    assert.equal(lines[0], "Deleted experiment trial.");
    assert.equal(await loadExperiment(home, "trial"), null);
    await assert.rejects(experiment(parseArgs(["experiment", "show", "trial"]), context), /No experiment named/);
    await assert.rejects(experiment(parseArgs(["experiment", "bogus", "trial"]), context), /Unknown experiment subcommand/);
    await assert.rejects(experiment(parseArgs(["experiment", "start", "../evil"]), context), /experiment name/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
