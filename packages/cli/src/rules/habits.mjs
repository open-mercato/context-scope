/**
 * Cross-session habit rules (ADR-003 section 2). Rule modules live next to
 * this file as `H-NN.mjs` and export
 * `{ id, scope: "habit", severity, title, whyItMatters, thresholdKeys, evaluate({ habits, setup, thresholds, notes }) }`.
 *
 * Input is a list of HabitRecords projected from manifest entries
 * (`habitRecordOf`): nothing here opens a run file, and nothing is stored.
 * Population (ADR-004 §2): one record per session = top-level run; a Codex
 * child rollout's record is merged into its root's (`mergeHabitRecords`), so
 * every `sessions` count and every window over records is over roots.
 * Every finding carries `sessions` (the sessions its evidence spans) and
 * evidence of kind "run" per session (≤ 5) plus one "metric". A rule may
 * export `needs(thresholds)` (the sessions it needs to say anything); the
 * engine notes starved rules (`notes[].kind === "starved"`) instead of staying
 * silently quiet.
 */
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findingId, formatTokens } from "./util.mjs";
import { HABITS_VERSION } from "../index/entry.mjs";
import { indexByRunId, rootRunIdOf } from "../index/reader.mjs";

const RULES_DIR = dirname(fileURLToPath(import.meta.url));
export const HABIT_RULE_FILE = /^H-\d{2}\.mjs$/;
export const MAX_RUN_EVIDENCE = 5;
const SEVERITIES = new Set(["high", "medium", "low"]);
const EVIDENCE_KINDS = new Set(["file", "request", "block", "scope", "metric", "run"]);
const PROVENANCES = new Set(["observed.vendor", "observed.artifact", "derived.exact", "estimated.local", "unknown"]);
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

let cache = null;

function warn(onWarning, message) {
  if (typeof onWarning === "function") onWarning(message);
  else if (onWarning !== false) console.warn(`[contextscope habits] ${message}`);
}

export function validateHabitRule(rule, file = "?") {
  if (!rule || typeof rule !== "object") throw new Error(`${file}: default export is not an object`);
  if (typeof rule.id !== "string" || !/^H-\d{2}$/.test(rule.id)) throw new Error(`${file}: invalid rule id ${rule.id}`);
  if (rule.scope !== "habit") throw new Error(`${file}: scope must be "habit"`);
  if (!SEVERITIES.has(rule.severity)) throw new Error(`${file}: invalid severity ${rule.severity}`);
  if (typeof rule.title !== "string" || !rule.title) throw new Error(`${file}: missing title`);
  if (typeof rule.whyItMatters !== "string" || !rule.whyItMatters) throw new Error(`${file}: missing whyItMatters`);
  if (!Array.isArray(rule.thresholdKeys)) throw new Error(`${file}: thresholdKeys must be an array`);
  if (typeof rule.evaluate !== "function") throw new Error(`${file}: evaluate must be a function`);
  if (rule.needs !== undefined && typeof rule.needs !== "function") throw new Error(`${file}: needs must be a function`);
  return rule;
}

export async function loadHabitRules({ dir = RULES_DIR, onWarning, force = false } = {}) {
  if (!force && dir === RULES_DIR && cache) return cache;
  let names = [];
  try { names = (await readdir(dir)).filter((name) => HABIT_RULE_FILE.test(name)).sort(); }
  catch (error) { warn(onWarning, `cannot read rules dir ${dir}: ${error.message}`); }
  const rules = [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(join(dir, name)).href);
      rules.push(validateHabitRule(mod.default, name));
    } catch (error) {
      warn(onWarning, `${name}: skipped (${error.message})`);
    }
  }
  if (dir === RULES_DIR) cache = rules;
  return rules;
}

// --- records ---

/**
 * Projects a manifest entry to the HabitRecord the rules read. Null when the
 * entry has no habits record. `stale` marks a record written by another
 * HABITS_VERSION (still used; the next index pass re-derives it).
 */
