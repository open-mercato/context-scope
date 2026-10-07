/**
 * "Live now" hero on the overview: one row per session whose transcript is
 * growing right now, with how full its window is. Sources: the SSE fold
 * (`liveRuns`, authoritative once an event arrived) and the `live` marker the
 * overview rows carried when fetched; both go through the same staleness guard
 * as the row badge. A live run outside the current scope still shows, by vendor
 * and short id, so the developer always sees the session they are sitting in.
 */
import type { OverviewRun } from "@ir/types.ts";
import { useTick } from "../hooks.ts";
import { hrefs, splitRunId } from "../router.ts";
import { activeLiveRuns, liveIdle, type LiveInfo } from "../store.ts";
import { formatDate, formatNumber, formatRelative, formatTokens, percent } from "../format.ts";
import { Panel } from "./Panel.tsx";
import { STALE_MS, formatAgo } from "./LiveBadge.tsx";

type Row = OverviewRun & { parentRunId?: string; agentType?: string; gitBranch?: string };

interface Entry { runId: string; row?: Row; info?: LiveInfo; at: number }

export function LiveNow({ runById }: { runById: ReadonlyMap<string, Row> }) {
  const now = useTick(5_000);
  const entries = new Map<string, Entry>();
  for (const [runId, info] of activeLiveRuns(now, STALE_MS)) entries.set(runId, { runId, row: runById.get(runId), info, at: Date.parse(info.at) });
  for (const row of runById.values()) {
    if (!row.live || entries.has(row.id) || liveIdle.value.has(row.id)) continue;
    const at = Date.parse(row.live.at);
    if (Number.isFinite(at) && now - at <= STALE_MS) entries.set(row.id, { runId: row.id, row, at });
  }
  if (!entries.size) return null;
  const list = [...entries.values()].sort((a, b) => b.at - a.at);
  return (
    <Panel class="live-now" title={<span title={list.length === 1 ? "This transcript is being written right now; the bar is how much of its window the last request used." : `${list.length} transcripts are being written right now; each bar is how much of the window the last request used.`}><span class="live-dot" aria-hidden="true" />Live now</span>} actions={<span class="muted">window used by the last request · <span class="live-now-mark-key" aria-hidden="true" /> 80 %</span>}>
      <ul class="live-now-list">
        {list.map((e) => {
          const { vendor, id } = splitRunId(e.runId);
          const requests = e.info?.requests ?? e.row?.summary.requests;
          const peak = e.info?.peak ?? e.row?.summary.peak.value;
          const window = e.row?.window.value;
          const share = peak !== undefined && window ? peak / window : undefined;
          const title = e.row ? (e.row.parentRunId ? `${e.row.agentType ?? "subagent"} · child of ${splitRunId(e.row.parentRunId).id.slice(0, 8)}` : e.row.project.displayName) : `${e.info?.vendor ?? vendor} session ${id.slice(0, 8)}`;
          const sub = e.row ? [formatDate(e.row.startedAt), e.row.summary.models.join(", "), e.row.gitBranch].filter(Boolean).join(" · ") : "not in the current overview scope";
          const tone = share === undefined ? "" : share >= 0.8 ? " hot" : share >= 0.6 ? " warm" : "";
          return (
            <li key={e.runId} class="live-now-row">
              <div class="live-now-who">
                <span class="live-now-title"><span class={`vendor vendor-${e.row?.vendor ?? e.info?.vendor ?? vendor}`}>{e.row?.vendor ?? e.info?.vendor ?? vendor}</span><a href={hrefs.session(vendor, id)}>{title}</a></span>
                <span class="live-now-sub">{sub} · updated {formatAgo(e.at, now)}{e.row ? ` · started ${formatRelative(e.row.startedAt, now)}` : ""}</span>
              </div>
              <div class="live-now-fill" title={peak !== undefined ? `${formatNumber(peak)} tokens in the last request${window ? ` of a ${formatNumber(window)} window` : ""}` : undefined}>
                <div class="live-now-nums">
                  <span><strong>{peak !== undefined ? formatTokens(peak) : "—"}</strong>{window ? <> of {formatTokens(window)}</> : null}{share !== undefined ? <> · <strong>{percent(share)}</strong> of the window</> : null}</span>
                  <span>{requests !== undefined ? `${formatNumber(requests)} requests` : ""}{e.row?.summary.compactions ? ` · ${e.row.summary.compactions} compactions` : ""}</span>
                </div>
                <div class="live-now-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share !== undefined ? Math.round(share * 100) : undefined} aria-label="Window used">
                  {share !== undefined ? <span class={`live-now-bar${tone}`} style={{ width: `${Math.min(100, Math.max(1, share * 100))}%` }} /> : null}
                  <span class="live-now-mark" style={{ left: "80%" }} title="80 % of the window: the zone where quality degrades before the hard limit" />
                </div>
              </div>
              <div class="live-now-actions">
                <a class="btn btn-primary" href={hrefs.session(vendor, id)}>Open live view</a>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
