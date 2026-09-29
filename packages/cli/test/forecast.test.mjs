import assert from "node:assert/strict";
import test from "node:test";
import { activeMinutesAxis, calibratedShareFor, compactionThreshold, finalizeRun, forecastScope, refinalizeRun, slope, FORECAST_BASIS, FORECAST_DEFAULT_SHARE, FORECAST_FLAT_REQUESTS, FORECAST_MIN_REQUESTS } from "../src/ir/finalize.mjs";
import { CALIBRATION } from "../src/ir/estimate.mjs";

const strip = (threshold) => ({ value: threshold.value, provenance: threshold.provenance });

function ramp({ count, start = 100_000, step = 4_000, minutes = 1, from = 0 }) {
  return Array.from({ length: count }, (_, i) => ({
    index: from + i,
    at: new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + (from + i) * minutes * 60_000).toISOString(),
    model: "m",
    turn: 1,
    usage: { input: 10, cacheCreation: 0, cacheRead: 0, output: 5, total: start + step * i },
  }));
}

test("slope is the least-squares slope", () => {
  assert.equal(slope([0, 1, 2, 3], [1, 3, 5, 7]), 2);
  assert.equal(slope([0, 1, 2, 3], [5, 5, 5, 5]), 0);
  assert.equal(slope([1], [5]), 0);
  assert.equal(slope([2, 2, 2], [1, 2, 3]), 0, "no spread in x");
});

test("forecast on a linear ramp is exact", () => {
  const requests = ramp({ count: 30, start: 100_000, step: 4_000, minutes: 2 });
  const forecast = forecastScope({ requests, compactions: [] }, { vendor: "claude", window: 1_000_000 });
  assert.ok(forecast);
  assert.equal(forecast.perRequest, 4_000);
  assert.equal(forecast.perMinute, 2_000);
  assert.deepEqual(forecast.basis, { requests: FORECAST_BASIS, from: 10, to: 29 });
  const share = CALIBRATION.autoCompact.claude.byWindow["1000000"].share;
  const threshold = Math.round(1_000_000 * share);
  assert.deepEqual(strip(forecast.threshold), { value: threshold, provenance: "estimated.local" });
  assert.equal(forecast.threshold.basis.kind, "calibration");
  assert.equal(forecast.threshold.basis.events, 5);
  assert.equal(forecast.threshold.basis.window, 1_000_000);
  assert.ok(forecast.threshold.basis.min <= threshold && threshold <= forecast.threshold.basis.max, "the range brackets the point");
  const current = 100_000 + 4_000 * 29;
  assert.equal(forecast.requestsLeft, Number(((threshold - current) / 4_000).toFixed(1)));
  assert.equal(forecast.minutesLeft, Number(((threshold - current) / 2_000).toFixed(1)));
  assert.equal(forecast.provenance, "derived.exact");
  assert.equal(forecast.status, "ok");
});

test("per-minute slope uses active time: a long break inside the basis does not stretch the countdown", () => {
  const requests = ramp({ count: 12, start: 100_000, step: 5_000, minutes: 1 });
  const gapped = requests.map((r, i) => (i >= 6 ? { ...r, at: new Date(Date.parse(r.at) + 3 * 60 * 60_000).toISOString() } : r));
  const flat = forecastScope({ requests, compactions: [] }, { vendor: "claude", window: 200_000 });
  const withGap = forecastScope({ requests: gapped, compactions: [] }, { vendor: "claude", window: 200_000 });
  assert.equal(flat.perMinute, 5_000);
  assert.equal(withGap.perMinute, 5_000, "the 3-hour gap is excluded from the axis");
  assert.equal(withGap.minutesLeft, flat.minutesLeft);
  assert.equal(withGap.requestsLeft, flat.requestsLeft);
  assert.deepEqual(activeMinutesAxis(gapped).slice(4, 8), [4, 5, 6, 7], "the gap counts as one typical (median) active step");
  assert.equal(activeMinutesAxis([{ at: "nope" }]), null);
});

