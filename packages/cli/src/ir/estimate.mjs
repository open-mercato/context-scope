/**
 * Local token estimator (provenance: estimated.local). Pluggable: replace
 * `estimateTokens` with a real tokenizer later without changing callers.
 *
 * chars-v2 (ADR-002 F): every constant lives in ./calibration.json together
 * with the corpus statistics that produced it. Callers pass `{ vendor,
 * category }` to get the vendor-calibrated estimate; without a vendor the
 * neutral ratios apply (prose ~3.6, code/JSON ~3.2 bytes per token).
 *
 *   claude: tokens = ceil(bytes / bytesPerToken[kind]) + envelope(category)
 *   codex:  tokens = max(1, round(ceil(bytes / bytesPerToken[kind]) * categoryScale(category)))
 *
 * The index keys its change detection on ESTIMATOR_VERSION and
 * CALIBRATION_VERSION: bump CALIBRATION_VERSION (in calibration.json) whenever
 * a constant changes; test/ir-calibration.test.mjs pins the file hash.
 */
import fs from "node:fs";

export const CALIBRATION = JSON.parse(fs.readFileSync(new URL("./calibration.json", import.meta.url), "utf8"));
export const ESTIMATOR_VERSION = CALIBRATION.estimatorVersion;
export const CALIBRATION_VERSION = CALIBRATION.calibrationVersion;

const NEUTRAL = CALIBRATION.neutral.bytesPerToken;
const VENDORS = CALIBRATION.vendors;
const ENVELOPE_SETS = new Map(Object.entries(VENDORS).map(([vendor, cal]) => [vendor, new Set(cal.envelopeCategories ?? [])]));

export function byteLength(text) {
  return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
}

/** Vendor calibration record, or null for unknown vendors. */
export function calibrationFor(vendor) {
  return (vendor && VENDORS[vendor]) || null;
}

export function estimateTokens(text, kind = "prose", options = undefined) {
  return estimateTokensFromBytes(byteLength(text), kind, options);
}

export function estimateTokensFromBytes(bytes, kind = "prose", { vendor, category } = {}) {
  if (!bytes) return 0;
  const cal = calibrationFor(vendor);
  const ratios = cal?.bytesPerToken ?? NEUTRAL;
  const base = Math.ceil(bytes / (kind === "code" ? ratios.code : ratios.prose));
  if (!cal) return base;
  let tokens = base;
  if (cal.categoryScale) tokens = Math.max(1, Math.round(base * categoryScaleFor(cal, category)));
  if (cal.envelopeTokens && category && ENVELOPE_SETS.get(vendor).has(category)) tokens += cal.envelopeTokens;
  return tokens;
}

function categoryScaleFor(cal, category) {
  const scale = cal.categoryScale;
  if (!category) return scale.other ?? 1;
  if (category.startsWith("tool_result.") || category === "subagent_handoff") return scale.toolResult ?? 1;
  if (category === "tool_call") return scale.toolCall ?? 1;
  return scale.other ?? 1;
}

/** Tokens charged for one image part (vendors do not report per-image tokens). */
export function imageTokensFor(vendor) {
  return calibrationFor(vendor)?.imageTokens ?? 1500;
}

/**
 * Vendor system-prompt baseline for reconciliation (ADR-002 A): the hidden
 * mass we are willing to label `system`; anything above it is `unlogged`.
 * Codex writes `base_instructions` to disk as an explicit system block, so
 * its baseline is 0 when that block exists.
 */
export function systemBaselineFor(vendor, { hasBaseInstructionsBlock = false } = {}) {
  const cal = calibrationFor(vendor);
  if (!cal) return VENDORS.claude.systemBaselineTokens;
  if (hasBaseInstructionsBlock && cal.systemBaselineWithBaseInstructions !== undefined) return cal.systemBaselineWithBaseInstructions;
  return cal.systemBaselineTokens ?? 0;
}

/** Heuristic content-kind detection for a block: JSON, code fences, or path-heavy content count as code. */
export function detectKind(text) {
  if (typeof text !== "string" || text.length < 40) return "prose";
  const sample = text.slice(0, 4000);
  const first = sample.trimStart()[0];
  if (first === "{" || first === "[") return "code";
  const symbols = (sample.match(/[{}();=<>\[\]\/\\|]/g) || []).length;
  return symbols / sample.length > 0.03 ? "code" : "prose";
}

export function sizeOfJson(value) {
  try { return byteLength(JSON.stringify(value)); } catch { return 0; }
}
