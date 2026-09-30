/**
 * `contextscope scan`: a terminal rendering of the index (ADR-002 section E).
 * A session is a top-level run; Codex child rollouts count as subagents
 * (ADR-004 section 2), in the header, the Habits title and every "N sessions".
 * Everything printed comes from the overview, the grouped findings and the
 * setup inventory: the same numbers the API serves, nothing read from a
 * transcript. `scanReport` builds the JSON; `renderScan` formats it.
 */
import { sourcesFor, withSources } from "../rules/sources.mjs";
import { formatCount, formatPercent, formatTokens, padLeft, padRight } from "../util/format.mjs";
import { groupFindings } from "./overview.mjs";

// Cycle-3 blocks are owned by other streams (ADR-005 §10): the changes block by index/changes.mjs (stream A) and the
// per-tool cost line by server/routes/cost.mjs (stream C). Each is mounted when its module exists and skipped otherwise.
const changesModule = await import("./changes.mjs").catch(() => null);
const costModule = await import("../server/routes/cost.mjs").catch(() => null);

const MAX_GROUP_ROWS = 12;
const MAX_COST_ROWS = 6;

/**
 * { overview, groups, setup, findings, firstChange, habits } from an analysis
 * provider (server/analysis.mjs). `all` prints the machine population; the
 * repo line (and every finding) stays repo-scoped either way.
 */
export async function scanReport(analysis, { since, limit, all = false } = {}) {
  const overview = await analysis.overview({ since, limit, scope: all ? "all" : "repo" });
  const findingsResponse = await analysis.findings({});
  const setup = await analysis.setup();
  let habits = { findings: [], notes: [], sessions: overview.scope?.sessions ?? 0 };
  if (typeof analysis.habits === "function") {
    try { habits = await analysis.habits({ since }); } catch {}
  }
  // Before/after per instruction-file edit (ADR-005 §1, stream A) and cost by tool (§5, stream C): both optional.
  let changes = null;
  if (typeof analysis.changes === "function") {
    try { changes = await analysis.changes({ since }); } catch {}
  }
  // Repo-scoped like the findings: `summary.toolCost` summed over the population (manifest only).
  let cost = null;
  if (typeof costModule?.aggregateToolCost === "function" && typeof analysis.population === "function") {
    try {
      const pop = await analysis.population({ since });
      const aggregate = costModule.aggregateToolCost(pop.entries);
      cost = { unit: "token-requests", provenance: "estimated.local", scope: { mode: "repo", sessions: pop.roots.length, runs: aggregate.runs, runsWithoutCost: aggregate.runsWithoutCost }, denominator: aggregate.denominator, rows: aggregate.rows };
    } catch {}
  }
  return {
    overview,
    groups: findingsResponse.groups ?? groupFindings(findingsResponse.findings ?? []),
    findings: findingsResponse.findings ?? [],
    firstChange: findingsResponse.firstChange ?? overview.firstFinding,
    setup: { ...setup, findings: setup.findings ?? [] },
    habits: { findings: habits.findings ?? [], notes: habits.notes ?? [], sessions: habits.sessions ?? 0, stale: habits.stale ?? 0 },
    ...(changes ? { changes } : {}),
    ...(cost ? { cost } : {}),
  };
}

/** The JSON `scan --json` prints: the report minus nothing, with the optional blocks only when present. */
export function scanJson(report) {
  const out = { overview: report.overview, groups: report.groups, findings: report.findings, firstChange: report.firstChange ? withSources(report.firstChange) : report.firstChange, habits: report.habits, setup: report.setup };
  // Where each fired rule's rationale comes from (read-time; src/rules/sources.json).
  const ruleIds = new Set([...(report.groups ?? []).map((group) => group.ruleId), ...(report.habits?.findings ?? []).map((finding) => finding.ruleId)].filter(Boolean));
  const ruleSources = Object.fromEntries([...ruleIds].sort().map((id) => [id, sourcesFor(id)]).filter(([, entry]) => entry));
  if (Object.keys(ruleSources).length) out.ruleSources = ruleSources;
  if (report.changes) out.changes = report.changes;
  if (report.cost) out.cost = report.cost;
  return out;
}

