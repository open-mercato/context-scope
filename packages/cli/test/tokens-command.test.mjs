import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { renderTokens, tokensReport, TokensUsageError } from "../src/commands/tokens.mjs";
import { estimateTokens, tokenReport } from "../src/ir/estimate.mjs";
import { createEstimator } from "../src/ir/estimate-core.mjs";
import { CALIBRATION } from "../src/ir/estimate.mjs";
import { buildSetupInventory } from "../src/setup/inventory.mjs";

test("tokens: files, directories and stdin; binary files are skipped, totals add up", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-tokens-"));
  try {
    await mkdir(path.join(base, "docs", "node_modules"), { recursive: true });
    const prose = "Context engineering decides what the agent sees and when. ".repeat(40);
    await writeFile(path.join(base, "AGENTS.md"), prose);
    await writeFile(path.join(base, "docs", "a.json"), JSON.stringify({ a: [1, 2, 3], b: "x".repeat(200) }));
    await writeFile(path.join(base, "docs", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    await writeFile(path.join(base, "docs", "node_modules", "dep.js"), "module.exports = 1;\n");
    const report = await tokensReport(["AGENTS.md", "docs", "-"], { cwd: base, stdin: async () => Buffer.from("hello from stdin\n") });
    assert.deepEqual(report.files.map((row) => row.path), ["AGENTS.md", path.join("docs", "a.json"), "(stdin)"]);
    assert.deepEqual(report.skipped, [{ path: path.join("docs", "logo.png"), reason: "binary" }]);
    const agents = report.files[0];
    assert.equal(agents.kind, "prose");
    assert.equal(agents.tokens.claude, estimateTokens(prose, "prose", { vendor: "claude" }));
    assert.equal(agents.tokens.neutral, estimateTokens(prose, "prose"));
    assert.equal(report.files[1].kind, "code");
    assert.equal(report.total.tokens.claude, report.files.reduce((sum, row) => sum + row.tokens.claude, 0));
    assert.equal(report.provenance, "estimated.local");
    assert.match(renderTokens(report), /total \(3 files\)/);
    await assert.rejects(tokensReport([], { cwd: base }), TokensUsageError);
    await assert.rejects(tokensReport(["AGENTS.md"], { cwd: base, kind: "poetry" }), TokensUsageError);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the I/O-free estimator core gives the same numbers as estimate.mjs (browser and CLI agree)", () => {
  const core = createEstimator(CALIBRATION);
  const text = "const x = { a: [1, 2, 3] };\n".repeat(50) + "zażółć gęślą jaźń ✓";
  assert.deepEqual(core.tokenReport(text), tokenReport(text));
  assert.equal(core.tokenReport(text).bytes, Buffer.byteLength(text, "utf8"));
});

test("the setup inventory and `contextscope tokens` give the same claude/codex/neutral numbers for the same file", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-tokens-inventory-"));
  const home = path.join(base, "home");
  try {
    await mkdir(home, { recursive: true });
    const prose = "# Conventions\n\nPrefer small modules. Explain why in comments, not what. ".repeat(80);
    const codeish = "# API\n\n```ts\nexport const x = { a: [1, 2], b: () => fetch(\"/api\") };\n```\n".repeat(60);
    await writeFile(path.join(base, "CLAUDE.md"), prose);
    await writeFile(path.join(base, "AGENTS.md"), codeish);
    const inventory = await buildSetupInventory({ repoRoot: base, home, sessionStats: { vendorsWithSessions: ["claude", "codex"], sessionCount: 0 }, capture: false });
    const report = await tokensReport(["CLAUDE.md", "AGENTS.md"], { cwd: base });
    for (const row of report.files) {
      const file = inventory.instructionFiles.find((entry) => entry.path === row.path);
      assert.ok(file, `${row.path} inventoried`);
      assert.deepEqual(file.estTokensBy, row.tokens, `${row.path}: inventory and tokens agree per vendor`);
      assert.equal(file.estKind, row.kind, `${row.path}: same prose/code detection`);
    }
    const claudeFile = inventory.instructionFiles.find((entry) => entry.path === "CLAUDE.md");
    const codexFile = inventory.instructionFiles.find((entry) => entry.path === "AGENTS.md");
    assert.equal(claudeFile.estBasis, "claude");
    assert.equal(claudeFile.estTokens, report.files.find((row) => row.path === "CLAUDE.md").tokens.claude, "check's single number is the tokens column of the file's vendor");
    assert.equal(codexFile.estBasis, "codex");
    assert.equal(codexFile.estTokens, report.files.find((row) => row.path === "AGENTS.md").tokens.codex);
    assert.equal(report.files.find((row) => row.path === "AGENTS.md").kind, "code", "auto detection applies to instruction files too");
    // The budget line per vendor is the sum of that vendor's column over the chain.
    assert.equal(inventory.startupBudget.claude.instructions.value, claudeFile.estTokensBy.claude);
    assert.equal(inventory.startupBudget.codex.instructions.value, codexFile.estTokensBy.codex);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
