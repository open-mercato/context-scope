/**
 * Reconciliation v2 (ADR-001 section 3.1 as amended by ADR-002 A and D).
 *
 * The transcript gives per-block sizes we can only estimate; the vendor gives
 * per-request totals that are exact. The composition stack is scaled so it
 * always sums to the exact total, and everything the total contains that the
 * transcript cannot explain is split into three named parts:
 *
 *   system        hidden system prompt + tool schemas, capped at the vendor baseline
 *   instructions  the setup chain estimate (main scope only)
 *   unlogged      input that is not in the transcript: resumed history, hidden
 *                 injections, tool schemas beyond the baseline
 *
 * Per compaction segment the hidden base H0 = T[i0] - est[i0] is split in that
 * order; per request k = (T - base) / est is clamped to [K_MIN, K_MAX] and the
 * remainder r goes to `unlogged` (or, when negative, shrinks `system`, then
 * `instructions`, then k itself; the request is then flagged
 * `reconciled: "rebased"` so no category is ever negative). Three consecutive
 * out-of-band requests on the same side whose residuals agree (each at least
 * STEP_MIN, spread within 25% of the median) re-derive the base (symmetric:
 * hidden mass can shrink after a model switch); the step is recorded as
 * `request.baseChange` and `scope.baseSteps` and the three requests are
 * recomputed with the new base.
 *
 * Two deliberate deviations from the ADR-002 text:
 * - STEP_MIN uses min(window, scope peak) instead of the window alone, so a
 *   33k injection in a 100k subagent on a 1M window is still a step (5% of 1M
 *   would hide it).
 * - The step magnitude is measured at a reference k (the median in-band k of
 *   the scope so far, 1 before any exists), not at the clamp bound: the
 *   clamp-bound residual shrinks by (K_MAX - 1) x est as blocks accumulate, so
 *   the three residuals rarely agree and the step, when found, is short by
 *   half the visible estimate. Detection still requires three consecutive
 *   out-of-band requests, so in-band estimator bias never becomes a step.
 *
 * Visibility is a sweep line (section D): events at firstRequest and
 * lastRequest + 1 with running per-category sums, O(B + R x C) instead of
 * O(R x B). Adapters guarantee dense request indices (requests[j].index === j);
 * `sweep` throws otherwise.
 *
 * Input scope shape (from adapters):
 *   requests[]:    { index, usage: { input, cacheCreation?, cacheRead, output, total } }
 *   blocks[]:      { id, category, estTokens, firstRequest, lastRequest?, droppedBy?, preservedBy? }
 *   compactions[]: { id, atRequest, summaryBlockId? }
 * Mutates requests in place: hiddenBase, scale, scaleRaw, composition,
 * newBlockIds, deltaCheck, baseChange?, reconciled?, visibleBlockIds
 * (optional). Sets scope.{estimatorErrorMedian, estimatorErrorP95,
 * clampedRequests, unloggedShare, baseSteps, resumed, transcriptIncomplete}.
 * Returns { errors, clamped, unloggedShare, baseSteps }.
 *
 * Thresholds: the reconcile* keys below are read from `options.thresholds`
 * when present (rules/thresholds.json should carry them) and default to
 * RECONCILE_DEFAULTS otherwise.
 */
import { CATEGORIES } from "./categories.mjs";

const EXCLUDED_FROM_OCCUPANCY = new Set(["assistant_thinking"]);
const HIDDEN = new Set(["system", "instructions", "unlogged"]);
const CATEGORY_INDEX = new Map(CATEGORIES.map((category, index) => [category, index]));

export const RECONCILE_DEFAULTS = {
  reconcileScaleMin: 0.6,
  reconcileScaleMax: 1.5,
  reconcileStepMinTokens: 10_000,
  reconcileStepWindowShare: 0.05,
  reconcileStepRun: 3,
  reconcileStepSpread: 0.25,
  transcriptIncompleteUnloggedShare: 0.8,
  transcriptIncompleteNewBlockShare: 0.2,
};

