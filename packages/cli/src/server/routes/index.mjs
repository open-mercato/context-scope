/**
 * /api route table. Each module under routes/ exports a function
 * `(context) => Route[]`, where `Route` is `{ method, pattern, handler, public?, queryToken? }`:
 *
 *   method      "GET" | "POST" | "PUT" | ...
 *   pattern     exact pathname string, or a RegExp with named groups (percent-decoded into `params`)
 *   handler     async ({ request, response, url, params }) => void; the route always answers
 *   public      true when the route runs before consent (default: 409 until authorized)
 *   queryToken  true when `?token=` is accepted in place of the Bearer header (SSE only)
 *
 * `context` carries the server wiring ({ index, home, repoRoot, rules, setup, sse, warn, authorize,
 * isAuthorized }) plus `analysis` (server/analysis.mjs), `cached` (prepared-JSON LRU) and `warnOnce`.
 * A stream adds a route file by appending one line to MODULES; first match wins, so keep specific
 * patterns ahead of broad ones.
 *
 *   GET  /api/v1/overview?scope=repo|all&since=30d&limit=200&nested=1   Overview (all=1: deprecated alias of nested=1)
 *   GET  /api/v1/habits?since=30d                       { findings, groups, notes, sessions, trends }
 *   GET  /api/v1/changes?since=all&file=CLAUDE.md       { changes: Change[], notes } before/after per instruction edit (manifest only)
 *   GET  /api/v1/runs/:vendor/:id                       Run + findings; scopes[0] full, children as ScopeSummary
 *   GET  /api/v1/runs/:vendor/:id/scopes/:scopeId       one full AgentScope
 *   GET  /api/v1/runs/:vendor/:id/export?scopes=&redact=  contextscope.export/1 document (attachment)
 *   GET  /api/v1/cost?run=&scope=|scope=repo|all&since=      CostResponse: per-tool token-requests (run, scope, or population)
 *   GET  /api/v1/setup                                  SetupInventory + findings + sessionStats
 *   GET  /api/v1/findings?scope=&vendor=                { findings, groups, firstChange } (scope: setup|session|subagent|habit)
 *   GET|PUT /api/v1/thresholds                          Thresholds
 *   GET  /api/v1/index/events                           SSE (query token allowed here only)
 *   POST /api/v1/index/refresh                          { ok, started, queued }
 *   POST /api/authorize                                 consent (public)
 */
import { RUN_CACHE_BYTES } from "../../index/reader.mjs";
import { createPreparedCache, decodeParam, sendJson } from "../http.mjs";
import { createAnalysis, emptySetupInventory } from "../analysis.mjs";
import overviewRoutes from "./overview.mjs";
import runRoutes from "./runs.mjs";
import exportRoutes from "./export.mjs";
import findingRoutes from "./findings.mjs";
import habitRoutes from "./habits.mjs";
import setupRoutes from "./setup.mjs";
import indexingRoutes from "./indexing.mjs";
import discoveryRoutes from "./discovery.mjs";
import costRoutes from "./cost.mjs";
import changeRoutes from "./changes.mjs";

export { emptySetupInventory };

const MODULES = [
  overviewRoutes,
  exportRoutes,
  runRoutes,
  findingRoutes,
  habitRoutes,
  setupRoutes,
  indexingRoutes,
  discoveryRoutes,
  changeRoutes,
  costRoutes,
];

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.pattern === "string") {
      if (route.pattern === pathname) return { route, params: {} };
      continue;
    }
    const found = route.pattern.exec(pathname);
    if (!found) continue;
    const params = {};
    for (const [name, value] of Object.entries(found.groups ?? {})) params[name] = value === undefined ? value : decodeParam(value);
    return { route, params };
  }
  return null;
}

export function createRoutes(options) {
  const {
    index, home, repoRoot, rules, setup,
    warn = (message) => console.error(message),
    cacheBytes = RUN_CACHE_BYTES,
    authorize = async () => {},
    isAuthorized = () => true,
  } = options;
  const analysis = createAnalysis({ index, home, repoRoot, rules, setup, warn });
  const prepared = createPreparedCache({ index, cacheBytes });
  const warned = new Set();

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(`ContextScope: ${message}`);
  }

  const context = { ...options, warn, authorize, isAuthorized, analysis, cache: prepared.cache, cached: prepared.cached, warnOnce };
  const routes = MODULES.flatMap((build) => build(context));

  /** The route for (method, pathname), or null. */
  function match(method, pathname) {
    return matchRoute(routes, method, pathname);
  }

  /** Returns true when the request was handled (including a 409 for a gated route before consent). */
  async function handle(request, response, url) {
    const found = match(request.method, url.pathname);
    if (!found) return false;
    if (!found.route.public && !isAuthorized()) {
      sendJson(response, 409, { status: "authorization-required" });
      return true;
    }
    await found.route.handler({ request, response, url, params: found.params });
    return true;
  }

  return {
    handle,
    match,
    routes,
    analysis,
    cache: prepared.cache,
    getSetup: analysis.getSetup,
    invalidateSetup: analysis.invalidateSetup,
    thresholds: analysis.thresholds,
    close() { prepared.close(); },
  };
}