/** Sessions per vendor from the totals (never from the row-capped list, review #19). */
function vendorBreakdown(overview) {
  const byVendor = overview.totals?.sessionsByVendor;
  const counts = byVendor && typeof byVendor === "object" ? Object.entries(byVendor) : [];
  const parts = counts.sort().map(([vendor, n]) => `${vendor} ${formatCount(n)}`);
  for (const row of overview.vendors ?? []) if (row.detected && !row.parsed) parts.push(`${row.vendor} ${formatCount(row.files)} unparsed`);
  const attributed = overview.scope?.attributed;
  const text = parts.join(" · ");
  // ADR-005 §2 (stream B): sessions claimed through file-path overlap are named in the header.
  return attributed > 0 ? `${text}; ${formatCount(attributed)} attributed by path overlap` : text;
}

/** `56 harness runs and 3 unattributed on this machine` (ADR-005 §2), or the cycle-2 unattributed tail, or nothing. */
function machineTail(scope) {
  if (!scope) return "";
  const parts = [];
  if (scope.harness > 0) parts.push(`${formatCount(scope.harness)} harness run${scope.harness === 1 ? "" : "s"}`);
  if (scope.unattributed > 0) parts.push(`${formatCount(scope.unattributed)} unattributed`);
  return parts.length ? ` · ${parts.join(" and ")} on this machine` : "";
}

/** The range the overview used: "all time", "last N days", or "since <value>". */
export function sinceLabel(overview, sinceOption) {
  const range = String(sinceOption ?? overview?.range ?? "").trim();
  if (/^all$/i.test(range) || (!range && !overview?.since)) return "all time";
  const days = /^(\d+(?:\.\d+)?)d$/i.exec(range);
  if (days) return `last ${Number(days[1])} days`;
  if (range) return `since ${range}`;
  const elapsed = Math.round((Date.now() - Date.parse(overview.since ?? "")) / (24 * 3600 * 1000));
  return Number.isFinite(elapsed) && elapsed > 0 ? `last ${elapsed} days` : "all time";
}

function indexLabel(overview) {
  const index = overview.index ?? {};
  const pass = index.lastPass;
  if (index.state === "indexing") return `indexing ${formatCount(index.done ?? 0)}/${formatCount(index.total ?? 0)}`;
  if (!pass) return `index empty (${formatCount(index.files ?? 0)} files)`;
  const changed = (pass.parsed ?? 0) + (pass.reevaluated ?? 0);
  const reevaluated = pass.reevaluated ? `, ${formatCount(pass.reevaluated)} re-evaluated` : "";
  return `index up to date (${formatCount(index.files ?? 0)} files, ${formatCount(changed)} changed${reevaluated}${pass.failed ? `, ${formatCount(pass.failed)} failed` : ""})`;
}

function severityTag(severity) {
  return `[${String(severity ?? "low").toUpperCase()}]`;
}

function fixLine(finding) {
  const fix = finding?.fix;
  if (!fix?.summary) return null;
  const target = fix.path ? ` → ${fix.path}` : "";
  return `  Fix (${fix.platform ?? "both"})${target}: ${fix.summary}`;
}

/** "H-04 needs 6 sessions, this repo has 3" for a starved rule; "H-05 suppressed for CLAUDE.md: …" otherwise. */
function noteLine(note) {
  if (note.kind === "starved") return `  ${note.ruleId} ${note.reason}`;
  if (note.kind === "stale") return `  ${note.reason}`;
  return `  ${note.ruleId} suppressed${note.path ? ` for ${note.path}` : ""}: ${note.reason}`;
}

/** `repo <name> · N sessions (M on this machine)`, or the machine line with the repo under it for `--all`. */
function scopeLine(overview, repoName) {
  const scope = overview.scope;
  if (!scope) return `repo ${repoName}`;
  const name = scope.repo?.name || repoName;
  const machine = `${formatCount(scope.machineSessions)} on this machine`;
  if (scope.mode === "all") return `all projects · ${formatCount(scope.machineSessions)} sessions · repo ${name}: ${formatCount(scope.sessions)}`;
  return `repo ${name} · ${formatCount(scope.sessions)} session${scope.sessions === 1 ? "" : "s"} (${machine})`;
}

