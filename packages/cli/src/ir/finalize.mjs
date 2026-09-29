/**
 * Turns an adapter's raw run into a finished Run: reconciles every scope
 * (reconciliation v2, sweep line), computes peaks, per-scope totals, handoff
 * ratios, active time, coverage, and the RunSummary used by the overview.
 *
 * Coverage numbers (ADR-002 A): `run.coverage.estimatorError*`,
 * `clampedRequests` and `unloggedShare` are the MAIN scope's numbers; every
 * scope carries its own on `scope.estimatorErrorMedian/P95`, `clampedRequests`,
 * `unloggedShare`, `baseSteps`, `resumed`, `transcriptIncomplete`.
 *
 * Window (ADR-002 H.2): when the observed peak exceeds an estimated table
 * value, the window becomes the smallest documented Claude window >= peak from
 * {200k, 1M} labelled `derived.exact` with `lowerBound: peak`; when no
 * documented window fits, the peak itself is kept and labelled `unknown`.
 *
 * Forecast (ADR-003 section 3): after the window is settled every scope gets
 * `scope.forecast` from `forecastScope` (slope over the last requests of the
 * current compaction segment against the auto-compaction threshold), or none.
 *
 * Per-tool cost (ADR-005 section 5): after reconciliation every scope gets
 * `scope.toolCost`, the token-requests each tool's blocks cost over their
 * presence window (`toolCostOf`), and the run summary carries the merged
 * table (`summary.toolCost`). Unit `token-requests`, provenance
 * `estimated.local`; see TOOL_COST_CAVEATS for what the number is not.
 */
import { percentile, reconcileScope } from "./reconcile.mjs";
import { CALIBRATION, ESTIMATOR_VERSION, CALIBRATION_VERSION, systemBaselineFor } from "./estimate.mjs";

const ACTIVE_GAP_MS = 30 * 60 * 1000;
const DOCUMENTED_WINDOWS = [200_000, 1_000_000];
/** Forecast (ADR-003 section 3): slope over the last FORECAST_BASIS requests of a segment with at least FORECAST_MIN_REQUESTS. */
export const FORECAST_BASIS = 20;
export const FORECAST_MIN_REQUESTS = 8;
/** Documented working assumption when the calibration has no evidence for a (vendor, window) pair. */
export const FORECAST_DEFAULT_SHARE = 0.95;
/** A calibrated share is used only when it rests on at least this many auto-compactions. */
export const FORECAST_MIN_CALIBRATION_EVENTS = 3;
/** Beyond these the forecast is reported as `status: "flat"` (no compaction expected at this rate). */
export const FORECAST_FLAT_MINUTES = 24 * 60;
export const FORECAST_FLAT_REQUESTS = 1_000;

/** Per-tool cost (ADR-005 section 5): unit, provenance, table size and the caveats printed next to the number. */
export const TOOL_COST_UNIT = "token-requests";
export const TOOL_COST_PROVENANCE = "estimated.local";
export const TOOL_COST_TOP = 8;
export const TOOL_COST_CAVEATS = Object.freeze([
  "Presence is not attention: a block counts for every request it sits in, whether the model used it or not.",
  "A cached token costs roughly a tenth of a fresh one on Claude; `uncached` weights each request by its uncached share and sits next to token-requests.",
  "Residue of blocks dropped at a compaction lives inside the compaction summary and is attributed to the summary, not to the tool.",
  "Clamped requests use the clamped scale k.",
]);
/** Row name for subagent handoffs and for blocks with no tool name. */
export const TOOL_COST_HANDOFFS = "Agent handoffs";
export const TOOL_COST_OTHER = "other";

