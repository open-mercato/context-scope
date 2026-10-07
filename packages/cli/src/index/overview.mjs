/**
 * Overview, findings recurrence and repo session stats, computed from manifest
 * entries only. No run file is opened here; the guard in index.test.mjs spies
 * on that.
 *
 * Population (ADR-004 section 2): every count labelled "sessions" is the number
 * of top-level runs (`repoSessions` in reader.mjs); Codex child rollouts are
 * subagents of their root and fold their requests, blocks, handoffs and
 * findings into it. Recurrence rule (ADR-002 section B, route part): a session
 * finding's `recurrence` is the number of distinct root runs of the current
 * repo whose own or descendants' `summary.findingIds` contain the same rule id. Setup findings act
 * on every session when the rule is S-01, S-02 or S-06 (an oversized chain, a
 * duplicated file, a broken import are paid on every request), so their
 * recurrence is the repo's session count; every other setup rule counts 1.
 * "First change" = argmax severityWeight × min(recurrence, 10); ties prefer a
 * finding with a `fix.path`, then the larger Σ tokensAffected (entry.mjs).
 */
import path from "node:path";
import { entryTime, indexByRunId, isChildEntry, repoSessions, toOverviewRun, topBlocksOfEntry } from "./reader.mjs";
import { SETUP_RULES_EVERY_SESSION, baseTitle, rankFindings, rankFirstChange } from "./entry.mjs";
import { parseSince } from "../util/format.mjs";

export const DEFAULT_SINCE_DAYS = 30;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_TREND_DAYS = 365;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function dayKey(iso) {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

export function ruleIdOf(findingId) {
  return String(findingId ?? "").split(":")[0];
}

/**
 * Map<ruleId, number of distinct sessions (root runs) in which the rule fired>.
 * `children` (Map<rootRunId, entries[]>) folds descendants into their root; a
 * plain entry list without it counts every entry as its own session.
 */
export function recurrenceByRule(roots, children = new Map()) {
  const counts = new Map();
  const seen = new Set();
  for (const entry of roots) {
    if (!entry || entry.error || seen.has(entry.runId)) continue;
    seen.add(entry.runId);
    const rules = new Set();
    for (const member of [entry, ...(children.get(entry.runId) ?? [])]) {
      for (const id of member.summary?.findingIds ?? []) { const ruleId = ruleIdOf(id); if (ruleId) rules.add(ruleId); }
    }
    for (const ruleId of rules) counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  }
  return counts;
}

/** Sets `finding.recurrence` in place (see the rule above). Returns the findings for chaining. */
export function attachRecurrence(findings, recurrence, { sessionCount = 0 } = {}) {
  for (const finding of findings) {
    if (!finding) continue;
    if (finding.scope === "setup") finding.recurrence = SETUP_RULES_EVERY_SESSION.has(finding.ruleId) ? Math.max(1, sessionCount) : 1;
    // Habit findings span sessions by construction: leverage uses the session count the rule measured.
    else if (finding.scope === "habit") finding.recurrence = Math.max(1, finding.sessions ?? 1);
    else finding.recurrence = Math.max(1, recurrence.get(finding.ruleId) ?? 1);
  }
  return findings;
}

/** Groups ranked findings by rule id (ADR-002 section B): one row per rule with session/occurrence totals. */
export function groupFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const group = groups.get(finding.ruleId) ?? {
      ruleId: finding.ruleId, title: baseTitle(finding.title), severity: finding.severity, scope: finding.scope,
      sessions: finding.recurrence ?? 1, occurrences: 0, tokensAffected: 0, findings: [],
    };
    group.occurrences += finding.count ?? 1;
    group.tokensAffected += finding.tokensAffected ?? 0;
    group.sessions = Math.max(group.sessions, finding.recurrence ?? 1);
    if ((SEVERITY_RANK[finding.severity] ?? 3) < (SEVERITY_RANK[group.severity] ?? 3)) group.severity = finding.severity;
    group.findings.push(finding);
    groups.set(finding.ruleId, group);
  }
  return [...groups.values()].sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || b.tokensAffected - a.tokensAffected
    || b.sessions - a.sessions
    || a.ruleId.localeCompare(b.ruleId));
}

