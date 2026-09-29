import { ApiError, NetworkError } from "../api.ts";

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div class="loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true" />{label}…</div>;
}

/** Placeholder rows while a panel's data is still arriving (progressive mount, child scope fetch). */
export function Skeleton({ rows = 3, chart = false, label = "Loading" }: { rows?: number; chart?: boolean; label?: string }) {
  return (
    <div class="skeleton" role="status" aria-label={label}>
      {chart ? <div class="skeleton-bar skeleton-chart" /> : null}
      {Array.from({ length: rows }, (_, i) => <div key={i} class="skeleton-bar" style={{ width: `${88 - (i % 3) * 18}%` }} />)}
    </div>
  );
}

/**
 * Explains a failed fetch. Only a NetworkError means the loopback companion is
 * gone; an ApiError is the companion answering with an error; anything else
 * is a UI bug and is shown as such (no "npx contextscope" advice).
 */
export function ErrorNotice({ error, retry }: { error: Error; retry?: () => void }) {
  const unreachable = error instanceof NetworkError;
  const unauthorized = error instanceof ApiError && (error.status === 401 || error.status === 403);
  const notFound = error instanceof ApiError && error.status === 404;
  const api = error instanceof ApiError;
  const title = unreachable ? (error.timedOut ? "Companion did not answer" : "Companion not reachable")
    : unauthorized ? "Session token rejected"
    : notFound ? "Not in the index"
    : api ? `Request failed (${error.message})`
    : "Something broke in the UI";
  return (
    <div class="error-notice" role="alert">
      <p class="error-title">{title}</p>
      <p class="error-body">
        {unreachable ? (
          <>The local ContextScope server is not answering on this port{error.timedOut ? " (timed out)" : ""}. Start it from the repository you want to inspect:</>
        ) : unauthorized ? (
          <>The page lost its per-launch token. Reopen the URL that the CLI printed (it carries <code>?token=</code>):</>
        ) : notFound ? (
          <>The companion has no record for this address ({error.message}). It may not be indexed yet; refresh the index from the top bar.</>
        ) : api ? (
          <>The companion answered with an error. Restart it and refresh:</>
        ) : (
          <>The screen failed while rendering: <code>{error.message}</code>. Reload the page; if it persists, file an issue with the details below.</>
        )}
      </p>
      {(unreachable || unauthorized || (api && !notFound)) ? <pre class="error-cmd"><code>npx contextscope</code></pre> : null}
      {!api && !unreachable && error.stack ? <details class="cs-help"><summary>Details</summary><pre class="fix-snippet"><code>{error.stack}</code></pre></details> : null}
      {retry ? <button type="button" class="btn" onClick={retry}>{api || unreachable ? "Retry" : "Reload"}</button> : null}
    </div>
  );
}
