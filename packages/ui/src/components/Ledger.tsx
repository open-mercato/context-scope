/**
 * Virtualised request ledger: one fixed-height row per request, expandable
 * (Enter / click) into fixed-height block rows. Row focus follows the chart
 * hover and pin; pinning from elsewhere scrolls the row into view. "New blocks"
 * come from `request.newBlockIds` when present, else from `blocks[].firstRequest`
 * (the payload split drops newBlockIds). ARIA: grid / row / gridcell with
 * aria-rowindex; the scroller owns focus and points at the focused row.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentScope, Block, Request } from "@ir/types.ts";
import { CATEGORY_META, formatTokens } from "../categories.ts";
import { formatClockSeconds, formatDelta, formatInt } from "../charts/scale.ts";
import { Badge } from "./Badge.tsx";
import { expandedRows, focusedRequest, hoveredRequest, ledgerFilter, pinnedRequest, setHovered, toggleExpanded, brushRange } from "../session-state.ts";

export const ROW_H = 32;
const OVERSCAN = 8;
const MAX_BLOCK_ROWS = 14;

type Row = { kind: "req"; request: Request } | { kind: "block"; index: number; block: Block } | { kind: "more"; index: number; count: number };

export interface LedgerProps {
  scope: AgentScope;
  /** All scopes of the run (summaries are enough) for the launch / delivery marks. */
  childScopes: AgentScope[];
  onPin: (index: number) => void;
  filterRef?: { current: HTMLInputElement | null };
}

function matches(r: Request, blocks: Block[], q: string): boolean {
  if (!q) return true;
  if (r.model.toLowerCase().includes(q) || String(r.index) === q) return true;
  for (const b of blocks) {
    if (b.category.includes(q) || CATEGORY_META[b.category].short.toLowerCase().includes(q)) return true;
    if (b.tool?.name.toLowerCase().includes(q) || b.label?.toLowerCase().includes(q)) return true;
  }
  return false;
}

/** New blocks per request: from newBlockIds when the payload carries them, else one pass over blocks[].firstRequest. */
export function newBlocksByRequest(scope: AgentScope): Map<number, Block[]> {
  const out = new Map<number, Block[]>();
  const blocks = scope.blocks ?? [];
  const requests = scope.requests ?? [];
  const hasIds = requests.length > 0 && requests.every((r) => Array.isArray(r.newBlockIds));
  if (hasIds) {
    const byId = new Map(blocks.map((b) => [b.id, b]));
    for (const r of requests) { const list = r.newBlockIds.map((id) => byId.get(id)).filter((b): b is Block => !!b); if (list.length) out.set(r.index, list); }
    return out;
  }
  for (const b of blocks) {
    if (b.category === "assistant_thinking") continue;
    const list = out.get(b.firstRequest) ?? [];
    list.push(b);
    out.set(b.firstRequest, list);
  }
  return out;
}

