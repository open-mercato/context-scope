/**
 * Run shell, scope and live-tail routes. Shell and scope payloads are prepared
 * once and served from the byte-bounded cache; the tail is computed per call.
 *
 *   GET /api/v1/runs/:vendor/:id/tail?after=<n>&scope=<id>&sig=<hash>  -> RunTail
 *     requests with index > after, blocks with firstRequest > after, blocks
 *     closed at or after `after` (their lastRequest / droppedBy), compactions
 *     with atRequest > after, the run summary, the scope peak and forecast.
 *     `sig` is the client's `requestsSignature` over requests[0..after]; when
 *     it differs from the server's, reconciliation moved earlier requests and
 *     the response is `{ rebased: true }` with empty lists so the client reloads.
 *     `forecast` is present only while the run is live (`index.liveRuns()`).
 *     The scope comes from the index's parsed-scope cache (one read per pass).
 */
import { createHash } from "node:crypto";
import { sendJson, sendPrepared } from "../http.mjs";

/**
 * Cheap, order-sensitive signature of requests[0..upTo] (index, total and the
 * reconciled composition). Mirrored in packages/ui/src/store.ts; keep in sync.
 */
export function requestsSignature(requests, upTo) {
  let text = "";
  const end = Math.min(upTo, requests.length - 1);
  for (let i = 0; i <= end; i += 1) {
    const r = requests[i];
    const comp = r.composition ?? {};
    const keys = Object.keys(comp).sort();
    let parts = "";
    for (const key of keys) if (comp[key]) parts += `${key}=${Math.round(comp[key])},`;
    text += `${r.index}:${r.usage?.total ?? 0}:${parts}\n`;
  }
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export function buildTail(scope, summary, { after, sig, live = true }) {
  const requests = scope.requests ?? [];
  const blocks = scope.blocks ?? [];
  // The forecast is a live affordance (ADR-004 section 4): a finished session shows none.
  const base = { summary, peak: scope.peak, forecast: live ? scope.forecast : undefined, requestCount: requests.length };
  if (typeof sig === "string" && sig && after >= 0 && requests.length) {
    const expected = requestsSignature(requests, Math.min(after, requests.length - 1));
    if (expected !== sig) return { ...base, requests: [], blocks: [], closed: [], compactions: [], rebased: true };
  }
  if (after >= 0 && after >= requests.length) {
    // The client knows more requests than the index does (a rebase that shortened the scope).
    return { ...base, requests: [], blocks: [], closed: [], compactions: [], rebased: true };
  }
  const closed = [];
  const fresh = [];
  for (const block of blocks) {
    if (block.firstRequest > after) fresh.push(block);
    else if (block.lastRequest !== undefined && block.lastRequest >= after) closed.push({ id: block.id, lastRequest: block.lastRequest, droppedBy: block.droppedBy });
  }
  return {
    ...base,
    requests: requests.filter((r) => r.index > after),
    blocks: fresh,
    closed,
    compactions: (scope.compactions ?? []).filter((c) => c.atRequest > after),
    rebased: false,
  };
}

export default function runRoutes({ index, analysis, cached }) {
  return [
    {
      method: "GET",
      pattern: /^\/api\/v1\/runs\/(?<vendor>[^/]+)\/(?<id>[^/]+)$/,
      async handler({ request, response, params }) {
        const runId = `${params.vendor}:${params.id}`;
        const prepared = await cached(`run:${runId}`, () => analysis.run(runId));
        if (!prepared) { sendJson(response, 404, { error: "Run not found.", runId }); return; }
        sendPrepared(request, response, prepared);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/runs\/(?<vendor>[^/]+)\/(?<id>[^/]+)\/tail$/,
      async handler({ request, response, params, url }) {
        const runId = `${params.vendor}:${params.id}`;
        const scopeId = url.searchParams.get("scope") || "main";
        const afterRaw = url.searchParams.get("after");
        const after = afterRaw === null || afterRaw === "" ? -1 : Number(afterRaw);
        if (!Number.isInteger(after) || after < -1) { sendJson(response, 400, { error: "after must be an integer request index (or -1)." }); return; }
        const sig = url.searchParams.get("sig") ?? undefined;
        const [scope, shell] = await Promise.all([index.readScope(runId, scopeId), index.readRunShell(runId)]);
        if (!scope || !shell) { sendJson(response, 404, { error: "Scope not found.", runId, scopeId }); return; }
        const live = typeof index.liveRuns === "function" ? index.liveRuns().get(runId) : undefined;
        const tail = buildTail(scope, shell.summary, { after, sig, live: Boolean(live) });
        sendJson(response, 200, { ...tail, live: live ? { at: live.at } : undefined }, { request });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/runs\/(?<vendor>[^/]+)\/(?<id>[^/]+)\/scopes\/(?<scopeId>[^/]+)$/,
      async handler({ request, response, params }) {
        const runId = `${params.vendor}:${params.id}`;
        const { scopeId } = params;
        const prepared = await cached(`scope:${runId}:${scopeId}`, () => analysis.scope(runId, scopeId));
        if (!prepared) { sendJson(response, 404, { error: "Scope not found.", runId, scopeId }); return; }
        sendPrepared(request, response, prepared);
      },
    },
  ];
}
