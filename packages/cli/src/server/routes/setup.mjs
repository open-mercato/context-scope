/** Setup inventory route. */
import { sendJson } from "../http.mjs";

export default function setupRoutes({ analysis }) {
  return [
    {
      method: "GET",
      pattern: "/api/v1/setup",
      async handler({ request, response }) {
        sendJson(response, 200, await analysis.getSetup(), { request });
      },
    },
  ];
}