export function Ledger({ scope, childScopes, onPin, filterRef }: LedgerProps) {
  const requests = scope.requests ?? [];
  const newBlocks = useMemo(() => newBlocksByRequest(scope), [scope]);
  const hasCreation = useMemo(() => requests.some((r) => r.usage.cacheCreation !== undefined && r.usage.cacheCreation !== null), [requests]);
  const agentMarks = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const c of childScopes) {
      if (c.parentScopeId !== scope.id) continue;
      if (c.launchedAtRequest !== undefined) m.set(c.launchedAtRequest, [...(m.get(c.launchedAtRequest) ?? []), `▶ ${c.agentType ?? c.id}`]);
      if (c.deliveredAtRequest !== undefined) m.set(c.deliveredAtRequest, [...(m.get(c.deliveredAtRequest) ?? []), `◀ ${c.agentType ?? c.id} ${c.handoff ? formatTokens(c.handoff.tokens.value) : ""}`]);
    }
    return m;
  }, [childScopes, scope.id]);

  const filter = ledgerFilter.value.trim().toLowerCase();
  const expanded = expandedRows.value;
  const range = brushRange.value;
  const { rows, requestRows, rowIndexByRequest } = useMemo(() => {
    const out: Row[] = [];
    const index = new Map<number, number>();
    let count = 0;
    for (const r of requests) {
      if (range && (r.index < range[0] || r.index > range[1])) continue;
      const blocks = newBlocks.get(r.index) ?? [];
      if (!matches(r, blocks, filter)) continue;
      index.set(r.index, out.length);
      out.push({ kind: "req", request: r });
      count++;
      if (expanded.has(r.index)) {
        const shown = blocks.slice(0, MAX_BLOCK_ROWS);
        for (const b of shown) out.push({ kind: "block", index: r.index, block: b });
        if (blocks.length > shown.length) out.push({ kind: "more", index: r.index, count: blocks.length - shown.length });
        if (blocks.length === 0) out.push({ kind: "more", index: r.index, count: 0 });
      }
    }
    return { rows: out, requestRows: count, rowIndexByRequest: index };
  }, [requests, newBlocks, filter, expanded, range]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(520);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const pinned = pinnedRequest.value;
  const hovered = hoveredRequest.value;
  const focused = focusedRequest.value;

  // Scroll to the pinned / focused request when it (or the row set) changes.
  const lastScrolled = useRef<{ target: number; rows: Row[] } | null>(null);
  useEffect(() => {
    const target = focused ?? pinned;
    if (target === null) return;
    if (lastScrolled.current && lastScrolled.current.target === target && lastScrolled.current.rows === rows) return;
    lastScrolled.current = { target, rows };
    const i = rowIndexByRequest.get(target);
    const el = scrollRef.current;
    if (i === undefined || !el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop + ROW_H || top > el.scrollTop + el.clientHeight - ROW_H * 2) el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H);
  }, [pinned, focused, rows, rowIndexByRequest]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const cols = hasCreation ? "" : " cs-ledger-min";
  const focusedRow = focused !== null ? rowIndexByRequest.get(focused) : undefined;
  const activeId = focusedRow !== undefined ? `cs-ledger-row-${focused}` : undefined;
  const focusedReq = focused !== null ? requests[focused] : undefined;

  return (
    <div class="cs-ledger-wrap">
      <div class="cs-ledger-tools">
        <input ref={filterRef} data-filter type="search" placeholder="Filter rows: model, tool, label, category (/)" value={ledgerFilter.value} onInput={(e) => { ledgerFilter.value = (e.currentTarget as HTMLInputElement).value; }} aria-label="Filter ledger rows" aria-describedby="cs-ledger-hint" />
        <span class="cs-muted">{requestRows} of {requests.length} requests{range ? ` · zoomed to ${range[0]}–${range[1]}` : ""}</span>
        <span class="cs-muted" id="cs-ledger-hint">Enter expands the focused row · j/k move · p pins · / filters</span>
      </div>
      <div class="cs-ledger">
       <div class="cs-ledger-inner" role="grid" aria-label="Request ledger" aria-rowcount={requests.length + 1} aria-activedescendant={activeId}>
        <div class={`cs-ledger-head${cols}`} role="row" aria-rowindex={1}>
          <div role="columnheader">#</div><div role="columnheader">time</div><div role="columnheader">model</div>
          <div class="num" role="columnheader">input<Badge provenance="observed.vendor" /></div>
          {hasCreation && <div class="num" role="columnheader">cache create<Badge provenance="observed.vendor" /></div>}
          <div class="num" role="columnheader">cache read<Badge provenance="observed.vendor" /></div>
          <div class="num" role="columnheader">output (thinking)<Badge provenance="observed.vendor" /></div>
          <div class="num" role="columnheader">total<Badge provenance="observed.vendor" /></div>
          <div class="num" role="columnheader">Δ prev<Badge provenance="derived.exact" /></div>
          <div role="columnheader">new blocks<Badge provenance="estimated.local" /></div>
          <div role="columnheader">subagents</div>
        </div>
        <div ref={scrollRef} class="cs-ledger-scroll" onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)} tabIndex={0} aria-label="Ledger rows (j/k to move, Enter to expand)">
          <div style={{ height: `${rows.length * ROW_H}px`, position: "relative" }}>
            {rows.slice(first, last).map((row, k) => {
              const i = first + k;
              const top = `${i * ROW_H}px`;
              if (row.kind === "block") {
                const b = row.block;
                return (
                  <div key={`b${b.id}`} class="cs-ledger-row cs-row-block" style={{ top }} role="row">
                    <div role="gridcell">{b.seq}</div>
                    <div role="gridcell">
                      <span class="num">{formatTokens(b.estTokens)} tok</span>
                      <span class="cs-chip"><span class={`cs-swatch${b.category === "unlogged" ? " cs-swatch-hatch" : ""}`} style={{ background: CATEGORY_META[b.category].color }} />{CATEGORY_META[b.category].short}</span>
                      {b.tool && <span class="cs-mono">{b.tool.name}{b.tool.isError ? " (error)" : ""}</span>}
                      <span class="cs-muted">{b.label ?? b.attachmentType ?? ""}</span>
                      <span class="cs-muted">{b.bytes.toLocaleString()} B · {b.kind ?? "prose"}{b.lastRequest !== undefined ? ` · left at ${b.lastRequest}` : " · still present"}</span>
                    </div>
                  </div>
                );
              }
              if (row.kind === "more") {
                return <div key={`m${row.index}`} class="cs-ledger-row cs-row-block" style={{ top }} role="row"><div role="gridcell" /><div role="gridcell" class="cs-muted">{row.count === 0 ? "No new blocks for this request." : `${row.count} more blocks not shown`}</div></div>;
              }
              const r = row.request;
              const prev = r.index > 0 ? requests[r.index - 1] : undefined;
              const delta = prev ? r.usage.total - prev.usage.total : 0;
              const blocks = newBlocks.get(r.index) ?? [];
              const cats = [...new Set(blocks.map((b) => b.category))];
              const isExp = expanded.has(r.index);
              const marks = agentMarks.get(r.index);
              const cls = ["cs-ledger-row", hovered === r.index ? "cs-row-hot" : "", pinned === r.index ? "cs-row-pinned" : "", focused === r.index ? "cs-row-focus" : "", r.compactionBefore ? "cs-row-compaction" : "", cols].join(" ");
              return (
                <div key={`r${r.index}`} id={`cs-ledger-row-${r.index}`} class={cls} style={{ top }} role="row" aria-rowindex={r.index + 2} aria-selected={focused === r.index ? "true" : undefined} data-request={r.index}
                  onPointerEnter={() => setHovered(r.index)} onPointerLeave={() => setHovered(null)}
                  onClick={() => { onPin(r.index); toggleExpanded(r.index); }}>
                  <div role="gridcell"><button type="button" class="cs-caret" aria-expanded={isExp} aria-label={`${isExp ? "Collapse" : "Expand"} request ${r.index}`} tabIndex={-1} onClick={(e) => { e.stopPropagation(); toggleExpanded(r.index); }}>{isExp ? "▾" : "▸"}</button>{r.index}</div>
                  <div role="gridcell" class="cs-mono">{formatClockSeconds(r.at)}</div>
                  <div role="gridcell" title={r.model}>{r.model}</div>
                  <div role="gridcell" class="num">{formatInt(r.usage.input)}</div>
                  {hasCreation && <div role="gridcell" class="num">{formatInt(r.usage.cacheCreation ?? 0)}</div>}
                  <div role="gridcell" class="num">{formatInt(r.usage.cacheRead)}</div>
                  <div role="gridcell" class="num">{formatTokens(r.usage.output)}{r.usage.thinking ? <span class="cs-muted"> ({formatTokens(r.usage.thinking)} thinking)</span> : null}</div>
                  <div role="gridcell" class="num">{formatInt(r.usage.total)}</div>
                  <div role="gridcell" class={`num ${delta > 0 ? "cs-delta-up" : "cs-delta-down"}`}>{formatDelta(delta, formatTokens)}</div>
                  <div role="gridcell">
                    <span class="cs-chips">
                      <span>{blocks.length}</span>
                      {cats.slice(0, 4).map((c) => <span key={c} class="cs-chip" title={CATEGORY_META[c].label}><span class="cs-swatch" style={{ background: CATEGORY_META[c].color }} />{CATEGORY_META[c].short}</span>)}
                      {cats.length > 4 && <span class="cs-muted">+{cats.length - 4}</span>}
                      {blocks.length > 0 && <span class="cs-muted">{formatTokens(blocks.reduce((s, b) => s + b.estTokens, 0))} tok</span>}
                    </span>
                  </div>
                  <div role="gridcell" class="cs-agent-mark" title={marks?.join(", ")}>{marks?.join(" ")}{r.compactionBefore ? <span class="cs-muted"> compaction</span> : null}</div>
                </div>
              );
            })}
          </div>
        </div>
       </div>
      </div>
      <div class="visually-hidden" aria-live="polite">{focusedReq ? `Request ${focusedReq.index}, ${formatInt(focusedReq.usage.total)} tokens` : ""}</div>
    </div>
  );
}