/** Finding heads of every entry in the population; a child's head keeps its own `runId` (where the evidence lives) and names its root. */
function populationHeads(population) {
  const heads = [];
  for (const entry of population.entries) {
    const rootRunId = population.rootOf(entry);
    for (const head of entry.findingHeads ?? []) heads.push({ ...head, runId: entry.runId, rootRunId, vendor: entry.vendor, evidence: [], thresholdKeys: [] });
  }
  return heads;
}

/**
 * Lower bound of the range in ms; 0 = all time. `since` accepts "30d", "12h",
 * an ISO date or "all". Default: all time for `mode: "repo"` (repo sessions are
 * few; a 30-day window hid every session of a repo last touched in the spring),
 * the last 30 days for `mode: "all"` (the machine-wide population).
 */
export function resolveSince(since, now, { mode = "all" } = {}) {
  const parsed = parseSince(since, now);
  if (parsed !== null) return parsed;
  return mode === "repo" ? 0 : now - DEFAULT_SINCE_DAYS * DAY_MS;
}

/** The range as a label: the request as given ("30d", "all", an ISO date) or the mode default. */
export function rangeLabel(since, { mode = "all" } = {}) {
  if (since !== undefined && since !== null && since !== "") return typeof since === "number" ? new Date(since).toISOString() : String(since).trim();
  return mode === "repo" ? "all" : `${DEFAULT_SINCE_DAYS}d`;
}

export function resolveLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(value));
}

