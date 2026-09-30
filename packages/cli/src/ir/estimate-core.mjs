/**
 * The estimator without I/O: the same arithmetic as estimate.mjs over a
 * calibration object passed in, so the browser (the Tokens screen) and the CLI
 * (`contextscope tokens`, the adapters) compute identical numbers.
 * estimate.mjs binds it to src/ir/calibration.json.
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

export function createEstimator(calibration) {
  const neutral = calibration.neutral.bytesPerToken;
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
    const base = Math.ceil(bytes / (kind === "code" ? ratios.code : ratios.prose));
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

  return { calibrationFor, estimateTokensFromBytes, tokenReport };
}
