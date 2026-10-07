/**
 * Occupancy chart: stacked areas by category (estimated.local, reconciled),
 * a thin exact-total line on top (observed.vendor), the context window line,
 * the auto-compaction threshold line (live forecast; dotted, distinct from the
 * window), compaction markers, base-step markers (reconciliation v2), hover crosshair
 * + tooltip, click to pin. Hover / pin / focus signals are read here, at the
 * leaf, so a hover frame re-renders this component only.
 */
import { useMemo, useState, useCallback, useRef } from "preact/hooks";
import type { Category, Compaction, Measured, Request } from "@ir/types.ts";
import { CATEGORY_META, STACK_ORDER, formatTokens } from "../categories.ts";
import { linear, ticks, yTop, maxTotal, nearestIndex, formatClockSeconds, formatPercent, formatInt, type LinearScale } from "./scale.ts";
import { Tooltip, TooltipRow } from "./Tooltip.tsx";
import { hoveredRequest, pinnedRequest, focusedRequest, hoveredLane } from "../session-state.ts";

export interface BaseStep { atRequest: number; delta: number }

export interface StackedAreaProps {
  requests: Request[];
  compactions: Compaction[];
  window: Measured;
  hidden: ReadonlySet<Category>;
  showStack: boolean;
  x: LinearScale;
  width: number;
  height: number;
  /** Launch request index per child lane id; the hovered lane's launch is drawn as a marker. */
  laneLaunches?: ReadonlyMap<string, number>;
  /** Persistent steps in the hidden (unlogged) base, drawn as dotted verticals with a label. */
  baseSteps?: BaseStep[];
  /** Auto-compaction threshold (forecast): a second horizontal line under the window line. */
  threshold?: Measured;
  onHover: (index: number | null) => void;
  onPin: (index: number) => void;
}

const TOP = 14;
const BOTTOM = 6;

interface Layer { category: Category; path: string; color: string }

function buildLayers(requests: Request[], order: Category[], x: LinearScale, y: LinearScale, lo: number, hi: number): Layer[] {
  const n = hi - lo + 1;
  const base = new Float64Array(n);
  const layers: Layer[] = [];
  for (const category of order) {
    const top = new Float64Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const v = requests[lo + i].composition[category] ?? 0;
      if (v > 0) any = true;
      top[i] = base[i] + v;
    }
    if (any) {
      let d = "";
      for (let i = 0; i < n; i++) d += `${i === 0 ? "M" : "L"}${x(lo + i).toFixed(1)},${y(top[i]).toFixed(1)}`;
      for (let i = n - 1; i >= 0; i--) d += `L${x(lo + i).toFixed(1)},${y(base[i]).toFixed(1)}`;
      layers.push({ category, path: d + "Z", color: CATEGORY_META[category].color });
    }
    base.set(top);
  }
  return layers;
}

