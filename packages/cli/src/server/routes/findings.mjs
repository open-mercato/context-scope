/** Findings route: setup + session findings of the launched repo, grouped, with the first change. */
import { sendJson } from "../http.mjs";

export default function findingRoutes({ analysis }) {
  return [
    {
      method: "GET",
      pattern: "/api/v1/findings",
      async handler({ request, response, url }) {
        try {
          sendJson(response, 200, await analysis.findings({ scope: url.searchParams.get("scope") || "", vendor: url.searchParams.get("vendor") || "" }), { request });
        } catch (error) {
          if (error?.status === 400) sendJson(response, 400, { error: error.message });
          else throw error;
        }
      },
    },
  ];
}