export function renderScan(report, { repoName = "repo", since } = {}) {
  const { overview, groups, firstChange, habits } = report;
  const totals = overview.totals ?? {};
  const scope = overview.scope;
  const hot = totals.sessionsHot ?? (overview.runs ?? []).filter((run) => (run.summary?.peakShareOfWindow ?? 0) >= 0.8).length;
  const lines = [];
  lines.push(`ContextScope · ${scopeLine(overview, repoName)} · ${sinceLabel(overview, since)} · ${indexLabel(overview)}`);
  lines.push(`Sessions ${formatCount(totals.runs ?? 0)}${totals.runs ? ` (${vendorBreakdown(overview)})` : ""} · subagents ${formatCount(totals.subagents ?? 0)} · requests ${formatCount(totals.requests ?? 0)}${machineTail(scope)}`);
  lines.push(`Processed input ${formatTokens(totals.processedInputTokens ?? 0)} tokens · cache-read ${formatPercent(totals.cacheReadShare ?? 0)} · compactions ${formatCount(totals.compactions ?? 0)} · sessions above 80% of window: ${formatCount(hot)}`);
  const costLine = renderCostLine(report.cost);
  if (costLine) lines.push(costLine);
  lines.push("");
  if (firstChange) {
    lines.push("One change to make first");
    const sessions = firstChange.recurrence ?? 1;
    const removes = firstChange.removes?.findings ?? firstChange.count ?? 1;
    const detail = firstChange.scope === "setup"
      ? `applies to ${formatCount(sessions)} session${sessions === 1 ? "" : "s"}`
      : `${formatCount(sessions)} session${sessions === 1 ? "" : "s"} · ${formatCount(removes)} finding${removes === 1 ? "" : "s"} · ${formatTokens(firstChange.tokensAffected ?? 0)} tokens`;
    lines.push(`  ${severityTag(firstChange.severity)} ${firstChange.ruleId} ${firstChange.title} · ${detail}`);
    const fix = fixLine(firstChange);
    if (fix) lines.push(fix);
    lines.push("");
  }
  if (habits?.findings?.length || habits?.notes?.length) {
    lines.push(`Habits (${formatCount(habits.sessions ?? scope?.sessions ?? 0)} sessions)`);
    for (const finding of habits.findings.slice(0, MAX_GROUP_ROWS)) {
      const tokens = finding.tokensAffected ? ` · ${formatTokens(finding.tokensAffected)} tokens` : "";
      lines.push(`  ${padRight(finding.ruleId, 5)} ${padRight(finding.title, 52)} ${padRight(finding.severity, 7)} ${padLeft(formatCount(finding.sessions ?? 1), 3)} sessions${tokens}`.trimEnd());
      const fix = fixLine(finding);
      if (fix) lines.push(`  ${fix.trim()}`);
    }
    for (const note of habits.notes ?? []) lines.push(noteLine(note));
    lines.push("");
  }
  const changesLines = renderChangesBlock(report.changes);
  if (changesLines.length) {
    lines.push(...changesLines);
    lines.push("");
  }
  if (groups?.length) {
    lines.push("Findings by leverage");
    const ranked = [...groups].sort((a, b) => leverage(b) - leverage(a) || b.tokensAffected - a.tokensAffected).slice(0, MAX_GROUP_ROWS);
    for (const group of ranked) {
      const where = group.scope === "setup"
        ? `setup${group.findings?.[0]?.fix?.path ? `  ${group.findings[0].fix.path}` : ""}`
        : `${padLeft(formatCount(group.sessions), 3)} session${group.sessions === 1 ? " " : "s"}${group.scope === "habit" ? " (habit)" : ""}`;
      const tokens = group.scope === "setup" ? "" : `${padLeft(formatTokens(group.tokensAffected), 7)} tokens${group.occurrences > group.findings.length ? ` (${formatCount(group.occurrences)})` : ""}`;
      lines.push(`  ${padRight(group.ruleId, 5)} ${padRight(group.title, 28)} ${padRight(group.severity, 7)} ${padRight(where, 12)} ${tokens}`.trimEnd());
    }
    lines.push("");
  } else {
    lines.push("No findings for this repository.");
    lines.push("");
  }
  lines.push("Open the evidence: contextscope start");
  return lines.join("\n");
}

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

function leverage(group) {
  return (SEVERITY_WEIGHT[group.severity] ?? 1) * Math.min(group.sessions ?? 1, 10);
}

