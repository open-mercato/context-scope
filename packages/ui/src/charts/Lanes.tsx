/**
 * Subagent lanes: one lane per descendant scope of the selected scope, pinned
 * under the parent axis from launch to delivery. Lane fill height encodes the
 * child's private peak; an arrow into the parent axis at delivery is labelled
 * with the handoff size and compression ratio. Nested children are indented
 * and positioned proportionally inside their parent's lane.
 *
 * Works on scope summaries (`partial: true`, `requestCount`) as well as full
 * scopes. Capped at the top LANE_CAP lanes by peak with "show all"; the rest is
 * listed in a compact table. The SVG is decorative; the HTML overlay is the
 * accessible list, with one tab stop per lane (the open link).
 */
import { useMemo } from "preact/hooks";
import type { AgentScope } from "@ir/types.ts";
import { formatTokens } from "../categories.ts";
import { formatRatio } from "../format.ts";
import type { LinearScale } from "./scale.ts";
import { hoveredLane, showAllLanes, setHovered } from "../session-state.ts";

export interface LaneRow {
  scope: AgentScope;
  depth: number;          // relative to the selected scope
  start: number;          // parent request index (fractional for nested)
  end: number | null;     // null = still open
}

export const LANE_H = 40;
export const LANE_CAP = 20;
const TEXT_H = 16;
const LABEL_W = 560;

export function scopeRequestCount(s: AgentScope): number {
  return s.requestCount ?? s.requests?.length ?? 0;
}

/** Flatten descendants of `parentId`, mapping nested launches into parent-axis coordinates. */
export function layoutLanes(scopes: AgentScope[], parentId: string): LaneRow[] {
  const rows: LaneRow[] = [];
  const byParent = new Map<string, AgentScope[]>();
  for (const s of scopes) if (s.parentScopeId) { const list = byParent.get(s.parentScopeId) ?? []; list.push(s); byParent.set(s.parentScopeId, list); }
  for (const list of byParent.values()) list.sort((a, b) => (a.launchedAtRequest ?? 0) - (b.launchedAtRequest ?? 0));
  const walk = (id: string, depth: number, map: (i: number) => number, parentEnd: number | null) => {
    for (const child of byParent.get(id) ?? []) {
      const s = map(child.launchedAtRequest ?? 0);
      const e = child.deliveredAtRequest !== undefined ? map(child.deliveredAtRequest) : parentEnd;
      rows.push({ scope: child, depth, start: s, end: e });
      const span = (e ?? s + 1) - s;
      const count = Math.max(1, scopeRequestCount(child) - 1);
      walk(child.id, depth + 1, (i) => s + (i / count) * span, e);
    }
  };
  walk(parentId, 0, (i) => i, null);
  return rows;
}

/** Top `cap` lanes by peak, kept in launch order; `showAll` returns everything. */
export function capLanes(rows: LaneRow[], cap: number, showAll: boolean): { shown: LaneRow[]; hidden: LaneRow[] } {
  if (showAll || rows.length <= cap) return { shown: rows, hidden: [] };
  const keep = new Set(rows.slice().sort((a, b) => b.scope.peak.value - a.scope.peak.value).slice(0, cap).map((r) => r.scope.id));
  return { shown: rows.filter((r) => keep.has(r.scope.id)), hidden: rows.filter((r) => !keep.has(r.scope.id)) };
}

export function arrowLabel(s: AgentScope, open: boolean): string {
  const handoff = s.handoff?.tokens.value;
  const ratio = s.handoff?.compressionRatio.value;
  if (handoff !== undefined) return `${formatTokens(s.peak.value)} → ${formatTokens(handoff)}${ratio !== undefined ? ` · ${formatRatio(ratio)}` : ""}`;
  return open ? "still running · no handoff yet" : "no handoff observed";
}

export interface LanesProps {
  scopes: AgentScope[];
  parentId: string;
  x: LinearScale;
  width: number;
  onOpen: (scopeId: string) => void;
  hrefFor: (scopeId: string) => string;
}

