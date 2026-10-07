import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { cp, mkdtemp, readFile, utimes } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildSetupInventory } from "../src/setup/inventory.mjs";

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.join(here, "fixtures", "repos");
const HOMES = path.join(here, "fixtures", "homes");
const IDS = ["S-01", "S-02", "S-03", "S-04", "S-05", "S-06", "S-07", "S-08", "S-09", "S-10", "S-11", "S-12"];

const thresholds = JSON.parse(await readFile(path.join(here, "..", "src", "rules", "thresholds.setup.json"), "utf8"));
const rules = Object.fromEntries(await Promise.all(IDS.map(async id => [id, (await import(`../src/rules/${id}.mjs`)).default])));

function evaluateAll(input, overrides = {}) {
  const t = { ...thresholds, ...overrides };
  const out = {};
  for (const id of IDS) out[id] = rules[id].evaluate(input, t);
  return out;
}

function assertFindingShape(finding) {
  assert.match(finding.id, /^S-\d\d:[0-9a-f]{10}$/);
  assert.equal(finding.scope, "setup");
  assert.ok(["high", "medium", "low"].includes(finding.severity));
  assert.ok(finding.title && finding.whyItMatters);
  assert.ok(Array.isArray(finding.evidence) && finding.evidence.length > 0, `${finding.ruleId} evidence`);
  for (const e of finding.evidence) {
    assert.ok(["file", "request", "block", "scope", "metric", "run"].includes(e.kind));
    assert.ok(typeof e.ref === "string" && e.ref.length);
    assert.ok(typeof e.label === "string" && e.label.length);
    assert.ok(["observed.vendor", "observed.artifact", "derived.exact", "estimated.local", "unknown"].includes(e.provenance));
  }
  assert.ok(["claude", "codex", "gemini", "both"].includes(finding.fix.platform));
  assert.ok(finding.fix.summary);
  assert.ok(finding.fix.snippet, `${finding.ruleId} snippet`);
  assert.ok(finding.fix.path, `${finding.ruleId} path`);
  assert.ok(Array.isArray(finding.thresholdKeys));
  for (const key of finding.thresholdKeys) assert.ok(key in thresholds, `unknown threshold ${key}`);
}

const messyStats = {
  sessionCount: 8,
  vendorsWithSessions: ["claude", "codex", "gemini"],
  skillInvocations: { fine: 3 },
  hookRuns: { "PostToolUse:Write|Edit": { runs: 10, stdoutSizes: [9000, 9000, 9000, 100, 100, 100, 100, 100, 100, 100] } },
  mcpInvocations: { bloated: 12 },
  mcpToolsObserved: { bloated: Array.from({ length: 20 }, (_, i) => `tool${i}`) },
};

const healthyStats = {
  sessionCount: 3,
  vendorsWithSessions: ["claude", "codex"],
  hookRuns: { "PostToolUse:Write|Edit": { runs: 4, stdoutSizes: [200, 300, 250, 100] } },
  mcpInvocations: { docs: 9 },
  mcpToolsObserved: { docs: ["search", "fetch", "list"] },
};

test("rule modules have the required shape", () => {
  for (const id of IDS) {
    const rule = rules[id];
    assert.equal(rule.id, id);
    assert.equal(rule.scope, "setup");
    assert.ok(["high", "medium", "low"].includes(rule.severity));
    assert.ok(rule.title && rule.whyItMatters);
    assert.ok(Array.isArray(rule.thresholdKeys));
    for (const key of rule.thresholdKeys) assert.ok(key in thresholds, `${id}: ${key} missing from thresholds.setup.json`);
    assert.equal(typeof rule.evaluate, "function");
  }
});

