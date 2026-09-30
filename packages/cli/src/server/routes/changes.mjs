/** Before/after per instruction-file edit (ADR-005 §1): manifest-only, served from `analysis.changes()`. */
import { parseSince } from "../../util/format.mjs";
import { sendJson } from "../http.mjs";

export default function changeRoutes({ analysis }) {
  return [
    {
      method: "GET",
      pattern: "/api/v1/changes",
      async handler({ request, response, url }) {
        const sinceRaw = url.searchParams.get("since");
        if (sinceRaw && parseSince(sinceRaw) === null) { sendJson(response, 400, { error: "since must be like 30d, 12h, an ISO date, or all." }); return; }
        const file = url.searchParams.get("file") || undefined;
        if (file && (file.length > 512 || file.includes("\0"))) { sendJson(response, 400, { error: "file must be a repo-relative path." }); return; }
        sendJson(response, 200, await analysis.changes({ since: sinceRaw || undefined, file }), { request });
      },
    },
  ];
}
