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
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { CALIBRATION, CALIBRATION_VERSION, ESTIMATOR_VERSION, basisFor, calibrationFor, detectBinary, detectBlockKind, estimateByVendor, estimateTokens, estimateTokensFromBytes, estTokensFor, imageTokensFor, pickEstimate, systemBaselineFor } from "../src/ir/estimate.mjs";
import { CATEGORIES } from "../src/ir/categories.mjs";
import { parseClaudeSession } from "../src/adapters/claude.mjs";

const PINNED = { calibrationVersion: "cal-2026-10-07a", sha1: "4ec4ef2461abefbdfaf5fdcf1c9a70b97f50e583" };

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

test("one estimate per file: estimateByVendor matches the per-vendor arithmetic and picks the basis from the vendors", () => {
  const text = "Write tests before fixes. ".repeat(200);
  const one = estimateByVendor(text, { vendors: ["claude"] });
  assert.deepEqual(Object.keys(one.estTokensBy).sort(), ["claude", "codex", "neutral"]);
  assert.equal(one.estTokensBy.claude, estimateTokens(text, "prose", { vendor: "claude" }));
  assert.equal(one.estTokensBy.codex, estimateTokens(text, "prose", { vendor: "codex" }));
  assert.equal(one.estTokensBy.neutral, estimateTokens(text, "prose"));
  assert.equal(one.estKind, "prose");
  assert.deepEqual([one.estTokens, one.estBasis], [one.estTokensBy.claude, "claude"]);
  assert.deepEqual(pickEstimate(one.estTokensBy, ["codex"]), { estTokens: one.estTokensBy.codex, estBasis: "codex" });
  assert.deepEqual(pickEstimate(one.estTokensBy, ["codex", "claude", "claude"]), { estTokens: Math.max(one.estTokensBy.claude, one.estTokensBy.codex), estBasis: "max(claude,codex)" });
  assert.deepEqual(pickEstimate(one.estTokensBy, ["gemini"]), { estTokens: one.estTokensBy.neutral, estBasis: "neutral" }, "an uncalibrated vendor rests on the neutral ratio");
  assert.deepEqual(pickEstimate(one.estTokensBy, []), { estTokens: one.estTokensBy.neutral, estBasis: "neutral" });
  assert.equal(basisFor(["gemini", "claude"]), "claude", "only calibrated vendors count towards the basis");
  assert.equal(estTokensFor(one, "codex"), one.estTokensBy.codex);
  assert.equal(estTokensFor(one, "gemini"), one.estTokensBy.neutral);
  assert.equal(estTokensFor({ estTokens: 7 }, "claude"), 7, "rows without the table fall back to their single number");
  assert.equal(estimateByVendor("{\"a\": [1, 2, 3]}".repeat(20)).estKind, "code", "kind auto by default");
});

test("binary documents: a separate ratio, applied only when the target extension and the content agree", () => {
  const pdfBytes = 532 * 1024;
  const binary = estimateTokensFromBytes(pdfBytes, "binary", { vendor: "claude", category: "tool_result.file" });
  const asProse = estimateTokensFromBytes(pdfBytes, "prose", { vendor: "claude", category: "tool_result.file" });
  assert.equal(binary, Math.ceil(pdfBytes / CALIBRATION.binary.bytesPerToken) + CALIBRATION.vendors.claude.envelopeTokens, "binary ratio + the per-message envelope");
  assert.ok(binary > 12_000 && binary < 15_000, `the one observation (about 13k) is reproduced: ${binary}`);
  assert.ok(asProse > 100_000, `the prose ratio overshoots by an order of magnitude: ${asProse}`);
  assert.equal(estimateTokensFromBytes(pdfBytes, "binary"), Math.ceil(pdfBytes / CALIBRATION.binary.bytesPerToken), "neutral binary");
  const base64 = Buffer.from("x".repeat(3000)).toString("base64");
  const json = JSON.stringify({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });
  assert.equal(detectBinary(json, { target: "docs/spec.pdf" }), true);
  assert.equal(detectBinary(json, { target: "docs/Spec.PDF" }), true, "extension match is case-insensitive");
  assert.equal(detectBinary(json, { target: "src/app.ts" }), false, "a data URI inside a text file stays text");
  assert.equal(detectBinary(json, {}), false, "no target, no verdict");
  assert.equal(detectBinary("Just a short note about the spec", { target: "docs/spec.pdf" }), false, "an error message or stub for a .pdf target is text");
  const rawBytes = "%PDF-1.7\n" + "\u0000\u0001\ufffd\u0002".repeat(300) + "x".repeat(400);
  assert.equal(detectBinary(rawBytes, { target: "docs/spec.pdf" }), true, "a cat of the raw bytes is binary too");
  assert.equal(detectBinary("const a = 1;\n".repeat(100), { target: "docs/spec.pdf" }), false, "clean text under a .pdf name is text");
  assert.equal(detectBlockKind(json, { target: "logo.png" }), "binary");
  assert.equal(detectBlockKind(json, { target: "logo.ts" }), "code");
});