function medianOf(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Overview from manifest entries. `scope` picks the population (ADR-003 §1):
 * "repo" (default) = sessions attributed to `repoRoot`/`projectKey`, "all" =
 * every session on the machine. A session is a top-level run; Codex child
 * rollouts are its subagents (ADR-004 §2) and appear as `children` of the root
 * row (every depth, flattened, each with its direct `parentRunId`). `nested`
 * (alias `all` from cycle 1) additionally lists children as rows — a debug
 * view. `since` ("30d", "all", ISO; default all time for repo, 30 d for all)
 * bounds rows, totals and trends by the root's time. `firstFinding` is always
 * repo-scoped; `habitFindings` take part in it. `instructionFiles` (setup
 * inventory) feed the edit markers.
 */
export function buildOverviewFromEntries(entries, {
  repoRoot,
  projectKey,
  since,
  limit,
  scope: scopeMode,
  kind: kindOption,
  nested,
  all = false,
  now: nowOption,
  setupFindings = [],
  habitFindings = [],
  instructionFiles = [],
  repoFiles,
  chainHashes,
  indexState = {},
  vendors: vendorTable = [],
} = {}) {
  const now = Number.isFinite(nowOption) ? nowOption : Date.now();
  const mode = scopeMode === "all" ? "all" : "repo";
  const listKind = kindOption === "harness" ? "harness" : "interactive";
  const sinceMs = resolveSince(since, now, { mode });
  const rowLimit = resolveLimit(limit);
  const showNested = nested ?? all;
  // Attribution evidence for temp-cwd sessions (ADR-005 §2): the repo's file list (`repoFiles`, from
  // analysis.mjs) and its instruction-file hashes (`chainHashes`, default: the setup inventory's `hash`).
  const hashes = Array.isArray(chainHashes) ? chainHashes : (Array.isArray(instructionFiles) ? instructionFiles : []).map((file) => file?.hash).filter((hash) => typeof hash === "string" && hash);
  const repoScope = { repoRoot, projectKey, repoFiles, chainHashes: hashes };
  const machine = repoSessions({ entries, since: sinceMs || undefined });
  const repoInRange = repoSessions({ entries, ...repoScope, since: sinceMs || undefined });
  // `kind=harness` lists the machine's harness runs (scope=all) and nothing else; they never join the repo/machine populations.
  const population = listKind === "harness" ? repoSessions({ entries, since: sinceMs || undefined, kind: "harness" }) : mode === "repo" ? repoInRange : machine;
  const { roots, children, rootOf } = population;
  const descendantsOf = (root) => children.get(root.runId) ?? [];

  // Codex child handoffs: joined from the direct parent's `handoffsByThread` (review #5); attributed to the root.
  const childHandoffs = new Map();
  for (const root of roots) {
    for (const child of descendantsOf(root)) {
      const parent = population.byRunId.get(`${child.vendor}:${child.parentThreadId}`);
      const table = parent?.handoffsByThread ?? {};
      const handoff = table[child.sessionId] ?? table[child.runId];
      if (!handoff || !(handoff.tokens > 0)) continue;
      const childPeak = child.summary?.peak?.value ?? 0;
      childHandoffs.set(child.runId, {
        runId: root.runId,
        scopeId: child.runId,
        parentRunId: parent.runId,
        blockId: handoff.blockId,
        agentType: child.summary?.agentType ?? child.project?.agentType ?? undefined,
        handoffTokens: handoff.tokens,
        childPeak,
        ratio: Number((childPeak / handoff.tokens).toFixed(2)),
      });
    }
  }

  const childRow = (child) => {
    const row = toOverviewRun(child);
    if (!row) return null;
    row.parentRunId = `${child.vendor}:${child.parentThreadId}`;
    row.rootRunId = rootOf(child);
    const handoff = childHandoffs.get(child.runId);
    if (handoff) row.handoff = { tokens: handoff.handoffTokens, childPeak: handoff.childPeak, ratio: handoff.ratio };
    return row;
  };

  const runs = [];
  const runsInRange = roots.length;
  for (const root of roots) {
    if (runs.length >= rowLimit) break;
    const row = toOverviewRun(root);
    if (!row) continue;
    if (root.kind === "harness") row.kind = "harness";
    if (typeof root.entrypoint === "string" && root.entrypoint) row.entrypoint = root.entrypoint;
    const attribution = population.attributionOf?.(root);
    if (attribution) row.attribution = attribution;
    const kids = descendantsOf(root).map(childRow).filter(Boolean);
    if (kids.length) {
      row.children = kids;
      // A Codex parent's subagent count = its descendants (plus whatever its own transcript reports).
      row.summary = { ...row.summary, subagents: (row.summary.subagents ?? 0) + kids.length };
    }
    runs.push(row);
    if (showNested) for (const kid of kids) if (runs.length < rowLimit) runs.push(kid);
  }

  const totals = { runs: 0, subagents: 0, requests: 0, processedInputTokens: 0, outputTokens: 0, cacheReadShare: 0, compactions: 0, vendors: [], sessionsByVendor: {}, sessionsHot: 0 };
  let cacheRead = 0;
  const vendors = new Set();
  for (const root of roots) {
    vendors.add(root.vendor);
    totals.runs += 1;
    totals.sessionsByVendor[root.vendor] = (totals.sessionsByVendor[root.vendor] ?? 0) + 1;
    if ((root.summary.peakShareOfWindow ?? 0) >= 0.8) totals.sessionsHot += 1;
    for (const entry of [root, ...descendantsOf(root)]) {
      const summary = entry.summary;
      if (entry !== root) totals.subagents += 1;
      totals.subagents += summary.subagents ?? 0;
      totals.requests += summary.requests ?? 0;
      totals.processedInputTokens += summary.processedInputTokens ?? 0;
      totals.outputTokens += summary.outputTokens ?? 0;
      totals.compactions += summary.compactions ?? 0;
      cacheRead += (summary.cacheReadShare ?? 0) * (summary.processedInputTokens ?? 0);
    }
  }
  totals.cacheReadShare = totals.processedInputTokens > 0 ? Number((cacheRead / totals.processedInputTokens).toFixed(4)) : 0;
  totals.vendors = [...vendors].sort();

  // Trends bucket by the root's day (endedAt), one bucket per day, first day included; children land in their root's day.
  const days = [];
  const dayIndex = new Map();
  // All time: one bucket per day from the oldest session in the population (at least 30, at most 365 days).
  const spanStart = sinceMs || (roots.length ? Math.min(...roots.map((entry) => entryTime(entry)).filter(Number.isFinite)) : now);
  const dayCount = sinceMs
    ? Math.max(1, Math.ceil((now - sinceMs) / DAY_MS))
    : Math.min(MAX_TREND_DAYS, Math.max(DEFAULT_SINCE_DAYS, Math.ceil((now - spanStart) / DAY_MS) + 1));
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const key = new Date(now - offset * DAY_MS).toISOString().slice(0, 10);
    dayIndex.set(key, days.length);
    days.push(key);
  }
  const trends = {
    days,
    processedInputTokens: days.map(() => 0),
    requests: days.map(() => 0),
    compactions: days.map(() => 0),
    subagents: days.map(() => 0),
    sessions: days.map(() => 0),
    peakShareMedian: days.map(() => 0),
    startupH0Median: days.map(() => 0),
    instructionEdits: [],
  };
  const peakShares = days.map(() => []);
  const startupH0s = days.map(() => []);
  for (const root of roots) {
    const at = dayIndex.get(dayKey(root.endedAt) ?? dayKey(root.startedAt));
    if (at === undefined) continue;
    trends.sessions[at] += 1;
    if (Number.isFinite(root.summary.peakShareOfWindow)) peakShares[at].push(root.summary.peakShareOfWindow);
    const h0 = root.habits?.startup?.h0;
    if (Number.isFinite(h0) && h0 > 0) startupH0s[at].push(h0);
    for (const entry of [root, ...descendantsOf(root)]) {
      trends.processedInputTokens[at] += entry.summary.processedInputTokens ?? 0;
      trends.requests[at] += entry.summary.requests ?? 0;
      trends.compactions[at] += entry.summary.compactions ?? 0;
      trends.subagents[at] += (entry.summary.subagents ?? 0) + (entry !== root ? 1 : 0);
    }
  }
  trends.peakShareMedian = peakShares.map((values) => Number(medianOf(values).toFixed(3)));
  trends.startupH0Median = startupH0s.map((values) => Math.round(medianOf(values)));
  for (const file of Array.isArray(instructionFiles) ? instructionFiles : []) {
    const at = Date.parse(file?.mtime ?? "");
    if (!Number.isFinite(at) || at < sinceMs || at > now + DAY_MS || typeof file.path !== "string") continue;
    trends.instructionEdits.push({ path: file.path, at: new Date(at).toISOString() });
  }
  trends.instructionEdits.sort((a, b) => a.at.localeCompare(b.at));
  trends.instructionEdits = trends.instructionEdits.slice(0, 50);

  const contextAtEnd = contextAtSessionEnd(roots);

  // Offenders attribute to the root session; a child's block or handoff names the child as `scopeId` (and `sourceRunId`).
  const largestBlocks = population.entries
    .flatMap((entry) => {
      const rootId = rootOf(entry);
      return topBlocksOfEntry(entry).map((block) => (rootId === entry.runId ? block : { ...block, runId: rootId, scopeId: entry.runId, sourceRunId: entry.runId, sourceScopeId: block.scopeId }));
    })
    .sort((a, b) => b.estTokens - a.estTokens)
    .slice(0, 10);
  const fattestHandoffs = [
    ...population.entries.flatMap((entry) => {
      const rootId = rootOf(entry);
      return (entry.handoffs ?? []).map((handoff) => (rootId === entry.runId ? { runId: entry.runId, ...handoff } : { runId: rootId, ...handoff, sourceRunId: entry.runId }));
    }),
    ...childHandoffs.values(),
  ]
    .sort((a, b) => b.handoffTokens - a.handoffTokens)
    .slice(0, 10);
  const mostCompacted = roots
    .map((root) => {
      const members = [root, ...descendantsOf(root)];
      return {
        runId: root.runId,
        compactions: members.reduce((sum, entry) => sum + (entry.summary.compactions ?? 0), 0),
        processedInputTokens: members.reduce((sum, entry) => sum + (entry.summary.processedInputTokens ?? 0), 0),
      };
    })
    .filter((row) => row.compactions > 0)
    .sort((a, b) => b.compactions - a.compactions || b.processedInputTokens - a.processedInputTokens)
    .slice(0, 10);

  // Findings of the launched repo, all time: recurrence and the first change come from finding heads only.
  const repoAllTime = sinceMs ? repoSessions({ entries, ...repoScope }) : repoInRange;
  const recurrence = recurrenceByRule(repoAllTime.roots, repoAllTime.children);
  const sessionCount = repoAllTime.roots.length;
  const candidates = attachRecurrence([
    ...populationHeads(repoAllTime),
    ...setupFindings.map((finding) => ({ ...finding })),
    ...habitFindings.map((finding) => ({ ...finding })),
  ], recurrence, { sessionCount });
  const firstFinding = rankFirstChange(candidates) ?? rankFindings(candidates)[0] ?? undefined;

  // Population line (ADR-003 §1, ADR-004 §2, ADR-005 §2): top-level sessions in range, repo vs machine, the ones that
  // joined the repo through evidence, the machine's harness runs, and the ones no project can claim.
  const scope = {
    mode,
    repo: { name: repoRoot ? path.basename(String(repoRoot).replace(/[\\/]+$/, "")) || String(repoRoot) : "", key: projectKey ?? "" },
    sessions: repoInRange.roots.length,
    subagents: repoInRange.roots.reduce((sum, root) => sum + (repoInRange.children.get(root.runId)?.length ?? 0) + (root.summary.subagents ?? 0), 0),
    machineSessions: machine.roots.length,
    unattributed: repoInRange.unattributed.length,
    attributed: repoInRange.attributions.size,
    harness: machine.harness.length,
    ...(listKind === "harness" ? { kind: "harness" } : {}),
  };

  const lastPass = indexState.lastPass ?? null;
  const vendorRows = Array.isArray(vendorTable) ? vendorTable.map((row) => ({ ...row })) : [];
  if (vendorRows.some((row) => row.parsed)) {
    const allTime = repoSessions({ entries });
    for (const row of vendorRows) if (row.parsed) row.sessions = allTime.roots.filter((entry) => entry.vendor === row.vendor).length;
  }

  return {
    scope,
    runs,
    totals,
    trends,
    topOffenders: { largestBlocks, fattestHandoffs, mostCompacted },
    contextAtEnd,
    firstFinding,
    vendors: vendorRows,
    since: sinceMs ? new Date(sinceMs).toISOString() : null,
    range: rangeLabel(since, { mode }),
    limit: rowLimit,
    index: {
      files: indexState.files ?? 0,
      indexed: indexState.indexed ?? 0,
      failed: indexState.failed ?? 0,
      runsInRange,
      state: indexState.state ?? "idle",
      lastRunAt: indexState.lastRunAt ?? lastPass?.at ?? undefined,
      lastPass: lastPass ? { total: lastPass.total ?? 0, parsed: lastPass.parsed ?? 0, reevaluated: lastPass.reevaluated ?? 0, skipped: lastPass.skipped ?? 0, failed: lastPass.failed ?? 0, ms: lastPass.ms ?? 0, at: lastPass.at, aborted: Boolean(lastPass.aborted) } : null,
      // Deprecated aliases (one release): progress of the current or last pass, not the corpus size.
      total: indexState.total ?? lastPass?.total ?? 0,
      done: indexState.state === "indexing" ? indexState.done ?? 0 : (lastPass?.total ?? 0),
    },
  };
}

