/**
 * Session view (ADR-001 2.2, ADR-002 A/C): occupancy chart, cache strip,
 * subagent lanes, heavy hitters, virtualised ledger, grouped session findings,
 * and a collapsible right rail. All aligned panels share one x scale of request
 * index for the selected scope.
 *
 * Data: `GET /runs/:vendor/:id` carries the main scope in full and child scopes
 * as summaries (`partial: true`); selecting a child fetches `/scopes/:id` (cached
 * per run, aborted on navigation). When the backend still ships full child
 * scopes the summary is used as-is. Panels mount progressively: charts first,
 * then lanes + ledger, then findings.
 *
 * Live mode (ADR-003 section 3): when `liveRuns` carries this run, every `live`
 * event fetches `/tail?after=<last index>&sig=<signature>` for the selected
 * scope and appends requests / blocks / compactions to a local copy of the
 * scope (the body keeps its key, so panels update in place). `rebased` or every
 * 20th event reloads the run. The cursor follows the newest request until the
 * user pins or brushes; the rail shows the compaction forecast.
 */
import { memo } from "../memo.ts";
import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import type { AgentScope, Block, Category, Finding, Forecast, Provenance, Request, Run, RunSummary } from "@ir/types.ts";
import { api, backend, downloadJson, isAbortError, type RunResponse } from "../api.ts";
import { hrefs, navigate } from "../router.ts";
import { CATEGORY_META, STACK_ORDER, formatTokens, PROVENANCE_META } from "../categories.ts";
import { formatRatio } from "../format.ts";
import { StackedArea, type BaseStep } from "../charts/StackedArea.tsx";
import { CacheStrip, CACHE_COLORS, CACHE_LABELS } from "../charts/CacheStrip.tsx";
import { Lanes, layoutLanes, scopeRequestCount } from "../charts/Lanes.tsx";
import { Brush } from "../charts/Brush.tsx";
import { Axis } from "../charts/Axis.tsx";
import { linear, MARGIN, formatDuration, formatPercent, formatInt, formatDate, formatClock } from "../charts/scale.ts";
import { useWidth } from "../charts/hooks.ts";
import { useResource } from "../hooks.ts";
import { indexVersion, liveRuns, loadThresholds, modalOpen, requestsSignature, rulesVersion, toast, type LiveInfo } from "../store.ts";
import { groupFindings } from "../findings.ts";
import { Badge } from "../components/Badge.tsx";
import { StatTile } from "../components/StatTile.tsx";
import { Panel } from "../components/Panel.tsx";
import { FindingGroup } from "../components/FindingGroup.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Ledger } from "../components/Ledger.tsx";
import { CostPanel } from "../components/CostPanel.tsx";
import { EndMixBar } from "../components/EndMixBar.tsx";
import { LiveBadge } from "../components/LiveBadge.tsx";
import { ErrorNotice, Loading, Skeleton } from "../components/Status.tsx";
import {
  hoveredRequest, pinnedRequest, focusedRequest, hiddenCategories, brushRange, railOpen, requestCount,
  resetSessionState, resetRunState, toggleCategory, pin, setHovered, clampToRange, ledgerFilter, toggleExpanded,
  followLive, setBrush, resumeFollow,
} from "../session-state.ts";

export interface SessionScreenProps { vendor: string; id: string; scope?: string; request?: number }

/** Short caption plus the shell's provenance badge. */
function Prov({ provenance, text }: { provenance: Provenance; text?: string }) {
  return <span class="cs-prov">{text ? <span class="cs-muted">{text}</span> : null}<Badge provenance={provenance} /></span>;
}

const APPROX_P95 = 0.15;
const HIDE_P95 = 0.40;
const UNLOGGED_BADGE = 0.05;
const INCOMPLETE_SHARE = 0.8;
const CHART_H = 300;
const SCOPE_CACHE = 10;
const FINDING_GROUPS_SHOWN = 8;
/** Every Nth live event reloads the whole run (new subagents, moved summaries) instead of appending. */
const LIVE_FULL_RELOAD_EVERY = 20;
/** Forecasts beyond this are not "in this session" (ADR-004 §4): show the slope, not a countdown. */
const FORECAST_FAR_REQUESTS = 150;
const FORECAST_FAR_MINUTES = 240;

/** Local copy of a scope grown by live tails; `base` is the scope object it was built from (dropped when the base changes). */
interface LiveScopeState { runKey: string; scopeId: string; base: AgentScope; scope: AgentScope; summary: RunSummary; seq: number }

/** Applies a tail to a scope: appends requests / blocks / compactions, closes blocks, refreshes peak and forecast. */
export function applyTail(scope: AgentScope, tail: { requests: Request[]; blocks: Block[]; closed: Array<{ id: string; lastRequest: number; droppedBy?: string }>; compactions: AgentScope["compactions"]; peak: AgentScope["peak"]; forecast?: Forecast }): AgentScope {
  let blocks = scope.blocks ?? [];
  if (tail.closed.length) {
    const byId = new Map(tail.closed.map((c) => [c.id, c]));
    blocks = blocks.map((b) => { const c = byId.get(b.id); return c ? { ...b, lastRequest: c.lastRequest, droppedBy: c.droppedBy ?? b.droppedBy } : b; });
  }
  if (tail.blocks.length) blocks = [...blocks, ...tail.blocks];
  const requests = tail.requests.length ? [...(scope.requests ?? []), ...tail.requests] : (scope.requests ?? []);
  const compactions = tail.compactions.length ? [...(scope.compactions ?? []), ...tail.compactions] : (scope.compactions ?? []);
  const next: AgentScope = { ...scope, requests, blocks, compactions, peak: tail.peak ?? scope.peak, partial: false, requestCount: requests.length };
  if (tail.forecast) next.forecast = tail.forecast; else delete next.forecast;
  return next;
}