test("threshold share is keyed by window size; a 200k Claude window uses the documented default, Codex is never vendor-observed", () => {
  assert.equal(calibratedShareFor("claude", 1_000_000).share, CALIBRATION.autoCompact.claude.byWindow["1000000"].share);
  assert.equal(calibratedShareFor("claude", 200_000), null, "no 200k evidence in the corpus");
  const small = compactionThreshold({ vendor: "claude", window: 200_000, compactions: [] });
  assert.deepEqual(strip(small), { value: Math.round(200_000 * FORECAST_DEFAULT_SHARE), provenance: "estimated.local" });
  assert.equal(small.basis.kind, "default");
  assert.equal(small.basis.events, 0);
  const codex = compactionThreshold({ vendor: "codex", window: 258_400, compactions: [] });
  assert.equal(codex.provenance, "estimated.local");
  assert.equal(codex.basis.kind, "calibration-inferred");
  const inferred = compactionThreshold({ vendor: "codex", window: 258_400, compactions: [{ trigger: "auto", preTokens: { value: 228_352, provenance: "derived.exact" } }] });
  assert.deepEqual(strip(inferred), { value: 228_352, provenance: "estimated.local" }, "an inferred Codex auto compaction never yields a vendor-observed threshold");
  assert.equal(inferred.basis.kind, "own-compactions-inferred");
});

test("a far-off threshold is reported as flat (no compaction expected at this rate)", () => {
  const slow = ramp({ count: 30, start: 100_000, step: 100, minutes: 1 });
  const forecast = forecastScope({ requests: slow, compactions: [] }, { vendor: "claude", window: 1_000_000 });
  assert.ok(forecast);
  assert.equal(forecast.status, "flat");
  assert.ok(forecast.requestsLeft > FORECAST_FLAT_REQUESTS);
  assert.equal(forecast.perRequest, 100, "the slope is still reported");
  const lazy = ramp({ count: 30, start: 100_000, step: 500, minutes: 60 });
  assert.equal(forecastScope({ requests: lazy, compactions: [] }, { vendor: "claude", window: 1_000_000 }).status, "flat", "each 60-minute gap counts zero, so per-minute is cadence-derived: still > 24 h");
});

test("a flat series, a short segment, and a scope above the threshold give no forecast", () => {
  const flat = ramp({ count: 30, step: 0 });
  assert.equal(forecastScope({ requests: flat, compactions: [] }, { vendor: "claude", window: 1_000_000 }), undefined);
  const falling = ramp({ count: 30, start: 500_000, step: -1_000 });
  assert.equal(forecastScope({ requests: falling, compactions: [] }, { vendor: "claude", window: 1_000_000 }), undefined);
  const short = ramp({ count: FORECAST_MIN_REQUESTS - 1 });
  assert.equal(forecastScope({ requests: short, compactions: [] }, { vendor: "claude", window: 1_000_000 }), undefined);
  const above = ramp({ count: 30, start: 990_000, step: 1_000 });
  assert.equal(forecastScope({ requests: above, compactions: [] }, { vendor: "claude", window: 1_000_000 }), undefined);
  assert.equal(forecastScope({ requests: ramp({ count: 30 }), compactions: [] }, { vendor: "claude", window: 0 }), undefined, "unknown window, no compactions");
});

test("the current segment starts at the last compaction and the run's own auto compactions set the threshold", () => {
  const before = ramp({ count: 12, start: 800_000, step: 10_000 });
  const after = ramp({ count: 10, start: 200_000, step: 5_000, from: 12 });
  const compaction = { id: "main:c0", at: after[0].at, atRequest: 12, trigger: "auto", preTokens: { value: 967_050, provenance: "observed.vendor" }, postTokens: { value: 200_000, provenance: "observed.vendor" }, droppedTokens: { value: 767_050, provenance: "observed.vendor" } };
  const scope = { requests: [...before, ...after], compactions: [compaction] };
  const forecast = forecastScope(scope, { vendor: "claude", window: 1_000_000, compactions: [compaction] });
  assert.ok(forecast);
  assert.deepEqual(forecast.basis, { requests: 10, from: 12, to: 21 });
  assert.equal(forecast.perRequest, 5_000);
  assert.deepEqual(strip(forecast.threshold), { value: 967_050, provenance: "observed.vendor" });
  assert.deepEqual(forecast.threshold.basis, { kind: "own-compactions", events: 1, min: 967_050, max: 967_050, window: 1_000_000 });
  assert.equal(forecast.requestsLeft, Number(((967_050 - 245_000) / 5_000).toFixed(1)));
  // Seven requests after the compaction: below the minimum, no forecast even though the whole scope is long.
  const tooShort = { requests: [...before, ...after.slice(0, 7)], compactions: [compaction] };
  assert.equal(forecastScope(tooShort, { vendor: "claude", window: 1_000_000, compactions: [compaction] }), undefined);
});