/**
 * How the context was split when sessions ended: each root's main-scope
 * composition on its last request, turned into shares, then averaged with
 * every session weighing the same (a 900k session does not drown ten 50k ones).
 * `tokens` is the mean over the same sessions (0 where a category is absent).
 * Subagents are left out: their windows are private and never add to the parent.
 */
export function contextAtSessionEnd(roots) {
  const sums = new Map();
  let sessions = 0;
  let totalSum = 0;
  for (const root of roots) {
    const composition = root?.summary?.compositionAtEnd;
    if (!composition) continue;
    const entries = Object.entries(composition).filter(([, value]) => Number.isFinite(value) && value > 0);
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    if (!(total > 0)) continue;
    sessions += 1;
    totalSum += total;
    for (const [category, value] of entries) {
      const row = sums.get(category) ?? { share: 0, tokens: 0, sessions: 0 };
      row.share += value / total;
      row.tokens += value;
      row.sessions += 1;
      sums.set(category, row);
    }
  }
  const rows = [...sums.entries()]
    .map(([category, row]) => ({ category, share: Number((row.share / sessions).toFixed(4)), tokens: Math.round(row.tokens / sessions), sessions: row.sessions }))
    .sort((a, b) => b.share - a.share || a.category.localeCompare(b.category));
  return { sessions, meanTotal: sessions ? Math.round(totalSum / sessions) : 0, rows };
}

