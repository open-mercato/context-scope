/**
 * ADR-002 F: a constant change without a version bump must fail CI. The hash
 * below pins the CONSTANTS of src/ir/calibration.json (every key except the
 * documentation keys `$comment` and `measured`, sorted); when you change a
 * number, bump `calibrationVersion` in the file and update PINNED here.
 * Measured corpus statistics can be documented without a bump.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { CALIBRATION, CALIBRATION_VERSION, ESTIMATOR_VERSION, calibrationFor, estimateTokens, estimateTokensFromBytes, imageTokensFor, systemBaselineFor } from "../src/ir/estimate.mjs";
import { CATEGORIES } from "../src/ir/categories.mjs";

const PINNED = { calibrationVersion: "cal-2026-09-02d", sha1: "7fee48baecbe08e06ff6f9e189cdd2e843948574" };

/** The constants only: documentation keys (`$comment`, `measured`) are dropped at every depth, keys sorted. */
export function constantsOf(value) {
  if (Array.isArray(value)) return value.map(constantsOf);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) if (key !== "$comment" && key !== "measured") out[key] = constantsOf(value[key]);
    return out;
  }
  return value;
}

test("calibration.json constants are pinned next to their version", () => {
  const raw = fs.readFileSync(new URL("../src/ir/calibration.json", import.meta.url), "utf8");
  const sha1 = createHash("sha1").update(JSON.stringify(constantsOf(JSON.parse(raw)))).digest("hex");
  assert.equal(ESTIMATOR_VERSION, "chars-v2");
  assert.equal(CALIBRATION_VERSION, PINNED.calibrationVersion, "calibrationVersion changed: update PINNED");
  assert.equal(sha1, PINNED.sha1, `calibration.json constants changed (sha1 ${sha1}) without a calibrationVersion bump: bump it and update PINNED`);
  assert.ok(CALIBRATION.vendors.claude.measured.envelopeFit, "the envelope fit is documented (ADR-003 section 9)");
});

test("estimator reads every constant from calibration.json", () => {
  const claude = calibrationFor("claude");
  const codex = calibrationFor("codex");
  assert.equal(estimateTokens("x".repeat(3600), "prose"), 1000, "neutral prose ratio without a vendor");
  assert.equal(estimateTokens("x".repeat(3200), "code"), 1000);
  assert.equal(estimateTokensFromBytes(0, "prose", { vendor: "claude", category: "user" }), 0);
  assert.equal(estimateTokens("x".repeat(1000), "code", { vendor: "claude", category: "tool_result.file" }), Math.ceil(1000 / claude.bytesPerToken.code) + claude.envelopeTokens);
  assert.equal(estimateTokens("x".repeat(1000), "prose", { vendor: "claude", category: "assistant_text" }), Math.ceil(1000 / claude.bytesPerToken.prose), "no envelope outside envelopeCategories");
  assert.equal(estimateTokens("x".repeat(1000), "prose", { vendor: "codex", category: "tool_result.shell" }), Math.max(1, Math.round(Math.ceil(1000 / codex.bytesPerToken.prose) * codex.categoryScale.toolResult)));
  assert.equal(estimateTokens("x".repeat(1000), "code", { vendor: "codex", category: "tool_call" }), Math.max(1, Math.round(Math.ceil(1000 / codex.bytesPerToken.code) * codex.categoryScale.toolCall)));
  assert.equal(imageTokensFor("claude"), claude.imageTokens);
  assert.equal(imageTokensFor("codex"), codex.imageTokens);
  assert.equal(systemBaselineFor("claude"), claude.systemBaselineTokens);
  assert.equal(systemBaselineFor("codex"), codex.systemBaselineTokens);
  assert.equal(systemBaselineFor("codex", { hasBaseInstructionsBlock: true }), 0);
  for (const category of claude.envelopeCategories) assert.ok(CATEGORIES.includes(category), category);
  assert.ok(CALIBRATION.vendors.claude.measured && CALIBRATION.vendors.codex.measured, "measured corpus stats are documented");
});

test("categories.mjs mirrors types.ts", () => {
  const types = fs.readFileSync(new URL("../src/ir/types.ts", import.meta.url), "utf8");
  const block = /export const CATEGORIES: Category\[\] = \[([^\]]+)\]/.exec(types)[1];
  const fromTypes = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fromTypes, CATEGORIES);
});