export function finalizeRun(run, { instructionTokensEstimate = 0, thresholds } = {}) {
  const vendor = run.vendor;
  const window = run.window?.value;
  for (const scope of run.scopes) {
    const hasBaseInstructionsBlock = vendor === "codex" && scope.blocks.some((block) => block.category === "system" && block.label === "base_instructions");
    reconcileScope(scope, {
      instructionTokensEstimate: scope.kind === "main" ? instructionTokensEstimate : 0,
      vendor,
      window,
      systemBaseline: systemBaselineFor(vendor, { hasBaseInstructionsBlock }),
      thresholds,
    });
    finalizeScope(scope);
    scope.toolCost = rankToolCost(toolCostGroups(scope), scope.processedInputTokens);
  }
  const main = run.scopes[0];
  for (const scope of run.scopes) {
    if (scope.kind !== "subagent" || !scope.handoff) continue;
    const handoffTokens = scope.handoff.tokens.value;
    scope.handoff.compressionRatio = {
      value: handoffTokens > 0 ? Number((scope.peak.value / handoffTokens).toFixed(2)) : 0,
      provenance: "derived.exact",
    };
  }
  const timestamps = run.scopes.flatMap((scope) => scope.requests.map((request) => Date.parse(request.at))).filter(Number.isFinite).sort((a, b) => a - b);
  run.activeMs = activeTime(timestamps);
  if (!run.startedAt && timestamps.length) run.startedAt = new Date(timestamps[0]).toISOString();
  if (!run.endedAt && timestamps.length) run.endedAt = new Date(timestamps[timestamps.length - 1]).toISOString();
  run.coverage = {
    ...run.coverage,
    requests: run.scopes.reduce((sum, scope) => sum + scope.requests.length, 0),
    estimatorErrorMedian: main.estimatorErrorMedian ?? 0,
    estimatorErrorP95: main.estimatorErrorP95 ?? 0,
    clampedRequests: main.clampedRequests ?? 0,
    unloggedShare: main.unloggedShare ?? 0,
    estimatorVersion: ESTIMATOR_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
  };
  const maxPeak = Math.max(0, ...run.scopes.map((scope) => scope.peak.value));
  if (maxPeak > run.window.value && run.window.provenance === "estimated.local") {
    run.window = roundWindow(maxPeak);
  }
  // The forecast needs the final window, so it runs after the window is settled.
  attachForecasts(run);
  run.summary = summarize(run);
  return run;
}

/** Per-scope forecasts against the run's own auto compactions (or the calibrated threshold). */
export function attachForecasts(run) {
  const autoCompactions = run.scopes.flatMap((scope) => scope.compactions ?? []).filter((c) => c.trigger === "auto" && c.preTokens?.value > 0);
  for (const scope of run.scopes) {
    const forecast = forecastScope(scope, { vendor: run.vendor, window: run.window.value, compactions: autoCompactions });
    if (forecast) scope.forecast = forecast;
    else delete scope.forecast;
  }
  return run;
}

/**
 * Re-derives what a capture join can change after `finalizeRun` (compaction
 * triggers, subagent status/timing): the forecast's auto-compaction filter and
 * the summary. Reconciliation is not repeated; peaks and totals do not move.
 */
export function refinalizeRun(run) {
  if (!run || !Array.isArray(run.scopes) || !run.scopes.length) return run;
  attachForecasts(run);
  run.summary = { ...summarize(run), findingIds: run.summary?.findingIds ?? [] };
  return run;
}

/** Least-squares slope of `ys` over `xs` (0 when the xs do not spread). */
export function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : 0;
}

/**
 * Calibrated auto-compaction share for one (vendor, window) pair
 * (`calibration.json` `autoCompact.<vendor>.byWindow[<window>]`), or null when
 * the corpus holds fewer than FORECAST_MIN_CALIBRATION_EVENTS events for it.
 */
export function calibratedShareFor(vendor, window) {
  const table = CALIBRATION.autoCompact?.[vendor]?.byWindow;
  const entry = table && typeof table === "object" ? table[String(window)] : undefined;
  if (!entry || !(entry.share > 0) || !(entry.events >= FORECAST_MIN_CALIBRATION_EVENTS)) return null;
  return { share: entry.share, events: entry.events, min: entry.min, max: entry.max, inferred: Boolean(entry.inferred) };
}