/** Stream A's block after Habits (ADR-005 §1): its own renderer when the module is present, nothing otherwise. */
function renderChangesBlock(changes) {
  if (!changes) return [];
  if (typeof changesModule?.renderChangesLines === "function") {
    try { return changesModule.renderChangesLines(changes) ?? []; } catch { return []; }
  }
  return [];
}

/**
 * Stream C's line (ADR-005 §5): `Cost by tool: Bash 41% (cache-read 78%) · Read 22% · Agent handoffs 9% — token-requests,
 * estimated`. Uses the module's renderer when it exports one; else a local rendering of `{ rows|tools: [{ name, share,
 * cacheReadShare? }] }`; null when there is no data.
 */
export function renderCostLine(cost) {
  if (!cost) return null;
  if (typeof costModule?.renderCostLines === "function") {
    try { const lines = costModule.renderCostLines(cost); return Array.isArray(lines) ? lines.join("\n") || null : lines || null; } catch { return null; }
  }
  const rows = Array.isArray(cost.rows) ? cost.rows : Array.isArray(cost.tools) ? cost.tools : Array.isArray(cost) ? cost : [];
  const cacheRead = (row) => (Number.isFinite(row.cacheReadShare) ? row.cacheReadShare : row.tokenRequests > 0 && Number.isFinite(row.uncached) ? 1 - row.uncached / row.tokenRequests : null);
  const parts = rows
    .filter((row) => row && typeof row.name === "string" && Number.isFinite(row.share) && row.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_COST_ROWS)
    .map((row, position) => { const share = cacheRead(row); return `${row.name} ${formatPercent(row.share)}${position === 0 && share !== null ? ` (cache-read ${formatPercent(Math.max(0, share))})` : ""}`; });
  if (!parts.length) return null;
  const missing = cost.scope?.runsWithoutCost > 0 ? `; ${formatCount(cost.scope.runsWithoutCost)} run${cost.scope.runsWithoutCost === 1 ? "" : "s"} indexed before the field existed` : "";
  return `Cost by tool: ${parts.join(" · ")} — token-requests, estimated${missing}`;
}

// --- first run: the "what we found" block printed by `start` after the first pass (ADR-005 §6) ---

const CATEGORY_LABELS = {
  system: "system prompt", instructions: "instructions", skills: "skills", user: "user messages", assistant_text: "assistant text",
  assistant_thinking: "thinking", tool_call: "tool calls", "tool_result.file": "file reads", "tool_result.shell": "shell output",
  "tool_result.search": "search results", "tool_result.web": "web results", "tool_result.other": "other tool results",
  subagent_handoff: "subagent handoffs", compaction_summary: "compaction summaries", attachments: "attachments", memory: "memory",
  unlogged: "unlogged", other: "other",
};

/** Top categories at peak across the repo's sessions: each root's composition at its own peak, summed. */
export function compositionAtPeak(runs, { top = 3 } = {}) {
  const sums = new Map();
  let total = 0;
  for (const run of runs ?? []) {
    for (const [category, tokens] of Object.entries(run?.summary?.compositionAtPeak ?? {})) {
      const value = Number(tokens) || 0;
      if (value <= 0) continue;
      sums.set(category, (sums.get(category) ?? 0) + value);
      total += value;
    }
  }
  if (!total) return [];
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, top).map(([category, tokens]) => ({ category, label: CATEGORY_LABELS[category] ?? category, share: tokens / total }));
}

