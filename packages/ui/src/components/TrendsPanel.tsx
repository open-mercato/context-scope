import { useMemo, useState } from "preact/hooks";
import type { Overview } from "@ir/types.ts";
import { formatDay, formatNumber, formatTokens, percent } from "../format.ts";
import { CLI_COMMAND } from "../config.ts";
import { Badge } from "./Badge.tsx";
import { Panel } from "./Panel.tsx";

type Trends = Overview["trends"];

interface Series {
  key: string;
  label: string;
  values: number[];
  /** Format for the tooltip and the headline value. */
  format: (value: number) => string;
  /** CSS colour token for the line. */
  color: string;
  provenance: "observed.vendor" | "derived.exact" | "estimated.local";
  hint: string;
  /** Vertical markers (instruction-file edits) drawn on this chart only. */
  markers?: Array<{ path: string; at: string; index: number }>;
}

const W = 260;
const H = 72;
const PAD_X = 6;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;

function lastNonZero(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i]) return values[i];
  return 0;
}

/**
 * One line per day; a crosshair + tooltip on hover, arrow keys on focus; a
 * visually hidden table carries every day's value for screen readers (#14).
 */
function TrendChart({ series, days }: { series: Series; days: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = series.values.length;
  const geometry = useMemo(() => {
    const max = Math.max(1e-9, ...series.values);
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_TOP - PAD_BOTTOM;
    const x = (i: number) => PAD_X + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
    const y = (v: number) => PAD_TOP + innerH - (v / max) * innerH;
    const path = series.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const baseY = PAD_TOP + innerH;
    return { x, y, path, baseY, max };
  }, [series.values, n]);
  if (n < 2) return <p class="muted trend-empty">Not enough days yet.</p>;
  const latest = lastNonZero(series.values);
  const indexAt = (clientX: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const px = ratio * W;
    return Math.max(0, Math.min(n - 1, Math.round(((px - PAD_X) / (W - PAD_X * 2)) * (n - 1))));
  };
  const onMove = (event: MouseEvent) => setHover(indexAt(event.clientX, event.currentTarget as SVGSVGElement));
  const onTouch = (event: TouchEvent) => { const t = event.touches[0]; if (t) setHover(indexAt(t.clientX, event.currentTarget as SVGSVGElement)); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (event.key === "ArrowLeft" ? -1 : 1)))); }
    else if (event.key === "Home") { event.preventDefault(); setHover(0); }
    else if (event.key === "End") { event.preventDefault(); setHover(n - 1); }
    else if (event.key === "Escape") setHover(null);
  };
  const hoverMarker = hover !== null ? series.markers?.filter((m) => m.index === hover) ?? [] : [];
  const tableId = `trend-table-${series.key}`;
  return (
    <figure class="trend">
      <figcaption class="trend-head">
        <span class="trend-label">{series.label}</span>
        <span class="trend-value" title={series.hint}>{series.format(latest)}</span>
        <Badge provenance={series.provenance} />
      </figcaption>
      <div class="trend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} class="trend-svg" role="img" tabIndex={0} aria-label={`${series.label}, ${n} days, latest ${series.format(latest)}; arrow keys read each day`} aria-describedby={tableId}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} onTouchStart={onTouch} onTouchMove={onTouch} onKeyDown={onKey} onBlur={() => setHover(null)} style={{ "--trend-color": series.color }}>
          <title>{`${series.label}: ${n} days, latest ${series.format(latest)}`}</title>
          <line x1={PAD_X} x2={W - PAD_X} y1={geometry.baseY} y2={geometry.baseY} class="trend-base" />
          {series.markers?.map((m) => (
            <g key={`${m.path}@${m.at}`} class="trend-marker">
              <line x1={geometry.x(m.index)} x2={geometry.x(m.index)} y1={PAD_TOP - 4} y2={geometry.baseY} />
              <path d={`M${(geometry.x(m.index) - 4).toFixed(1)},${PAD_TOP - 8} L${(geometry.x(m.index) + 4).toFixed(1)},${PAD_TOP - 8} L${geometry.x(m.index).toFixed(1)},${PAD_TOP - 2} Z`} />
            </g>
          ))}
          <path d={geometry.path} class="trend-line" fill="none" />
          {hover !== null ? (
            <g class="trend-cross">
              <line x1={geometry.x(hover)} x2={geometry.x(hover)} y1={PAD_TOP - 2} y2={geometry.baseY} />
              <circle cx={geometry.x(hover)} cy={geometry.y(series.values[hover])} r={4} />
            </g>
          ) : null}
        </svg>
        {hover !== null ? (
          <div class="trend-tip" role="tooltip" aria-hidden="true" style={{ left: `${(geometry.x(hover) / W) * 100}%` }}>
            <div class="trend-tip-day">{formatDay(days[hover])}</div>
            <div class="trend-tip-value">{series.format(series.values[hover])}</div>
            {hoverMarker.map((m) => <div key={m.path} class="trend-tip-edit">edited {m.path}</div>)}
          </div>
        ) : null}
        <table class="visually-hidden" id={tableId}>
          <caption>{series.label} by day</caption>
          <tbody>{days.map((d, i) => <tr key={d}><th scope="row">{formatDay(d)}</th><td>{series.format(series.values[i])}</td></tr>)}</tbody>
        </table>
        <div class="visually-hidden" aria-live="polite">{hover !== null ? `${formatDay(days[hover])}: ${series.format(series.values[hover])}` : ""}</div>
      </div>
    </figure>
  );
}

