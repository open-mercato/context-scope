/** `contextscope check`: exit codes on the four fixture repositories, config precedence, --github and --json. */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dedupeFindings, globToRegExp, normalizeConfig, renderGithub, runCheck } from "../src/commands/check.mjs";
import { gitTopLevel, resolveRepoRoot } from "../src/util/repo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "contextscope.mjs");
const REPOS = path.join(here, "fixtures", "repos");
const HOME = path.join(here, "fixtures", "homes", "healthy");

function check(args, { home = HOME, env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    execFileCb(process.execPath, [CLI, "check", ...args], { cwd, env: { ...process.env, CI: "", HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"] }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

const repo = (name) => path.join(REPOS, name);

test("check-pass exits 0 and prints the budget table", async () => {
  const started = Date.now();
  const result = await check(["--repo", repo("check-pass")]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ContextScope check · check-pass/);
  assert.match(result.stdout, /claude\s+startup\s+\d+ \/ 6,000 tokens\s+ok\s+\(claude-calibrated, from disk\)/, "the budget line names its basis");
  assert.doesNotMatch(result.stdout, /estimated from disk/);
  assert.match(result.stdout, /0 violations, 0 findings at or above high → ok \(exit 0\)/);
  assert.ok(Date.now() - started < 2000, "check under 2 s");
});

test("check-budget: .contextscope.json budget fails (exit 1); the --budget flag overrides the file", async () => {
  const failing = await check(["--repo", repo("check-budget")]);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /claude\s+startup\s+[\d,]+ \/ 500 tokens\s+over by [\d,]+\s+FAIL/);
  assert.match(failing.stdout, /\[HIGH\] S-01 Instruction chain oversized · CLAUDE\.md/);
  const overridden = await check(["--repo", repo("check-budget"), "--budget", "startup=6000"]);
  assert.equal(overridden.code, 0, overridden.stdout);
});

test("check-broken-ref: missing reference is a violation (exit 1); --no-broken-refs passes (exit 0)", async () => {
  const failing = await check(["--repo", repo("check-broken-ref")]);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /CLAUDE\.md → docs\/missing\.md\s+missing reference\s+FAIL/);
  assert.match(failing.stdout, /\[LOW\] S-05 .*\(below --fail-on\)/);
  const relaxed = await check(["--repo", repo("check-broken-ref"), "--no-broken-refs"]);
  assert.equal(relaxed.code, 0, relaxed.stdout);
  assert.doesNotMatch(relaxed.stdout, /S-05/);
  const strict = await check(["--repo", repo("check-broken-ref"), "--fail-on", "medium", "--no-broken-refs"]);
  assert.equal(strict.code, 0, "S-05 is off with --no-broken-refs even at --fail-on medium");
});

test("check-high: a high finding fails (exit 1); rules can be switched off from --config; invalid config is exit 2", async () => {
  const failing = await check(["--repo", repo("check-high"), "--github"]);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /\[HIGH\] S-03 Skill missing description · \.claude\/skills\/deploy\/SKILL\.md/);
  assert.match(failing.stdout, /^::error file=\.claude\/skills\/deploy\/SKILL\.md,line=1::S-03 Skill missing description: /m);
  const relaxed = await check(["--repo", repo("check-high"), "--config", path.join(repo("check-high"), "contextscope.relaxed.json")]);
  assert.equal(relaxed.code, 0, relaxed.stdout);
  const invalid = await check(["--repo", repo("check-high"), "--config", path.join(repo("check-high"), "contextscope.invalid.json")]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /budgets\.startupTokens/);
  const missing = await check(["--repo", repo("check-high"), "--config", path.join(repo("check-high"), "nope.json")]);
  assert.equal(missing.code, 2);
});

test("usage errors exit 2: bad --fail-on, bad --budget, unreadable repo", async () => {
  assert.equal((await check(["--repo", repo("check-pass"), "--fail-on", "critical"])).code, 2);
  assert.equal((await check(["--repo", repo("check-pass"), "--budget", "startup=lots"])).code, 2);
  assert.equal((await check(["--repo", repo("check-pass"), "--max-instruction-file", "big"])).code, 2);
  assert.equal((await check(["--repo", path.join(REPOS, "does-not-exist")])).code, 2);
});

test("--json carries ok, exitCode, budget, violations and findings", async () => {
  const result = await check(["--repo", repo("check-broken-ref"), "--json"]);
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.exitCode, 1);
  assert.equal(json.budget.claude.ok, true);
  assert.equal(json.budget.claude.basis, "claude");
  assert.deepEqual(json.violations.map((violation) => violation.kind), ["broken-ref"]);
  assert.equal(json.violations[0].ref, "docs/missing.md");
  assert.deepEqual(json.findings.map((finding) => finding.ruleId), ["S-05"]);
  assert.equal(json.config.failOn, "high");
});

test("normalizeConfig accepts both documented shapes and rejects bad values", () => {
  const a = normalizeConfig({ budgets: { startupTokens: 5000, instructionFileTokens: 2000 }, failOn: "medium", rules: { "S-05": "off" }, ignore: ["vendor/**"] });
  assert.equal(a.budgets.startupTokens, 5000);
  assert.equal(a.budgets.instructionFileTokens, 2000);
  assert.equal(a.failOn, "medium");
  assert.deepEqual(a.rules, { "S-05": "off" });
  assert.deepEqual(a.ignore, ["vendor/**"]);
  const b = normalizeConfig({ check: { budget: { startup: 4000 }, maxInstructionFile: 1500, brokenRefs: false, failOn: "high" } });
  assert.equal(b.budgets.startupTokens, 4000);
  assert.equal(b.budgets.instructionFileTokens, 1500);
  assert.equal(b.brokenRefs, false);
  assert.throws(() => normalizeConfig({ failOn: "critical" }), /failOn/);
  assert.throws(() => normalizeConfig({ rules: { "B-01": "off" } }), /S-NN/);
  assert.throws(() => normalizeConfig([]), /object/);
  assert.ok(globToRegExp("packages/*/test/**").test("packages/cli/test/fixtures/x/CLAUDE.md"));
  assert.ok(!globToRegExp("packages/*/test/**").test("packages/cli/src/CLAUDE.md"));
});

test("runCheck ignores globbed files for violations and findings; github annotations escape newlines and property values", async () => {
  const config = normalizeConfig({ ignore: ["**/CLAUDE.md"], brokenRefs: true });
  const result = await runCheck({ repoRoot: repo("check-broken-ref"), home: HOME, config });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  const annotations = renderGithub({ violations: [{ kind: "file", file: "a.md", message: "line1\nline2 100%" }], findings: [], config });
  assert.equal(annotations, "::error file=a.md,line=1::line1%0Aline2 100%25");
  const odd = renderGithub({ violations: [{ kind: "file", file: "docs/a,b:c.md", message: "x" }], findings: [], config });
  assert.equal(odd, "::error file=docs/a%2Cb%3Ac.md,line=1::x", "`,` and `:` are escaped in property values");
});

test("--max-instruction-file judges a file on its own basis: a shared file by the larger of its vendors, labelled", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-check-basis-"));
  try {
    const text = "Keep functions small and name them after what they return. ".repeat(60);
    await writeFile(path.join(base, "CLAUDE.md"), `# Project\n\n${text}`);
    await writeFile(path.join(base, "AGENTS.md"), `# Project\n\n${text}`);
    // 3.6 KB of prose: about 1.6k Claude tokens, about 0.9k Codex tokens; 500 trips both, on each file's own basis.
    await writeFile(path.join(base, ".contextscope.json"), JSON.stringify({ budgets: { instructionFileTokens: 500, startupTokens: 100000 } }));
    const result = await check(["--repo", base, "--json"]);
    assert.equal(result.code, 1, result.stderr);
    const json = JSON.parse(result.stdout);
    const files = Object.fromEntries(json.violations.filter((violation) => violation.kind === "file").map((violation) => [violation.file, violation]));
    assert.equal(files["CLAUDE.md"].basis, "claude");
    assert.equal(files["AGENTS.md"].basis, "codex");
    assert.ok(files["CLAUDE.md"].value > files["AGENTS.md"].value, "the same bytes are more Claude tokens than Codex tokens");
    assert.match(files["CLAUDE.md"].message, /claude-calibrated/);
    assert.equal(json.budget.claude.basis, "claude");
    assert.equal(json.budget.codex.basis, "codex");
    assert.ok(json.budget.claude.startup > json.budget.codex.startup, "each vendor's budget uses its own calibration of the same-sized file");
    const text2 = await check(["--repo", base]);
    assert.match(text2.stdout, /CLAUDE\.md\s+[\d,]+ tokens > 500\s+FAIL\s+\(claude-calibrated\)/);
    assert.match(text2.stdout, /AGENTS\.md\s+[\d,]+ tokens > 500\s+FAIL\s+\(codex-calibrated\)/);
    assert.match(text2.stdout, /codex\s+startup.*\(codex-calibrated, from disk\)/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("one fact, one line: same (rule, title, file) from two vendors merges with a vendor tag; S-01 file findings fold into the size violation", () => {
  const finding = (vendor, title, file, id) => ({ id, ruleId: "S-01", severity: "high", scope: "setup", vendor, title, whyItMatters: "w", evidence: [{ kind: "file", ref: file, label: file, provenance: "observed.artifact" }], fix: { platform: vendor, summary: "s", path: file }, thresholdKeys: [], tokensAffected: 10_000 });
  const findings = [
    finding("claude", "Instruction chain oversized", "AGENTS.md", "S-01:aaaaaaaaaa"),
    finding("codex", "Instruction chain oversized", "AGENTS.md", "S-01:bbbbbbbbbb"),
    finding("codex", "Instruction file oversized", "AGENTS.md", "S-01:cccccccccc"),
    finding("claude", "Instruction file oversized", "CLAUDE.md", "S-01:dddddddddd"),
  ];
  const { findings: deduped, folded } = dedupeFindings(findings, [{ kind: "file", file: "AGENTS.md", value: 10_486, limit: 3_000 }]);
  assert.equal(folded, 1, "the AGENTS.md file finding is the size violation");
  assert.deepEqual(deduped.map((f) => [f.title, f.vendors]), [["Instruction chain oversized", ["claude", "codex"]], ["Instruction file oversized", ["claude"]]]);
  assert.equal(deduped[0].fix.platform, "both");
  assert.equal(deduped[0].vendor, undefined);
  assert.equal(deduped[1].fix.platform, "claude");
});

test("the developer's home config is ignored unless --user-config; CI=1 keeps it out; exit 3 on a runtime error", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-check-home-"));
  try {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "CLAUDE.md"), `# user rules\n${"lorem ipsum dolor sit amet ".repeat(400)}\n`);
    const isolated = await check(["--repo", repo("check-pass"), "--max-instruction-file", "500"], { home });
    assert.equal(isolated.code, 0, isolated.stdout);
    assert.match(isolated.stdout, /repo files only \(no ~ config; --user-config to include\)/);
    assert.doesNotMatch(isolated.stdout, /~\/\.claude\/CLAUDE\.md/);
    const withHome = await check(["--repo", repo("check-pass"), "--max-instruction-file", "500", "--user-config"], { home });
    assert.equal(withHome.code, 1, withHome.stdout);
    assert.match(withHome.stdout, /with user config \(~\)/);
    assert.match(withHome.stdout, /~\/\.claude\/CLAUDE\.md/);
    const ci = await check(["--repo", repo("check-pass"), "--max-instruction-file", "500", "--user-config"], { home, env: { CI: "1" } });
    assert.equal(ci.code, 0, "CI=1 implies --user-config off");
    const json = JSON.parse((await check(["--repo", repo("check-pass"), "--json"], { home })).stdout);
    assert.equal(json.userConfig, false);
    assert.equal(json.folded, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  // A runtime error (not usage): the inventory throws on an unusable home. Exit 3, distinct from violations (1) and usage (2).
  const runtime = await new Promise((resolve) => {
    execFileCb(process.execPath, ["--input-type=module", "-e", `
      import { run } from ${JSON.stringify(path.join(here, "..", "src", "commands", "check.mjs"))};
      import { parseArgs } from ${JSON.stringify(path.join(here, "..", "src", "commands", "args.mjs"))};
      const args = parseArgs(["check", "--repo", ${JSON.stringify(repo("check-pass"))}, "--user-config"]);
      await run(args, { home: 42, cwd: process.cwd(), env: {} });
    `], { env: { ...process.env, HOME: HOME }, stdio: ["ignore", "pipe", "pipe"] }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  assert.equal(runtime.code, 3, runtime.stderr);
  assert.match(runtime.stderr, /runtime error/);
});

test("repo root: the git top level above cwd, an explicit --repo as given, cwd without .git", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-repo-"));
  try {
    const top = path.join(base, "mono");
    await mkdir(path.join(top, ".git"), { recursive: true });
    await mkdir(path.join(top, "packages", "cli", "src"), { recursive: true });
    const worktree = path.join(base, "wt");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), "gitdir: ../mono/.git/worktrees/wt\n");
    assert.equal(gitTopLevel(path.join(top, "packages", "cli", "src")), top);
    assert.equal(resolveRepoRoot(path.join(top, "packages", "cli")), top, "cwd inside a checkout resolves to the top level");
    assert.equal(resolveRepoRoot(path.join(top, "packages", "cli"), "."), path.join(top, "packages", "cli"), "an explicit --repo is honoured as given");
    assert.equal(resolveRepoRoot(worktree), worktree, "a .git file (worktree) is a root");
    const plain = path.join(base, "plain");
    await mkdir(plain, { recursive: true });
    assert.equal(resolveRepoRoot(plain), plain, "no .git anywhere: the cwd");
    const fromSub = await check([], { cwd: path.join(top, "packages", "cli") });
    assert.match(fromSub.stdout, /^ContextScope check · mono/, "check from a sub-package reports the top-level repo");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
