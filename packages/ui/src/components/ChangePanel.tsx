import type { Change, ChangeMeasure, ChangeMetricKey, ChangeNote } from "@ir/types.ts";
import { Badge } from "./Badge.tsx";
import { formatDate, formatNumber, formatTokens, plural } from "../format.ts";

/** ADR-005 §1 metric table, in display order; copy matches `index/changes.mjs` METRICS. */
const METRICS: Array<{ key: ChangeMetricKey; label: string; unit: "tokens" | "ratio" | "per-hour" | "count"; hint: string }> = [
  { key: "startupH0", label: "Startup H0", unit: "tokens", hint: "Hidden base of request 0 (chars-per-token estimate)" },
  { key: "peakShare", label: "Peak share of window", unit: "ratio", hint: "Observed peak context ÷ the model window" },
  { key: "compactionsPerHour", label: "Compactions per active hour", unit: "per-hour", hint: "Compactions of the session and its subagents ÷ active hours" },
  { key: "processedInputTokens", label: "Processed input tokens per session", unit: "tokens", hint: "Vendor usage fields, session + subagents" },
  { key: "fatResults", label: "Fat results per session", unit: "count", hint: "Tool results above the fat threshold (local estimate)" },
  { key: "handoffRatio", label: "Subagent handoff ratio", unit: "ratio", hint: "Median compression ratio of subagent handoffs, weighted by runs" },
];

/** "n small" below this per side; the interval exists only from here (ADR-005 §1). */
export const MIN_INTERVAL_N = 5;
/** The Findings card needs at least this many sessions per side to say anything. */
export const MIN_CARD_N = 2;

function cell(unit: (typeof METRICS)[number]["unit"], value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (unit === "tokens") return formatTokens(value);
  if (unit === "ratio") return `${value.toFixed(2)}x`;
  return formatNumber(Math.round(value * 100) / 100);
}

function peakCell(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function measure(metric: (typeof METRICS)[number], m: ChangeMeasure | undefined) {
  if (!m) return "—";
  return metric.key === "peakShare" ? peakCell(m.value) : cell(metric.unit, m.value);
}

function deltaText(metric: (typeof METRICS)[number], change: Change): { text: string; excludesZero: boolean } {
  const delta = change.delta[metric.key];
  if (delta === undefined) return { text: "—", excludesZero: false };
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const magnitude = metric.key === "peakShare" ? `${Math.round(Math.abs(delta) * 100)} pts` : cell(metric.unit, Math.abs(delta));
  const ratio = change.delta[`${metric.key}Ratio`];
  const ci = change.ci?.[metric.key];
  let text = `${sign}${magnitude}`;
  if (ratio !== undefined) text += ` (${ratio.toFixed(2)}x)`;
  if (ci) text += ` · 90% [${metric.key === "peakShare" ? peakCell(ci.low) : cell(metric.unit, ci.low)}, ${metric.key === "peakShare" ? peakCell(ci.high) : cell(metric.unit, ci.high)}]`;
  return { text, excludesZero: Boolean(ci && (ci.low > 0 || ci.high < 0)) };
}

export function anchorLabel(change: Pick<Change, "anchor" | "commit">): string {
  if (change.anchor === "commit") return change.commit ? `commit ${change.commit}` : "commit";
  if (change.anchor === "experiment") return "experiment candidate";
  return "file modified";
}

export interface ChangePanelProps { change: Change; /** Compact: the table only (Findings card). */ compact?: boolean }

/**
 * The paired table of one Change (metric · before · after · delta · n), the
 * rule rows, the caveats line and the confound badge. No colour on deltas:
 * a delta whose interval excludes zero is bold, never green (ADR-005 §9).
 */
export function ChangePanel({ change, compact }: ChangePanelProps) {
  const smallN = change.n.before < MIN_INTERVAL_N || change.n.after < MIN_INTERVAL_N;
  return (
    <div class={`change-panel ${compact ? "change-compact" : ""}`} data-change-file={change.file}>
      <p class="change-head">
        <span>Since <code>{change.file}</code> · {anchorLabel(change)} <time dateTime={change.at}>{formatDate(change.at)}</time></span>
        <span class="change-n">{plural(change.n.after, "session")} after vs {change.n.before} before{change.n.afterObserved ? <> · {change.n.afterObserved} observed loading it</> : null}{change.n.unverified ? <> · {change.n.unverified} unverified</> : null}</span>
        {change.confounds.confounded
          ? <Badge label="confounded" tone="warn" title={change.confounds.reason} />
          : <Badge label="no model/CLI confound" tone="neutral" title="Same dominant model and the same CLI version set on both sides" />}
        {smallN ? <Badge label="n small" tone="neutral" title={`Fewer than ${MIN_INTERVAL_N} sessions on a side: no interval`} /> : null}
      </p>
      <div class="table-wrap">
        <table class="change-table">
          <thead><tr><th scope="col">Metric</th><th scope="col" class="num">Before</th><th scope="col" class="num">After</th><th scope="col" class="num">Delta (after − before)</th><th scope="col" class="num">n</th></tr></thead>
          <tbody>
            {METRICS.map((metric) => {
              const before = change.before[metric.key];
              const after = change.after[metric.key];
              const delta = deltaText(metric, change);
              const provenance = after?.provenance ?? before?.provenance;
              return (
                <tr key={metric.key}>
                  <th scope="row"><span title={metric.hint}>{metric.label}</span> {provenance ? <Badge provenance={provenance} /> : null}</th>
                  <td class="num">{measure(metric, before)}</td>
                  <td class="num">{measure(metric, after)}</td>
                  <td class={`num ${delta.excludesZero ? "change-delta-strong" : ""}`}>{delta.text}</td>
                  <td class="num muted">{before?.n ?? 0} / {after?.n ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!compact && change.findingsByRule.length ? (
        <div class="table-wrap">
          <table class="change-table change-rules">
            <thead><tr><th scope="col">Rule</th><th scope="col" class="num">Before</th><th scope="col" class="num">After</th></tr></thead>
            <tbody>
              {change.findingsByRule.map((row) => (
                <tr key={row.ruleId}>
                  <th scope="row"><code>{row.ruleId}</code> {row.title}</th>
                  <td class="num">{row.before.sessions}/{row.before.of}</td>
                  <td class="num">{row.after.sessions}/{row.after.of}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p class="change-caveats muted">{change.caveats.join(" · ")}</p>
    </div>
  );
}

/** The one muted line for a file with no pairable window ("edited Sep 2: no session since"). */
export function ChangeNoteLine({ note }: { note: ChangeNote }) {
  return <p class="change-note muted">{note.reason}</p>;
}