/**
 * Per-repo daily trends (ADR-003 §2): sessions, median peak share, compactions
 * per session, and startup base (hidden base of request 0) with markers on the
 * days an instruction file was edited. Series the companion does not report
 * are not drawn as zero lines; the panel says which are missing and why (#9).
 */
export function TrendsPanel({ trends, repoName, rangeLabel }: { trends: Trends; repoName?: string; rangeLabel?: string }) {
  const days = trends.days ?? [];
  const hasSessions = Array.isArray(trends.sessions);
  const hasPeak = Array.isArray(trends.peakShareMedian);
  const hasStartup = Array.isArray(trends.startupH0Median);
  const sessions = trends.sessions ?? [];
  const compactionsPerSession = hasSessions ? days.map((_, i) => (sessions[i] ? (trends.compactions?.[i] ?? 0) / sessions[i] : 0)) : null;
  const markers = (trends.instructionEdits ?? [])
    .map((edit) => ({ path: edit.path, at: edit.at, index: days.indexOf(edit.at.slice(0, 10)) }))
    .filter((m) => m.index >= 0);
  const totalSessions = sessions.reduce((a, b) => a + b, 0);
  const series: Series[] = [];
  if (hasSessions) series.push({ key: "sessions", label: "Sessions per day", values: sessions, format: (v) => formatNumber(v), color: "var(--series-1)", provenance: "observed.vendor", hint: "Top-level sessions that ended on that day" });
  if (hasPeak) series.push({ key: "peak", label: "Median peak share of window", values: trends.peakShareMedian ?? [], format: (v) => percent(v), color: "var(--series-2)", provenance: "derived.exact", hint: "Median over the day's sessions of peak occupancy ÷ context window" });
  if (compactionsPerSession) series.push({ key: "compactions", label: "Compactions per session", values: compactionsPerSession, format: (v) => v.toFixed(1), color: "var(--series-4)", provenance: "observed.vendor", hint: "Compaction boundaries ÷ sessions that day" });
  if (hasStartup) series.push({ key: "startup", label: "Startup base (request 0)", values: trends.startupH0Median ?? [], format: (v) => `${formatTokens(v)} tok`, color: "var(--series-3)", provenance: "estimated.local", hint: "Median hidden base at request 0: system prompt, instructions, unlogged mass. Estimated locally.", markers });
  const missing = [!hasSessions && "sessions per day", !hasPeak && "median peak share", !hasSessions && "compactions per session", !hasStartup && "startup base"].filter(Boolean) as string[];
  const allZero = series.length > 0 && totalSessions === 0;
  // Trends always cover the companion's trailing window, whatever the range selector says; the description says so.
  const daysLabel = `last ${days.length} days${rangeLabel && rangeLabel !== `last ${days.length} days` ? ` (the table shows ${rangeLabel})` : ""}`;
  return (
    <Panel
      title="Trends"
      description={`${repoName ? `${repoName} · ` : ""}${daysLabel}${hasSessions ? ` · ${plural(totalSessions)}` : ""}${markers.length ? ` · ${markers.length} instruction edit${markers.length === 1 ? "" : "s"} marked` : ""}`}
      class="trends-panel"
    >
      {series.length === 0 ? (
        <p class="muted trend-empty">This companion does not report per-repo trends yet. Update it with <code>{CLI_COMMAND}@latest</code> and refresh the index.</p>
      ) : allZero ? (
        <p class="muted trend-empty">No sessions of this repository ended in this range; the trend lines have nothing to show yet.</p>
      ) : (
        <div class="trend-grid">
          {series.map((s) => <TrendChart key={s.key} series={s} days={days} />)}
        </div>
      )}
      {series.length > 0 && missing.length ? <p class="muted trend-empty">Not reported by this companion: {missing.join(", ")} (update with <code>{CLI_COMMAND}@latest</code>).</p> : null}
      {markers.length ? (
        <ul class="trend-edits" aria-label="Instruction file edits">
          {markers.slice(-5).map((m) => <li key={`${m.path}@${m.at}`}><span class="trend-edit-mark" aria-hidden="true" /> <code>{m.path}</code> <span class="muted">{formatDay(m.at)}</span></li>)}
        </ul>
      ) : null}
    </Panel>
  );
}

function plural(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? "session" : "sessions"}`;
}