export function StackedArea(props: StackedAreaProps) {
  const { requests, compactions, window: win, hidden, showStack, x, width, height, onHover, onPin, threshold } = props;
  const lo = Math.max(0, Math.floor(x.domain[0]));
  const hi = Math.min(requests.length - 1, Math.ceil(x.domain[1]));
  const plotH = height - TOP - BOTTOM;

  const hovered = hoveredRequest.value;
  const pinned = pinnedRequest.value;
  const focused = focusedRequest.value;
  const hotLane = hoveredLane.value;
  const launchMarker = hotLane !== null ? props.laneLaunches?.get(hotLane) : undefined;

  const scopePeak = useMemo(() => maxTotal(requests), [requests]);
  const yMax = useMemo(() => yTop(maxTotal(requests, lo, hi), Math.max(win.value, threshold?.value ?? 0)), [requests, lo, hi, win.value, threshold?.value]);
  const y = useMemo(() => linear([0, yMax], [TOP + plotH, TOP]), [yMax, plotH]);

  const order = useMemo(() => STACK_ORDER.filter((c) => !hidden.has(c)), [hidden]);
  const layers = useMemo(() => (showStack && hi >= lo ? buildLayers(requests, order, x, y, lo, hi) : []), [requests, order, x, y, lo, hi, showStack]);
  const totalPath = useMemo(() => {
    let d = "";
    for (let i = lo; i <= hi; i++) d += `${i === lo ? "M" : "L"}${x(i).toFixed(1)},${y(requests[i].usage.total).toFixed(1)}`;
    return d;
  }, [requests, x, y, lo, hi]);
  const yTicks = useMemo(() => ticks(0, yMax, Math.max(2, Math.floor(plotH / 48))), [yMax, plotH]);
  const ariaLabel = useMemo(() => `Context occupancy by category across ${requests.length} requests; peak ${formatTokens(scopePeak)} tokens; window ${formatTokens(win.value)}.`, [requests.length, scopePeak, win.value]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pointer, setPointer] = useState<{ px: number; py: number } | null>(null);
  const [stepTip, setStepTip] = useState<number | null>(null);

  const onMove = useCallback((e: PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setPointer({ px, py });
    onHover(nearestIndex(x, px));
  }, [x, onHover]);
  const onLeave = useCallback(() => { setPointer(null); onHover(null); }, [onHover]);

  const active = hovered ?? focused ?? pinned;
  const activeReq = active !== null ? requests[active] : undefined;
  const tooltipIndex = hovered ?? (pointer ? null : focused ?? pinned);
  const ttReq = tooltipIndex !== null && tooltipIndex !== undefined ? requests[tooltipIndex] : undefined;

  const rows = useMemo(() => {
    if (!ttReq) return [];
    const total = ttReq.usage.total || 1;
    return STACK_ORDER.map((c) => ({ category: c, value: ttReq.composition[c] ?? 0 })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value)
      .map((r) => ({ ...r, share: r.value / total, hidden: hidden.has(r.category) }));
  }, [ttReq, hidden]);

  const steps = useMemo(() => (props.baseSteps ?? []).filter((s) => s.atRequest >= lo && s.atRequest <= hi), [props.baseSteps, lo, hi]);
  const stepFor = stepTip !== null ? steps.find((s) => s.atRequest === stepTip) : undefined;

  return (
    <div class="cs-chart" style={{ height: `${height}px` }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        class="cs-area"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onClick={() => { if (hovered !== null) onPin(hovered); }}
      >
        <defs>
          <pattern id="cs-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" class="cs-hatch-bg" />
            <line x1="0" y1="0" x2="0" y2="6" class="cs-hatch-line" />
          </pattern>
        </defs>
        <g class="cs-grid">
          {yTicks.map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={x.range[0]} x2={x.range[1]} class="cs-gridline" />
              <text x={x.range[0] - 8} dy="0.32em" text-anchor="end" class="cs-axis-text">{formatTokens(t)}</text>
            </g>
          ))}
        </g>
        <g class="cs-layers">
          {layers.map((l) => <path key={l.category} d={l.path} fill={l.color} class="cs-layer" data-category={l.category} />)}
        </g>
        <path d={totalPath} class="cs-total-line" />
        {win.value > 0 && win.value <= yMax && (
          <g transform={`translate(0,${y(win.value)})`}>
            <line x1={x.range[0]} x2={x.range[1]} class="cs-window-line" />
            <text x={x.range[1]} y={-4} text-anchor="end" class="cs-axis-text cs-window-label">window {formatTokens(win.value)} ({win.provenance === "observed.vendor" ? "vendor" : "estimated"})</text>
          </g>
        )}
        {threshold && threshold.value > 0 && threshold.value <= yMax && (
          <g transform={`translate(0,${y(threshold.value)})`} class="cs-threshold">
            <line x1={x.range[0]} x2={x.range[1]} class="cs-threshold-line" />
            <text x={x.range[1]} y={12} text-anchor="end" class="cs-axis-text cs-threshold-label">auto-compaction ~{formatTokens(threshold.value)} ({threshold.provenance === "estimated.local" ? "estimated" : threshold.provenance === "observed.vendor" ? "observed" : "derived"})</text>
          </g>
        )}
        {compactions.filter((c) => c.atRequest >= lo && c.atRequest <= hi).map((c) => {
          const cx = x(c.atRequest) - (x(1) - x(0)) / 2;
          return (
            <g key={c.id} transform={`translate(${cx.toFixed(1)},0)`} class="cs-compaction">
              <line y1={TOP} y2={TOP + plotH} class="cs-compaction-line" />
              <text y={TOP - 3} x={4} class="cs-axis-text cs-compaction-label">{formatTokens(c.preTokens.value)} → {formatTokens(c.postTokens.value)}</text>
            </g>
          );
        })}
        {steps.map((s) => (
          <g key={`s${s.atRequest}`} transform={`translate(${x(s.atRequest).toFixed(1)},0)`} class="cs-step"
            onPointerEnter={() => setStepTip(s.atRequest)} onPointerLeave={() => setStepTip(null)}>
            <line y1={TOP} y2={TOP + plotH} class="cs-step-line" />
            <rect x={-4} y={TOP} width={8} height={plotH} class="cs-step-hit" />
            <text y={TOP + plotH - 4} x={3} class="cs-step-label">{s.delta >= 0 ? "+" : "−"}{formatTokens(Math.abs(s.delta))}</text>
          </g>
        ))}
        {launchMarker !== undefined && launchMarker >= lo && launchMarker <= hi && (
          <line x1={x(launchMarker)} x2={x(launchMarker)} y1={TOP} y2={TOP + plotH} class="cs-launch-line" />
        )}
        {pinned !== null && pinned >= lo && pinned <= hi && (
          <g transform={`translate(${x(pinned)},0)`} class="cs-pin">
            <line y1={TOP} y2={TOP + plotH} class="cs-pin-line" />
            <circle cy={y(requests[pinned].usage.total)} r={4.5} class="cs-pin-dot" />
          </g>
        )}
        {activeReq && active !== null && active >= lo && active <= hi && (
          <g transform={`translate(${x(active)},0)`} class="cs-crosshair">
            <line y1={TOP} y2={TOP + plotH} class="cs-crosshair-line" />
            <circle cy={y(activeReq.usage.total)} r={4} class="cs-crosshair-dot" />
          </g>
        )}
      </svg>
      {stepFor && !ttReq && (
        <Tooltip x={x(stepFor.atRequest)} y={TOP + 8} width={width}>
          <div class="cs-tt-head"><strong>Base step at request {stepFor.atRequest}</strong></div>
          <div>{stepFor.delta >= 0 ? "+" : "−"}{formatInt(Math.abs(stepFor.delta))} tokens of unlogged input {stepFor.delta >= 0 ? "entered" : "left"} the prompt here and stayed.</div>
          <div class="cs-tt-foot cs-muted">Detected from a persistent residual between the vendor total and the estimated stack (derived).</div>
        </Tooltip>
      )}
      {ttReq && (
        <Tooltip x={x(ttReq.index)} y={Math.min(Math.max(8, (pointer?.py ?? 40) - 20), height - 40)} width={width}>
          <div class="cs-tt-head">
            <strong>Request {ttReq.index}</strong> <span class="cs-muted">{formatClockSeconds(ttReq.at)} · turn {ttReq.turn} · {ttReq.model}</span>
          </div>
          <TooltipRow label="Total (observed)" value={formatInt(ttReq.usage.total)} share={formatPercent(ttReq.usage.total / (win.value || 1), 0) + " of window"} />
          {showStack ? rows.slice(0, 12).map((r) => (
            <TooltipRow key={r.category} color={CATEGORY_META[r.category].color} hatch={r.category === "unlogged"} label={CATEGORY_META[r.category].short + (r.hidden ? " (hidden)" : "")} value={formatInt(r.value)} share={formatPercent(r.share, 0)} dim={r.hidden} />
          )) : <div class="cs-muted">Composition hidden: estimator error too high.</div>}
          {ttReq.compactionBefore && <div class="cs-muted">Compaction before this request</div>}
          <div class="cs-tt-foot cs-muted">{pinned === ttReq.index ? "Pinned · Esc unpins" : "Click or press p to pin"}</div>
        </Tooltip>
      )}
    </div>
  );
}
