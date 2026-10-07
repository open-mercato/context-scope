/**
 * The estimator without I/O: the same arithmetic as estimate.mjs over a
 * calibration object passed in, so the browser (the Tokens screen) and the CLI
 * (`contextscope tokens`, the adapters, the setup inventory) compute identical
 * numbers. estimate.mjs binds it to src/ir/calibration.json.
 */

/** UTF-8 byte length; works in Node and in the browser. */
export function byteLength(text) {
  return typeof text === "string" ? new TextEncoder().encode(text).length : 0;
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

/** File extensions whose contents a model receives as a converted document, not as text. */
export const BINARY_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "heic", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "zip", "gz", "tar", "woff", "woff2", "ttf", "otf", "mp3", "mp4", "mov", "wav"]);

const BASE64_RUN = /[A-Za-z0-9+/]{400,}={0,2}/;
const BINARY_NOISE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F�]/g;

/**
 * Whether a tool result is a binary document. Deliberately conservative: BOTH
 * the target's extension (`Read foo.pdf`, `cat logo.png`) AND the result text
 * must agree, because transcripts never say what a tool returned: a base64
 * run inside a `.pdf` read is the document, the same run inside a `.ts` read
 * is a data URI the text ratio handles fine. The text test accepts the two
 * shapes seen in the wild: a base64 payload (Claude's `document` content
 * part) or raw bytes decoded as UTF-8 (a `cat` of the file: control
 * characters and U+FFFD replacement characters).
 */
export function detectBinary(text, { target } = {}) {
  if (typeof text !== "string" || text.length < 400 || typeof target !== "string") return false;
  const ext = target.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext || !BINARY_EXTENSIONS.has(ext)) return false;
  const sample = text.slice(0, 20_000);
  if (BASE64_RUN.test(sample)) return true;
  const noise = (sample.match(BINARY_NOISE) || []).length;
  return noise / sample.length > 0.02;
}

/** The `kind` of a block: `binary` when the target and the content agree, else prose/code. */
export function detectBlockKind(text, { target } = {}) {
  return detectBinary(text, { target }) ? "binary" : detectKind(text);
}

export function createEstimator(calibration) {
  const neutral = calibration.neutral.bytesPerToken;
  const binary = calibration.binary?.bytesPerToken;
  const vendors = calibration.vendors;
  const envelopeSets = new Map(Object.entries(vendors).map(([vendor, cal]) => [vendor, new Set(cal.envelopeCategories ?? [])]));

  function calibrationFor(vendor) {
    return (vendor && vendors[vendor]) || null;
  }

  function categoryScaleFor(cal, category) {
    const scale = cal.categoryScale;
    if (!category) return scale.other ?? 1;
    if (category.startsWith("tool_result.") || category === "subagent_handoff") return scale.toolResult ?? 1;
    if (category === "tool_call") return scale.toolCall ?? 1;
    return scale.other ?? 1;
  }

  function estimateTokensFromBytes(bytes, kind = "prose", { vendor, category } = {}) {
    if (!bytes) return 0;
    const cal = calibrationFor(vendor);
    const ratios = cal?.bytesPerToken ?? neutral;
    // A binary document is converted by the vendor before tokenizing, so the text ratios do not apply;
    // the envelope and category scale are per message, not per content, and still do.
    const ratio = kind === "binary" && binary ? binary : kind === "code" ? ratios.code : ratios.prose;
    const base = Math.ceil(bytes / ratio);
    if (!cal) return base;
    let tokens = base;
    if (cal.categoryScale) tokens = Math.max(1, Math.round(base * categoryScaleFor(cal, category)));
    if (cal.envelopeTokens && category && envelopeSets.get(vendor).has(category)) tokens += cal.envelopeTokens;
    return tokens;
  }

  /**
   * Token estimate of a piece of text on its own (no message envelope): per
   * vendor calibration and the neutral ratio. `kind` "auto" detects prose/code.
   */
  function tokenReport(text, { kind = "auto" } = {}) {
    const source = typeof text === "string" ? text : "";
    const bytes = byteLength(source);
    const resolved = kind === "prose" || kind === "code" ? kind : detectKind(source);
    return {
      bytes,
      chars: source.length,
      lines: source ? source.split("\n").length - (source.endsWith("\n") ? 1 : 0) : 0,
      kind: resolved,
      tokens: {
        claude: estimateTokensFromBytes(bytes, resolved, { vendor: "claude" }),
        codex: estimateTokensFromBytes(bytes, resolved, { vendor: "codex" }),
        neutral: estimateTokensFromBytes(bytes, resolved),
      },
    };
  }

  /**
   * The basis a single number for a file rests on: the file's vendor when it
   * has exactly one calibrated vendor, the larger of its calibrated vendors
   * when it has several (conservative: a budget that passes on the larger
   * figure passes on both), `neutral` when none of its vendors is calibrated
   * (gemini, or no vendor at all).
   */
  function basisFor(vendorList) {
    const calibrated = [...new Set(Array.isArray(vendorList) ? vendorList : [])].filter((vendor) => Boolean(calibrationFor(vendor))).sort();
    if (!calibrated.length) return "neutral";
    if (calibrated.length === 1) return calibrated[0];
    return `max(${calibrated.join(",")})`;
  }

  /** Picks `estTokens` + `estBasis` out of a per-vendor table for the vendors that load the file. */
  function pickEstimate(estTokensBy, vendorList) {
    const estBasis = basisFor(vendorList);
    if (estBasis === "neutral") return { estTokens: estTokensBy.neutral ?? 0, estBasis };
    if (!estBasis.startsWith("max(")) return { estTokens: estTokensBy[estBasis] ?? estTokensBy.neutral ?? 0, estBasis };
    const vendorsIn = estBasis.slice(4, -1).split(",");
    return { estTokens: Math.max(...vendorsIn.map((vendor) => estTokensBy[vendor] ?? 0)), estBasis };
  }

  /**
   * ONE estimate per inventoried file (instruction files, skills, agents):
   * the same `tokenReport` arithmetic as `contextscope tokens` (so the two
   * agree to the token), kept per vendor in `estTokensBy`, plus the single
   * backwards-compatible `estTokens` chosen by `pickEstimate`.
   */
  function estimateByVendor(text, { vendors: vendorList = [], kind = "auto" } = {}) {
    const report = tokenReport(text, { kind });
    return { estKind: report.kind, estTokensBy: report.tokens, ...pickEstimate(report.tokens, vendorList) };
  }

  /** The per-vendor figure of a row produced by `estimateByVendor` (falls back to its single number). */
  function estTokensFor(row, vendor) {
    if (!row) return 0;
    const basis = basisFor([vendor]);
    const value = row.estTokensBy?.[basis];
    return typeof value === "number" ? value : (row.estTokens ?? 0);
  }

  return { calibrationFor, estimateTokensFromBytes, tokenReport, basisFor, pickEstimate, estimateByVendor, estTokensFor };
}
