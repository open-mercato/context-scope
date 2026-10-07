import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { renderTokens, tokensReport, TokensUsageError } from "../src/commands/tokens.mjs";
import { estimateTokens, tokenReport } from "../src/ir/estimate.mjs";
import { createEstimator } from "../src/ir/estimate-core.mjs";
import { CALIBRATION } from "../src/ir/estimate.mjs";

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