/**
 * Auto-compaction threshold for a run: the median `preTokens` of its own auto
 * compactions when it has any, else the calibrated share of the window for
 * this window size (`estimated.local`), else the documented default share.
 *
 * Provenance: `observed.vendor` only when every compaction's preTokens was
 * reported by the vendor (Claude compactMetadata). A Codex "auto" trigger is
 * inferred (>= 0.75 x window) and its preTokens is the previous request's
 * total, so a Codex threshold is `estimated.local` until an auto-compaction is
 * actually observed. `basis` says where the number comes from.
 */
export function compactionThreshold({ vendor, window, compactions = [] }) {
  const observed = compactions.map((c) => c.preTokens.value).filter((v) => Number.isFinite(v) && v > 0);
  if (observed.length) {
    const reported = compactions.every((c) => c.preTokens?.provenance === "observed.vendor");
    const provenance = reported ? "observed.vendor" : "estimated.local";
    const kind = reported ? "own-compactions" : "own-compactions-inferred";
    return { value: Math.round(percentile(observed, 50)), provenance, basis: { kind, events: observed.length, min: Math.min(...observed), max: Math.max(...observed), window: window > 0 ? window : undefined } };
  }
  if (!(window > 0)) return null;
  const calibrated = calibratedShareFor(vendor, window);
  if (calibrated) {
    return {
      value: Math.round(window * calibrated.share),
      provenance: "estimated.local",
      basis: { kind: calibrated.inferred ? "calibration-inferred" : "calibration", events: calibrated.events, min: Math.round(window * calibrated.min), max: Math.round(window * calibrated.max), share: calibrated.share, window },
    };
  }
  return { value: Math.round(window * FORECAST_DEFAULT_SHARE), provenance: "estimated.local", basis: { kind: "default", events: 0, share: FORECAST_DEFAULT_SHARE, window } };
}

/**
 * Active-time axis in minutes for a sample of requests: like `activeTime`,
 * a gap of ACTIVE_GAP_MS or more (a break, a resumed session) is not wall
 * time the user worked. It is replaced by the median active gap of the
 * sample (one typical step; zero when the sample has no active gap) so the
 * per-minute slope describes the pace while the user works and a break does
 * not stretch the countdown. Null when a timestamp is missing.
 */
export function activeMinutesAxis(requests) {
  const times = requests.map((r) => Date.parse(r.at));
  if (!times.every(Number.isFinite)) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
  const active = gaps.filter((gap) => gap > 0 && gap < ACTIVE_GAP_MS);
  const typical = active.length ? percentile(active, 50) : 0;
  const axis = [0];
  for (const gap of gaps) axis.push(axis[axis.length - 1] + (gap > 0 && gap < ACTIVE_GAP_MS ? gap : typical) / 60_000);
  return axis;
}

/**
 * Compaction forecast for one scope (ADR-003 section 3): over the last
 * FORECAST_BASIS requests of the current segment (after the last compaction),
 * the least-squares slope of usage.total by request index and by ACTIVE
 * minute (gaps >= 30 min excluded, as in `activeTime`); requests and minutes
 * left until the threshold. Returns undefined when the segment is shorter
 * than FORECAST_MIN_REQUESTS, the slope is not positive, the threshold is
 * unknown, or the scope already sits above it. `status` is "flat" when the
 * threshold is further away than FORECAST_FLAT_REQUESTS requests or
 * FORECAST_FLAT_MINUTES active minutes: no compaction expected at this rate.
 * The forecast is stored for every scope; the server serves it for live runs only.
 */