export function SessionScreen(props: SessionScreenProps) {
  const runKey = `${props.vendor}/${props.id}`;
  const version = indexVersion.value;
  const rules = rulesVersion.value;
  const { data: run, error, reload } = useResource((signal) => api.run(props.vendor, props.id, signal), [runKey, version, rules]);
  useEffect(() => { void loadThresholds(); }, [rules]);

  // Scope selection follows the route; unknown scope ids fall back to main with a notice.
  const requestedScope = props.scope ?? "main";
  const summary = run ? (run.scopes.find((s) => s.id === requestedScope) ?? run.scopes[0]) : undefined;
  const scopeId = summary?.id ?? "main";
  const missingScope = run && summary && summary.id !== requestedScope ? requestedScope : null;

  // Full scope: the summary itself when it is not partial (main, or an unsplit backend), else fetched and cached per run.
  const cache = useRef(new Map<string, AgentScope>());
  const [scopeState, setScopeState] = useState<{ id: string; runKey: string; scope: AgentScope | null; error: Error | null }>({ id: "", runKey: "", scope: null, error: null });
  useEffect(() => { cache.current = new Map(); }, [runKey]);
  useEffect(() => {
    if (!run || !summary) return;
    if (!summary.partial && summary.requests) { setScopeState({ id: summary.id, runKey, scope: summary, error: null }); return; }
    const cached = cache.current.get(summary.id);
    if (cached) { setScopeState({ id: summary.id, runKey, scope: cached, error: null }); return; }
    const controller = new AbortController();
    setScopeState({ id: summary.id, runKey, scope: null, error: null });
    api.scope(props.vendor, props.id, summary.id, controller.signal).then((full) => {
      if (controller.signal.aborted) return;
      const merged: AgentScope = { ...summary, ...full, partial: false };
      cache.current.set(summary.id, merged);
      if (cache.current.size > SCOPE_CACHE) cache.current.delete(cache.current.keys().next().value as string);
      setScopeState({ id: summary.id, runKey, scope: merged, error: null });
    }).catch((e: unknown) => { if (!isAbortError(e)) setScopeState({ id: summary.id, runKey, scope: null, error: e instanceof Error ? e : new Error(String(e)) }); });
    return () => controller.abort();
  }, [run, summary?.id, runKey]);

  // Reset coordinated state: everything on a run change, interaction state on a scope change.
  const lastRun = useRef<string | null>(null);
  useEffect(() => {
    if (lastRun.current !== runKey) { resetRunState(scopeId); lastRun.current = runKey; }
    else resetSessionState(scopeId);
  }, [runKey, scopeId]);

  const baseScope = scopeState.runKey === runKey && scopeState.id === scopeId ? scopeState.scope : null;
  const scopeError = scopeState.runKey === runKey && scopeState.id === scopeId ? scopeState.error : null;
  useEffect(() => {
    if (props.request !== undefined && baseScope) pin(Math.min(props.request, Math.max(0, (baseScope.requests?.length ?? 1) - 1)));
  }, [props.request, baseScope]);

  // Live tail: one fetch per `live` event for this run, appended to a local copy of the selected scope.
  const runId = `${props.vendor}:${props.id}`;
  const live = liveRuns.value.get(runId);
  const [liveState, setLiveState] = useState<LiveScopeState | null>(null);
  const liveEvents = useRef(0);
  const lastSeq = useRef(0);
  const current = liveState && liveState.runKey === runKey && liveState.scopeId === scopeId && liveState.base === baseScope ? liveState : null;
  useEffect(() => {
    if (!live || !baseScope || !run) return;
    if (live.seq === lastSeq.current) return;
    lastSeq.current = live.seq;
    liveEvents.current += 1;
    // Periodic full reload: only the scope that grew is re-fetched; other cached child scopes stay (#28). A rebase drops everything.
    if (liveEvents.current % LIVE_FULL_RELOAD_EVERY === 0) { cache.current.delete(scopeId); reload(); return; }
    const source = current?.scope ?? baseScope;
    const requests = source.requests ?? [];
    const after = requests.length - 1;
    const controller = new AbortController();
    (async () => {
      const sig = await requestsSignature(requests, after);
      const tail = await api.tail(props.vendor, props.id, { after, scope: scopeId, sig: sig || undefined }, controller.signal);
      if (controller.signal.aborted) return;
      if (tail.rebased) { cache.current = new Map(); reload(); return; }
      const scope = applyTail(source, tail);
      setLiveState({ runKey, scopeId, base: baseScope, scope, summary: tail.summary, seq: live.seq });
      const newest = (scope.requests?.length ?? 0) - 1;
      if (tail.requests.length && followLive.peek() && pinnedRequest.peek() === null && newest >= 0) {
        // Following keeps a manual zoom and extends its upper bound as the tail grows (#33).
        const zoom = brushRange.peek();
        if (zoom) brushRange.value = [zoom[0], newest];
        focusedRequest.value = newest;
      }
    })().catch((e: unknown) => { if (!isAbortError(e)) toast(`Live update failed: ${(e as Error).message}`, "error"); });
    return () => controller.abort();
  }, [live?.seq, baseScope, run, runKey, scopeId]);
  useEffect(() => { liveEvents.current = 0; }, [runKey]);

  const scope = current?.scope ?? baseScope;
  const liveRun = useMemo<RunResponse | null>(() => {
    if (!run || !current) return run;
    return { ...run, summary: current.summary, scopes: run.scopes.map((s) => (s.id === scopeId ? current.scope : s)) };
  }, [run, current, scopeId]);
  const liveSummary = liveRun ? (liveRun.scopes.find((s) => s.id === scopeId) ?? liveRun.scopes[0]) : undefined;

  if (error) return <section class="screen"><ErrorNotice error={error} retry={reload} /></section>;
  if (!liveRun || !liveSummary) return <section class="screen"><Loading label={`Loading session ${props.id.slice(0, 8)}`} /></section>;
  return (
    <SessionBody key={`${runKey}/${scopeId}`} run={liveRun} summary={liveSummary} scope={scope} scopeError={scopeError} missingScope={missingScope} props={props} live={live} />
  );
}

// ---------- derived numbers ----------