export function Lanes({ scopes, parentId, x, width, onOpen, hrefFor }: LanesProps) {
  const all = useMemo(() => layoutLanes(scopes, parentId), [scopes, parentId]);
  const showAll = showAllLanes.value;
  const { shown: rows, hidden } = useMemo(() => capLanes(all, LANE_CAP, showAll), [all, showAll]);
  const maxPeak = useMemo(() => { let m = 1; for (const r of rows) m = Math.max(m, r.scope.peak.value); return m; }, [rows]);
  const hot = hoveredLane.value;
  const height = rows.length * LANE_H + 8;
  const [lo, hi] = x.domain;
  if (all.length === 0) return null;
  const dense = rows.length > 8;
  const geometry = rows.map((row, i) => {
    const open = row.end === null;
    const endIdx = row.end ?? hi;
    const visible = !(endIdx < lo || row.start > hi);
    const x0 = Math.max(x.range[0], x(row.start));
    const x1 = Math.min(x.range[1], x(endIdx));
    const top = 4 + i * LANE_H;
    const bandTop = top + TEXT_H + 2;
    const bandH = LANE_H - TEXT_H - 6;
    const fillH = Math.max(4, (row.scope.peak.value / maxPeak) * bandH);
    const yFill = bandTop + bandH - fillH;
    const indent = row.depth * 14;
    return { row, open, visible, x0, x1, top, fillH, yFill, indent };
  });
  const hoverLane = (id: string | null, launch: number | null) => { hoveredLane.value = id; setHovered(launch); };
  return (
    <>
      <div class="cs-chart" style={{ height: `${height}px` }}>
        <svg width={width} height={height} class="cs-lanes" aria-hidden="true">
          <defs>
            <marker id="cs-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0.5 L7,4 L0,7.5Z" class="cs-arrow-head" /></marker>
          </defs>
          {geometry.map(({ row, open, visible, x0, x1, top, fillH, yFill, indent }) => {
            if (!visible) return null;
            const s = row.scope;
            return (
              <g key={s.id} class={`cs-lane${hot === s.id ? " cs-lane-hot" : ""}${open ? " cs-lane-open" : ""}`}
                onPointerEnter={() => hoverLane(s.id, Math.round(row.start))}
                onPointerLeave={() => hoverLane(null, null)}
                onClick={() => onOpen(s.id)}>
                <rect x={x.range[0]} y={top} width={x.range[1] - x.range[0]} height={LANE_H - 2} class="cs-lane-hit" />
                <line x1={x0} x2={x0} y1={top + 2} y2={yFill + fillH} class="cs-lane-launch" />
                <rect x={x0 + indent} y={yFill} width={Math.max(2, x1 - x0 - indent)} height={fillH} class="cs-lane-fill" rx={2} />
                {open && <line x1={x1} x2={x1} y1={yFill - 2} y2={yFill + fillH + 2} class="cs-lane-open-end" />}
                {!open && <line x1={x1} x2={x1} y1={yFill + fillH / 2} y2={top + 2} class="cs-lane-arrow" marker-end="url(#cs-arrow)" />}
              </g>
            );
          })}
        </svg>
        <ul class="cs-lane-texts" aria-label={`${rows.length} of ${all.length} subagent lanes`}>
          {geometry.map(({ row, open, visible, x0, top, indent }) => {
            if (!visible) return null;
            const s = row.scope;
            // Left-anchored, shifted left when the lane starts late so the label never clips at either edge.
            const left = dense ? x.range[0] + 4 + indent : Math.max(x.range[0], Math.min(x0 + indent + 6, width - LABEL_W));
            const count = scopeRequestCount(s);
            return (
              <li key={s.id} class="cs-lane-text" style={{ left: `${left}px`, top: `${top}px`, maxWidth: `${Math.max(120, width - left)}px` }}>
                <strong>{row.depth > 0 ? "└ " : ""}{s.agentType ?? s.kind}</strong>
                {s.description && <span class="cs-muted">{s.description}</span>}
                <span class="cs-muted">peak</span><span>{formatTokens(s.peak.value)}</span>
                <span class="cs-muted">{count} req · {s.status}</span>
                <span class="cs-lane-handoff">{arrowLabel(s, open)}</span>
                <a href={hrefFor(s.id)} class="cs-muted" aria-label={`Open ${s.agentType ?? s.kind} ${s.id}: launched at request ${s.launchedAtRequest ?? "?"}, ${open ? "still open" : `delivered at request ${s.deliveredAtRequest}`}, peak ${formatTokens(s.peak.value)}`}
                  onClick={(e) => { e.preventDefault(); onOpen(s.id); }} onFocus={() => hoverLane(s.id, Math.round(row.start))} onBlur={() => hoverLane(null, null)}>open ›</a>
              </li>
            );
          })}
        </ul>
      </div>
      {(hidden.length > 0 || showAll && all.length > LANE_CAP) && (
        <div class="cs-lanes-more">
          {hidden.length > 0
            ? <><span>Showing the {rows.length} lanes with the highest peak; {hidden.length} more not drawn.</span><button type="button" class="cs-link" onClick={() => { showAllLanes.value = true; }}>Show all {all.length} lanes</button></>
            : <button type="button" class="cs-link" onClick={() => { showAllLanes.value = false; }}>Show only the top {LANE_CAP} by peak</button>}
        </div>
      )}
      {hidden.length > 0 && (
        <details class="cs-lane-list">
          <summary>All {all.length} subagents as a list</summary>
          <div style={{ overflowX: "auto" }}>
            <table class="cs-table">
              <thead><tr><th>Agent</th><th>Depth</th><th class="num">Launched</th><th class="num">Delivered</th><th class="num">Requests</th><th class="num">Peak</th><th>Handoff</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {all.map(({ scope: s, depth }) => (
                  <tr key={s.id}>
                    <td><strong>{s.agentType ?? s.kind}</strong> <span class="cs-mono cs-muted">{s.id}</span></td>
                    <td>{depth}</td>
                    <td class="num">{s.launchedAtRequest ?? "—"}</td>
                    <td class="num">{s.deliveredAtRequest ?? "—"}</td>
                    <td class="num">{scopeRequestCount(s)}</td>
                    <td class="num">{formatTokens(s.peak.value)}</td>
                    <td>{s.handoff ? `${formatTokens(s.handoff.tokens.value)} · ${formatRatio(s.handoff.compressionRatio.value)}` : "—"}</td>
                    <td>{s.status}</td>
                    <td><a href={hrefFor(s.id)} onClick={(e) => { e.preventDefault(); onOpen(s.id); }}>open ›</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