export function forecastScope(scope, { vendor, window, compactions = [], basis = FORECAST_BASIS, minRequests = FORECAST_MIN_REQUESTS } = {}) {
  const requests = scope.requests ?? [];
  const last = scope.compactions?.length ? scope.compactions[scope.compactions.length - 1].atRequest : 0;
  const segmentStart = Math.max(0, Math.min(requests.length, last));
  const segment = requests.slice(segmentStart);
  if (segment.length < minRequests) return undefined;
  const threshold = compactionThreshold({ vendor, window, compactions });
  if (!threshold || !(threshold.value > 0)) return undefined;
  const sample = segment.slice(-basis);
  const indices = sample.map((r) => r.index);
  const totals = sample.map((r) => r.usage.total);
  const perRequest = slope(indices, totals);
  if (!(perRequest > 0)) return undefined;
  const current = totals[totals.length - 1];
  if (!(current < threshold.value)) return undefined;
  const axis = activeMinutesAxis(sample);
  let perMinute = axis ? slope(axis, totals) : 0;
  if (!(perMinute > 0)) {
    // Flat or missing timestamps: derive the rate from the cadence instead of a time regression.
    const span = axis ? axis[axis.length - 1] - axis[0] : 0;
    perMinute = span > 0 ? perRequest * ((sample.length - 1) / span) : 0;
  }
  const remaining = threshold.value - current;
  const round = (value) => Number(value.toFixed(1));
  const requestsLeft = round(remaining / perRequest);
  const minutesLeft = perMinute > 0 ? round(remaining / perMinute) : 0;
  const flat = requestsLeft > FORECAST_FLAT_REQUESTS || minutesLeft > FORECAST_FLAT_MINUTES;
  return {
    threshold,
    perRequest: round(perRequest),
    perMinute: round(perMinute),
    requestsLeft,
    minutesLeft,
    basis: { requests: sample.length, from: indices[0], to: indices[indices.length - 1] },
    provenance: "derived.exact",
    status: flat ? "flat" : "ok",
  };
}

export function finalizeScope(scope) {
  let peak = 0;
  let processed = 0;
  let output = 0;
  for (const request of scope.requests) {
    peak = Math.max(peak, request.usage.total);
    processed += request.usage.total;
    output += request.usage.output;
  }
  scope.peak = { value: peak, provenance: "observed.vendor" };
  scope.processedInputTokens = processed;
  scope.outputTokens = output;
  scope.toolCalls = scope.blocks.filter((block) => block.category === "tool_call").length;
  scope.models = [...new Set(scope.requests.map((request) => request.model).filter(Boolean))];
  scope.depth ??= scope.kind === "main" ? 0 : 1;
  scope.status ??= "unknown";
  return scope;
}

export function activeTime(sortedTimestamps) {
  let active = 0;
  for (let i = 1; i < sortedTimestamps.length; i += 1) {
    const gap = sortedTimestamps[i] - sortedTimestamps[i - 1];
    if (gap > 0 && gap < ACTIVE_GAP_MS) active += gap;
  }
  return active;
}

/** Smallest documented window that covers an observed peak; never invents a larger step. */
export function roundWindow(peak) {
  const step = DOCUMENTED_WINDOWS.find((value) => value >= peak);
  if (step !== undefined) return { value: step, provenance: "derived.exact", lowerBound: peak };
  return { value: peak, provenance: "unknown", lowerBound: peak };
}

