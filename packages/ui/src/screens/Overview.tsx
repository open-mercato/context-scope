import { useEffect, useMemo, useState } from "preact/hooks";
import type { Attribution, Overview, OverviewRun, Vendor } from "@ir/types.ts";
import { api, backend, type IndexInfo } from "../api.ts";
import { CATEGORY_META } from "../categories.ts";
import { CLI_COMMAND } from "../config.ts";
import { useResource, useTick } from "../hooks.ts";
import { hrefs, route, splitRunId } from "../router.ts";
import { indexVersion, liveIdle, liveRuns, loadThresholds, noteIndexFromOverview, rulesVersion } from "../store.ts";
import { formatDate, formatDuration, formatNumber, formatRatio, formatRelative, formatTokens, percent, plural } from "../format.ts";
import { Badge } from "../components/Badge.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FindingCard } from "../components/FindingCard.tsx";
import { Panel } from "../components/Panel.tsx";
import { StatTile } from "../components/StatTile.tsx";
import { Table, type Column } from "../components/Table.tsx";
import { ErrorNotice, Loading } from "../components/Status.tsx";
import { TrendsPanel } from "../components/TrendsPanel.tsx";
import { ContextMixPanel } from "../components/ContextMixPanel.tsx";
import { LiveBadge } from "../components/LiveBadge.tsx";

/**
 * Codex child runs (thread_spawn) arrive nested under their parent. `gitBranch`
 * and `agentType` are what the cycle-2 fix wave adds to rows (ADR-004 §7.10);
 * both are optional so an older companion still renders.
 */
export type OverviewRunNode = OverviewRun & { children?: OverviewRunNode[]; parentRunId?: string; gitBranch?: string; agentType?: string };

/** Human name of an attribution method (ADR-005 §2). */
export const ATTRIBUTION_LABELS: Record<Attribution["method"], string> = {
  cwd: "working directory",
  "nested-hash": "nested instruction file",
  "instructions-hash": "AGENTS.md content",
  "path-overlap": "file-path overlap",
};

/** "attributed · file-path overlap (12 files)" for a row badge; the method names the evidence, never a directory name. */
export function attributionText(a: Attribution): string {
  return `attributed · ${ATTRIBUTION_LABELS[a.method] ?? a.method}${a.method === "path-overlap" && a.files ? ` (${plural(a.files, "file")})` : ""}`;
}

function attributionTitle(a: Attribution): string {
  switch (a.method) {
    case "nested-hash": return "Temp-directory session: a nested CLAUDE.md/AGENTS.md it loaded has exactly the content of one in this repository (observed, exact).";
    case "instructions-hash": return "Temp-directory session: the AGENTS.md the runtime loaded has exactly the content of this repository's (observed, exact).";
    case "path-overlap": return `Temp-directory session: ${a.files ?? "at least five"} of the distinct files it read exist at the same relative paths in this repository (derived: ≥ 5 targets, ≥ 80 % matching).`;
    default: return "Working directory is this repository.";
  }
}

/** Sessions that joined the repo through evidence, grouped by method: "1 attributed by file-path overlap". */
function attributedSummary(runs: OverviewRunNode[], total: number): string {
  const counts = new Map<Attribution["method"], number>();
  for (const run of runs) if (run.attribution) counts.set(run.attribution.method, (counts.get(run.attribution.method) ?? 0) + 1);
  const parts = Array.from(counts.entries()).map(([method, n]) => `${n} attributed by ${ATTRIBUTION_LABELS[method] ?? method}`);
  return parts.length ? parts.join(", ") : `${total} attributed by evidence`;
}

function flattenRuns(runs: OverviewRunNode[]): OverviewRunNode[] {
  const out: OverviewRunNode[] = [];
  for (const run of runs) { out.push(run); if (run.children) out.push(...flattenRuns(run.children)); }
  return out;
}

function VendorBadge({ vendor }: { vendor: Vendor | string }) {
  return <span class={`vendor vendor-${vendor}`}>{vendor}</span>;
}

const OVERVIEW_LIMIT = 200;
const SCOPE_KEY = "contextscope.overview.scope";
const RANGE_KEY = "contextscope.overview.since";

export type ScopeMode = "repo" | "all";
/** Time range as sent in `since=`; the companion's default (all time for the repo, 30 d for all projects) applies when nothing was chosen. */
export type RangeMode = "30d" | "90d" | "all";
const RANGES: RangeMode[] = ["30d", "90d", "all"];
const defaultRange = (scope: ScopeMode): RangeMode => (scope === "repo" ? "all" : "30d");

