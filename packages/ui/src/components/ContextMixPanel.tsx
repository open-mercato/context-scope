import { useState } from "preact/hooks";
import type { Category, Overview } from "@ir/types.ts";
import { CATEGORY_META, formatTokens } from "../categories.ts";
import { formatNumber, percent, plural } from "../format.ts";
import { Badge } from "./Badge.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Panel } from "./Panel.tsx";
import { MixStack } from "./EndMixBar.tsx";

type ContextAtEnd = NonNullable<Overview["contextAtEnd"]>;
interface Row { key: string; category?: Category; label: string; full: string; color: string; share: number; tokens: number; sessions: number; folded?: number }

/** Categories below this mean share fold into one "smaller categories" bar so the chart stays readable. */
const FOLD_BELOW = 0.01;
type View = "stack" | "bars";
const VIEW_KEY = "contextscope.contextMixView";
function readView(): View { try { return localStorage.getItem(VIEW_KEY) === "bars" ? "bars" : "stack"; } catch { return "stack"; } }
function saveView(view: View) { try { localStorage.setItem(VIEW_KEY, view); } catch {} }

function toRows(data: ContextAtEnd): Row[] {
  const rows: Row[] = [];
  const small = { share: 0, tokens: 0, sessions: 0, count: 0, names: [] as string[] };
  for (const row of data.rows) {
    const meta = CATEGORY_META[row.category];
    if (row.share < FOLD_BELOW) {
      small.share += row.share; small.tokens += row.tokens; small.count += 1;
      small.sessions = Math.max(small.sessions, row.sessions);
      small.names.push(meta?.short ?? row.category);
      continue;
    }
    rows.push({ key: row.category, category: row.category, label: meta?.short ?? row.category, full: meta?.label ?? row.category, color: meta?.color ?? "var(--cat-other)", share: row.share, tokens: row.tokens, sessions: row.sessions });
  }
  if (small.count === 1) {
    const only = data.rows.find((row) => row.share < FOLD_BELOW)!;
    const meta = CATEGORY_META[only.category];
    rows.push({ key: only.category, category: only.category, label: meta?.short ?? only.category, full: meta?.label ?? only.category, color: meta?.color ?? "var(--cat-other)", share: only.share, tokens: only.tokens, sessions: only.sessions });
  } else if (small.count > 1) {
    rows.push({ key: "__small", label: `${small.count} smaller`, full: `Under ${percent(FOLD_BELOW, 0)} each: ${small.names.join(", ")}`, color: "var(--faint)", share: small.share, tokens: small.tokens, sessions: small.sessions, folded: small.count });
  }
  return rows;
}

/**
 * Overview: how the main context was split when sessions ended. One bar per
 * category, length = mean share of the last request's input (each session
 * weighs the same); the value column adds the mean tokens behind that share.
 */
export function ContextMixPanel({ data, rangeLabel }: { data?: Overview["contextAtEnd"]; rangeLabel: string }) {
  const [active, setActive] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(readView);
  const setView = (next: View) => { setViewState(next); saveView(next); };
  const description = "What filled the main context on each session's last request, as a share of that request, averaged over sessions (each session weighs the same). Subagent windows are separate and not included.";
  if (!data || !data.sessions) {
    return (
      <Panel title="Context at session end" description={description}>
        <EmptyState compact title="No session-end composition yet" body={<>Sessions indexed before this view existed are re-evaluated on the next index pass; refresh the index from the top bar.</>} />
      </Panel>
    );
  }
  const rows = toRows(data);
  const max = Math.max(...rows.map((row) => row.share), 0.0001);
  const focus = rows.find((row) => row.key === active);
  return (
    <Panel
      title="Context at session end"
      description={description}
      class="context-mix-panel"
      actions={<>
        <span class="context-mix-meta"><strong>{formatTokens(data.meanTotal)}</strong> mean at end · {plural(data.sessions, "session")} · {rangeLabel} <Badge provenance="estimated.local" /></span>
        <div class="segmented" role="group" aria-label="Chart type">
          <button type="button" aria-pressed={view === "stack"} onClick={() => setView("stack")} title="One 100 % bar split by category">100 %</button>
          <button type="button" aria-pressed={view === "bars"} onClick={() => setView("bars")} title="One bar per category, sorted by share">Bars</button>
        </div>
      </>}
    >
      {view === "stack" ? (
        <MixStack
          parts={data.rows.map((row) => ({ category: row.category, tokens: row.tokens, share: row.share, sessions: row.sessions }))}
          total={data.meanTotal}
          note="Mean share of each session's last request; the value adds the mean tokens behind it. Estimated per block, reconciled to the vendor's exact request totals."
          detailOf={(part) => `present in ${part.sessions ?? 0} of ${data.sessions} sessions`}
        />
      ) : <>
      <ol class="context-mix" aria-label={`Mean share of the context at session end by category, ${plural(data.sessions, "session")}`} onMouseLeave={() => setActive(null)}>
        {rows.map((row) => (
          <li
            key={row.key}
            class={`context-mix-row ${active && active !== row.key ? "dim" : ""}`}
            tabIndex={0}
            onMouseEnter={() => setActive(row.key)}
            onFocus={() => setActive(row.key)}
            onBlur={() => setActive(null)}
            title={`${row.full}: ${percent(row.share, 1)} of the context at session end on average, mean ${formatNumber(row.tokens)} tokens; present in ${row.sessions} of ${data.sessions} sessions`}
          >
            <span class="context-mix-label"><span class="cat-dot" style={{ background: row.color }} aria-hidden="true" />{row.label}</span>
            <span class="context-mix-track" aria-hidden="true"><span class="context-mix-bar" style={{ width: `${(row.share / max) * 100}%`, background: row.color }} /></span>
            <span class="context-mix-value"><strong>{percent(row.share, 1)}</strong><span class="muted"> · {formatTokens(row.tokens)}</span></span>
          </li>
        ))}
      </ol>
      <p class="context-mix-detail muted" aria-live="polite">
        {focus
          ? <>{focus.full} · <strong>{percent(focus.share, 1)}</strong> on average · mean {formatNumber(focus.tokens)} tokens · {focus.folded ? `${focus.folded} categories` : `present in ${focus.sessions} of ${data.sessions} sessions`}</>
          : <>Bar length = mean share of the last request; the value adds the mean tokens behind it. Composition is estimated per block and reconciled to the vendor's exact request total.</>}
      </p>
      </>}
    </Panel>
  );
}