function shortStart(iso) {
  const at = new Date(iso ?? "");
  if (!Number.isFinite(at.getTime())) return "";
  return at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * The data behind the block: the repo overview (all time), the machine count,
 * the three questions and the hooks state. `pass` is the index pass result
 * (`{ files, ms }`), `hooks` the report from `hooksStatus` (optional).
 */
export async function firstRunReport(analysis, { pass, hooks } = {}) {
  const overview = await analysis.overview({ scope: "repo" });
  const findings = await analysis.findings({}).catch(() => ({}));
  const totals = overview.totals ?? {};
  const scope = overview.scope ?? {};
  const runs = overview.runs ?? [];
  const fattest = overview.topOffenders?.fattestHandoffs?.[0] ?? null;
  const handoffRun = fattest ? runs.find((run) => run.id === fattest.runId) : null;
  return {
    files: pass?.files ?? overview.index?.files ?? 0,
    ms: pass?.ms ?? overview.index?.lastPass?.ms ?? 0,
    machineSessions: scope.machineSessions ?? 0,
    repo: scope.repo?.name ?? "",
    sessions: totals.runs ?? scope.sessions ?? 0,
    sessionsByVendor: totals.sessionsByVendor ?? {},
    subagents: totals.subagents ?? 0,
    harness: scope.harness ?? 0,
    unattributed: scope.unattributed ?? 0,
    composition: compositionAtPeak(runs),
    handoff: fattest ? { agentType: fattest.agentType ?? null, handoffTokens: fattest.handoffTokens ?? 0, childPeak: fattest.childPeak ?? 0, ratio: fattest.ratio ?? 0, startedAt: handoffRun?.startedAt ?? null } : null,
    firstChange: findings.firstChange ?? overview.firstFinding ?? null,
    hooksInstalled: hooks ? Boolean(hooks.scopes?.some((entry) => entry.installed?.length)) : null,
    captureRecords: hooks?.capture?.records ?? 0,
  };
}

export function renderFirstRun(found, { url } = {}) {
  const lines = [];
  const byVendor = Object.entries(found.sessionsByVendor ?? {}).sort().map(([vendor, n]) => `${vendor} ${formatCount(n)}`).join(", ");
  const repo = found.repo ? ` · ${formatCount(found.sessions)} in ${found.repo}${byVendor ? ` (${byVendor})` : ""}` : "";
  lines.push(`What we found: ${formatCount(found.files)} session file${found.files === 1 ? "" : "s"} · ${formatCount(found.machineSessions)} session${found.machineSessions === 1 ? "" : "s"} on this machine${repo} · ${formatCount(found.subagents)} subagent${found.subagents === 1 ? "" : "s"} · ${(found.ms / 1000).toFixed(1)} s`);
  if (!found.sessions) {
    lines.push(`  No session of ${found.repo || "this repository"} yet: run claude or codex inside it, and the index follows the transcript live.`);
    if (found.machineSessions) lines.push(`  The ${formatCount(found.machineSessions)} sessions on this machine belong to other directories; contextscope --repo <path> analyses one of them.`);
  } else {
    lines.push(`  Where the context went: at peak, ${found.composition.length ? found.composition.map((row) => `${row.label} ${formatPercent(row.share)}`).join(" · ") : "no per-request composition yet"} (${formatCount(found.sessions)} session${found.sessions === 1 ? "" : "s"}, all time)`);
    if (found.handoff) {
      const who = found.handoff.agentType ? `${found.handoff.agentType} ` : "";
      const when = found.handoff.startedAt ? ` (session ${shortStart(found.handoff.startedAt)})` : "";
      lines.push(`  What subagents cost: fattest handoff ${who}${formatTokens(found.handoff.handoffTokens)} tokens back from a ${formatTokens(found.handoff.childPeak)}-token peak, ratio ${found.handoff.ratio.toFixed(2)}${when}`);
    } else {
      lines.push(`  What subagents cost: ${found.subagents ? `${formatCount(found.subagents)} subagent run${found.subagents === 1 ? "" : "s"}, no handoff measured yet` : "no subagent runs in these sessions"}`);
    }
    if (found.firstChange) {
      const change = found.firstChange;
      const sessions = change.recurrence ?? change.sessions ?? 1;
      lines.push(`  Change first: ${severityTag(change.severity)} ${change.ruleId} ${change.title} · ${formatCount(sessions)} session${sessions === 1 ? "" : "s"}`);
      const fix = fixLine(change);
      if (fix) lines.push(`  ${fix}`);
    } else {
      lines.push("  Change first: no finding yet (rules need indexed sessions with tool calls; habits need 3 sessions of this repository)");
    }
  }
  if (found.hooksInstalled === false) lines.push("  hooks: not installed (contextscope hooks install --scope user) · runtime evidence for the Setup screen");
  else if (found.hooksInstalled === true) lines.push(`  hooks: installed · ${formatCount(found.captureRecords)} record${found.captureRecords === 1 ? "" : "s"} captured`);
  if (url) lines.push(`  Open: ${url}`);
  return lines.join("\n");
}
