/**
 * Cache split strip: per request, stacked segments for cache read, cache
 * creation and uncached input (observed.vendor). Codex has no cacheCreation
 * field, so two segments are drawn. Model switches are marked (ADR-002 A).
 * Hover / pin / focus are read here at the leaf.
 */
import { useMemo, useRef, useCallback, useState } from "preact/hooks";
import type { Request } from "@ir/types.ts";
import { linear, yTop, maxTotal, nearestIndex, formatInt, formatPercent, type LinearScale } from "./scale.ts";
import { formatTokens } from "../categories.ts";
import { Tooltip, TooltipRow } from "./Tooltip.tsx";
import { hoveredRequest, pinnedRequest, focusedRequest } from "../session-state.ts";

/** Theme tokens (theme.css `--cache-*`, dark overrides included). */
export const CACHE_COLORS = { cacheRead: "var(--cache-read)", cacheCreation: "var(--cache-create)", uncached: "var(--cache-plain)" } as const;
export const CACHE_LABELS = { cacheRead: "Cache read", cacheCreation: "Cache creation", uncached: "Uncached input" } as const;

export interface CacheStripProps {
  requests: Request[];
  x: LinearScale;
  width: number;
  height: number;
  onHover: (index: number | null) => void;
  onPin: (index: number) => void;
}

const TOP = 4;
const BOTTOM = 4;

export function CacheStrip({ requests, x, width, height, onHover, onPin }: CacheStripProps) {
  const lo = Math.max(0, Math.floor(x.domain[0]));
  const hi = Math.min(requests.length - 1, Math.ceil(x.domain[1]));
  const hasCreation = useMemo(() => requests.some((r) => r.usage.cacheCreation !== undefined && r.usage.cacheCreation !== null), [requests]);
  const plotH = height - TOP - BOTTOM;
  const yMax = useMemo(() => yTop(maxTotal(requests, lo, hi)), [requests, lo, hi]);
  const y = useMemo(() => linear([0, yMax], [TOP + plotH, TOP]), [yMax, plotH]);
  const step = x(1) - x(0);
  const barW = Math.max(1, step - (step > 4 ? 1.5 : step > 2 ? 0.5 : 0));

  const hovered = hoveredRequest.value;
  const pinned = pinnedRequest.value;
  const focused = focusedRequest.value;

  // One path per segment kind: 3 path elements instead of 3n rects.
  const paths = useMemo(() => {
    let read = "", create = "", plain = "";
    for (let i = lo; i <= hi; i++) {
      const u = requests[i].usage;
      const cx = x(i) - barW / 2;
      const cc = u.cacheCreation ?? 0;
      const uncached = Math.max(0, u.total - u.cacheRead - cc);
      let y0 = y(0);
      const seg = (v: number) => { if (v <= 0) return ""; const y1 = y0 - (y(0) - y(v)); const d = `M${cx.toFixed(1)},${y1.toFixed(1)}h${barW.toFixed(1)}v${(y0 - y1).toFixed(1)}h${(-barW).toFixed(1)}Z`; y0 = y1; return d; };
      read += seg(u.cacheRead);
      create += seg(cc);
      plain += seg(uncached);
    }
    return { read, create, plain };
  }, [requests, x, y, lo, hi, barW]);

  const modelSwitches = useMemo(() => {
    const out: number[] = [];
    for (let i = Math.max(1, lo); i <= hi; i++) if (requests[i].model !== requests[i - 1].model) out.push(i);
    return out;
  }, [requests, lo, hi]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [inside, setInside] = useState(false);
  const onMove = useCallback((e: PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    onHover(nearestIndex(x, e.clientX - rect.left));
  }, [x, onHover]);

  const active = hovered ?? focused ?? pinned;
  const req = active !== null && active >= lo && active <= hi ? requests[active] : undefined;
  const totals = useMemo(() => {
    let read = 0, create = 0, total = 0;
    for (let i = lo; i <= hi; i++) { const u = requests[i].usage; read += u.cacheRead; create += u.cacheCreation ?? 0; total += u.total; }
    return { read, create, total };
  }, [requests, lo, hi]);

  return (
    <div class="cs-chart" style={{ height: `${height}px` }}>
      <svg ref={svgRef} width={width} height={height} class="cs-cache" role="img" aria-label={`Cache split per request: ${formatPercent(totals.read / (totals.total || 1), 0)} read from cache over the visible range.`}
        onPointerMove={onMove} onPointerEnter={() => setInside(true)} onPointerLeave={() => { setInside(false); onHover(null); }} onClick={() => { if (hovered !== null) onPin(hovered); }}>
        <text x={x.range[0] - 8} y={TOP + 10} text-anchor="end" class="cs-axis-text">{formatTokens(yMax)}</text>
        <text x={x.range[0] - 8} y={TOP + plotH} text-anchor="end" class="cs-axis-text">0</text>
        <path d={paths.read} fill={CACHE_COLORS.cacheRead} class="cs-cache-seg" />
        {hasCreation && <path d={paths.create} fill={CACHE_COLORS.cacheCreation} class="cs-cache-seg" />}
        <path d={paths.plain} fill={CACHE_COLORS.uncached} class="cs-cache-seg" />
        {modelSwitches.map((i) => <line key={`m${i}`} x1={x(i) - step / 2} x2={x(i) - step / 2} y1={TOP} y2={TOP + plotH} class="cs-model-switch"><title>Model switch at request {i}: {requests[i].model}</title></line>)}
        {req && <line x1={x(req.index)} x2={x(req.index)} y1={TOP} y2={TOP + plotH} class="cs-crosshair-line" />}
        {pinned !== null && pinned >= lo && pinned <= hi && <line x1={x(pinned)} x2={x(pinned)} y1={TOP} y2={TOP + plotH} class="cs-pin-line" />}
      </svg>
      {req && inside && hovered !== null && (
        <Tooltip x={x(req.index)} y={-4} width={width}>
          <div class="cs-tt-head"><strong>Request {req.index}</strong> <span class="cs-muted">cache split · observed</span></div>
          <TooltipRow color={CACHE_COLORS.cacheRead} label={CACHE_LABELS.cacheRead} value={formatInt(req.usage.cacheRead)} share={formatPercent(req.usage.cacheRead / (req.usage.total || 1), 0)} />
          {hasCreation && <TooltipRow color={CACHE_COLORS.cacheCreation} label={CACHE_LABELS.cacheCreation} value={formatInt(req.usage.cacheCreation ?? 0)} share={formatPercent((req.usage.cacheCreation ?? 0) / (req.usage.total || 1), 0)} />}
          <TooltipRow color={CACHE_COLORS.uncached} label={CACHE_LABELS.uncached} value={formatInt(Math.max(0, req.usage.total - req.usage.cacheRead - (req.usage.cacheCreation ?? 0)))} share={formatPercent(Math.max(0, req.usage.total - req.usage.cacheRead - (req.usage.cacheCreation ?? 0)) / (req.usage.total || 1), 0)} />
          {req.deltaCheck !== undefined && <div class="cs-tt-foot cs-muted">delta check {req.deltaCheck >= 0 ? "+" : ""}{formatInt(req.deltaCheck)} tok vs new blocks</div>}
        </Tooltip>
      )}
    </div>
  );
}
