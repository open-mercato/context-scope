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
 *   binary: kind "binary" (a PDF / image / office document read as base64 or
 *           raw bytes) swaps the vendor ratio for `binary.bytesPerToken`.
 *
 * Inventoried files (instruction files, skills, agents) go through
 * `estimateByVendor`: one `estTokensBy { claude, codex, neutral }` table per
 * file, the same arithmetic as `contextscope tokens`, and one backwards-
 * compatible `estTokens` whose `estBasis` names the vendor it rests on.
 *
 * The index keys its change detection on ESTIMATOR_VERSION and
 * CALIBRATION_VERSION: bump CALIBRATION_VERSION (in calibration.json) whenever
 * a constant changes; test/ir-calibration.test.mjs pins the file hash.
 */
import fs from "node:fs";
import { BINARY_EXTENSIONS, createEstimator, detectBinary, detectBlockKind, detectKind } from "./estimate-core.mjs";

export const CALIBRATION = JSON.parse(fs.readFileSync(new URL("./calibration.json", import.meta.url), "utf8"));
export const ESTIMATOR_VERSION = CALIBRATION.estimatorVersion;
export const CALIBRATION_VERSION = CALIBRATION.calibrationVersion;

const VENDORS = CALIBRATION.vendors;
const core = createEstimator(CALIBRATION);

export function byteLength(text) {
  return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
}

/** Vendor calibration record, or null for unknown vendors. */
export const calibrationFor = core.calibrationFor;

export function estimateTokens(text, kind = "prose", options = undefined) {
  return estimateTokensFromBytes(byteLength(text), kind, options);
}

export const estimateTokensFromBytes = core.estimateTokensFromBytes;

/** Token estimate of standalone text per vendor and neutral (`contextscope tokens`, the Tokens screen). */
export const tokenReport = core.tokenReport;

/** One estimate per inventoried file: `{ kind, estTokensBy, estTokens, estBasis }` (see estimate-core.mjs). */
export const estimateByVendor = core.estimateByVendor;
/** `estTokens` + `estBasis` for a per-vendor table and the vendors that load the file. */
export const pickEstimate = core.pickEstimate;
/** "claude" | "codex" | "neutral" | "max(claude,codex)" for a vendor list. */
export const basisFor = core.basisFor;
/** The figure of an inventoried row for one vendor (that vendor's calibration, neutral for uncalibrated vendors). */
export const estTokensFor = core.estTokensFor;

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

export { BINARY_EXTENSIONS, detectBinary, detectBlockKind, detectKind };

export function sizeOfJson(value) {
  try { return byteLength(JSON.stringify(value)); } catch { return 0; }
}
