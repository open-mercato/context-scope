/**
 * Per-tool cost route (ADR-005 section 5).
 *
 *   GET /api/v1/cost?run=<vendor:id>[&scope=<scopeId>]   one run's table (manifest summary; a scope id opens the run shell)
 *   GET /api/v1/cost?scope=repo|all[&since=30d]          population aggregate: `summary.toolCost` summed over the
 *                                                        sessions of the repo (default: all time) or the machine
 *                                                        (default: 30 d); manifest only, no run file is opened
 *
 * Every answer is `{ unit, provenance, scope, denominator, rows, caveats }`
 * (`CostResponse` in ir/types.ts). Rows are token-requests, estimated; the
 * caveats say what the number is not. Runs indexed before the field existed
 * carry no `summary.toolCost` and are counted in `runsWithoutCost`.
 */
import { rankToolCost, mergeToolCostGroups, groupsFromRows, toolCostGroups, TOOL_COST_CAVEATS, TOOL_COST_PROVENANCE, TOOL_COST_UNIT } from "../../ir/finalize.mjs";
import { rangeLabel, resolveSince } from "../../index/overview.mjs";
import { repoSessions } from "../../index/reader.mjs";
import { parseSince } from "../../util/format.mjs";
import { sendJson } from "../http.mjs";

const envelope = (scope, denominator, rows) => ({ unit: TOOL_COST_UNIT, provenance: TOOL_COST_PROVENANCE, scope, denominator, rows, caveats: [...TOOL_COST_CAVEATS] });

/**
 * Population aggregate over manifest entries (roots + their descendants):
 * the merged `summary.toolCost` rows, shares over the summed processed input.
 * Pure; the overview panel calls it on a few hundred entries in well under 5 ms.
 */
export function aggregateToolCost(entries) {
  const maps = [];
  let denominator = 0;
  let runsWithoutCost = 0;
  for (const entry of entries) {
    const summary = entry?.summary;
    if (!summary) continue;
    if (!Array.isArray(summary.toolCost)) { runsWithoutCost += 1; continue; }
    maps.push(groupsFromRows(summary.toolCost));
    denominator += summary.processedInputTokens ?? 0;
  }
  return { rows: rankToolCost(mergeToolCostGroups(maps), denominator), denominator, runsWithoutCost, runs: entries.length };
}

export default function costRoutes({ index, analysis, repoRoot }) {
  async function runCost(runId, scopeId, response) {
    const shell = await index.readRunShell(runId);
    if (!shell) { sendJson(response, 404, { error: "Run not found.", runId }); return; }
    if (!scopeId) {
      const rows = Array.isArray(shell.summary?.toolCost) ? shell.summary.toolCost : [];
      sendJson(response, 200, envelope({ mode: "run", runId }, shell.summary?.processedInputTokens ?? 0, rows));
      return;
    }
    const summary = (shell.scopes ?? []).find((scope) => scope.id === scopeId);
    if (!summary) { sendJson(response, 404, { error: "Scope not found.", runId, scopeId }); return; }
    let rows = Array.isArray(summary.toolCost) ? summary.toolCost : null;
    let denominator = summary.processedInputTokens ?? 0;
    if (!rows) {
      // Indexed before the field existed: derive it from the scope once, on request.
      const full = await index.readScope(runId, scopeId);
      if (full?.requests && full?.blocks) { denominator = full.processedInputTokens ?? full.requests.reduce((sum, r) => sum + (r.usage?.total ?? 0), 0); rows = rankToolCost(toolCostGroups(full), denominator); }
      else rows = [];
    }
    sendJson(response, 200, envelope({ mode: "run", runId, scopeId }, denominator, rows));
  }

  async function populationCost(mode, sinceRaw, response, now = Date.now()) {
    const since = resolveSince(sinceRaw, now, { mode });
    const entries = typeof index.entries === "function" ? await index.entries() : await index.repoEntries({ repoRoot });
    const population = mode === "repo" ? await analysis.population({ since: since || undefined }) : repoSessions({ entries, since: since || undefined });
    const aggregate = aggregateToolCost(population.entries);
    const scope = { mode, sessions: population.roots.length, runs: aggregate.runs, runsWithoutCost: aggregate.runsWithoutCost, since: since ? new Date(since).toISOString() : null, range: rangeLabel(sinceRaw, { mode }) };
    sendJson(response, 200, envelope(scope, aggregate.denominator, aggregate.rows));
  }

  return [
    {
      method: "GET",
      pattern: "/api/v1/cost",
      async handler({ response, url }) {
        const run = url.searchParams.get("run");
        const scope = url.searchParams.get("scope") || "";
        if (run) {
          if (!run.includes(":")) { sendJson(response, 400, { error: "run must be <vendor>:<session id>." }); return; }
          await runCost(run, scope, response);
          return;
        }
        const mode = scope || "repo";
        if (mode !== "repo" && mode !== "all") { sendJson(response, 400, { error: "scope must be repo, all, or a scope id with run=<vendor:id>." }); return; }
        const sinceRaw = url.searchParams.get("since");
        if (sinceRaw && parseSince(sinceRaw) === null) { sendJson(response, 400, { error: "since must be like 30d, 12h, all, or an ISO date." }); return; }
        await populationCost(mode, sinceRaw || undefined, response);
      },
    },
  ];
}
