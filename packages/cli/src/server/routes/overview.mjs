/** Overview (`?scope=repo|all&since=30d|90d|all&nested=1`) and thresholds routes. Default range: all time for repo, 30 d for all. */
import { resolveLimit } from "../../index/overview.mjs";
import { parseSince } from "../../util/format.mjs";
import { publicError, readJsonBody, sendJson } from "../http.mjs";

export default function overviewRoutes({ analysis }) {
  return [
    {
      method: "GET",
      pattern: "/api/v1/overview",
      async handler({ request, response, url }) {
        // `nested=1` shows Codex child rollouts as rows; `all=1` is the cycle-1 alias (deprecated, one release).
        const nested = url.searchParams.get("nested") === "1" || url.searchParams.get("all") === "1";
        const scopeRaw = url.searchParams.get("scope") || "repo";
        if (scopeRaw !== "repo" && scopeRaw !== "all") { sendJson(response, 400, { error: "scope must be repo or all." }); return; }
        const sinceRaw = url.searchParams.get("since");
        if (sinceRaw && parseSince(sinceRaw) === null) { sendJson(response, 400, { error: "since must be like 30d, 12h, all, or an ISO date." }); return; }
        const limitRaw = url.searchParams.get("limit");
        if (limitRaw && !(Number(limitRaw) > 0)) { sendJson(response, 400, { error: "limit must be a positive integer." }); return; }
        sendJson(response, 200, await analysis.overview({ since: sinceRaw || undefined, limit: limitRaw ? resolveLimit(limitRaw) : undefined, scope: scopeRaw, nested }), { request });
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/thresholds",
      async handler({ response }) {
        sendJson(response, 200, await analysis.thresholds());
      },
    },
    {
      method: "PUT",
      pattern: "/api/v1/thresholds",
      async handler({ request, response }) {
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, { error: publicError(error) });
          return;
        }
        try {
          sendJson(response, 200, await analysis.saveThresholds(body));
        } catch (error) {
          if (error?.status) sendJson(response, error.status, { error: error.message });
          else throw error;
        }
      },
    },
  ];
}
