import type { ComponentChildren } from "preact";
import type { Provenance } from "@ir/types.ts";
import { formatTokens } from "../format.ts";
import { Badge } from "./Badge.tsx";
import { Sparkline } from "./Sparkline.tsx";

export interface StatTileProps {
  label: string;
  /** Numbers are compacted with formatTokens; strings render as given (e.g. "34%"). */
  value: number | string;
  hint?: ComponentChildren;
  provenance?: Provenance;
  /** Optional trend series (e.g. last 30 days); rendered as a sparkline. */
  trend?: number[];
  /** Accent colour for the sparkline's current point. */
  accent?: string;
  /** Extra title on the value (full number). */
  title?: string;
}

/** KPI tile: label, big proportional-figure value, hint, provenance badge, optional sparkline. */
export function StatTile({ label, value, hint, provenance, trend, accent, title }: StatTileProps) {
  const display = typeof value === "number" ? formatTokens(value) : value;
  const fullValue = typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : undefined;
  return (
    <div class="stat-tile" role="listitem">
      <div class="stat-label">{label}</div>
      <div class="stat-row">
        <div class="stat-value" title={title ?? fullValue} aria-label={fullValue && fullValue !== display ? `${label}: ${fullValue}` : undefined}>{display}</div>
        {trend && trend.length > 1 ? <Sparkline values={trend} accent={accent} label={`${label}, trend`} /> : null}
      </div>
      <div class="stat-foot">
        {hint ? <span class="stat-hint">{hint}</span> : null}
        {provenance ? <Badge provenance={provenance} /> : null}
      </div>
    </div>
  );
}