export function habitRecordOf(entry) {
  if (!entry || entry.error || !entry.habits || typeof entry.habits !== "object") return null;
  const record = {
    runId: entry.runId,
    vendor: entry.vendor,
    startedAt: entry.startedAt ?? "",
    endedAt: entry.endedAt ?? entry.startedAt ?? "",
    activeMs: entry.activeMs ?? 0,
    cliVersion: entry.cliVersion ?? entry.habits.startup?.cliVersion,
    requests: entry.summary?.requests ?? entry.habits.compaction?.requests ?? 0,
    compactions: entry.summary?.compactions ?? entry.habits.compaction?.n ?? 0,
    habits: entry.habits,
    parentRunId: entry.parentThreadId ? `${entry.vendor}:${entry.parentThreadId}` : undefined,
    rootRunId: entry.rootRunId ?? undefined,
    subagentRuns: 0,
  };
  if (entry.habits.v !== HABITS_VERSION) record.stale = true;
  return record;
}

function mergeTotals(target, items, keyOf, extra = () => ({})) {
  const map = new Map(target.map((item) => [keyOf(item), { ...item }]));
  for (const item of items) {
    const key = keyOf(item);
    const slot = map.get(key);
    if (!slot) { map.set(key, { ...item }); continue; }
    slot.tokens = (slot.tokens ?? 0) + (item.tokens ?? 0);
    slot.n = (slot.n ?? 0) + (item.n ?? 0);
    Object.assign(slot, extra(slot, item));
  }
  return [...map.values()].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || (b.n ?? 0) - (a.n ?? 0));
}