test("compactionThreshold: median of observed preTokens, else calibrated share of the window", () => {
  const pre = (value, provenance = "observed.vendor") => ({ trigger: "auto", preTokens: { value, provenance } });
  const own = compactionThreshold({ vendor: "claude", window: 1_000_000, compactions: [pre(967_050), pre(999_634), pre(967_423)] });
  assert.deepEqual(strip(own), { value: 967_423, provenance: "observed.vendor" });
  assert.deepEqual(own.basis, { kind: "own-compactions", events: 3, min: 967_050, max: 999_634, window: 1_000_000 });
  assert.deepEqual(strip(compactionThreshold({ vendor: "codex", window: 258_400, compactions: [pre(228_352, "derived.exact")] })), { value: 228_352, provenance: "estimated.local" });
  assert.deepEqual(strip(compactionThreshold({ vendor: "codex", window: 258_400, compactions: [] })), { value: Math.round(258_400 * CALIBRATION.autoCompact.codex.byWindow["258400"].share), provenance: "estimated.local" });
  assert.deepEqual(strip(compactionThreshold({ vendor: "gemini", window: 100_000, compactions: [] })), { value: 95_000, provenance: "estimated.local" }, "unknown vendor falls back to 0.95");
  assert.equal(compactionThreshold({ vendor: "claude", window: 0, compactions: [] }), null);
});

test("refinalizeRun re-derives the forecast and the summary without touching peaks", () => {
  const scope = { id: "main", kind: "main", requests: ramp({ count: 25, start: 300_000, step: 8_000 }), blocks: [], compactions: [] };
  const run = {
    id: "claude:s", vendor: "claude", sessionId: "s", project: { key: "k", displayName: "repo", cwdHash: "c" }, startedAt: "", endedAt: "", activeMs: 0,
    window: { value: 1_000_000, provenance: "estimated.local" }, coverage: { records: 1 }, source: { file: "~/x.jsonl", bytes: 1, mtimeMs: 1, subagentFiles: 0 }, scopes: [scope],
  };
  finalizeRun(run);
  run.summary.findingIds = ["B-01:x"];
  const peak = run.scopes[0].peak.value;
  delete run.scopes[0].forecast;
  refinalizeRun(run);
  assert.equal(run.scopes[0].forecast.perRequest, 8_000);
  assert.equal(run.scopes[0].peak.value, peak);
  assert.deepEqual(run.summary.findingIds, ["B-01:x"], "finding ids survive");
  assert.equal(refinalizeRun(null), null);
});

test("finalizeRun attaches the forecast per scope and drops it when there is none", () => {
  const scope = (id, requests, extra = {}) => ({ id, kind: id === "main" ? "main" : "subagent", parentScopeId: id === "main" ? undefined : "main", requests, blocks: [], compactions: [], ...extra });
  const run = {
    id: "claude:s", vendor: "claude", sessionId: "s", project: { key: "k", displayName: "repo", cwdHash: "c" }, startedAt: "", endedAt: "", activeMs: 0,
    window: { value: 1_000_000, provenance: "estimated.local" },
    coverage: { records: 1, unparsedRecords: 0, unparsedTypes: {}, syntheticRecordsSkipped: 0, adapterVersion: "t" },
    source: { file: "~/x.jsonl", bytes: 1, mtimeMs: 1, subagentFiles: 0 },
    scopes: [scope("main", ramp({ count: 25, start: 300_000, step: 8_000 })), scope("a1", ramp({ count: 25, step: 0 }), { forecast: { stale: true } })],
  };
  finalizeRun(run);
  assert.ok(run.scopes[0].forecast, "main scope rises: forecast present");
  assert.equal(run.scopes[0].forecast.perRequest, 8_000);
  assert.equal(run.scopes[0].forecast.threshold.provenance, "estimated.local");
  assert.equal(run.scopes[1].forecast, undefined, "flat child: stale forecast removed");
});