function quantiles(values: number[]): { median: number; p95: number } {
  if (!values.length) return { median: 0, p95: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { median: q(0.5), p95: q(0.95) };
}

interface ScopeStats {
  errMedian: number;
  errP95: number;
  unloggedShare: number;
  /** Tokens of `unlogged` at request 0 when it dominates the first request (resumed session). */
  resumedTokens: number;
  transcriptIncomplete: boolean;
  baseSteps: BaseStep[];
  peak: number;
}

function scopeStats(scope: AgentScope, run: Run): ScopeStats {
  const requests = scope.requests ?? [];
  const coverage = run.coverage as Run["coverage"] | undefined;
  let fromRun = scope.kind === "main" && coverage && Number.isFinite(coverage.estimatorErrorMedian) ? { median: coverage.estimatorErrorMedian, p95: coverage.estimatorErrorP95 } : undefined;
  if (scope.estimatorErrorMedian === undefined && !fromRun) {
    const errs: number[] = [];
    for (const r of requests) { const k = (r as { scaleRaw?: number }).scaleRaw ?? r.scale; if (Number.isFinite(k)) errs.push(Math.abs(1 - k)); }
    fromRun = quantiles(errs);
  }
  let unloggedSum = 0, totalSum = 0, withNew = 0, peak = 0;
  for (const r of requests) { unloggedSum += r.composition.unlogged ?? 0; totalSum += r.usage.total; if (r.usage.total > peak) peak = r.usage.total; if ((r.newBlockIds?.length ?? 1) > 0) withNew++; }
  const unloggedShare = scope.unloggedShare ?? (totalSum ? unloggedSum / totalSum : 0);
  const r0 = requests[0];
  const unlogged0 = r0?.composition.unlogged ?? 0;
  const resumedTokens = r0 && unlogged0 >= 10_000 && unlogged0 > 0.25 * r0.usage.total ? unlogged0 : 0;
  const steps: BaseStep[] = scope.baseSteps ? scope.baseSteps.slice() : [];
  if (!scope.baseSteps) for (const r of requests) { const bc = (r as { baseChange?: { tokens: number } }).baseChange; if (bc) steps.push({ atRequest: r.index, delta: bc.tokens }); }
  return {
    errMedian: scope.estimatorErrorMedian ?? fromRun?.median ?? 0,
    errP95: scope.estimatorErrorP95 ?? fromRun?.p95 ?? 0,
    unloggedShare,
    resumedTokens,
    transcriptIncomplete: unloggedShare > INCOMPLETE_SHARE && requests.length > 0 && withNew / requests.length < 0.2,
    baseSteps: steps,
    peak: scope.peak?.value ?? peak,
  };
}

interface HeavyRow { id: string; category: Category; estTokens: number; firstRequest: number; tool?: string; isError?: boolean; label?: string; lastRequest?: number; droppedBy?: string; presenceKnown: boolean }

function heavyRows(scope: AgentScope): HeavyRow[] {
  if (scope.blocks && scope.blocks.length) {
    return scope.blocks.filter((b) => b.category !== "assistant_thinking").slice().sort((a, b) => b.estTokens - a.estTokens).slice(0, 10)
      .map((b: Block) => ({ id: b.id, category: b.category, estTokens: b.estTokens, firstRequest: b.firstRequest, tool: b.tool?.name, isError: b.tool?.isError, label: b.label ?? b.attachmentType, lastRequest: b.lastRequest, droppedBy: b.droppedBy, presenceKnown: true }));
  }
  return (scope.topBlocks ?? []).slice(0, 10).map((b) => ({ id: b.id, category: b.category, estTokens: b.estTokens, firstRequest: b.firstRequest, tool: b.tool, label: b.label, presenceKnown: false }));
}

/** Resolve a finding's primary evidence to a scope and optional request index (block ids carry their scope prefix). */
export function resolveEvidence(finding: Finding, run: Run, loaded?: AgentScope | null): { scopeId: string; request?: number } | null {
  const scopesById = new Map(run.scopes.map((s) => [s.id, s]));
  for (const e of finding.evidence) {
    if (e.kind === "request") {
      const parts = e.ref.split("#");
      if (parts.length >= 3) { const idx = Number(parts[parts.length - 1]); const sid = parts[parts.length - 2]; if (scopesById.has(sid) && Number.isInteger(idx)) return { scopeId: sid, request: idx }; }
    }
  }
  for (const e of finding.evidence) {
    if (e.kind === "block") {
      const blockId = e.ref.includes("#") ? e.ref.slice(e.ref.indexOf("#") + 1) : e.ref;
      const sid = blockId.includes(":") ? blockId.slice(0, blockId.indexOf(":")) : finding.scopeId;
      if (!sid || !scopesById.has(sid)) continue;
      const source = loaded && loaded.id === sid ? loaded : scopesById.get(sid);
      const b = source?.blocks?.find((x) => x.id === blockId);
      return { scopeId: sid, request: b?.firstRequest };
    }
  }
  for (const e of finding.evidence) {
    if (e.kind === "scope") { const sid = e.ref.includes("#") ? e.ref.slice(e.ref.indexOf("#") + 1) : e.ref; if (scopesById.has(sid)) return { scopeId: sid }; }
  }
  if (finding.scopeId && scopesById.has(finding.scopeId)) return { scopeId: finding.scopeId };
  return null;
}

// ---------- body ----------

interface BodyProps { run: RunResponse; summary: AgentScope; scope: AgentScope | null; scopeError: Error | null; missingScope: string | null; props: SessionScreenProps; live?: LiveInfo }

function SessionBody({ run, summary, scope, scopeError, missingScope, props, live }: BodyProps) {
  const requests: Request[] = scope?.requests ?? [];
  const compactions = scope?.compactions ?? [];
  const loaded = !!scope;

  // Render timing: from body mount to the first effect after paint.
  const renderStart = useRef(performance.now());
  const [renderMs, setRenderMs] = useState<number | null>(null);
  useEffect(() => {
    if (!loaded) return;
    setRenderMs(Math.round((performance.now() - renderStart.current) * 10) / 10);
    // Kept in production too (#4): a horizontal overflow is a layout bug worth a console line on any build.
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) console.warn(`[contextscope] horizontal overflow: scrollWidth ${root.scrollWidth} > clientWidth ${root.clientWidth}`);
  }, [loaded]);

  // Progressive mount: 0 = header + charts, 1 = lanes + heavy hitters + ledger, 2 = findings.
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!loaded || phase >= 2) return;
    const t = setTimeout(() => setPhase((p) => p + 1), 0);
    return () => clearTimeout(t);
  }, [loaded, phase]);

  useEffect(() => { requestCount.value = requests.length; }, [requests.length]);
  const [chartRef, width] = useWidth<HTMLDivElement>();
  const range = brushRange.value;
  const domain: [number, number] = range ?? [0, Math.max(1, requests.length - 1)];
  const x = useMemo(() => linear(domain, [MARGIN.left, Math.max(MARGIN.left + 50, width - MARGIN.right)]), [domain[0], domain[1], width]);

  const hidden = hiddenCategories.value;
  const stats = useMemo(() => (scope ? scopeStats(scope, run) : null), [scope, run]);
  const mainStats = useMemo(() => (run.scopes[0] && run.scopes[0].id !== scope?.id ? scopeStats(run.scopes[0], run) : null), [run, scope?.id]);
  const p95 = stats?.errP95 ?? run.coverage?.estimatorErrorP95 ?? 0;
  const approximate = p95 > APPROX_P95;
  const showStack = p95 <= HIDE_P95 && !(stats?.transcriptIncomplete);
  const lanes = useMemo(() => layoutLanes(run.scopes, summary.id), [run.scopes, summary.id]);
  const laneLaunches = useMemo(() => new Map(lanes.map((l) => [l.scope.id, Math.round(l.start)])), [lanes]);
  const legendEntries = useMemo(() => STACK_ORDER.filter((c) => requests.some((r) => (r.composition[c] ?? 0) > 0)), [requests]);
  const groups = useMemo(() => groupFindings(run.findings ?? []), [run.findings]);

  const isLive = !!live;
  const doPin = useCallback((i: number) => pin(pinnedRequest.peek() === i ? null : i), []);
  const openScope = useCallback((id: string) => navigate(hrefs.session(props.vendor, props.id, { scope: id === "main" ? undefined : id })), [props.vendor, props.id]);
  const hrefFor = useCallback((id: string) => hrefs.session(props.vendor, props.id, { scope: id }), [props.vendor, props.id]);
  const filterRef = useRef<HTMLInputElement | null>(null);

  // Keyboard map (session subset): j/k, [ ], p, z/Z, Esc, Enter (body or ledger only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || modalOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        if (e.key === "Escape") { (t as HTMLInputElement).blur(); ledgerFilter.value = ""; }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const cur = focusedRequest.peek() ?? pinnedRequest.peek() ?? hoveredRequest.peek();
      const n = requests.length;
      const lo = brushRange.peek()?.[0] ?? 0;
      const onBody = !t || t === document.body || !!t.closest(".cs-ledger-wrap");
      switch (e.key) {
        case "f": if (isLive) { resumeFollow(); e.preventDefault(); } break;
        // The ledger's own scroller must never own these: End goes to the page end, Home to the top (ADR-004 §7.14).
        case "End": if (onBody) { window.scrollTo({ top: document.documentElement.scrollHeight }); e.preventDefault(); } break;
        case "Home": if (onBody) { window.scrollTo({ top: 0 }); e.preventDefault(); } break;
        case "j": focusedRequest.value = clampToRange(cur === null ? lo : cur + 1); e.preventDefault(); break;
        case "k": focusedRequest.value = clampToRange(cur === null ? lo : cur - 1); e.preventDefault(); break;
        case "]": { const next = compactions.map((c) => c.atRequest).filter((i) => i > (cur ?? -1)).sort((a, b) => a - b)[0]; if (next !== undefined) focusedRequest.value = clampToRange(next); e.preventDefault(); break; }
        case "[": { const prev = compactions.map((c) => c.atRequest).filter((i) => i < (cur ?? n)).sort((a, b) => b - a)[0]; focusedRequest.value = clampToRange(prev ?? lo); e.preventDefault(); break; }
        case "p": if (cur !== null) pin(pinnedRequest.peek() === cur ? null : cur); e.preventDefault(); break;
        case "z": if (cur !== null && n > 1) { brushRange.value = [Math.max(0, cur - 50), Math.min(n - 1, cur + 50)]; e.preventDefault(); } break;
        case "Z": brushRange.value = null; e.preventDefault(); break;
        case "Enter": if (onBody && cur !== null) { toggleExpanded(cur); e.preventDefault(); } break;
        case "Escape":
          if (pinnedRequest.peek() !== null || focusedRequest.peek() !== null) { if (isLive) resumeFollow(); else pin(null); }
          else if (brushRange.peek()) brushRange.value = null;
          else if (ledgerFilter.peek()) ledgerFilter.value = "";
          else railOpen.value = false;
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requests.length, compactions, isLive]);

  // Findings: evidence refs `${runId}#${scopeId}#${index}` (request), `${runId}#${blockId}` (block), `${runId}#${scopeId}` (scope).
  const pinInScope = useCallback((target: { scopeId: string; request?: number }) => {
    if (target.scopeId !== summary.id) { navigate(hrefs.session(props.vendor, props.id, { scope: target.scopeId, request: target.request })); return; }
    if (target.request !== undefined) {
      const r = brushRange.peek();
      if (r && (target.request < r[0] || target.request > r[1])) brushRange.value = null;
      pin(target.request);
      document.querySelector(`.cs-ledger-row[data-request="${target.request}"]`)?.classList.add("cs-flash");
    }
  }, [summary.id, props.vendor, props.id]);
  const showEvidence = useCallback((finding: Finding) => {
    const target = resolveEvidence(finding, run, scope);
    if (target) pinInScope(target);
  }, [run, scope, pinInScope]);

  const compositionBadge = stats ? `composition · estimated, reconciled · p95 ${formatPercent(stats.errP95, 0)}${stats.unloggedShare > UNLOGGED_BADGE ? ` · ${formatPercent(stats.unloggedShare, 0)} not in transcript` : ""}` : "composition · estimated, reconciled";

  return (
    <section class={`cs-session${railOpen.value ? "" : " cs-rail-closed"}`} aria-label="Session view">
      <div class="cs-main">
        <SessionHeader run={run} summary={summary} props={props} openScope={openScope} live={live} />
        {missingScope && <p class="cs-notice" role="status">Scope <code>{missingScope}</code> is not in this run — showing <strong>main</strong>.</p>}
        {scopeError && <ErrorNotice error={scopeError} retry={() => openScope(summary.id)} />}

        {loaded && requests.length > 0 && <EndMixBar last={requests[requests.length - 1]} blocks={scope?.blocks ?? []} scopeName={summary.kind === "main" ? "the main scope" : summary.agentType ?? summary.id} reliable={showStack && !stats?.transcriptIncomplete} />}

        <Panel title="Context occupancy" description={`What filled the model's input on each of ${loaded ? formatInt(requests.length) : formatInt(scopeRequestCount(summary))} requests in ${summary.kind === "main" ? "the main scope" : summary.agentType ?? summary.id}. Stack: estimated, reconciled to the exact vendor total (thin line).`}
          actions={<>
            {stats?.transcriptIncomplete && <span class="cs-badge-warn" title={`${formatPercent(stats.unloggedShare, 0)} of the input is not in the transcript and fewer than 20% of requests carry new blocks; only the exact total is drawn`}>transcript incomplete</span>}
            {!stats?.transcriptIncomplete && approximate && showStack && <span class="cs-badge-warn" title={`Estimator error p95 ${formatPercent(p95)} exceeds ${formatPercent(APPROX_P95, 0)} for this scope`}>composition approximate</span>}
            {!stats?.transcriptIncomplete && !showStack && <span class="cs-badge-warn" title={`Estimator error p95 ${formatPercent(p95)} exceeds ${formatPercent(HIDE_P95, 0)} for this scope; only the exact total is drawn`}>composition hidden · error {formatPercent(p95, 0)}</span>}
            <Prov provenance="observed.vendor" text="total · observed" />
            <span class="cs-badge-comp" title={PROVENANCE_META["estimated.local"].hint}>{compositionBadge}<Badge provenance="estimated.local" /></span>
          </>}>
          {!loaded ? (
            <Skeleton chart rows={2} label={`Loading scope ${summary.agentType ?? summary.id}`} />
          ) : (
            <>
              <ul class="cs-legend" aria-label="Categories (click to hide from the stack)">
                <li><span class="cs-legend-static"><span class="cs-line-key" /> Exact total</span></li>
                {legendEntries.map((c) => (
                  <li key={c}><button type="button" aria-pressed={!hidden.has(c)} onClick={() => toggleCategory(c)} title={CATEGORY_META[c].label}><span class={`cs-swatch${c === "unlogged" ? " cs-swatch-hatch" : ""}`} style={{ background: CATEGORY_META[c].color }} />{CATEGORY_META[c].short}</button></li>
                ))}
                {hidden.size > 0 && <li><button type="button" class="cs-muted" onClick={() => { hiddenCategories.value = new Set(); }}>show all</button></li>}
                {legendEntries.includes("unlogged") && <li class="cs-muted" style={{ fontSize: "11px" }}>hatched = input the model saw that is not in this transcript</li>}
              </ul>
              <div class="cs-charts" ref={chartRef}>
                {width > 0 && requests.length > 0 ? (
                  <>
                    <StackedArea requests={requests} compactions={compactions} window={run.window} hidden={hidden} showStack={showStack} x={x} width={width} height={CHART_H}
                      laneLaunches={laneLaunches} baseSteps={stats?.baseSteps} threshold={scope?.forecast?.threshold} onHover={setHovered} onPin={doPin} />
                    <Axis x={x} requests={requests} width={width} />
                    <Brush requests={requests} width={width} height={36} range={range} onChange={setBrush} />

                    <div class="cs-subhead"><strong>Cache split</strong><span>per request: cache read / cache creation / uncached input · dotted = model switch</span><Badge provenance="observed.vendor" /></div>
                    <ul class="cs-legend">
                      <li><span class="cs-legend-static"><span class="cs-swatch" style={{ background: CACHE_COLORS.cacheRead }} /> {CACHE_LABELS.cacheRead}</span></li>
                      {run.vendor !== "codex" && <li><span class="cs-legend-static"><span class="cs-swatch" style={{ background: CACHE_COLORS.cacheCreation }} /> {CACHE_LABELS.cacheCreation}</span></li>}
                      <li><span class="cs-legend-static"><span class="cs-swatch" style={{ background: CACHE_COLORS.uncached }} /> {CACHE_LABELS.uncached}</span></li>
                    </ul>
                    <CacheStrip requests={requests} x={x} width={width} height={72} onHover={setHovered} onPin={doPin} />
                  </>
                ) : requests.length === 0 ? <EmptyState compact title="No requests in this scope" body="The transcript for this scope carries no assistant request with usage fields." /> : <Skeleton chart rows={1} label="Measuring" />}

                <div class="cs-subhead"><strong>Subagent lanes</strong><span>launch → delivery on the parent axis; fill height = child peak; arrow label = peak → handoff · ratio</span><Prov provenance="observed.vendor" text="peak · observed" /><Prov provenance="observed.artifact" text="handoff · artifact" /><Prov provenance="derived.exact" text="ratio · derived" /></div>
                {lanes.length === 0
                  ? <EmptyState compact title="No subagents were launched from this scope" body={run.vendor === "codex" ? "Codex child threads appear here when a rollout spawns them (thread_spawn)." : "Claude subagents appear here when the Agent tool is used; their transcripts live next to the session file."} path={run.vendor === "codex" ? "~/.codex/sessions/" : "~/.claude/projects/<project>/<session>/subagents/"} />
                  : phase >= 1 && width > 0
                    ? <Lanes scopes={run.scopes} parentId={summary.id} x={x} width={width} onOpen={openScope} hrefFor={hrefFor} />
                    : <Skeleton rows={3} label="Loading lanes" />}
              </div>
            </>
          )}
        </Panel>

        {loaded && scope && (phase >= 1 ? <HeavyHitters scope={scope} onOpenRequest={(i) => pinInScope({ scopeId: summary.id, request: i })} /> : <Panel title="Heavy hitters"><Skeleton rows={4} label="Loading heavy hitters" /></Panel>)}
        {loaded && scope && (phase >= 1 ? <CostPanel scope={scope} /> : <Panel title="What cost the most"><Skeleton rows={4} label="Loading per-tool cost" /></Panel>)}

        <Panel title="Ledger" description="One row per request. Token columns are the vendor's own counts; block sizes are local estimates." actions={<Prov provenance="observed.vendor" text="tokens · observed" />}>
          {loaded && scope && phase >= 1 ? <Ledger scope={scope} childScopes={run.scopes} onPin={(i) => pin(i)} filterRef={filterRef} /> : <Skeleton rows={6} label="Loading ledger" />}
        </Panel>

        <Panel title="Session findings" description={`${groups.length ? `${groups.length} rule${groups.length === 1 ? "" : "s"} fired on this session, one card per rule. ` : ""}Show evidence pins the request or opens the scope.`} id="cs-findings"
          actions={groups.length > FINDING_GROUPS_SHOWN ? <a class="btn btn-ghost" href={hrefs.findings({ vendor: run.vendor })}>All findings</a> : undefined}>
          {phase >= 2 ? <SessionFindings groups={groups} onShowEvidence={showEvidence} /> : <Skeleton rows={3} label="Loading findings" />}
        </Panel>
      </div>

      {railOpen.value && (
        <aside class="cs-rail" aria-label="Session facts">
          <button type="button" class="cs-rail-toggle" onClick={() => { railOpen.value = false; }} aria-label="Hide rail">Hide rail ›</button>
          {live && <ForecastCard forecast={scope?.forecast} window={run.window.value} lastRequest={requests.length ? requests[requests.length - 1] : undefined} autoCompactions={compactions.filter((c) => c.trigger === "auto").length} />}
          <RailFacts run={run} summary={summary} stats={stats} mainStats={mainStats} renderMs={renderMs} approximate={approximate} />
          {scope && <PinnedRequestPanel requests={requests} showStack={showStack} />}
        </aside>
      )}
    </section>
  );
}

