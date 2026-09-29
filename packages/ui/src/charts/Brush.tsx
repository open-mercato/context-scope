/**
 * Range brush under the occupancy chart. Shows the exact-total line for the
 * whole scope; drag to select a request range, drag the selection to move it,
 * drag a handle to resize, double-click to reset. Emits inclusive indexes.
 * With no range the selection rect is inert so a drag on the background
 * creates a range instead of "moving" a full-width selection to nowhere.
 * Handles are focusable: arrow keys nudge by 1 (Shift: 10), Delete resets.
 */
import { useMemo, useRef, useState, useCallback } from "preact/hooks";
import type { Request } from "@ir/types.ts";
import { linear, yTop, maxTotal, MARGIN } from "./scale.ts";

export interface BrushProps {
  requests: Request[];
  width: number;
  height: number;
  range: [number, number] | null;
  onChange: (range: [number, number] | null) => void;
}

type Drag = { kind: "new" | "move" | "left" | "right"; startPx: number; startRange: [number, number] };

export function Brush({ requests, width, height, range, onChange }: BrushProps) {
  const n = requests.length;
  const x = useMemo(() => linear([0, Math.max(1, n - 1)], [MARGIN.left, width - MARGIN.right]), [n, width]);
  const yMax = useMemo(() => yTop(maxTotal(requests)), [requests]);
  const y = useMemo(() => linear([0, yMax], [height - 2, 2]), [yMax, height]);
  const path = useMemo(() => {
    let d = "";
    for (let i = 0; i < n; i++) d += `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(requests[i].usage.total).toFixed(1)}`;
    return d;
  }, [requests, x, y, n]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [preview, setPreviewState] = useState<[number, number] | null>(null);
  // Refs mirror the state so pointerup sees the latest values even when move and up land in one tick.
  const dragRef = useRef<Drag | null>(null);
  const previewRef = useRef<[number, number] | null>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };
  const setPreview = (p: [number, number] | null) => { previewRef.current = p; setPreviewState(p); };
  const hasSelection = !!(preview ?? range);
  const shown: [number, number] = preview ?? range ?? [0, Math.max(0, n - 1)];
  const toIndex = (px: number) => Math.max(0, Math.min(n - 1, Math.round(x.invert(px))));

  const localX = (e: PointerEvent) => { const r = svgRef.current?.getBoundingClientRect(); return r ? e.clientX - r.left : 0; };
  const onDown = useCallback((kind: Drag["kind"]) => (e: PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const px = localX(e);
    const start: [number, number] = range ?? [0, Math.max(0, n - 1)];
    setDrag({ kind, startPx: px, startRange: kind === "new" ? [toIndex(px), toIndex(px)] : start });
  }, [range, n, x]);
  const onMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const px = localX(e);
    const idx = toIndex(px);
    const [a, b] = drag.startRange;
    let next: [number, number];
    if (drag.kind === "new") next = idx >= drag.startRange[0] ? [drag.startRange[0], idx] : [idx, drag.startRange[0]];
    else if (drag.kind === "left") next = [Math.min(idx, b), b];
    else if (drag.kind === "right") next = [a, Math.max(idx, a)];
    else { const delta = toIndex(px) - toIndex(drag.startPx); const span = b - a; const lo = Math.max(0, Math.min(n - 1 - span, a + delta)); next = [lo, lo + span]; }
    setPreview(next);
  }, [n, x]);
  const onUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const result = previewRef.current;
    setDrag(null); setPreview(null);
    if (!result) return;
    if (result[0] === 0 && result[1] === n - 1) onChange(null);
    else if (result[1] - result[0] < 2 && drag.kind === "new") { /* click without drag: ignore */ }
    else onChange(result);
  }, [n, onChange]);

  const nudge = (side: "left" | "right") => (e: KeyboardEvent) => {
    const cur = range ?? [0, Math.max(0, n - 1)];
    const stepSize = e.shiftKey ? 10 : 1;
    let next: [number, number] | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const d = e.key === "ArrowLeft" ? -stepSize : stepSize;
      next = side === "left" ? [Math.max(0, Math.min(cur[1], cur[0] + d)), cur[1]] : [cur[0], Math.min(n - 1, Math.max(cur[0], cur[1] + d))];
    } else if (e.key === "Delete" || e.key === "Backspace") next = null;
    else return;
    e.preventDefault();
    onChange(next && next[0] === 0 && next[1] === n - 1 ? null : next);
  };

  const sx0 = x(shown[0]), sx1 = x(shown[1]);
  return (
    <svg ref={svgRef} width={width} height={height} class={`cs-brush${drag ? " cs-brush-dragging" : ""}`} role="group" aria-label="Zoom range over requests: drag to select, handles nudge with arrow keys"
      onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDblClick={() => onChange(null)}>
      <rect x={MARGIN.left} y={0} width={Math.max(0, width - MARGIN.left - MARGIN.right)} height={height} class="cs-brush-bg" onPointerDown={onDown("new")} />
      <path d={path} class="cs-brush-line" />
      <rect x={Math.min(sx0, sx1)} y={0} width={Math.max(2, Math.abs(sx1 - sx0))} height={height} class={`cs-brush-sel${hasSelection ? "" : " cs-brush-sel-none"}`} onPointerDown={hasSelection ? onDown("move") : undefined} />
      <rect x={sx0 - 4} y={0} width={8} height={height} class="cs-brush-handle" tabIndex={0} role="slider" aria-label="Range start" aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={shown[0]} onPointerDown={onDown("left")} onKeyDown={nudge("left")} />
      <rect x={sx1 - 4} y={0} width={8} height={height} class="cs-brush-handle" tabIndex={0} role="slider" aria-label="Range end" aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={shown[1]} onPointerDown={onDown("right")} onKeyDown={nudge("right")} />
      <text x={MARGIN.left - 8} y={height / 2} dy="0.32em" text-anchor="end" class="cs-axis-text">zoom</text>
      {hasSelection && <text x={width - MARGIN.right} y={height - 4} text-anchor="end" class="cs-axis-text">{shown[0]}–{shown[1]} · double-click resets</text>}
    </svg>
  );
}