export function summarize(run) {
  const main = run.scopes[0];
  const scopes = run.scopes;
  const requests = scopes.reduce((sum, scope) => sum + scope.requests.length, 0);
  const processed = scopes.reduce((sum, scope) => sum + scope.processedInputTokens, 0);
  const cacheRead = scopes.reduce((sum, scope) => sum + scope.requests.reduce((s, r) => s + (r.usage.cacheRead ?? 0), 0), 0);
  const outputTokens = scopes.reduce((sum, scope) => sum + scope.outputTokens, 0);
  const peakRequest = main.requests.reduce((best, request) => (!best || request.usage.total > best.usage.total ? request : best), null);
  const topBlocks = scopes.flatMap((scope) => scope.blocks.map((block) => ({ id: block.id, scopeId: scope.id, category: block.category, estTokens: block.estTokens, firstRequest: block.firstRequest, tool: block.tool?.name, label: block.label })))
    .filter((block) => block.category !== "assistant_thinking")
    .sort((a, b) => b.estTokens - a.estTokens)
    .slice(0, 10);
  return {
    requests,
    turns: main.requests.length ? Math.max(...main.requests.map((request) => request.turn ?? 0)) : 0,
    processedInputTokens: processed,
    outputTokens,
    cacheReadShare: processed > 0 ? Number((cacheRead / processed).toFixed(4)) : 0,
    peak: main.peak,
    peakShareOfWindow: run.window.value > 0 ? Number((main.peak.value / run.window.value).toFixed(4)) : 0,
    compactions: scopes.reduce((sum, scope) => sum + scope.compactions.length, 0),
    subagents: scopes.length - 1,
    toolCalls: scopes.reduce((sum, scope) => sum + scope.toolCalls, 0),
    models: [...new Set(scopes.flatMap((scope) => scope.models))],
    topBlocks,
    findingIds: run.summary?.findingIds ?? [],
    compositionAtPeak: peakRequest?.composition ?? {},
    // What the main scope held on its last request: the state the session ended in (Overview "context at session end").
    compositionAtEnd: main.requests.at(-1)?.composition ?? {},
    toolCost: rankToolCost(mergeToolCostGroups(scopes.map((scope) => (Array.isArray(scope.blocks) && Array.isArray(scope.requests) ? toolCostGroups(scope) : groupsFromRows(scope.toolCost)))), processed),
  };
}

// ---------- per-tool cost (ADR-005 section 5) ----------

/** Row identity for one block: `{ name, kind, server? }`, or null when the block is not a tool, handoff or attachment. */
export function toolCostKeyOf(block) {
  const category = block.category;
  if (category === "subagent_handoff") return { name: TOOL_COST_HANDOFFS, kind: "agent" };
  if (category === "attachments") return { name: block.attachmentType || "attachment", kind: "attachment" };
  if (category === "tool_call" || (typeof category === "string" && category.startsWith("tool_result."))) {
    const tool = block.tool ?? {};
    const name = typeof tool.name === "string" && tool.name ? tool.name : TOOL_COST_OTHER;
    const key = { name, kind: tool.kind ?? "other" };
    if (typeof tool.server === "string" && tool.server) key.server = tool.server;
    return key;
  }
  return null;
}

/**
 * Token-requests per tool for one reconciled scope: for every block with a
 * presence window [first, last] (last = the scope's last request when
 * undefined; never-entered blocks and thinking skipped),
 * tokenRequests += estTokens x sum(k_i) and uncached += estTokens x
 * sum(k_i x (1 - cacheRead_i / total_i)) over i in the window, where k_i is the
 * clamped `request.scale`. Prefix sums make it O(B + R). Returns
 * Map<name, { name, kind, server?, blocks, tokenRequests, uncached }>.
 */
export function toolCostGroups(scope) {
  const requests = scope.requests ?? [];
  const n = requests.length;
  const groups = new Map();
  if (!n) return groups;
  const K = new Float64Array(n + 1);
  const U = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    const usage = requests[i].usage ?? {};
    const k = Number.isFinite(requests[i].scale) ? requests[i].scale : 1;
    const total = usage.total ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const uncachedShare = total > 0 ? Math.max(0, Math.min(1, 1 - cacheRead / total)) : 1;
    K[i + 1] = K[i] + k;
    U[i + 1] = U[i] + k * uncachedShare;
  }
  for (const block of scope.blocks ?? []) {
    if (block.category === "assistant_thinking") continue;
    const first = block.firstRequest;
    if (!Number.isInteger(first) || first < 0 || first >= n) continue;
    const last = block.lastRequest === undefined ? n - 1 : Math.min(block.lastRequest, n - 1);
    if (last < first) continue;
    const key = toolCostKeyOf(block);
    if (!key) continue;
    const est = Number(block.estTokens) || 0;
    let row = groups.get(key.name);
    if (!row) { row = { ...key, blocks: 0, tokenRequests: 0, uncached: 0 }; groups.set(key.name, row); }
    row.blocks += 1;
    row.tokenRequests += est * (K[last + 1] - K[first]);
    row.uncached += est * (U[last + 1] - U[first]);
  }
  return groups;
}