test("adapter: a Read of a PDF is a binary block sized by the binary ratio; the same payload under a .ts name is not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "contextscope-binary-read-"));
  try {
    const cwd = path.join(dir, "repo");
    const sessionId = "aaaaaaaa-0000-4000-8000-000000000001";
    const base64 = Buffer.alloc(40_000, 7).toString("base64");
    const document = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }];
    const asText = [{ type: "text", text: `data:application/octet-stream;base64,${base64}` }];
    let uuid = 0;
    let t = Date.parse("2026-10-01T10:00:00.000Z");
    const records = [];
    const push = (record) => { uuid += 1; t += 1000; records.push({ parentUuid: uuid === 1 ? null : `u${uuid - 1}`, isSidechain: false, ...record, uuid: `u${uuid}`, timestamp: new Date(t).toISOString(), userType: "external", cwd, sessionId, version: "2.0.0", gitBranch: "main" }); };
    const usage = (n) => ({ input_tokens: 1, cache_creation_input_tokens: n, cache_read_input_tokens: 0, output_tokens: 20 });
    push({ type: "user", message: { role: "user", content: "read the spec and the app" } });
    push({ type: "assistant", message: { model: "claude-sonnet-5", id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: `${cwd}/docs/spec.pdf` } }], stop_reason: "tool_use", usage: usage(20_000) }, requestId: "req_1" });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: document, is_error: false }] } });
    push({ type: "assistant", message: { model: "claude-sonnet-5", id: "msg_2", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: `${cwd}/src/app.ts` } }], stop_reason: "tool_use", usage: usage(40_000) }, requestId: "req_2" });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: asText, is_error: false }] } });
    push({ type: "assistant", message: { model: "claude-sonnet-5", id: "msg_3", type: "message", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: usage(60_000) }, requestId: "req_3" });
    const file = path.join(dir, `${sessionId}.jsonl`);
    await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const run = await parseClaudeSession(file, { home: dir });
    const blocks = run.scopes[0].blocks.filter((block) => block.category === "tool_result.file");
    const pdf = blocks.find((block) => block.tool?.target === "docs/spec.pdf");
    const ts = blocks.find((block) => block.tool?.target === "src/app.ts");
    assert.ok(pdf && ts, "both reads are file blocks");
    assert.equal(pdf.kind, "binary");
    assert.equal(pdf.estTokens, estimateTokensFromBytes(pdf.bytes, "binary", { vendor: "claude", category: "tool_result.file" }));
    assert.notEqual(ts.kind, "binary", "the same base64 under a text file name keeps the text ratio");
    assert.ok(pdf.estTokens * 5 < ts.estTokens, `binary ${pdf.estTokens} vs text ${ts.estTokens}`);
    assert.ok(!JSON.stringify(run).includes(base64.slice(0, 64)), "content never enters the IR");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
