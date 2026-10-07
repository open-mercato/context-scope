/** Habits route: cross-session findings of the launched repo plus its trends, from the manifest only. */
import { parseSince } from "../../util/format.mjs";
import { sendJson } from "../http.mjs";

export default function habitRoutes({ analysis }) {
  return [
    {
      method: "GET",
      pattern: "/api/v1/habits",
      async handler({ request, response, url }) {
        const sinceRaw = url.searchParams.get("since");
        if (sinceRaw && parseSince(sinceRaw) === null) { sendJson(response, 400, { error: "since must be like 30d, 12h, or an ISO date." }); return; }
        sendJson(response, 200, await analysis.habits({ since: sinceRaw || undefined }), { request });
      },
    },
  ];
}
