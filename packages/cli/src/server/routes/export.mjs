/**
 * GET /api/v1/runs/:vendor/:id/export?scopes=main&redact=1
 * The same `contextscope.export/1` document the CLI writes, served as an
 * attachment so the browser saves it; `scopes` is main | all | id,id.
 */
import { BASE_HEADERS, sendJson } from "../http.mjs";
import { buildExport, parseScopeSelection } from "../../export/schema.mjs";
import { publicMessage } from "../../util/errors.mjs";

const TRUE = new Set(["1", "true", "yes"]);

export default function exportRoutes({ index, analysis }) {
  return [
    {
      method: "GET",
      pattern: /^\/api\/v1\/runs\/(?<vendor>[^/]+)\/(?<id>[^/]+)\/export$/,
      async handler({ request, response, url, params }) {
        const runId = `${params.vendor}:${params.id}`;
        const redact = TRUE.has((url.searchParams.get("redact") ?? "").toLowerCase());
        const scopes = parseScopeSelection(url.searchParams.get("scopes") ?? "main");
        let doc;
        try {
          doc = await buildExport({ index, runId, scopes, redact, thresholds: await analysis.thresholds(), recurrence: await analysis.repoRecurrence() });
        } catch (error) {
          const status = error?.status === 404 ? 404 : 500;
          sendJson(response, status, { error: status === 404 ? "Run not found." : publicMessage(error, 500), runId });
          return;
        }
        const body = Buffer.from(JSON.stringify(doc));
        const file = `contextscope-${params.vendor}-${params.id.slice(0, 8)}${redact ? "-redacted" : ""}.json`;
        response.writeHead(200, {
          ...BASE_HEADERS,
          "content-type": "application/json; charset=utf-8",
          "content-length": body.length,
          "content-disposition": `attachment; filename="${file}"`,
        });
        response.end(request.method === "HEAD" ? undefined : body);
      },
    },
  ];
}
