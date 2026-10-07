/** Index progress (SSE) and refresh routes. */
import { publicError, sendJson } from "../http.mjs";

export default function indexingRoutes({ index, sse, analysis, warnOnce }) {
  return [
    {
      method: "GET",
      pattern: "/api/v1/index/events",
      queryToken: true,
      async handler({ request, response }) {
        const state = index.state;
        const initial = [{ type: "state", ...state }];
        if (state.state === "idle" && index.lastResult) initial.push(index.lastResult);
        sse.subscribe(request, response, initial);
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/index/refresh",
      async handler({ response, url }) {
        const force = url.searchParams.get("force") === "1";
        const started = !index.running;
        const queued = !started && force;
        if (started || queued) {
          index.ensure({ force }).then(() => analysis.invalidateSetup()).catch((error) => warnOnce(`refresh:${Date.now()}`, `index refresh failed (${publicError(error)}).`));
        }
        sendJson(response, 200, { ok: true, started, queued });
      },
    },
  ];
}