/** Groups from an already ranked table (a summarised scope without blocks); the `other` row stays `other`. */
export function groupsFromRows(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.name !== "string") continue;
    const { share: _share, ...rest } = row;
    groups.set(row.name, { ...rest, blocks: row.blocks ?? 0, tokenRequests: row.tokenRequests ?? 0, uncached: row.uncached ?? 0 });
  }
  return groups;
}

/** Merges group maps of several scopes (same name = same row; sums). */
export function mergeToolCostGroups(maps) {
  const merged = new Map();
  for (const groups of maps) {
    for (const [name, row] of groups) {
      const target = merged.get(name);
      if (target) { target.blocks += row.blocks; target.tokenRequests += row.tokenRequests; target.uncached += row.uncached; }
      else merged.set(name, { ...row });
    }
  }
  return merged;
}

/**
 * Ranked table: the top `top` rows by token-requests plus one `other` row for
 * the rest, each with `share = tokenRequests / denominator` (the scope's or
 * run's sum of vendor totals, `observed.vendor`). Numbers are rounded to
 * integers; shares to 4 decimals and never above 1.
 */
export function rankToolCost(groups, denominator, top = TOOL_COST_TOP) {
  const rows = [...groups.values()].filter((row) => row.tokenRequests > 0 || row.blocks > 0).sort((a, b) => b.tokenRequests - a.tokenRequests || a.name.localeCompare(b.name));
  const named = rows.filter((row) => row.name !== TOOL_COST_OTHER);
  const rest = rows.filter((row) => row.name === TOOL_COST_OTHER);
  const head = named.slice(0, top);
  const tail = [...named.slice(top), ...rest];
  const finish = (row) => ({
    name: row.name,
    kind: row.kind,
    ...(row.server ? { server: row.server } : {}),
    blocks: row.blocks,
    tokenRequests: Math.round(row.tokenRequests),
    uncached: Math.round(row.uncached),
    share: denominator > 0 ? Math.min(1, Number((row.tokenRequests / denominator).toFixed(4))) : 0,
  });
  const out = head.map(finish);
  if (tail.length) {
    const other = tail.reduce((sum, row) => ({ blocks: sum.blocks + row.blocks, tokenRequests: sum.tokenRequests + row.tokenRequests, uncached: sum.uncached + row.uncached }), { blocks: 0, tokenRequests: 0, uncached: 0 });
    out.push(finish({ name: TOOL_COST_OTHER, kind: "other", ...other }));
  }
  return out;
}

/** Cache-read share of a row: 1 - uncached / tokenRequests (0 when the row is empty). */
export function toolCostCacheReadShare(row) {
  if (!row || !(row.tokenRequests > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - row.uncached / row.tokenRequests));
}

/**
 * One terminal line for `scan`: `Cost by tool: Bash 41% (cache-read 78%) ·
 * Read 22% · Agent handoffs 9% — token-requests, estimated`. Empty string
 * when the table has no row.
 */
export function toolCostLine(rows, { top = 3 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row.name !== TOOL_COST_OTHER && row.share > 0).slice(0, top);
  if (!list.length) return "";
  const pct = (value) => `${Math.round(value * 100)}%`;
  const parts = list.map((row, i) => `${row.name} ${pct(row.share)}${i === 0 ? ` (cache-read ${pct(toolCostCacheReadShare(row))})` : ""}`);
  return `Cost by tool: ${parts.join(" · ")} — ${TOOL_COST_UNIT}, estimated`;
}
