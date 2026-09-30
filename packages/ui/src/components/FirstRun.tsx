import { indexStatus } from "../store.ts";
import { backend } from "../api.ts";
import { CLI_COMMAND } from "../config.ts";
import { formatNumber } from "../format.ts";

export interface FirstRunProps {
  /** Vendor rows from the overview when the caller has them (`Overview.vendors`); the static paths are shown otherwise. */
  vendors?: Array<{ vendor: string; detected: boolean; files: number; parsed: boolean }>;
  /** Pass progress from the overview's `index` block; the SSE fold in the store is used when absent. */
  progress?: { done?: number; total?: number };
}

const STORES: Array<{ vendor: string; label: string; path: string; command: string }> = [
  { vendor: "claude", label: "Claude Code", path: "~/.claude/projects/<project>/<session>.jsonl (+ <session>/subagents/)", command: "claude   # in the repository you want to inspect" },
  { vendor: "codex", label: "Codex", path: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl", command: "codex    # in the repository you want to inspect" },
  { vendor: "gemini", label: "Gemini CLI", path: "~/.gemini/tmp/<project>/chats/ (detected and counted only; no adapter yet)", command: "" },
];

/**
 * True while the companion has never finished a pass in this page's lifetime
 * and the first one is running or about to: the overview has no runs yet.
 * Static and export modes never qualify (they have no index).
 */
export function isFirstRun(): boolean {
  if (backend.value.mode !== "companion") return false;
  const status = indexStatus.value;
  if (status.lastRunAt || (status.files ?? 0) > 0) return false;
  return status.state === "indexing";
}

/**
 * First-run card (ADR-005 §6): shown on the overview while the first index
 * pass runs and no session row exists yet. Teaching copy only: which stores
 * are being read, what fills them, and the habit-rule minimum. The progress
 * numbers come from the SSE fold (`start` / `progress` events).
 */
export function FirstRun({ vendors, progress }: FirstRunProps) {
  const status = indexStatus.value;
  const done = progress?.done ?? status.done;
  const total = progress?.total ?? status.total;
  const known = new Map((vendors ?? []).map((row) => [row.vendor, row]));
  const rows = STORES.map((store) => ({ ...store, row: known.get(store.vendor) }));
  const busy = status.state === "indexing";
  return (
    <div class="empty" role="status" aria-live="polite" data-first-run>
      <p class="empty-title">{busy ? `First pass: indexing ${formatNumber(done)}${total ? ` of ${formatNumber(total)}` : ""} session file${total === 1 ? "" : "s"}` : "First pass: waiting for the companion"}</p>
      <p class="empty-body">
        ContextScope reads the transcripts Claude Code and Codex already keep on disk and stores sizes, hashes, tool names and token counts under <code>~/.contextscope</code>; never message text. Rows appear as sessions are parsed; the terminal prints "What we found" when the pass ends.
      </p>
      <dl class="empty-meta">
        {rows.map((store) => (
          <>
            <dt>{store.label}</dt>
            <dd>
              <code>{store.path}</code>
              {store.row ? <span class="muted"> · {store.row.detected ? `${formatNumber(store.row.files)} file${store.row.files === 1 ? "" : "s"}${store.row.parsed ? "" : ", not parsed"}` : "not found on this machine"}</span> : null}
              {store.command ? <><br /><span class="muted">Populated by </span><code>{store.command}</code></> : null}
            </dd>
          </>
        ))}
        <dt>Then</dt>
        <dd>Session and subagent rules fire on the first indexed session; habit rules (H-01..H-07) need 3 sessions of this repository. Install the runtime hook for load evidence: <code>{CLI_COMMAND.replace(/npx /, "npx ")} hooks install --scope user</code>.</dd>
      </dl>
    </div>
  );
}