export function resolveThresholds(thresholds) {
  const out = { ...RECONCILE_DEFAULTS };
  for (const key of Object.keys(RECONCILE_DEFAULTS)) {
    const value = thresholds?.[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export function applyCompactionPresence(scope) {
  // Blocks emitted before a compaction boundary leave the window at that boundary,
  // except the compaction summary itself and blocks the vendor says it preserved.
  for (const compaction of scope.compactions ?? []) {
    for (const block of scope.blocks) {
      if (block.id === compaction.summaryBlockId) continue;
      if (block.preservedBy === compaction.id) continue;
      if (block.firstRequest < compaction.atRequest && (block.lastRequest === undefined || block.lastRequest >= compaction.atRequest)) {
        block.lastRequest = compaction.atRequest - 1;
        block.droppedBy = compaction.id;
      }
    }
  }
}

/**
 * Sweep line over presence windows. Returns per-request visible estimate,
 * per-category visible estimate (Float64Array indexed by CATEGORIES), the
 * blocks that become visible at each request (`addAt`) and every block whose
 * firstRequest is that request (`newAt`, thinking included, for newBlockIds).
 */
export function sweep(scope) {
  const requests = scope.requests;
  const n = requests.length;
  for (let j = 0; j < n; j += 1) {
    if (requests[j].index !== j) throw new Error(`reconcile: request indices must be dense (got ${requests[j].index} at position ${j})`);
  }
  const addAt = Array.from({ length: n + 1 }, () => []);
  const removeAt = Array.from({ length: n + 1 }, () => []);
  const newAt = Array.from({ length: n + 1 }, () => []);
  for (const block of scope.blocks) {
    const first = block.firstRequest;
    if (!Number.isInteger(first) || first < 0 || first >= n) continue;
    newAt[first].push(block);
    if (EXCLUDED_FROM_OCCUPANCY.has(block.category)) continue;
    const last = block.lastRequest === undefined ? n - 1 : Math.min(block.lastRequest, n - 1);
    if (last < first) continue; // empty presence window (in flight at a compaction)
    addAt[first].push(block);
    removeAt[last + 1].push(block);
  }
  const width = CATEGORIES.length;
  const running = new Float64Array(width);
  const est = new Float64Array(n);
  const estByCat = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    for (const block of addAt[i]) { running[categoryIndex(block.category)] += block.estTokens; total += block.estTokens; }
    for (const block of removeAt[i]) { running[categoryIndex(block.category)] -= block.estTokens; total -= block.estTokens; }
    est[i] = total;
    estByCat[i] = running.slice();
  }
  return { est, estByCat, addAt, removeAt, newAt };
}

function categoryIndex(category) {
  const index = CATEGORY_INDEX.get(category);
  return index === undefined ? CATEGORY_INDEX.get("other") : index;
}

export function reconcileScope(scope, options = {}) {
  scope.compactions ??= [];
  applyCompactionPresence(scope);
  return reconcileWithEstimates(scope, sweep(scope), options);
}

/** Reconciliation arithmetic over precomputed visibility (used by the equivalence test with a brute-force sweep). */
export function reconcileWithEstimates(scope, { est, estByCat, addAt, removeAt, newAt }, {
  instructionTokensEstimate = 0,
  keepVisibleIds = false,
  vendor,
  window,
  systemBaseline,
  thresholds,
} = {}) {
  const requests = scope.requests;
  const n = requests.length;
  const T = resolveThresholds(thresholds);
  const K_MIN = T.reconcileScaleMin;
  const K_MAX = T.reconcileScaleMax;
  const STEP_RUN = Math.max(1, Math.round(T.reconcileStepRun));
  const baseline = Number.isFinite(systemBaseline) ? Math.max(0, systemBaseline) : defaultBaseline(vendor, scope);
  const instructionsEstimate = Math.max(0, instructionTokensEstimate || 0);

  const result = { errors: [], clamped: 0, unloggedShare: 0, baseSteps: [] };
  if (!n) {
    Object.assign(scope, { estimatorErrorMedian: 0, estimatorErrorP95: 0, clampedRequests: 0, unloggedShare: 0, baseSteps: [], resumed: false, transcriptIncomplete: false });
    return result;
  }

  let peak = 0;
  for (const request of requests) peak = Math.max(peak, request.usage.total);
  const stepScale = Math.min(Number.isFinite(window) && window > 0 ? window : Infinity, peak);
  const STEP_MIN = Math.max(T.reconcileStepMinTokens, T.reconcileStepWindowShare * (Number.isFinite(stepScale) ? stepScale : 0));

  const errAt = new Array(n).fill(null);
  const clampedAt = new Uint8Array(n);
  const unloggedAt = new Float64Array(n);
  const baseSteps = [];
  const inBand = [];                       // in-band kRaw values seen so far (reference k for step magnitudes)
  let resumed = false;

  const starts = [...new Set([0, ...scope.compactions.map((c) => c.atRequest).filter((at) => Number.isInteger(at) && at > 0 && at < n)])].sort((a, b) => a - b);
  for (let s = 0; s < starts.length; s += 1) {
    const segStart = starts[s];
    const segEnd = s + 1 < starts.length ? starts[s + 1] : n;
    const T0 = requests[segStart].usage.total;
    const H0 = Math.max(0, T0 - est[segStart]);
    let system = Math.min(H0, baseline);
    let instr = Math.min(H0 - system, instructionsEstimate);
    let U = H0 - system - instr;
    if (segStart === 0) resumed = U > 0.5 * T0;
    let recent = [];                       // step residuals of consecutive out-of-band requests
    let rewinds = 0;
    let i = segStart;
    while (i < segEnd) {
      const request = requests[i];
      const total = request.usage.total;
      const visible = est[i];
      const base = system + instr + U;
      const kRaw = visible > 0 ? (total - base) / visible : 1;
      const k = Math.min(K_MAX, Math.max(K_MIN, kRaw));
      const r = total - base - k * visible;

      // Persistent step detection (symmetric), then recompute the run with the new base.
      const side = visible > 0 ? (kRaw > K_MAX ? 1 : kRaw < K_MIN ? -1 : 0) : Math.sign(total - base);
      if (i === segStart || side === 0) {
        recent = [];
        if (visible > 0 && i !== segStart) inBand.push(kRaw);
      } else {
        const kRef = inBand.length >= 3 ? median(inBand.slice(-20)) : 1;
        recent.push(total - base - kRef * visible);
        if (recent.length > STEP_RUN) recent.shift();
      }
      if (recent.length === STEP_RUN && rewinds < 2 * (segEnd - segStart)) {
        const sign = Math.sign(recent[recent.length - 1]);
        if (sign !== 0 && recent.every((x) => Math.abs(x) >= STEP_MIN && Math.sign(x) === sign)) {
          const med = median(recent);
          const spread = (Math.max(...recent) - Math.min(...recent)) / Math.abs(med);
          if (spread <= T.reconcileStepSpread) {
            const step = Math.round(med);
            if (U + step < 0) { system = Math.max(0, system + U + step); U = 0; } else { U += step; }
            const at = i - STEP_RUN + 1;
            requests[at].baseChange = { tokens: step, provenance: "derived.exact" };
            const existing = baseSteps.findIndex((entry) => entry.atRequest === at);
            if (existing >= 0) baseSteps[existing] = { atRequest: at, delta: step }; else baseSteps.push({ atRequest: at, delta: step });
            recent = [];
            rewinds += 1;
            i = at;
            continue;
          }
        }
      }

      // Split the remainder; never let a category go negative.
      let systemI = system;
      let instrI = instr;
      let unloggedI;
      let kEff = k;
      let rebased = false;
      if (U + r >= 0) {
        unloggedI = U + r;
      } else {
        unloggedI = 0;
        const short = -(U + r);
        if (short <= system) systemI = system - short;
        else if (short - system <= instr) { systemI = 0; instrI = instr - (short - system); }
        else { systemI = 0; instrI = 0; kEff = visible > 0 ? total / visible : 0; rebased = true; }
      }
      systemI = Math.round(systemI);
      instrI = Math.round(instrI);
      unloggedI = Math.round(unloggedI);

      const composition = {};
      if (systemI > 0) composition.system = systemI;
      if (instrI > 0) composition.instructions = instrI;
      if (unloggedI > 0) composition.unlogged = unloggedI;
      let assigned = systemI + instrI + unloggedI;
      let largest = null;
      let largestValue = -1;
      const byCat = estByCat[i];
      for (let c = 0; c < byCat.length; c += 1) {
        if (byCat[c] <= 0) continue;
        const category = CATEGORIES[c];
        const value = Math.round(byCat[c] * kEff);
        composition[category] = (composition[category] ?? 0) + value;
        assigned += value;
        if (byCat[c] > largestValue) { largestValue = byCat[c]; largest = category; }
      }
      // Rounding correction: the stack must sum to the exact vendor total.
      const correction = total - assigned;
      if (correction !== 0) {
        const target = largest ?? (composition.unlogged ? "unlogged" : composition.system ? "system" : composition.instructions ? "instructions" : "other");
        composition[target] = (composition[target] ?? 0) + correction;
        if (composition[target] < 0) { composition[target] = 0; rebalance(composition, total); }
      }
      for (const key of Object.keys(composition)) if (composition[key] === 0 && !HIDDEN.has(key)) delete composition[key];

      request.hiddenBase = { value: systemI + instrI + unloggedI, provenance: "estimated.local" };
      request.scale = round4(kEff);
      request.scaleRaw = round4(kRaw);
      request.composition = composition;
      if (rebased) request.reconciled = "rebased"; else delete request.reconciled;
      request.newBlockIds = newAt[i].map((block) => block.id);
      if (request.usage.cacheCreation !== undefined && i > segStart) {
        let newEstimate = 0;
        for (const block of addAt[i]) newEstimate += block.estTokens;
        request.deltaCheck = (request.usage.input + request.usage.cacheCreation) - newEstimate;
      } else {
        delete request.deltaCheck;
      }
      unloggedAt[i] = unloggedI;
      if (visible > 0 && i > segStart) {
        if (kRaw >= K_MIN && kRaw <= K_MAX && !rebased) { errAt[i] = Math.abs(1 - kRaw); clampedAt[i] = 0; }
        else { errAt[i] = null; clampedAt[i] = 1; }
      } else { errAt[i] = null; clampedAt[i] = 0; }
      i += 1;
    }
  }

  if (keepVisibleIds) {
    const live = new Set();
    for (let i = 0; i < n; i += 1) {
      for (const block of addAt[i]) live.add(block.id);
      for (const block of removeAt[i]) live.delete(block.id);
      requests[i].visibleBlockIds = [...live];
    }
  }

  let sumTotal = 0;
  let sumUnlogged = 0;
  let withNewBlocks = 0;
  for (let i = 0; i < n; i += 1) {
    sumTotal += requests[i].usage.total;
    sumUnlogged += unloggedAt[i];
    if (addAt[i].length) withNewBlocks += 1;
    if (errAt[i] !== null) result.errors.push(errAt[i]);
    if (clampedAt[i]) result.clamped += 1;
  }
  result.unloggedShare = sumTotal > 0 ? round4(sumUnlogged / sumTotal) : 0;
  result.baseSteps = baseSteps.sort((a, b) => a.atRequest - b.atRequest);
  scope.estimatorErrorMedian = round4(percentile(result.errors, 50));
  scope.estimatorErrorP95 = round4(percentile(result.errors, 95));
  scope.clampedRequests = result.clamped;
  scope.unloggedShare = result.unloggedShare;
  scope.baseSteps = result.baseSteps;
  scope.resumed = resumed;
  scope.transcriptIncomplete = result.unloggedShare > T.transcriptIncompleteUnloggedShare && withNewBlocks / n < T.transcriptIncompleteNewBlockShare;
  return result;
}

function defaultBaseline(vendor, scope) {
  if (vendor === "codex") {
    const hasBase = scope.blocks.some((block) => block.category === "system" && block.label === "base_instructions");
    return hasBase ? 0 : 8_000;
  }
  return 25_000;
}

/** Defensive: after zeroing a negative category, push the remaining difference into the largest positive one. */
function rebalance(composition, total) {
  let assigned = 0;
  let largest = null;
  for (const [key, value] of Object.entries(composition)) {
    assigned += value;
    if (largest === null || value > composition[largest]) largest = key;
  }
  const diff = total - assigned;
  if (diff !== 0 && largest !== null) composition[largest] = Math.max(0, composition[largest] + diff);
}

function round4(value) { return Number(value.toFixed(4)); }

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