// ---------- header ----------

function SessionHeader({ run, summary, props, openScope, live }: { run: RunResponse; summary: AgentScope; props: SessionScreenProps; openScope: (id: string) => void; live?: LiveInfo }) {
  const byId = useMemo(() => new Map(run.scopes.map((s) => [s.id, s])), [run.scopes]);
  const chain: AgentScope[] = [];
  for (let p = summary.parentScopeId ? byId.get(summary.parentScopeId) : undefined; p && p.kind === "subagent"; p = p.parentScopeId ? byId.get(p.parentScopeId) : undefined) chain.unshift(p);
  const label = (s: AgentScope) => (s.kind === "main" ? "main" : `${s.agentType ?? s.id} (${s.id})`);
  return (
    <div class="cs-head">
      <div>
        <nav class="cs-crumb" aria-label="Breadcrumb">
          <a href={hrefs.overview()}>Overview</a> › <a href={hrefs.session(props.vendor, props.id)}>Session</a>
          {summary.kind === "subagent" && <> › <a href={hrefs.session(props.vendor, props.id)}>main</a>{chain.map((p) => <span key={p.id}> › <a href={hrefs.session(props.vendor, props.id, { scope: p.id })}>{p.agentType ?? p.id}</a></span>)} › {summary.agentType ?? "subagent"} <span class="cs-mono">({summary.id})</span></>}
        </nav>
        <div class="cs-title-row">
          <h1>{run.project.displayName} <span class="cs-muted">· {run.vendor} · {formatDate(run.startedAt)} {formatClock(run.startedAt)}</span></h1>
          <LiveBadge live={live} />
          {(run.summary.models.length || run.gitBranch) ? <span class="cs-muted cs-title-sub">{[run.summary.models.join(", "), run.gitBranch].filter(Boolean).join(" · ")}</span> : null}
        </div>
      </div>
      <div class="cs-head-right">
        {live && <FollowToggle />}
        {live?.parseMs !== undefined && <span class="cs-live-meta" title="Time the companion took to re-parse the transcript after the last change">re-parse {formatInt(live.parseMs)} ms</span>}
        {backend.value.mode !== "memory" && <ExportControl vendor={props.vendor} id={props.id} defaultScopes={run.scopes.length <= 8 ? "all" : "main"} currentScope={summary.kind === "subagent" ? summary.id : undefined} />}
        {summary.kind === "subagent" && <button type="button" class="cs-rail-toggle" onClick={() => openScope(summary.parentScopeId ?? "main")}>‹ Back to {summary.parentScopeId && summary.parentScopeId !== "main" ? (byId.get(summary.parentScopeId)?.agentType ?? "parent") : "main"}</button>}
        <label>Scope <select class="cs-select" value={summary.id} onChange={(e) => openScope((e.currentTarget as HTMLSelectElement).value)}>
          {run.scopes.map((s) => <option key={s.id} value={s.id}>{"  ".repeat(s.depth)}{label(s)} · {formatInt(scopeRequestCount(s))} req</option>)}
        </select></label>
        <span class="cs-hints"><span class="cs-kbd">j</span>/<span class="cs-kbd">k</span> request · <span class="cs-kbd">[</span>/<span class="cs-kbd">]</span> compaction · <span class="cs-kbd">p</span> pin · <span class="cs-kbd">z</span> zoom · <span class="cs-kbd">Esc</span> unpin{live ? <> · <span class="cs-kbd">f</span> follow</> : null}</span>
        {!railOpen.value && <button type="button" class="cs-rail-toggle" onClick={() => { railOpen.value = true; }}>Show rail</button>}
      </div>
    </div>
  );
}