export function emptyStats() {
  return { skillInvocations: {}, agentRuns: {}, hookRuns: {}, mcpInvocations: {}, mcpToolsObserved: {}, vendorsWithSessions: [], sessionCount: 0, codexInstructionChars: 0, instructionFilesObserved: [] };
}

/**
 * Session stats over a list of entries. `sessionCount` follows the population
 * rule: a child rollout whose root is in the list does not count as a session
 * (pass `{ sessions }` to override with the population's root count).
 */
export function aggregateStats(entries, { sessions } = {}) {
  const total = emptyStats();
  const vendors = new Set();
  const instructionFiles = new Set();
  const byRunId = indexByRunId(entries);
  for (const entry of entries) {
    const stats = entry.stats;
    if (!stats) continue;
    if (!isChildEntry(entry, byRunId)) total.sessionCount += stats.sessionCount ?? 1;
    for (const vendor of stats.vendorsWithSessions ?? [entry.vendor]) vendors.add(vendor);
    for (const [key, value] of Object.entries(stats.skillInvocations ?? {})) total.skillInvocations[key] = (total.skillInvocations[key] ?? 0) + value;
    for (const [key, value] of Object.entries(stats.agentRuns ?? {})) total.agentRuns[key] = (total.agentRuns[key] ?? 0) + value;
    for (const [key, value] of Object.entries(stats.mcpInvocations ?? {})) total.mcpInvocations[key] = (total.mcpInvocations[key] ?? 0) + value;
    for (const [server, tools] of Object.entries(stats.mcpToolsObserved ?? {})) {
      const list = (total.mcpToolsObserved[server] ??= []);
      for (const tool of tools) if (!list.includes(tool)) list.push(tool);
    }
    for (const [name, hook] of Object.entries(stats.hookRuns ?? {})) {
      const target = (total.hookRuns[name] ??= { runs: 0, stdoutSizes: [], unit: hook.unit ?? "tokens", byMatcher: {} });
      target.runs += hook.runs ?? 0;
      target.stdoutSizes.push(...(hook.stdoutSizes ?? []));
      for (const [matcher, sub] of Object.entries(hook.byMatcher ?? {})) {
        const slot = (target.byMatcher[matcher] ??= { runs: 0, stdoutSizes: [] });
        slot.runs += sub.runs ?? 0;
        slot.stdoutSizes.push(...(sub.stdoutSizes ?? []));
      }
    }
    if (Number.isFinite(stats.codexInstructionChars)) total.codexInstructionChars = Math.max(total.codexInstructionChars, stats.codexInstructionChars);
    for (const file of stats.instructionFilesObserved ?? []) instructionFiles.add(file);
  }
  if (Number.isFinite(sessions)) total.sessionCount = sessions;
  total.vendorsWithSessions = [...vendors].sort();
  total.instructionFilesObserved = [...instructionFiles].slice(0, 500);
  return total;
}