function mergeAgents(target, items) {
  const map = new Map(target.map((agent) => [agent.type, { ...agent }]));
  for (const agent of items) {
    const slot = map.get(agent.type);
    if (!slot) { map.set(agent.type, { ...agent }); continue; }
    const n = (slot.n ?? 0) + (agent.n ?? 0);
    const weighted = (key) => (n > 0 ? Math.round(((slot[key] ?? 0) * (slot.n ?? 0) + (agent[key] ?? 0) * (agent.n ?? 0)) / n) : 0);
    slot.handoffP50 = weighted("handoffP50");
    slot.peakP50 = weighted("peakP50");
    slot.ratioP50 = n > 0 ? Number((((slot.ratioP50 ?? 0) * (slot.n ?? 0) + (agent.ratioP50 ?? 0) * (agent.n ?? 0)) / n).toFixed(2)) : 0;
    slot.handoffMax = Math.max(slot.handoffMax ?? 0, agent.handoffMax ?? 0);
    slot.n = n;
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

/**
 * One record per session: the root's record with every descendant's fat
 * results, full reads, agents, compactions and MCP calls folded in (the root's
 * startup base, CLI version and times stay). Each child adds one subagent run.
 */
/** A record written by another HABITS_VERSION (flagged by `habitRecordOf`, or judged from `habits.v` for a raw record). */
export function isStaleRecord(record) {
  return Boolean(record?.stale) || (record?.habits?.v !== undefined && record.habits.v !== HABITS_VERSION);
}

export function mergeHabitRecords(root, children = []) {
  if (!children.length) return { ...root, rootRunId: root.runId, subagentRuns: root.subagentRuns ?? 0, ...(isStaleRecord(root) ? { stale: true } : {}) };
  const habits = { ...root.habits };
  let requests = root.requests ?? 0;
  let compactions = root.compactions ?? 0;
  let compactionN = habits.compaction?.n ?? 0;
  let compactionAuto = habits.compaction?.auto ?? 0;
  let compactionRequests = habits.compaction?.requests ?? 0;
  const mcp = new Set(habits.mcp?.invoked ?? []);
  let stale = isStaleRecord(root);
  for (const child of children) {
    const h = child.habits ?? {};
    habits.fat = mergeTotals(habits.fat ?? [], h.fat ?? [], (item) => `${item.call ? "call" : "result"}\u0000${item.kind ?? ""}\u0000${item.label ?? ""}`);
    habits.fullReads = mergeTotals(habits.fullReads ?? [], h.fullReads ?? [], (item) => item.label ?? "");
    habits.agents = mergeAgents(habits.agents ?? [], h.agents ?? []);
    requests += child.requests ?? 0;
    compactions += child.compactions ?? 0;
    compactionN += h.compaction?.n ?? 0;
    compactionAuto += h.compaction?.auto ?? 0;
    compactionRequests += h.compaction?.requests ?? 0;
    for (const server of h.mcp?.invoked ?? []) mcp.add(server);
    if (isStaleRecord(child)) stale = true;
  }
  habits.compaction = { ...(habits.compaction ?? {}), n: compactionN, auto: compactionAuto, requests: compactionRequests };
  habits.mcp = { invoked: [...mcp].sort() };
  const merged = { ...root, rootRunId: root.runId, requests, compactions, habits, subagentRuns: (root.subagentRuns ?? 0) + children.length };
  if (stale) merged.stale = true;
  return merged;
}

export function recordTime(record) {
  const value = Date.parse(record?.endedAt || record?.startedAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function sum(values) {
  let total = 0;
  for (const value of values) total += Number(value) || 0;
  return total;
}

// --- evidence and findings ---

export function runEvidence(record, label, { value, unit = "tokens", provenance = "estimated.local" } = {}) {
  const day = String(record.startedAt ?? "").slice(0, 10);
  const evidence = { kind: "run", ref: record.runId, label: day ? `${day} · ${label}` : label, provenance };
  if (Number.isFinite(value)) { evidence.value = Math.round(value); evidence.unit = unit; }
  return evidence;
}

export function metricEvidence(ruleId, name, label, value, { unit = "count", provenance = "derived.exact" } = {}) {
  return { kind: "metric", ref: `habit:${ruleId}:${name}`, label, value: Number.isFinite(value) ? value : undefined, unit, provenance };
}

/** Majority vendor across the records, or "both" when split. */
export function platformOf(records) {
  const counts = new Map();
  for (const record of records) counts.set(record.vendor, (counts.get(record.vendor) ?? 0) + 1);
  if (counts.size === 1) return [...counts.keys()][0];
  const [top, next] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return next && next[1] === top[1] ? "both" : top[0];
}

export function instructionFileFor(platform) {
  return platform === "codex" ? "AGENTS.md" : "CLAUDE.md";
}

/** Top `limit` records by `pick` descending as run evidence. */
export function topRunEvidence(records, pick, toLabel, limit = MAX_RUN_EVIDENCE) {
  return [...records]
    .map((record) => ({ record, value: pick(record) ?? 0 }))
    .sort((a, b) => b.value - a.value || recordTime(b.record) - recordTime(a.record))
    .slice(0, limit)
    .map(({ record, value }) => runEvidence(record, toLabel(record, value), { value }));
}

export function makeHabitFinding(rule, { primaryRef, records, evidence, fix, tokensAffected, severity, title, count }) {
  if (!evidence?.length) throw new Error(`${rule.id}: a finding needs at least one evidence entry`);
  const sessions = new Set(records.map((record) => record.runId)).size;
  const finding = {
    id: findingId(rule.id, primaryRef ?? evidence[0].ref),
    ruleId: rule.id,
    severity: severity ?? rule.severity,
    scope: "habit",
    sessions,
    title: title ?? rule.title,
    whyItMatters: rule.whyItMatters,
    evidence,
    fix,
    thresholdKeys: [...rule.thresholdKeys],
  };
  const platform = platformOf(records);
  if (platform !== "both") finding.vendor = platform;
  if (Number.isFinite(tokensAffected)) finding.tokensAffected = Math.round(tokensAffected);
  if (count !== undefined) finding.count = count;
  return finding;
}

export function assertHabitFindingShape(finding) {
  const fail = (message) => { throw new Error(`invalid habit finding ${finding?.id ?? "?"}: ${message}`); };
  if (!finding || typeof finding !== "object") fail("not an object");
  if (typeof finding.id !== "string" || !/^H-\d{2}:[0-9a-f]{10}$/.test(finding.id)) fail(`bad id ${finding.id}`);
  if (finding.scope !== "habit") fail(`bad scope ${finding.scope}`);
  if (!SEVERITIES.has(finding.severity)) fail(`bad severity ${finding.severity}`);
  if (!Number.isInteger(finding.sessions) || finding.sessions < 1) fail("sessions missing");
  if (!Array.isArray(finding.evidence) || !finding.evidence.length) fail("empty evidence");
  if (!finding.evidence.some((item) => item.kind === "run")) fail("no run evidence");
  if (finding.evidence.filter((item) => item.kind === "run").length > MAX_RUN_EVIDENCE) fail("too many run evidence items");
  for (const item of finding.evidence) {
    if (!EVIDENCE_KINDS.has(item?.kind)) fail(`bad evidence kind ${item?.kind}`);
    if (typeof item.ref !== "string" || !item.ref) fail("evidence without ref");
    if (typeof item.label !== "string" || !item.label) fail("evidence without label");
    if (!PROVENANCES.has(item.provenance)) fail(`bad provenance ${item.provenance}`);
  }
  if (!finding.fix || typeof finding.fix.summary !== "string" || !finding.fix.summary) fail("fix without summary");
  if (!["claude", "codex", "gemini", "both"].includes(finding.fix.platform)) fail(`bad fix platform ${finding.fix.platform}`);
  return finding;
}

export function rankHabitFindings(findings) {
  return [...findings].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    || (b.sessions ?? 0) - (a.sessions ?? 0)
    || (b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)
    || a.id.localeCompare(b.id));
}

function isRecord(item) {
  return Boolean(item && item.habits && item.runId && item.vendor && "requests" in item);
}

/**
 * Habit findings over a repo's records, with the reasons a rule stayed quiet
 * (`notes`: H-05 confounded by a CLI upgrade; a rule starved of sessions —
 * "H-04 needs 6 sessions, this repo has 3"; records written by an older
 * habits version). `records` may be manifest entries or HabitRecords; entries
 * without a habits record are skipped. Records are grouped by root run before
 * any rule runs: a child's record (its `parentRunId` chain, or `rootOf(record)`
 * when the caller resolved roots over the whole manifest) merges into its
 * root's, so `sessions` in the result is the number of top-level runs.
 */
export async function evaluateHabitsDetailed(records, { thresholds = {}, setup, rules, onWarning, rootOf } = {}) {
  const projected = [];
  for (const item of Array.isArray(records) ? records : []) {
    const record = isRecord(item) ? { ...item } : habitRecordOf(item);
    if (!record) continue;
    if (record.rootRunId === undefined && typeof rootOf === "function") record.rootRunId = rootOf(item) ?? undefined;
    projected.push(record);
  }
  // Roots resolved over the records themselves when the caller did not: a parent absent from the list makes the child top-level.
  const byRunId = indexByRunId(projected.map((record) => ({ ...record, summary: {}, parentThreadId: record.parentRunId?.slice(record.parentRunId.indexOf(":") + 1) })));
  const known = new Set(projected.map((record) => record.runId));
  const rootIdOf = (record) => (record.rootRunId && known.has(record.rootRunId) ? record.rootRunId : rootRunIdOf(byRunId.get(record.runId), byRunId) ?? record.runId);
  const roots = new Map();
  const childrenOf = new Map();
  for (const record of projected) {
    const rootId = rootIdOf(record);
    if (rootId === record.runId) { roots.set(record.runId, record); continue; }
    if (!childrenOf.has(rootId)) childrenOf.set(rootId, []);
    childrenOf.get(rootId).push(record);
  }
  const list = [...roots.values()]
    .map((root) => mergeHabitRecords(root, childrenOf.get(root.runId) ?? []))
    .sort((a, b) => recordTime(a) - recordTime(b));
  const notes = [];
  const findings = [];
  const seen = new Set();
  const stale = list.filter((record) => record.stale).length;
  if (stale) notes.push({ ruleId: "habits", kind: "stale", reason: `${stale} session record${stale === 1 ? " was" : "s were"} computed by an older habits version (${HABITS_VERSION} current); the next index pass re-derives ${stale === 1 ? "it" : "them"}` });
  const allRules = rules ?? (await loadHabitRules({ onWarning }));
  for (const rule of allRules) {
    const needs = typeof rule.needs === "function" ? Number(rule.needs(thresholds)) : 0;
    if (needs > 0 && list.length < needs) {
      notes.push({ ruleId: rule.id, kind: "starved", needs, have: list.length, reason: `needs ${needs} sessions, this repo has ${list.length}` });
      continue;
    }
    let out;
    try { out = rule.evaluate({ habits: list, setup, thresholds, notes }) ?? []; }
    catch (error) { warn(onWarning, `${rule.id}: evaluate threw (${error.message})`); continue; }
    if (!Array.isArray(out)) { warn(onWarning, `${rule.id}: evaluate did not return an array`); continue; }
    for (const finding of out) {
      try {
        assertHabitFindingShape(finding);
        if (seen.has(finding.id)) continue;
        seen.add(finding.id);
        findings.push(finding);
      } catch (error) {
        warn(onWarning, `${rule.id}: dropped finding (${error.message})`);
      }
    }
  }
  const subagentRuns = list.reduce((sum, record) => sum + (record.subagentRuns ?? 0), 0);
  return { findings: rankHabitFindings(findings), notes, sessions: list.length, subagentRuns, stale };
}

export async function evaluateHabits(records, options = {}) {
  return (await evaluateHabitsDetailed(records, options)).findings;
}

export { formatTokens, RULES_DIR as HABIT_RULES_DIR };