/**
 * "Export" (companion and demo): downloads this run as a `contextscope.export/1`
 * document (sizes, hashes, token counts; never text) that `#/open` can load.
 * The scope selection is explicit (#20); `redact` hashes file labels and the project name.
 */
function ExportControl({ vendor, id, defaultScopes, currentScope }: { vendor: string; id: string; defaultScopes: "main" | "all"; currentScope?: string }) {
  const [redact, setRedact] = useState(true);
  const [scopes, setScopes] = useState<string>(defaultScopes);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const doc = await api.exportRun(vendor, id, { redact, scopes });
      downloadJson(doc, `contextscope-${vendor}-${id.slice(0, 8)}${redact ? "-redacted" : ""}.json`);
      toast(`Export saved${redact ? " (labels redacted)" : ""} · open it via Open an export`, "success");
    } catch (err) {
      if (!isAbortError(err)) toast(`Export failed: ${(err as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="cs-export">
      <label class="cs-export-redact" title="Which scopes the file carries: the main scope only (small), every subagent, or the scope on screen">
        <select class="cs-select" value={scopes} onChange={(e) => setScopes((e.currentTarget as HTMLSelectElement).value)} aria-label="Scopes to export">
          <option value="main">main scope</option>
          <option value="all">all scopes</option>
          {currentScope ? <option value={currentScope}>this scope ({currentScope})</option> : null}
        </select>
      </label>
      <label class="cs-export-redact" title="Replace file labels and the project name with sha1-10 hashes so the file can leave the team; token counts and shapes stay">
        <input type="checkbox" checked={redact} onChange={(e) => setRedact((e.currentTarget as HTMLInputElement).checked)} /> redact
      </label>
      <button type="button" class="cs-follow" disabled={busy} onClick={() => { void run(); }} title="Download this session as JSON: sizes, hashes and token counts only, no text">{busy ? "Exporting…" : "Export"}</button>
    </span>
  );
}

/** Reads the follow signal at the leaf; the header does not re-render on pin. */
function FollowToggle() {
  const on = followLive.value && pinnedRequest.value === null;
  return (
    <button type="button" class="cs-follow cs-follow-live" aria-pressed={on} onClick={() => { if (on) followLive.value = false; else resumeFollow(); }} title={on ? "Following the newest request as the transcript grows; click (or pin a request) to stop" : "Jump to the newest request and keep following (f); a zoom is kept and grows with the tail"}>
      <span class="live-dot" aria-hidden="true" />{on ? "Following newest" : "Follow newest"} <span class="cs-kbd">f</span>
    </button>
  );
}

/** What the fix wave adds to `Forecast` (ADR-004 §4); optional so an older companion still renders. */
type ForecastExtra = Forecast & { status?: "ok" | "flat"; threshold: Forecast["threshold"] & { basis?: { events?: number; min?: number; max?: number; source?: string } } };

/** Requests rounded to 10 and minutes to 5 (ADR-004 §4): a slope over 20 requests does not support finer figures. */
function roundRequests(n: number): string { return n < 10 ? `~${Math.max(1, Math.ceil(n))}` : `~${Math.round(n / 10) * 10}`; }
function roundMinutes(m: number): string { const r = Math.max(5, Math.round(m / 5) * 5); return r >= 60 ? `about ${formatDuration(r * 60_000)}` : `about ${r} min`; }

/**
 * Compaction forecast (ADR-003 §3, copy per ADR-004 §4), rendered only while
 * the session is live. States the basis (last N requests, active time), where
 * the threshold comes from (this session's own auto-compactions, or a local
 * calibration with its event count and range), and caps far-off countdowns.
 */
function ForecastCard({ forecast: raw, window: win, lastRequest, autoCompactions }: { forecast?: Forecast; window: number; lastRequest?: Request; autoCompactions: number }) {
  const forecast = raw as ForecastExtra | undefined;
  const now = lastRequest ? `Now ${formatTokens(lastRequest.usage.total)} of ${formatTokens(win)}.` : "";
  if (!forecast) {
    return (
      <Panel title="Compaction forecast">
        <p class="cs-forecast-none">{lastRequest ? `No forecast: the context has not grown over the last requests. ${now}` : "No forecast yet: fewer than 8 requests since the last compaction."}</p>
      </Panel>
    );
  }
  const prov = forecast.threshold.provenance;
  const basis = forecast.threshold.basis;
  const range = basis && Number.isFinite(basis.min) && Number.isFinite(basis.max) && basis.min !== basis.max ? `; range ${formatTokens(basis.min as number)}–${formatTokens(basis.max as number)}` : "";
  const source = prov === "observed.vendor" || prov === "observed.artifact"
    ? `observed: median of ${autoCompactions ? `${autoCompactions} auto-compaction${autoCompactions === 1 ? "" : "s"} in this session` : "this session's auto-compactions"}${range}`
    : prov === "estimated.local"
      ? `calibrated from ${basis?.events ? `${basis.events} local auto-compaction${basis.events === 1 ? "" : "s"}` : "local auto-compactions"}${basis?.source ? ` (${basis.source})` : ""}${range}`
      : `${PROVENANCE_META[prov]?.label ?? prov}${range}`;
  const far = forecast.requestsLeft > FORECAST_FAR_REQUESTS || (forecast.minutesLeft > FORECAST_FAR_MINUTES && forecast.perMinute > 0);
  const flat = forecast.status === "flat" || !(forecast.perRequest > 0);
  return (
    <Panel title="Compaction forecast" actions={<Badge provenance="derived.exact" />}>
      <p class="cs-forecast">
        Auto-compaction at <strong class="cs-forecast-num">~{formatTokens(forecast.threshold.value)}</strong> <span class="cs-muted">({source})</span> <Badge provenance={prov} />. {now}
      </p>
      <p class="cs-forecast">
        {flat ? (
          <>Last {forecast.basis.requests} requests: no growth. <strong>No compaction expected at this rate.</strong></>
        ) : (
          <>
            Last {forecast.basis.requests} requests: <strong class="cs-forecast-num">+{formatTokens(forecast.perRequest)} per request</strong>{forecast.perMinute > 0 ? <>, +{formatTokens(forecast.perMinute)}/min of active time</> : null}.{" "}
            {far ? <strong>Not within this session at the current pace.</strong> : <>→ <strong class="cs-forecast-num">{roundRequests(forecast.requestsLeft)} requests</strong>{forecast.perMinute > 0 && forecast.minutesLeft > 0 ? <>, <strong class="cs-forecast-num">{roundMinutes(forecast.minutesLeft)}</strong></> : null}.</>}
          </>
        )}
      </p>
      <p class="cs-forecast-basis">Slope: least squares over requests {forecast.basis.from}–{forecast.basis.to} of the current segment; time from active minutes between them. Threshold and slope are derived; the countdown is not a promise.</p>
    </Panel>
  );
}

// ---------- static panels (memoised: never re-render on hover) ----------

const HeavyHitters = memo(function HeavyHitters({ scope, onOpenRequest }: { scope: AgentScope; onOpenRequest: (index: number) => void }) {
  const heavy = useMemo(() => heavyRows(scope), [scope]);
  const compactions = scope.compactions ?? [];
  return (
    <Panel title="Heavy hitters" description="The ten largest blocks in this scope and whether they are still in the window." actions={<><Prov provenance="estimated.local" text="tokens · estimated" /><Prov provenance="derived.exact" text="presence · derived" /></>}>
      {heavy.length === 0 ? <EmptyState compact title="No blocks in this scope" body="Blocks are the tool results, prompts and attachments that entered the prompt; this scope recorded none." /> : (
        <div style={{ overflowX: "auto" }}>
          <table class="cs-table">
            <thead><tr><th>Category</th><th>Tool</th><th>Label</th><th class="num">Tokens</th><th>Entered</th><th>Presence</th></tr></thead>
            <tbody>
              {heavy.map((b) => {
                const dropped = b.droppedBy ? compactions.find((c) => c.id === b.droppedBy) : undefined;
                return (
                  <tr key={b.id}>
                    <td><span class="cs-chip"><span class={`cs-swatch${b.category === "unlogged" ? " cs-swatch-hatch" : ""}`} style={{ background: CATEGORY_META[b.category].color }} />{CATEGORY_META[b.category].short}</span></td>
                    <td class="cs-mono">{b.tool ?? "—"}{b.isError ? " (error)" : ""}</td>
                    <td title={b.label}>{b.label ?? "—"}</td>
                    <td class="num">{formatInt(b.estTokens)}</td>
                    <td><button type="button" class="cs-link" onClick={() => onOpenRequest(b.firstRequest)}>request {b.firstRequest}</button></td>
                    <td>{!b.presenceKnown ? <span class="cs-muted">—</span> : b.lastRequest === undefined ? <span class="cs-presence-ok">still present</span> : dropped ? <span class="cs-presence-dropped">dropped by compaction before {dropped.atRequest}</span> : <span class="cs-presence-ok">left at request {b.lastRequest}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
});

const SessionFindings = memo(function SessionFindings({ groups, onShowEvidence }: { groups: ReturnType<typeof groupFindings>; onShowEvidence: (f: Finding) => void }) {
  const shown = groups.slice(0, FINDING_GROUPS_SHOWN);
  if (groups.length === 0) return <EmptyState compact title="No findings for this session" body="Nothing crossed a threshold. Thresholds are editable on the Findings screen." path="~/.contextscope/thresholds.json" />;
  return (
    <div class="finding-group">
      {shown.map((g, i) => <FindingGroup key={`${g.ruleId}/${g.scope}`} group={g} defaultOpen={i === 0} onShowEvidence={onShowEvidence} />)}
      {groups.length > shown.length && <p class="cs-note">{groups.length - shown.length} more rule{groups.length - shown.length === 1 ? "" : "s"} fired on this session; see the Findings screen for the full list.</p>}
    </div>
  );
});

const RailFacts = memo(function RailFacts({ run, summary, stats, mainStats, renderMs, approximate }: { run: RunResponse; summary: AgentScope; stats: ScopeStats | null; mainStats: ScopeStats | null; renderMs: number | null; approximate: boolean }) {
  return (
    <>
      <Panel title="Session">
        {stats && stats.resumedTokens > 0 && (
          <p class="cs-resumed"><strong>Resumed session:</strong> {formatTokens(stats.resumedTokens)} tokens of earlier context are not in this transcript (hatched band at request 0).</p>
        )}
        <dl class="cs-facts">
          <dt>Vendor</dt><dd>{run.vendor}{run.entrypoint ? ` · ${run.entrypoint}` : ""}</dd>
          <dt>Models</dt><dd title={run.summary.models.join(", ")}>{run.summary.models.join(", ") || "—"}</dd>
          <dt>Directory</dt><dd title={run.project.cwdDisplay}>{run.project.cwdDisplay ?? run.project.displayName}</dd>
          <dt>Branch</dt><dd>{run.gitBranch ?? "—"}</dd>
          <dt>CLI</dt><dd>{run.cliVersion ?? "—"}</dd>
          <dt>Started</dt><dd>{formatDate(run.startedAt)} {formatClock(run.startedAt)}</dd>
          <dt>Source</dt><dd title={run.source?.file}>{run.source?.file ?? "—"}</dd>
        </dl>
        <div class="cs-stats" style={{ marginTop: "10px" }} role="list">
          <StatTile label="Window" value={formatTokens(run.window.value)} provenance={run.window.provenance} hint={run.window.provenance === "observed.vendor" ? "vendor field" : "model table"} />
          <StatTile label="Active time" value={formatDuration(run.activeMs)} hint="gaps > 30 min excluded" provenance="derived.exact" />
          <StatTile label="Requests / turns" value={`${formatInt(run.summary.requests)} / ${formatInt(run.summary.turns)}`} provenance="observed.artifact" />
          <StatTile label="Peak" value={formatTokens(run.summary.peak.value)} hint={`${formatPercent(run.summary.peakShareOfWindow, 0)} of window`} provenance={run.summary.peak.provenance} />
          <StatTile label="Cache read share" value={formatPercent(run.summary.cacheReadShare, 0)} provenance="derived.exact" />
          <StatTile label="Compactions / subagents" value={`${run.summary.compactions} / ${run.summary.subagents}`} provenance="observed.vendor" />
        </div>
      </Panel>
      {summary.kind === "subagent" && (
        <Panel title={`Scope: ${summary.agentType ?? summary.id}`}>
          <dl class="cs-facts">
            <dt>Status</dt><dd>{summary.status}</dd>
            <dt>Launched</dt><dd>request {summary.launchedAtRequest ?? "—"} of parent</dd>
            <dt>Delivered</dt><dd>{summary.deliveredAtRequest !== undefined ? `request ${summary.deliveredAtRequest} of parent` : "not yet"}</dd>
            <dt>Requests</dt><dd>{formatInt(scopeRequestCount(summary))}</dd>
            <dt>Peak</dt><dd>{formatTokens(summary.peak.value)} <Badge provenance={summary.peak.provenance} /></dd>
            <dt>Handoff</dt><dd>{summary.handoff ? <>{formatTokens(summary.handoff.tokens.value)} <Badge provenance={summary.handoff.tokens.provenance} /> · {formatRatio(summary.handoff.compressionRatio.value)} <Badge provenance="derived.exact" /></> : "—"}</dd>
            {summary.description && <><dt>Task</dt><dd title={summary.description}>{summary.description}</dd></>}
          </dl>
        </Panel>
      )}
      <Panel title="Coverage" actions={<Badge provenance="observed.artifact" />}>
        <dl class="cs-facts">
          <dt>Records</dt><dd>{formatInt(run.coverage?.records ?? NaN)}</dd>
          <dt>Unparsed</dt><dd title={Object.entries(run.coverage?.unparsedTypes ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")}>{formatInt(run.coverage?.unparsedRecords ?? NaN)}{Object.keys(run.coverage?.unparsedTypes ?? {}).length ? ` (${Object.keys(run.coverage.unparsedTypes).join(", ")})` : ""}</dd>
          <dt>Synthetic skipped</dt><dd>{formatInt(run.coverage?.syntheticRecordsSkipped ?? NaN)}</dd>
          <dt>{summary.kind === "main" ? "Estimator error" : "Error (this scope)"}</dt>
          <dd class={approximate ? "cs-note-amber" : ""} title="|1 − k| per request over unclamped requests; drives the composition badge for the scope on screen">
            {stats ? <>median {formatPercent(stats.errMedian)} · p95 {formatPercent(stats.errP95)}{approximate ? " · approximate" : ""}</> : "—"}
          </dd>
          {mainStats && <><dt>Error (main)</dt><dd>median {formatPercent(mainStats.errMedian)} · p95 {formatPercent(mainStats.errP95)}</dd></>}
          {stats && stats.unloggedShare > 0 && <><dt>Not in transcript</dt><dd title="Share of the input attributed to the unlogged category (resumed history, hidden injections)">{formatPercent(stats.unloggedShare, 0)}{stats.baseSteps.length ? ` · ${stats.baseSteps.length} base step${stats.baseSteps.length === 1 ? "" : "s"}` : ""}</dd></>}
          <dt>Adapter</dt><dd>{run.coverage?.adapterVersion ?? "—"}</dd>
          {renderMs !== null && <><dt>Render</dt><dd>{renderMs} ms</dd></>}
        </dl>
        <details class="cs-help">
          <summary>What the numbers mean</summary>
          <p><strong>Total</strong> is the vendor's own input count per request ({PROVENANCE_META["observed.vendor"].label}). The <strong>stack</strong> splits that total by category using local size estimates, scaled so the stack sums to the exact total ({PROVENANCE_META["estimated.local"].label}).</p>
          <p><strong>Unlogged</strong> (hatched) is input the model saw that is not in the transcript: resumed history, hidden injections, tool schemas beyond the baseline. A dotted vertical marks a persistent step in that base.</p>
          <p><strong>Estimator error</strong> is |1 − k| per request, where k is the scale that makes estimates match the vendor total, over requests whose k stayed inside the clamp band. p95 above {formatPercent(APPROX_P95, 0)} for the scope on screen marks the composition approximate; above {formatPercent(HIDE_P95, 0)} the stack is hidden.</p>
          <p><strong>Cache read</strong> is the prefix the vendor served from cache; <strong>cache creation</strong> is what it wrote; a creation spike without a large new block means something early in the prompt changed.</p>
          <p><strong>Handoff ratio</strong> = child peak ÷ handoff tokens: how much the subagent compressed what it read.</p>
        </details>
      </Panel>
    </>
  );
});

/** Reads the pinned signal at the leaf; nothing above it re-renders on pin. */
function PinnedRequestPanel({ requests, showStack }: { requests: Request[]; showStack: boolean }) {
  const pinned = pinnedRequest.value;
  const req = pinned !== null ? requests[pinned] : undefined;
  if (!req) return null;
  const scaleRaw = (req as { scaleRaw?: number }).scaleRaw;
  return (
    <Panel title={`Pinned request ${req.index}`} actions={<button type="button" class="cs-link" onClick={() => pin(null)}>unpin</button>}>
      <dl class="cs-facts">
        <dt>Time</dt><dd>{formatClock(req.at)} · turn {req.turn}</dd>
        <dt>Model</dt><dd>{req.model}</dd>
        <dt>Total</dt><dd>{formatInt(req.usage.total)} <Badge provenance="observed.vendor" /></dd>
        <dt>Hidden base</dt><dd>{formatInt(req.hiddenBase.value)} <Badge provenance={req.hiddenBase.provenance} /></dd>
        <dt>Scale k</dt><dd>{req.scale.toFixed(3)}{scaleRaw !== undefined && Math.abs(scaleRaw - req.scale) > 0.0005 ? <span class="cs-muted"> (raw {scaleRaw.toFixed(3)}, clamped)</span> : null}</dd>
      </dl>
      {showStack && <ul class="cs-pinned-comp">
        {STACK_ORDER.map((c) => ({ c, v: req.composition[c] ?? 0 })).filter((e) => e.v > 0).sort((a, b) => b.v - a.v).map(({ c, v }) => (
          <li key={c}><span class={`cs-swatch${c === "unlogged" ? " cs-swatch-hatch" : ""}`} style={{ background: CATEGORY_META[c].color }} /><span class="cs-muted">{CATEGORY_META[c].short}</span><span class="num">{formatInt(v)}</span><span class="num cs-muted">{formatPercent(v / (req.usage.total || 1), 0)}</span></li>
        ))}
      </ul>}
    </Panel>
  );
}