test("messy fixture fires S-01..S-06, S-08..S-12 with well-formed findings", async () => {
  const setup = await buildSetupInventory({ repoRoot: path.join(REPOS, "messy"), home: path.join(HOMES, "messy"), sessionStats: messyStats });
  const result = evaluateAll({ setup, sessionStats: messyStats });
  for (const findings of Object.values(result)) findings.forEach(assertFindingShape);

  const s01 = result["S-01"];
  assert.ok(s01.some(f => f.evidence[0].ref === "CLAUDE.md" && f.severity === "high"), "S-01 file");
  assert.ok(s01.some(f => f.evidence[0].ref === "chain:claude"), "S-01 chain");
  assert.equal(s01.find(f => f.evidence[0].ref === "CLAUDE.md").fix.platform, "claude");

  assert.equal(result["S-02"].length, 1);
  assert.deepEqual(result["S-02"][0].evidence.slice(0, 2).map(e => e.ref), ["CLAUDE.md", ".claude/rules/general.md"]);
  assert.equal(result["S-02"][0].fix.path, ".claude/rules/general.md");

  const s03 = result["S-03"].map(f => f.evidence[0].ref).sort();
  assert.deepEqual(s03, [".claude/skills/broken-frontmatter/SKILL.md", ".claude/skills/no-description/SKILL.md"]);
  const s04 = result["S-04"].map(f => f.evidence[0].ref).sort();
  assert.deepEqual(s04, [".claude/skills/broken-frontmatter/SKILL.md", ".claude/skills/long-description/SKILL.md", ".claude/skills/wrong-name/SKILL.md"]);

  const s05 = result["S-05"];
  assert.deepEqual(s05.map(f => f.evidence[0].ref).sort(), ["AGENTS.md", "CLAUDE.md"]);
  assert.ok(s05.find(f => f.evidence[0].ref === "CLAUDE.md").evidence.some(e => e.ref === "docs/style-guide.md"));
  assert.ok(s05.every(f => f.severity === "low"), "S-05 is hygiene, never a CI gate on its own");

  const s06 = result["S-06"];
  assert.deepEqual(s06.map(f => f.vendor).sort(), ["claude", "codex"]);

  assert.deepEqual(result["S-07"], [], "no git dir -> S-07 silent");

  const s08 = result["S-08"];
  assert.equal(s08.length, 1);
  assert.equal(s08[0].evidence[0].ref, "mcp:bloated");
  assert.equal(s08[0].tokensAffected, 20 * 150);

  const s09 = result["S-09"].map(f => f.evidence[0].ref).sort();
  assert.deepEqual(s09, ["mcp:codex_unused", "mcp:global_server", "mcp:quoted.name", "mcp:unused", "mcp:user_server"]);
  assert.equal(result["S-09"].find(f => f.evidence[0].ref === "mcp:codex_unused").fix.platform, "codex");
  assert.match(result["S-09"].find(f => f.evidence[0].ref === "mcp:codex_unused").fix.snippet, /enabled = false/);

  assert.equal(result["S-10"].length, 1);
  assert.equal(result["S-10"][0].severity, "low");

  assert.equal(result["S-11"].length, 1);
  assert.match(result["S-11"][0].evidence[0].label, /30%/);
  assert.match(result["S-11"][0].fix.snippet, /tail -20/);

  assert.deepEqual(result["S-12"].map(f => f.vendor), ["gemini"]);
  assert.equal(result["S-12"][0].fix.path, "GEMINI.md");
});

test("healthy fixture fires nothing", async () => {
  const setup = await buildSetupInventory({ repoRoot: path.join(REPOS, "healthy"), home: path.join(HOMES, "healthy"), sessionStats: healthyStats });
  const result = evaluateAll({ setup, sessionStats: healthyStats });
  for (const id of IDS) assert.deepEqual(result[id], [], `${id} should not fire on the healthy repo`);
});

test("stats-dependent rules: S-08 total, S-09 needs sessions, S-10 needs sessions, S-12 per vendor", async () => {
  const setup = await buildSetupInventory({ repoRoot: path.join(REPOS, "healthy"), home: path.join(HOMES, "healthy") });
  // No stats at all: nothing fires.
  const quiet = evaluateAll({ setup });
  for (const id of ["S-08", "S-09", "S-10", "S-11", "S-12"]) assert.deepEqual(quiet[id], []);

  const many = { sessionCount: 6, vendorsWithSessions: ["claude", "codex"], mcpInvocations: {}, mcpToolsObserved: { docs: Array.from({ length: 12 }, (_, i) => `d${i}`), other: Array.from({ length: 30 }, (_, i) => `o${i}`) } };
  const setupWithStats = await buildSetupInventory({ repoRoot: path.join(REPOS, "healthy"), home: path.join(HOMES, "healthy"), sessionStats: many });
  const result = evaluateAll({ setup: setupWithStats, sessionStats: many });
  assert.equal(result["S-10"].length, 1, "6 sessions and no memory");
  assert.equal(result["S-09"].length, 2, "docs configured twice (claude + codex) with 0 invocations");
  assert.equal(result["S-08"].length, 0, "only the configured server counts; 12 < 15 and total 12 < 40");

  const total = evaluateAll({ setup: setupWithStats, sessionStats: many }, { mcpToolsPerServer: 100, mcpToolsTotal: 10 });
  assert.equal(total["S-08"].length, 1);
  assert.equal(total["S-08"][0].evidence[0].ref, "mcp:total");

  const noCodexFile = await buildSetupInventory({ repoRoot: path.join(REPOS, "messy"), home: path.join(HOMES, "healthy"), sessionStats: { sessionCount: 1, vendorsWithSessions: ["codex", "claude"] } });
  noCodexFile.instructionFiles = noCodexFile.instructionFiles.filter(f => f.path !== "AGENTS.md");
  const s12 = rules["S-12"].evaluate({ setup: noCodexFile, sessionStats: { sessionCount: 1, vendorsWithSessions: ["codex", "claude"] } }, thresholds);
  assert.deepEqual(s12.map(f => f.vendor), ["codex"]);
  assert.equal(s12[0].fix.path, "AGENTS.md");
});