function hashQuery(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

/** The explicit choice from the hash (`since=`), else the one remembered for this tab, else null = never chosen (#8). */
function readRange(): RangeMode | null {
  const fromHash = hashQuery().get("since");
  if (fromHash && (RANGES as string[]).includes(fromHash)) return fromHash as RangeMode;
  try { const stored = sessionStorage.getItem(RANGE_KEY); if (stored && (RANGES as string[]).includes(stored)) return stored as RangeMode; } catch { /* private mode */ }
  return null;
}

/** Keeps `#/?scope=&since=` in sync with the two selectors (replaceState: no history entry per click). */
function writeQuery(scope: ScopeMode, range: RangeMode | null) {
  try { sessionStorage.setItem(SCOPE_KEY, scope); if (range) sessionStorage.setItem(RANGE_KEY, range); else sessionStorage.removeItem(RANGE_KEY); } catch { /* private mode */ }
  const [pathPart] = location.hash.replace(/^#/, "").split("?");
  const query = new URLSearchParams();
  if (scope === "all") query.set("scope", "all");
  if (range) query.set("since", range);
  const next = `#${pathPart || "/"}${query.size ? `?${query}` : ""}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

/** "all time", "last 30 days", or "since <date>" from the companion's `range`, else its `since` (#26), else the scope default. */
export function rangeText(range: string | undefined, since: string | null | undefined, fallback: ScopeMode): string {
  const value = range ?? (since === null ? "all" : since ? `date:${since}` : defaultRange(fallback));
  if (value === "all") return "all time";
  const days = /^(\d+)d$/.exec(value);
  if (days) return `last ${days[1]} days`;
  const iso = value.startsWith("date:") ? value.slice(5) : value;
  return `since ${formatDate(iso)}`;
}

/** `#/?scope=all&kind=harness` lists the machine's harness runs (ADR-005 §2); never remembered across tabs. */
function readKind(): "harness" | undefined {
  return hashQuery().get("kind") === "harness" ? "harness" : undefined;
}

/** Scope from the hash query (`#/?scope=all`), else sessionStorage, else repo. */
function readScope(): ScopeMode {
  const fromHash = hashQuery().get("scope");
  if (fromHash === "all" || fromHash === "repo") return fromHash;
  try { const stored = sessionStorage.getItem(SCOPE_KEY); if (stored === "all" || stored === "repo") return stored; } catch { /* private mode */ }
  return "repo";
}

/** Session label (ADR-004 §7.10): project · start; children by agent type, never by raw id. */
function sessionTitle(r: OverviewRunNode, parentOf?: OverviewRunNode): string {
  if (r.parentRunId) return `${r.agentType ?? "subagent"} · child of ${parentOf ? formatDate(parentOf.startedAt) : splitRunId(r.parentRunId).id.slice(0, 8)}`;
  return `${r.project.displayName} · ${formatDate(r.startedAt)}`;
}

export function OverviewScreen() {
  const version = indexVersion.value;
  const rules = rulesVersion.value;
  const [scope, setScopeState] = useState<ScopeMode>(readScope);
  const [range, setRangeState] = useState<RangeMode | null>(readRange);
  const setScope = (next: ScopeMode) => { writeQuery(next, range); setScopeState(next); };
  const setRange = (next: RangeMode | null) => { writeQuery(scope, next); setRangeState(next); };
  // `#/?scope=all&since=90d` typed into the URL bar: the hash is re-read on every route change (ADR-004 §7.15).
  const currentRoute = route.value;
  useEffect(() => {
    if (currentRoute.name !== "overview") return;
    const s = readScope(); const r = readRange();
    if (s !== scope) setScopeState(s);
    if (r !== range) setRangeState(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoute]);
  const kind = currentRoute.name === "overview" ? readKind() : undefined;
  const { data, error, reload } = useResource((signal) => api.overview({ since: range ?? undefined, limit: OVERVIEW_LIMIT, scope: kind ? "all" : scope, kind }, signal), [version, rules, scope, range, kind]);
  useEffect(() => { void loadThresholds(); }, [rules]);
  const now = useTick(30_000);
  const live = liveRuns.value;
  const idle = liveIdle.value;
  const [query, setQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  useEffect(() => { noteIndexFromOverview(data?.index as IndexInfo | undefined); }, [data]);

  const runs = (data?.runs ?? []) as OverviewRunNode[];
  const allRuns = useMemo(() => flattenRuns(runs), [runs]);
  const runById = useMemo(() => new Map(allRuns.map((r) => [r.id, r])), [allRuns]);
  const projects = useMemo(() => Array.from(new Set(allRuns.map((r) => r.project.displayName))).sort(), [allRuns]);
  const vendors = useMemo(() => Array.from(new Set(allRuns.map((r) => r.vendor))).sort(), [allRuns]);

  const filtered = useMemo<OverviewRunNode[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (run: OverviewRunNode) =>
      (!vendorFilter || run.vendor === vendorFilter) &&
      (!projectFilter || run.project.displayName === projectFilter) &&
      (!q || `${run.project.displayName} ${run.vendor} ${run.id} ${run.summary.models.join(" ")} ${run.gitBranch ?? ""} ${run.agentType ?? ""}`.toLowerCase().includes(q));
    return runs
      .map((run): OverviewRunNode => ({ ...run, children: run.children?.filter(matches) }))
      .filter((run) => matches(run) || (run.children && run.children.length > 0));
  }, [runs, query, vendorFilter, projectFilter]);

  if (error) return <section class="screen"><ErrorNotice error={error} retry={reload} /></section>;
  if (!data) return <section class="screen"><Loading label="Loading overview" /></section>;

  const { totals, trends, topOffenders } = data;
  const index = data.index as IndexInfo;
  const headerProps = { data, now, scope, setScope, range, setRange };
  if (runs.length === 0) {
    return (
      <section class="screen">
        <ScreenHeader {...headerProps} />
        <EmptyState
          title={scope === "repo" && (data.scope?.machineSessions ?? 0) > 0 ? "No sessions in this repository yet" : "No sessions indexed yet"}
          body={<>ContextScope reads the transcripts Claude Code and Codex already keep on disk. Run either tool in a project, then refresh the index from the top bar.</>}
          command={`${CLI_COMMAND}   # from the repository you want to inspect`}
        >
          <dl class="empty-meta">
            <dt>Claude Code</dt><dd><code>~/.claude/projects/&lt;project&gt;/*.jsonl</code> · written by <code>claude</code></dd>
            <dt>Codex</dt><dd><code>~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl</code> · written by <code>codex</code></dd>
          </dl>
        </EmptyState>
      </section>
    );
  }

  const sessionHref = (run: OverviewRun) => { const { vendor, id } = splitRunId(run.id); return hrefs.session(vendor, id); };
  // Offender rows: in repo mode every row is this repo, so the start time alone names the session.
  const runLabel = (runId: string) => { const r = runById.get(runId); if (!r) return splitRunId(runId).id.slice(0, 8); if (r.parentRunId || scope === "all") return sessionTitle(r, r.parentRunId ? runById.get(r.parentRunId) : undefined); return formatDate(r.startedAt); };
  const runVendor = (runId: string) => (runById.get(runId)?.vendor ?? splitRunId(runId).vendor) as Vendor;
  const more = index.runsInRange !== undefined && index.runsInRange > allRuns.length ? index.runsInRange - allRuns.length : 0;

  // Live marker: the SSE fold (`liveRuns`) wins over the marker the overview carried when it was fetched;
  // a `live-idle` seen since load clears it even before the next refetch (#5).
  const liveOf = (r: OverviewRunNode) => (idle.has(r.id) ? undefined : live.get(r.id) ?? r.live);
  const liveDot = (r: OverviewRunNode) => <LiveBadge live={liveOf(r)} compact />;
  const columns: Column<OverviewRunNode>[] = [
    { key: "vendor", label: "Vendor", width: "6.5rem", sortValue: (r) => r.vendor, render: (r) => <VendorBadge vendor={r.vendor} /> },
    // Live rows sort first (ADR-003 §3), then newest first; the title is project · start so two rows are never twins.
    { key: "session", label: "Session", title: "Project and start time; model, branch and id underneath", sortValue: (r) => Date.parse(r.startedAt) + (liveOf(r) ? 1e13 : 0), render: (r) => (
      <span class="cell-project">
        <span>{liveDot(r)}<a href={sessionHref(r)} class="cell-link">{sessionTitle(r, r.parentRunId ? runById.get(r.parentRunId) : undefined)}</a></span>
        <span class="cell-sub muted" title={r.id}>{[r.summary.models.join(", "), r.gitBranch, splitRunId(r.id).id.slice(0, 8)].filter(Boolean).join(" · ")}</span>
        {r.attribution ? <span class="cell-sub"><span class="pill" title={attributionTitle(r.attribution)}>{attributionText(r.attribution)}</span></span> : null}
        {r.kind === "harness" ? <span class="cell-sub"><span class="pill" title={`Harness run: ${r.entrypoint === "sdk-cli" ? "started through the SDK (entrypoint sdk-cli)" : "a temp directory with no tool use and at most two requests"}. Never part of a population, habits or trends.`}>harness{r.entrypoint ? ` · ${r.entrypoint}` : ""}</span></span> : null}
      </span>
    ) },
    { key: "active", label: "Active", numeric: true, align: "right", sortValue: (r) => r.activeMs, title: "Active time (gaps over 30 min excluded)", render: (r) => formatDuration(r.activeMs) },
    { key: "requests", label: "Requests", numeric: true, align: "right", sortValue: (r) => r.summary.requests, render: (r) => formatNumber(r.summary.requests) },
    { key: "peak", label: "Peak", numeric: true, align: "right", sortValue: (r) => r.summary.peak.value, title: "Peak occupancy (badge: peak provenance) and share of the context window (title: window provenance)", render: (r) => (
      <span class="cell-peak">
        <span title={`${formatNumber(r.summary.peak.value)} of ${formatNumber(r.window.value)} tokens`}>{formatTokens(r.summary.peak.value)}</span>
        <span class={`peak-share ${r.summary.peakShareOfWindow >= 0.8 ? "hot" : ""}`} title={`Window ${formatNumber(r.window.value)} tokens · ${r.window.provenance}`}>{percent(r.summary.peakShareOfWindow)}</span>
        <Badge provenance={r.summary.peak.provenance} />
      </span>
    ) },
    { key: "compactions", label: "Compactions", numeric: true, align: "right", sortValue: (r) => r.summary.compactions, render: (r) => r.summary.compactions ? <span class={r.summary.compactions >= 3 ? "warn-text" : ""}>{r.summary.compactions}</span> : <span class="muted">0</span> },
    { key: "subagents", label: "Subagents", numeric: true, align: "right", sortValue: (r) => r.summary.subagents, title: "Claude subagent transcripts and Codex thread_spawn children of this session", render: (r) => r.summary.subagents || <span class="muted">0</span> },
    { key: "findings", label: "Findings", numeric: true, align: "right", sortValue: (r) => r.findingsCount * 100 + r.findingsHigh, render: (r) => (
      <span class="cell-findings">
        {r.findingsCount || <span class="muted">0</span>}
        {r.findingsHigh ? <span class="pill pill-high" title="High severity">{r.findingsHigh} high</span> : null}
      </span>
    ) },
  ];

  const population = data.scope;
  const sessionsCount = scope === "repo" ? (population?.sessions ?? runs.length) : runs.length;
  const harnessListing = data.scope?.kind === "harness";
  const sessionsLine = harnessListing
    ? `${plural(runs.length, "harness run")} on this machine (SDK-driven, no tool use; excluded from every population) · ${rangeText(data.range, data.since, "all")}${more ? ` · newest ${allRuns.length} shown` : ""}`
    : `${plural(sessionsCount, "session")} ${scope === "repo" ? "in this repo" : "on this machine"} · ${rangeText(data.range, data.since, scope)}${more ? ` · newest ${allRuns.length} shown` : ""}`;

  return (
    <section class="screen screen-overview">
      <ScreenHeader {...headerProps} />

      <div class="tiles" role="list">
        <StatTile label="Processed input tokens" value={totals.processedInputTokens} hint="sum of input + cache over all requests" provenance="observed.vendor" trend={trends.processedInputTokens} title={`${formatNumber(totals.processedInputTokens)} tokens`} />
        <StatTile label="Cache-read share" value={percent(totals.cacheReadShare)} hint={`${plural(totals.requests, "request")}`} provenance="derived.exact" trend={trends.requests} accent="var(--series-3)" />
        <StatTile label="Compactions" value={totals.compactions} hint={`${plural(totals.runs, "session")} in range`} provenance="observed.vendor" trend={trends.compactions} accent="var(--series-2)" />
        <StatTile label="Subagent runs" value={totals.subagents} hint={`${plural(totals.runs, "session")}, ${totals.vendors.length} vendor${totals.vendors.length === 1 ? "" : "s"}`} provenance="observed.artifact" trend={trends.subagents} accent="var(--series-4)" />
      </div>

      {data.firstFinding ? (
        <Panel title="One change to make first" description="Leverage-ranked: the fix that removes findings in the most sessions of this repository" actions={<a class="btn btn-ghost" href={hrefs.findings()}>All findings</a>}>
          <FindingCard finding={data.firstFinding} highlight />
        </Panel>
      ) : (
        <Panel title="One change to make first">
          <EmptyState compact title="No findings for this repository" body={<>Rules run over indexed sessions and the repository setup. Index freshness: {lastPassAt(index) ? formatRelative(lastPassAt(index), now) : "never"}.</>} />
        </Panel>
      )}

      {harnessListing ? null : <ContextMixPanel data={data.contextAtEnd} rangeLabel={rangeText(data.range, data.since, scope)} />}

      <Panel
        title="Sessions"
        description={sessionsLine}
        flush
        actions={
          <div class="filters">
            <input
              type="search"
              class="filter-input"
              data-filter
              placeholder="Filter sessions  ( / )"
              aria-label="Filter sessions"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
          </div>
        }
      >
        <div class="chips" role="group" aria-label="Vendor and project filters">
          <span class="chips-label">Vendor</span>
          <button type="button" class={`chip ${vendorFilter === null ? "on" : ""}`} aria-pressed={vendorFilter === null} onClick={() => setVendorFilter(null)}>all</button>
          {vendors.map((v) => <button key={v} type="button" class={`chip ${vendorFilter === v ? "on" : ""}`} aria-pressed={vendorFilter === v} onClick={() => setVendorFilter(vendorFilter === v ? null : v)}>{v}</button>)}
          {scope === "all" && projects.length > 1 ? <>
            <span class="chips-label">Project</span>
            <button type="button" class={`chip ${projectFilter === null ? "on" : ""}`} aria-pressed={projectFilter === null} onClick={() => setProjectFilter(null)}>all</button>
            {projects.slice(0, 12).map((p) => <button key={p} type="button" class={`chip ${projectFilter === p ? "on" : ""}`} aria-pressed={projectFilter === p} onClick={() => setProjectFilter(projectFilter === p ? null : p)}>{p}</button>)}
            {projects.length > 12 ? <span class="muted chips-label" title={projects.slice(12).join(", ")}>+{projects.length - 12} more (type to filter)</span> : null}
          </> : null}
        </div>
        <Table
          label="Sessions"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          rowHref={sessionHref}
          childRows={(r) => r.children}
          defaultExpanded
          defaultSort={{ key: "session", dir: "desc" }}
          empty={<span>No sessions match <code>{query || `${vendorFilter ?? ""} ${projectFilter ?? ""}`.trim()}</code>. Press <kbd>Esc</kbd> to clear the filter.</span>}
        />
      </Panel>

      {scope === "repo" ? <TrendsPanel trends={trends} repoName={data.scope?.repo.name} rangeLabel={rangeText(data.range, data.since, scope)} /> : null}

      <div class="grid-3 offenders">
        <Panel title="Largest tool results" description="Single blocks that took the most window" class="offender-panel">
          {topOffenders.largestBlocks.length ? (
            <ol class="offender-list">
              {topOffenders.largestBlocks.map((b) => {
                const { vendor, id } = splitRunId(b.runId);
                return (
                  <li key={b.blockId}>
                    <a href={hrefs.session(vendor, id, { scope: b.scopeId, request: b.firstRequest })} class="offender-row">
                      <span class="offender-main">
                        <span class="offender-label"><span class="cat-dot" style={{ background: CATEGORY_META[b.category]?.color }} title={CATEGORY_META[b.category]?.label} /> {b.label ?? b.tool ?? CATEGORY_META[b.category]?.short ?? b.category}</span>
                        <span class="offender-sub muted">{runLabel(b.runId)} · {runVendor(b.runId)} · req {b.firstRequest}{b.scopeId !== "main" ? ` · ${b.scopeId}` : ""}</span>
                      </span>
                      <span class="offender-value">{formatTokens(b.estTokens)} <Badge provenance="estimated.local" /></span>
                    </a>
                  </li>
                );
              })}
            </ol>
          ) : <EmptyState compact title="No tool results indexed" body="Blocks appear once a session with tool calls is indexed." path="~/.claude/projects/<project>/*.jsonl · ~/.codex/sessions/" command="claude   # run a session with tool calls, then refresh the index" />}
        </Panel>
        <Panel title="Fattest subagent handoffs" description="What a child returned into its parent, next to the window it took to produce it" class="offender-panel">
          {topOffenders.fattestHandoffs.length ? (
            <ol class="offender-list">
              {topOffenders.fattestHandoffs.map((h) => {
                const { vendor, id } = splitRunId(h.runId);
                // Codex children are scopes named by their run id; never show the raw id when a type or a short id will do.
                const childName = h.agentType ?? runById.get(h.scopeId)?.agentType ?? runById.get(`${vendor}:${h.scopeId}`)?.agentType ?? `subagent ${splitRunId(h.scopeId).id.slice(0, 8)}`;
                return (
                  <li key={`${h.runId}#${h.scopeId}`}>
                    <a href={hrefs.session(vendor, id, { scope: h.scopeId })} class="offender-row">
                      <span class="offender-main">
                        <span class="offender-label">{childName}</span>
                        <span class="offender-sub" title={`Child peak ${formatNumber(h.childPeak)} tokens → handoff ${formatNumber(h.handoffTokens)} tokens; ratio = peak ÷ handoff`}>peak {formatTokens(h.childPeak)} → {formatTokens(h.handoffTokens)} · <strong>{formatRatio(h.ratio)}</strong> compression</span>
                        <span class="offender-sub muted">{runLabel(h.runId)} · {runVendor(h.runId)}</span>
                      </span>
                      <span class="offender-value">{formatTokens(h.handoffTokens)} <Badge provenance="observed.artifact" /></span>
                    </a>
                  </li>
                );
              })}
            </ol>
          ) : <EmptyState compact title="No subagent handoffs" body="Claude writes subagent transcripts next to the session; Codex links child threads via thread_spawn." path="~/.claude/projects/<project>/<session>/subagents/*.jsonl" command="claude   # delegate with the Agent tool, then refresh the index" />}
        </Panel>
        <Panel title="Most-compacted sessions" description="Compaction boundaries per session" class="offender-panel">
          {topOffenders.mostCompacted.length ? (
            <ol class="offender-list">
              {topOffenders.mostCompacted.map((c) => {
                const { vendor, id } = splitRunId(c.runId);
                return (
                  <li key={c.runId}>
                    <a href={hrefs.session(vendor, id)} class="offender-row">
                      <span class="offender-main">
                        <span class="offender-label">{runLabel(c.runId)}</span>
                        <span class="offender-sub muted">{runVendor(c.runId)} · {formatTokens(c.processedInputTokens)} processed</span>
                      </span>
                      <span class="offender-value">{c.compactions} <span class="muted">×</span> <Badge provenance="observed.vendor" /></span>
                    </a>
                  </li>
                );
              })}
            </ol>
          ) : <EmptyState compact title="No compactions observed" body="Claude records compact_boundary system records; Codex records context compaction events." path="~/.claude/projects/<project>/*.jsonl (compact_boundary)" command="claude   # /compact, or let a long session auto-compact" />}
        </Panel>
      </div>
    </section>
  );
}

function lastPassAt(index: IndexInfo): string | undefined {
  return index.lastPass?.at ?? index.lastRunAt;
}

function ScreenHeader({ data, now, scope, setScope, range, setRange }: { data: Overview; now: number; scope: ScopeMode; setScope: (scope: ScopeMode) => void; range: RangeMode | null; setRange: (range: RangeMode | null) => void }) {
  const { totals } = data;
  const population = data.scope;
  const index = data.index as IndexInfo;
  const files = index.files ?? index.total;
  const pass = index.lastPass;
  const passDone = pass?.parsed ?? pass?.done ?? index.done;
  const passTotal = pass?.total ?? (pass ? (pass.parsed ?? 0) + (pass.skipped ?? 0) + (pass.failed ?? 0) : index.total);
  const failed = pass?.failed ?? index.failed;
  const at = lastPassAt(index);
  // The pressed range button: the explicit choice, else what the companion resolved, else the scope's default (#8).
  const effectiveRange = range ?? ((data.range && (RANGES as string[]).includes(data.range) ? data.range : defaultRange(scope)) as RangeMode);
  const rangeLabel = rangeText(data.range, data.since, scope);
  // Static and memory modes have no index pass: say what the data is (#10).
  const mode = backend.value.mode;
  const freshness = mode === "static" ? "demo dataset · synthetic" : mode === "memory" ? `export · ${backend.value.label ?? "opened file"}` : index.state === "indexing"
    ? `indexing ${formatNumber(passDone)}/${formatNumber(passTotal)}`
    : at ? `indexed ${formatRelative(at, now)}` : "not indexed yet";
  const detail = mode !== "companion" || index.state === "indexing" ? "" : pass ? ` · last pass ${formatNumber(pass.parsed ?? passDone)} parsed${pass.skipped ? `, ${formatNumber(pass.skipped)} unchanged` : ""}${pass.ms ? ` in ${formatDuration(pass.ms)}` : ""}` : "";
  return (
    <header class="screen-head">
      <div>
        <h1>Overview</h1>
        <div class="scope-row">
          <div class="segmented" role="group" aria-label="Session population">
            <button type="button" aria-pressed={scope === "repo"} onClick={() => setScope("repo")} title={population?.repo.name ? `Sessions whose working directory is ${population.repo.name} or a folder inside it` : "Sessions of the repository this companion was launched from"}>This repo{population?.repo.name ? ` · ${population.repo.name}` : ""}</button>
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")} title="Every indexed session on this machine, all vendors">All projects</button>
          </div>
          <div class="segmented segmented-range" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={effectiveRange === r} onClick={() => setRange(r)} title={`${r === "all" ? "Every indexed session" : `Sessions that ended in the last ${r.slice(0, -1)} days`}${r === defaultRange(scope) ? ` (the default for ${scope === "repo" ? "a repository" : "all projects"})` : ""}${range === null ? "" : "; your choice is kept when the scope changes"}`}>{r === "all" ? "all" : r}</button>
            ))}
          </div>
          {population ? (
            <p class="scope-line">
              <strong>{formatNumber(population.sessions)}</strong> {population.sessions === 1 ? "session" : "sessions"} in this repo
              {(population.attributed ?? 0) > 0 ? <span class="muted" title="Temp-directory sessions that joined this repository through evidence: a nested instruction file or AGENTS.md with exactly this repository's content, or at least five files read at paths that exist here (≥ 80 % matching). A directory name is never evidence."> ({attributedSummary(data.runs as OverviewRunNode[], population.attributed ?? 0)})</span> : null}
              {" · "}<strong>{formatNumber(population.machineSessions)}</strong> on this machine
              {(population.harness ?? 0) > 0 ? <> · <a class="scope-unattributed" href={`#/?scope=all&kind=harness${range ? `&since=${range}` : ""}`} title="SDK-driven runs: entrypoint sdk-cli, or a temp directory with no tool use and at most two requests. Counted here, listed under this link, and never part of a repository or machine population, habits, trends or offenders. An SDK app of your own counts here too."><strong>{formatNumber(population.harness ?? 0)}</strong> harness {population.harness === 1 ? "run" : "runs"}</a></> : null}
              {population.unattributed > 0 ? <> · <span class="scope-unattributed" title="Sessions no project can claim: a temp isolation directory with real work but no evidence for this repository (no matching nested instruction file or AGENTS.md, fewer than five repository files read), or a Claude project directory whose dashed name cannot be decoded back to a path. SDK harness runs with no tool use are counted separately."><strong>{formatNumber(population.unattributed)}</strong> unattributed</span></> : null}
              <span class="muted"> · {rangeLabel}</span>
            </p>
          ) : <p class="screen-sub">{scope === "repo" ? "This repository" : "All projects"}, all vendors, {rangeLabel}</p>}
        </div>
      </div>
      <ul class="strip" aria-label="Index summary">
        <li><strong>{formatNumber(totals.runs)}</strong> sessions in range</li>
        <li><strong>{formatNumber(totals.subagents)}</strong> subagents</li>
        {files !== undefined && mode === "companion" ? <li><strong>{formatNumber(files)}</strong> files in the index</li> : null}
        <li><strong>{totals.vendors.length ? totals.vendors.join(", ") : "none"}</strong> detected</li>
        <li title={detail.trim() || undefined}>{freshness}{failed && mode === "companion" ? <span class="warn-text"> · {failed} failed</span> : null} {mode === "companion" ? <Badge provenance="observed.artifact" /> : null}</li>
      </ul>
    </header>
  );
}
