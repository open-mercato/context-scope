/**
 * Before/after per instruction-file edit (ADR-005 §1): the one metric engine
 * the `/api/v1/changes` route, the H-05 habit rule, the `scan` block and
 * `contextscope experiment compare` share. Everything here is manifest
 * arithmetic over session entries (roots + descendants); no run file is
 * opened, and the test suite spies on that.
 *
 * Vocabulary (kept deliberately observational — nothing here says "improved"):
 *   anchor     one edit of an instruction file: a commit that touched it
 *              (`anchor: "commit"`), the file mtime (`"mtime"`) or a named
 *              experiment snapshot (`"experiment"`)
 *   window     `before` = sessions started in [previous anchor, anchor),
 *              `after` = [anchor, next anchor); open without a neighbour
 *   Measured   `{ value, n, provenance }` per metric per side (medians)
 *   Change     the paired table for one anchor plus confounds and caveats
 */
import { entryTime } from "./reader.mjs";
import { formatCount, formatTokens } from "../util/format.mjs";

export const MAX_CHANGES = 20;
export const MAX_ANCHORS_PER_FILE = 10;
export const MIN_INTERVAL_N = 5;
export const BOOTSTRAP_RESAMPLES = 1000;
export const INTERVAL_LEVEL = 0.9;
export const CODEX_SIZE_TOLERANCE = 0.02;

export const CAVEAT_OBSERVATIONAL = "observational: sessions are different tasks";
export const CAVEAT_STARTUP = "startup H0 is a local estimate";

/** The metric table of ADR-005 §1, in display order. `ratio` marks token metrics that also report after/before. */
export const METRICS = Object.freeze([
  { key: "startupH0", label: "startup H0", unit: "tokens", provenance: "estimated.local", ratio: true },
  { key: "peakShare", label: "peak share of window", unit: "ratio", provenance: "derived.exact" },
  { key: "compactionsPerHour", label: "compactions per active hour", unit: "per-hour", provenance: "derived.exact" },
  { key: "processedInputTokens", label: "processed input tokens per session", unit: "tokens", provenance: "observed.vendor", ratio: true },
  { key: "fatResults", label: "fat results per session", unit: "count", provenance: "estimated.local" },
  { key: "handoffRatio", label: "subagent handoff ratio", unit: "ratio", provenance: "estimated.local" },
]);

// --- arithmetic ---

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of `value` weighted by integer `weight` (each item counted `weight` times). */
export function weightedMedian(items) {
  const expanded = [];
  for (const item of items) {
    const weight = Math.max(0, Math.min(1000, Math.round(item.weight ?? 1)));
    if (!Number.isFinite(item.value)) continue;
    for (let i = 0; i < weight; i += 1) expanded.push(item.value);
  }
  return median(expanded);
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** xorshift32, seeded from an anchor time so the same anchor always yields the same interval. */
export function createRng(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Seeded bootstrap of the difference of medians (after − before): `resamples`
 * paired resamples with replacement, the (1 − level)/2 and 1 − (1 − level)/2
 * quantiles. Only meaningful from `MIN_INTERVAL_N` per side; callers gate it.
 */
export function bootstrapDifference(before, after, { seed, resamples = BOOTSTRAP_RESAMPLES, level = INTERVAL_LEVEL } = {}) {
  const rng = createRng(seed);
  const draw = (values) => {
    const sample = new Array(values.length);
    for (let i = 0; i < values.length; i += 1) sample[i] = values[Math.floor(rng() * values.length)];
    return median(sample);
  };
  const diffs = new Array(resamples);
  for (let i = 0; i < resamples; i += 1) diffs[i] = draw(after) - draw(before);
  diffs.sort((a, b) => a - b);
  const at = (q) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(q * (diffs.length - 1))))];
  const tail = (1 - level) / 2;
  return { low: round(at(tail), 4), high: round(at(1 - tail), 4), level, resamples };
}

// --- per-session facts (root + descendants), never a run file ---

function ruleIdOf(id) {
  return String(id ?? "").split(":")[0];
}

