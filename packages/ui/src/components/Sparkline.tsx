import { formatTokens } from "../format.ts";

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Colour for the current (last) point; the line itself uses the de-emphasis hue. */
  accent?: string;
  /** Accessible description prefix, e.g. "Processed input tokens, last 30 days". */
  label?: string;
}

/**
 * Tiny inline SVG line. Line in the muted hue, last point in the accent (dataviz
 * stat-tile contract), baseline area very faint. No axes; the tile carries the value.
 */
export function Sparkline({ values, width = 112, height = 30, accent, label }: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  let max = -Infinity, min = 0;
  for (const v of clean) { if (v > max) max = v; if (v < min) min = v; }
  const span = max - min || 1;
  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const step = innerW / (clean.length - 1);
  const points = clean.map((v, i) => [padX + i * step, padY + innerH - ((v - min) / span) * innerH] as const);
  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const baseY = padY + innerH - ((0 - min) / span) * innerH;
  const area = `${path} L${points[points.length - 1][0].toFixed(1)},${baseY.toFixed(1)} L${points[0][0].toFixed(1)},${baseY.toFixed(1)} Z`;
  const last = points[points.length - 1];
  const description = `${label ?? "Trend"}: ${clean.length} points, latest ${formatTokens(clean[clean.length - 1])}, peak ${formatTokens(max)}`;
  return (
    <svg class="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={accent ? { "--spark-accent": accent } : undefined}>
      <title>{description}</title>
      <path d={area} class="sparkline-area" />
      <path d={path} class="sparkline-line" fill="none" />
      <circle cx={last[0]} cy={last[1]} r={2.5} class="sparkline-dot" />
    </svg>
  );
}
