/** Minimal scales and formatters for the hand-rolled SVG charts. */
import type { Request } from "@ir/types.ts";

export interface LinearScale {
  (value: number): number;
  invert(pixel: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linear(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as LinearScale;
  scale.invert = (pixel: number) => d0 + ((pixel - r0) / ((r1 - r0) || 1)) * span;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** "Nice" tick values for a domain: 1/2/2.5/5 steps, roughly `count` ticks, never above `max`. */
export function ticks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * power);
  const step = candidates.find((c) => c >= raw) ?? candidates[candidates.length - 1];
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Integer ticks for a request-index axis. */
export function indexTicks(min: number, max: number, count = 8): number[] {
  const span = Math.max(1, max - min);
  const raw = span / count;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((s) => s >= raw) ?? steps[steps.length - 1];
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

/** Shared horizontal margins so every aligned panel puts request i at the same x. */
export const MARGIN = { left: 60, right: 20 } as const;

/**
 * Top of the y domain (ADR-002 G): `max(peak, window) × 1.08`, unrounded.
 * Tick values stay nice via `ticks()`; the top of the plot does not jump to
 * the next 1/2/5 step (989k peak with a 1M window used to render as 2.0M).
 */
export function yTop(peak: number, window = 0): number {
  return Math.max(1, Math.max(peak, window)) * 1.08;
}

/** Largest usage.total among requests[lo..hi] (loop, no spread: scopes can have 100k+ requests). */
export function maxTotal(requests: Request[], lo = 0, hi = requests.length - 1): number {
  let m = 0;
  for (let i = Math.max(0, lo); i <= Math.min(requests.length - 1, hi); i++) { const t = requests[i].usage.total; if (t > m) m = t; }
  return m;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatClockSeconds(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

/** Signed delta, compact. */
export function formatDelta(value: number, fmt: (v: number) => string): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${fmt(Math.abs(value))}`;
}

/** Nearest request index to a pixel on an x scale, clamped into the domain. */
export function nearestIndex(x: LinearScale, pixel: number): number {
  const [d0, d1] = x.domain;
  return Math.max(d0, Math.min(d1, Math.round(x.invert(pixel))));
}