/** Rule ids that fired in the session (root + descendants), from stored finding heads / ids. */
export function rulesOfSession(root, descendants = []) {
  const rules = new Map();
  for (const entry of [root, ...descendants]) {
    for (const head of entry.findingHeads ?? []) if (head?.ruleId) rules.set(head.ruleId, head.title ?? rules.get(head.ruleId));
    for (const id of entry.summary?.findingIds ?? []) { const ruleId = ruleIdOf(id); if (ruleId && !rules.has(ruleId)) rules.set(ruleId, undefined); }
  }
  return rules;
}

/**
 * The six metrics of one session as numbers (undefined when the session has no
 * value for the metric), plus its rule set, model and CLI version. Works on
 * manifest entries and on HabitRecords (which carry `habits`, `startedAt`,
 * `cliVersion` and `compactions` but no `summary`).
 */
export function sessionFacts(root, descendants = []) {
  const members = [root, ...descendants];
  const h0 = root.habits?.startup?.h0;
  let compactions = 0;
  let activeMs = 0;
  let processed = 0;
  let hasProcessed = false;
  let fat = 0;
  let hasFat = false;
  const ratios = [];
  for (const entry of members) {
    compactions += entry.summary?.compactions ?? entry.compactions ?? entry.habits?.compaction?.n ?? 0;
    activeMs += entry.activeMs ?? 0;
    if (Number.isFinite(entry.summary?.processedInputTokens)) { processed += entry.summary.processedInputTokens; hasProcessed = true; }
    if (Array.isArray(entry.habits?.fat)) { hasFat = true; for (const slot of entry.habits.fat) fat += slot?.n ?? 0; }
    for (const agent of entry.habits?.agents ?? []) if (Number.isFinite(agent?.ratioP50) && agent.ratioP50 > 0) ratios.push({ value: agent.ratioP50, weight: agent.n ?? 1 });
  }
  const peak = root.summary?.peakShareOfWindow ?? root.habits?.peakShare;
  return {
    runId: root.runId,
    vendor: root.vendor,
    startedAt: root.startedAt,
    model: root.habits?.startup?.model,
    cliVersion: root.cliVersion ?? root.habits?.startup?.cliVersion,
    metrics: {
      startupH0: Number.isFinite(h0) && h0 > 0 ? h0 : undefined,
      peakShare: Number.isFinite(peak) ? peak : undefined,
      compactionsPerHour: activeMs > 0 ? compactions / (activeMs / 3.6e6) : undefined,
      processedInputTokens: hasProcessed ? processed : undefined,
      fatResults: hasFat ? fat : undefined,
      handoffRatio: ratios.length ? weightedMedian(ratios) : undefined,
    },
    rules: rulesOfSession(root, descendants),
  };
}

// --- windows ---

export function startTime(entry) {
  const value = Date.parse(entry?.startedAt ?? "");
  return Number.isFinite(value) ? value : entryTime(entry);
}

/**
 * Windows around each anchor of one file: `before` = sessions started in
 * [previous anchor, anchor), `after` = [anchor, next anchor); open at the
 * ends. `anchors` is `[{ at, anchor, ... }]` in any order; sessions are
 * anything with `startedAt` (entries or HabitRecords). Returns one window per
 * anchor, newest first, `{ anchor, before, after }`.
 */