test("thresholds are honoured: lowering them fires S-01/S-06 on the healthy repo", async () => {
  const setup = await buildSetupInventory({ repoRoot: path.join(REPOS, "healthy"), home: path.join(HOMES, "healthy") });
  const result = evaluateAll({ setup }, { instructionFileTokens: 10, instructionChainTokens: 10, rulesScopingMinTokens: 10, skillDescriptionMinChars: 500, skillDescriptionMaxChars: 10 });
  assert.ok(result["S-01"].length >= 3);
  assert.equal(result["S-06"].length, 0, "healthy has scoped rules and nested AGENTS.md");
  assert.ok(result["S-03"].length >= 1);
  assert.ok(result["S-04"].length >= 1);
});

test("S-07 fires for an old instruction file with many commits under its scope (git repo in tmp)", async (t) => {
  try { await execFile("git", ["--version"]); } catch { t.skip("git not available"); return; }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cs-s07-"));
  const repo = path.join(tmp, "repo");
  await cp(path.join(REPOS, "healthy"), repo, { recursive: true });
  const git = args => execFile("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "init"]);
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
  await utimes(path.join(repo, "CLAUDE.md"), old, old);
  const home = path.join(HOMES, "healthy");
  const before = await buildSetupInventory({ repoRoot: repo, home });
  assert.equal(before.repo.git, true);
  const claude = before.instructionFiles.find(f => f.path === "CLAUDE.md");
  assert.equal(claude.commitsSinceMtime, 1);
  // 1 commit > 0 and 400 days > 180: fires with a zero commit threshold.
  const fired = rules["S-07"].evaluate({ setup: before }, { ...thresholds, staleInstructionCommits: 0 });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].severity, "low");
  assertFindingShape(fired[0]);
  // Default threshold (50 commits) does not fire with a single commit.
  assert.deepEqual(rules["S-07"].evaluate({ setup: before }, thresholds), []);
  // Fresh file: not stale regardless of commits.
  const now = new Date();
  await utimes(path.join(repo, "CLAUDE.md"), now, now);
  const after = await buildSetupInventory({ repoRoot: repo, home });
  assert.deepEqual(rules["S-07"].evaluate({ setup: after }, { ...thresholds, staleInstructionCommits: 0 }), []);
});

test("S-01 reports oversized nested (lazily loaded) files as low severity, not as startup cost", async () => {
  const { default: rule } = await import("../src/rules/S-01.mjs");
  const thresholds = { instructionFileTokens: 3000, instructionChainTokens: 6000 };
  const setup = {
    vendorsDetected: ["claude"],
    instructionFiles: [
      { path: "CLAUDE.md", scope: "project", vendors: ["claude"], bytes: 4000, estTokens: 1000, precedence: 1, mtime: "", loadState: "expected.load", brokenRefs: [] },
      { path: "fixtures/messy/CLAUDE.md", scope: "nested", vendors: ["claude"], bytes: 20000, estTokens: 5000, precedence: 9, mtime: "", loadState: "discoverable", brokenRefs: [] },
    ],
  };
  const findings = rule.evaluate({ setup }, thresholds);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "low");
  assert.match(findings[0].title, /Nested/);
  assert.equal(findings[0].fix.path, "fixtures/messy/CLAUDE.md");
});
