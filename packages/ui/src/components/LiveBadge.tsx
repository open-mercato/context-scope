/**
 * "live · updated 12 s ago" with a pulsing dot. Mounted on overview rows and
 * in the session header. Renders nothing without `live` or once the last
 * update is older than STALE_MS (the watcher sends `live-idle` after 3 min;
 * this is the client-side guard for a dropped stream, set to the same 3 min).
 */
import { useTick } from "../hooks.ts";

/** Same as the watcher's idle window (packages/cli/src/index/watch.mjs `idleMs`), so a dropped stream never outlives it (#31). */
export const STALE_MS = 3 * 60_000;

export function formatAgo(atMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - atMs) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ago`;
}

export function LiveBadge({ live, compact = false }: { live?: { at: string }; compact?: boolean }) {
  const now = useTick(5_000);
  if (!live) return null;
  const atMs = Date.parse(live.at);
  if (!Number.isFinite(atMs) || now - atMs > STALE_MS) return null;
  const ago = formatAgo(atMs, now);
  return (
    <span class={`live-badge${compact ? " live-badge-compact" : ""}`} title={`Transcript re-parsed ${ago} (${new Date(atMs).toLocaleTimeString()})`} role="status" aria-live="off">
      <span class="live-dot" aria-hidden="true" />
      {compact ? "live" : <>live · updated {ago}</>}
    </span>
  );
}