export function windowsFor(sessions, anchors, { timeOf = startTime } = {}) {
  const sorted = [...anchors]
    .map((anchor) => ({ ...anchor, atMs: Date.parse(anchor.at ?? "") }))
    .filter((anchor) => Number.isFinite(anchor.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const timed = sessions.map((session) => ({ session, at: timeOf(session) })).filter((item) => item.at > 0);
  const windows = sorted.map((anchor, index) => {
    const previous = index > 0 ? sorted[index - 1].atMs : -Infinity;
    const next = index + 1 < sorted.length ? sorted[index + 1].atMs : Infinity;
    const before = timed.filter((item) => item.at >= previous && item.at < anchor.atMs).map((item) => item.session);
    const after = timed.filter((item) => item.at >= anchor.atMs && item.at < next).map((item) => item.session);
    const { atMs, ...rest } = anchor;
    return { anchor: rest, before, after };
  });
  return windows.reverse();
}

// --- confounds ---

export function dominantModel(facts) {
  const counts = new Map();
  for (const item of facts) if (item.model) counts.set(item.model, (counts.get(item.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

export function cliVersionsOf(facts) {
  return [...new Set(facts.map((item) => item.cliVersion).filter(Boolean))].sort();
}

/** As H-05 does it: dominant model per side, CLI version sets per side; confounded when either differs. */
export function confoundsOf(beforeFacts, afterFacts) {
  const models = { before: dominantModel(beforeFacts), after: dominantModel(afterFacts) };
  const cliVersions = { before: cliVersionsOf(beforeFacts), after: cliVersionsOf(afterFacts) };
  const reasons = [];
  if (models.before && models.after && models.before !== models.after) reasons.push(`dominant model changed (${models.before} → ${models.after})`);
  const sameVersions = cliVersions.before.length === cliVersions.after.length && cliVersions.before.every((v, i) => v === cliVersions.after[i]);
  if (cliVersions.before.length && cliVersions.after.length && !sameVersions) reasons.push(`CLI version changed (${cliVersions.before.join(", ")} → ${cliVersions.after.join(", ")})`);
  const result = { models, cliVersions, confounded: reasons.length > 0 };
  if (reasons.length) result.reason = reasons.join("; ");
  return result;
}

// --- observation of the edited file by a session ---

function pathMatches(observed, file) {
  if (typeof observed !== "string" || !observed) return false;
  if (observed === file) return true;
  const bare = observed.replace(/^\.\//, "");
  return bare === file || bare.endsWith(`/${file}`) || file.endsWith(`/${bare}`);
}

/**
 * How a session relates to the edited file: `observed` (hook InstructionsLoaded
 * named it, `observed.artifact`; or a Codex session whose instruction chars
 * match the anchor's size within 2 %, `derived`), `unverified` (a Codex session
 * whose chars do not match a known size), else `expected` (in the chain, no
 * evidence either way).
 */
export function observationOf(entry, { file, bytes } = {}) {
  const observed = entry.stats?.instructionFilesObserved ?? [];
  if (file && observed.some((item) => pathMatches(item, file))) return "observed";
  if (entry.vendor === "codex") {
    const chars = entry.stats?.codexInstructionChars;
    if (Number.isFinite(bytes) && bytes > 0 && Number.isFinite(chars) && chars > 0) {
      return Math.abs(chars - bytes) <= CODEX_SIZE_TOLERANCE * bytes ? "observed" : "unverified";
    }
    return "unverified";
  }
  return "expected";
}

// --- the Change ---

function sideMeasure(metric, facts) {
  const values = facts.map((item) => item.metrics[metric.key]).filter((v) => Number.isFinite(v));
  const value = median(values);
  return { value: value === undefined ? null : round(value, metric.unit === "tokens" ? 0 : 3), n: values.length, provenance: metric.provenance };
}

/**
 * The paired table for one anchor. `before` / `after` are session groups
 * `[{ root, descendants }]` (or bare roots); `observationOf(root)` classifies
 * the after side; `titleOf(ruleId)` names the rule rows. Pure and
 * deterministic: the interval is seeded from `at`.
 */
export function buildChange({ file, at, anchor = "mtime", commit, before, after, observationOf: observe, titleOf = () => undefined }) {
  const group = (item) => (item && item.root ? item : { root: item, descendants: [] });
  const beforeFacts = before.map(group).map(({ root, descendants }) => sessionFacts(root, descendants));
  const afterFacts = after.map(group).map(({ root, descendants }) => sessionFacts(root, descendants));
  let afterObserved = 0;
  let unverified = 0;
  if (typeof observe === "function") {
    for (const item of after.map(group)) {
      const state = observe(item.root);
      if (state === "observed") afterObserved += 1;
      else if (state === "unverified") unverified += 1;
    }
  }
  const beforeSide = {};
  const afterSide = {};
  const delta = {};
  const ci = {};
  let hasInterval = false;
  const seed = Date.parse(at ?? "") || 1;
  for (const metric of METRICS) {
    const b = sideMeasure(metric, beforeFacts);
    const a = sideMeasure(metric, afterFacts);
    beforeSide[metric.key] = b;
    afterSide[metric.key] = a;
    if (b.value !== null && a.value !== null) {
      delta[metric.key] = round(a.value - b.value, metric.unit === "tokens" ? 0 : 3);
      if (metric.ratio && b.value > 0) delta[`${metric.key}Ratio`] = round(a.value / b.value, 3);
      if (b.n >= MIN_INTERVAL_N && a.n >= MIN_INTERVAL_N) {
        const values = (facts) => facts.map((item) => item.metrics[metric.key]).filter((v) => Number.isFinite(v));
        const interval = bootstrapDifference(values(beforeFacts), values(afterFacts), { seed: seed + METRICS.indexOf(metric) });
        ci[metric.key] = { low: interval.low, high: interval.high, level: INTERVAL_LEVEL, provenance: "derived.exact", claim: "observational" };
        hasInterval = true;
      }
    }
  }
  const ruleIds = new Set();
  const titles = new Map();
  for (const facts of [...beforeFacts, ...afterFacts]) for (const [ruleId, title] of facts.rules) { ruleIds.add(ruleId); if (title && !titles.has(ruleId)) titles.set(ruleId, title); }
  const findingsByRule = [...ruleIds].sort().map((ruleId) => ({
    ruleId,
    title: titleOf(ruleId) ?? titles.get(ruleId) ?? ruleId,
    before: { sessions: beforeFacts.filter((f) => f.rules.has(ruleId)).length, of: beforeFacts.length },
    after: { sessions: afterFacts.filter((f) => f.rules.has(ruleId)).length, of: afterFacts.length },
  }));
  const confounds = confoundsOf(beforeFacts, afterFacts);
  const n = { before: beforeFacts.length, after: afterFacts.length, afterObserved };
  if (unverified) n.unverified = unverified;
  const caveats = [
    CAVEAT_OBSERVATIONAL,
    `${formatCount(n.before)} before / ${formatCount(n.after)} after`,
    `model/CLI confound: ${confounds.confounded ? confounds.reason : "none"}`,
    CAVEAT_STARTUP,
  ];
  if (!hasInterval) caveats.push(`n small: no interval below ${MIN_INTERVAL_N} sessions per side`);
  const change = { file, at, anchor, n, before: beforeSide, after: afterSide, delta, findingsByRule, confounds, caveats, claim: "observational" };
  if (commit) change.commit = commit;
  if (hasInterval) change.ci = ci;
  return change;
}

/**
 * Every change of a repo: one per anchor per instruction file, newest anchor
 * first, at most `MAX_CHANGES`; anchors with an empty side become `notes`.
 *
 *   files     `[{ path, vendors?, bytes?, mtime?, anchors?: [{ at, anchor, commit?, bytes? }] }]`
 *             (the setup inventory's instruction files; `anchors` from setup/git.mjs, else the mtime)
 *   sessions  `[{ root, descendants }]` of the population (repoSessions roots + children)
 *   titleOf   rule id → title (the rules catalogue)
 * Sessions of a file are the population's sessions whose vendor loads it (`file.vendors`).
 */
export function changesFor({ files, sessions, titleOf, file: only, now = Date.now() } = {}) {
  const changes = [];
  const notes = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.path !== "string") continue;
    if (only && file.path !== only) continue;
    const anchors = anchorsOfFile(file);
    if (!anchors.length) continue;
    const vendors = Array.isArray(file.vendors) && file.vendors.length ? new Set(file.vendors) : null;
    const eligible = sessions.filter((item) => !vendors || vendors.has(item.root.vendor));
    for (const window of windowsFor(eligible, anchors, { timeOf: (item) => startTime(item.root) })) {
      const at = window.anchor.at;
      if (!window.before.length || !window.after.length) {
        const day = new Date(at).toISOString().slice(0, 10);
        const reason = !window.after.length
          ? (Date.parse(at) > now ? "edit is in the future" : "no session since")
          : "no session before";
        notes.push({ file: file.path, at, anchor: window.anchor.anchor, reason: `${file.path} edited ${day}: ${reason}` });
        continue;
      }
      changes.push(buildChange({
        file: file.path, at, anchor: window.anchor.anchor, commit: window.anchor.commit,
        before: window.before, after: window.after,
        observationOf: (root) => observationOf(root, { file: file.path, bytes: window.anchor.bytes ?? (window.anchor.anchor === "mtime" ? file.bytes : undefined) }),
        titleOf,
      }));
    }
  }
  changes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.file.localeCompare(b.file));
  notes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.file.localeCompare(b.file));
  return { changes: changes.slice(0, MAX_CHANGES), notes: notes.slice(0, MAX_CHANGES) };
}

/** The file's git anchors when present (capped), else its mtime as the one anchor. */
export function anchorsOfFile(file) {
  const anchors = Array.isArray(file.anchors) ? file.anchors.filter((anchor) => anchor && Number.isFinite(Date.parse(anchor.at ?? ""))) : [];
  if (anchors.length) return anchors.slice(0, MAX_ANCHORS_PER_FILE).map((anchor) => ({ anchor: "commit", ...anchor }));
  const at = Date.parse(file.mtime ?? "");
  return Number.isFinite(at) ? [{ at: new Date(at).toISOString(), anchor: "mtime", bytes: file.bytes }] : [];
}

// --- terminal rendering (mounted by `scan`) ---

function shortDay(iso) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "?";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmt(metric, value) {
  if (value === null || value === undefined) return "—";
  if (metric.unit === "tokens") return formatTokens(value);
  if (metric.unit === "ratio") return metric.key === "peakShare" ? `${Math.round(value * 100)}%` : `${value.toFixed(1)}x`;
  return String(round(value, 1));
}

/** The `scan` block of ADR-005 §1: one line per change, one per note, "observational" on every line. */
export function renderChangesLines(response, { limit = 5 } = {}) {
  const lines = [];
  const changes = response?.changes ?? [];
  const notes = response?.notes ?? [];
  if (!changes.length && !notes.length) return lines;
  lines.push("Since the last instruction edits (observational: sessions are different tasks)");
  for (const change of changes.slice(0, limit)) {
    const parts = [`${formatCount(change.n.after)} session${change.n.after === 1 ? "" : "s"} vs ${formatCount(change.n.before)} before`];
    const startup = METRICS[0];
    if (change.before.startupH0.value !== null && change.after.startupH0.value !== null) parts.push(`startup ${fmt(startup, change.before.startupH0.value)} → ${fmt(startup, change.after.startupH0.value)}`);
    const rule = [...change.findingsByRule].sort((a, b) => Math.abs(b.after.sessions / b.after.of - b.before.sessions / b.before.of) - Math.abs(a.after.sessions / a.after.of - a.before.sessions / a.before.of))[0];
    if (rule) parts.push(`${rule.ruleId} in ${rule.after.sessions}/${rule.after.of} (was ${rule.before.sessions}/${rule.before.of})`);
    const compaction = METRICS[2];
    if (change.before.compactionsPerHour.value !== null && change.after.compactionsPerHour.value !== null) parts.push(`compactions/h ${fmt(compaction, change.before.compactionsPerHour.value)} → ${fmt(compaction, change.after.compactionsPerHour.value)}`);
    parts.push(change.ci ? "90% interval available" : "n small");
    parts.push(change.confounds.confounded ? `confounded: ${change.confounds.reason}` : "observational");
    lines.push(`  Since ${change.file} (${shortDay(change.at)}, ${change.anchor}): ${parts.join(" · ")}`);
  }
  for (const note of notes.slice(0, limit)) lines.push(`  ${note.reason}`);
  return lines;
}
