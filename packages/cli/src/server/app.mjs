/**
 * ContextScope loopback server. `createServer()` wires the token guard, the
 * consent gate, static UI serving, the /api/v1 routes and SSE index progress.
 *
 * Token policy: the launch token travels as `?token=` exactly once, on the
 * first page load (the served index.html moves it into sessionStorage and
 * rewrites the URL) and on the consent page; API routes take `Authorization:
 * Bearer` only, except the SSE route where EventSource cannot send headers.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createIndex } from "../index/writer.mjs";
import { resolveRoots, displayPath } from "../util/fs.mjs";
import { renderConsentPage } from "./consent.mjs";
import { hasCapability, hasSafeOrigin, isLocalHost, publicError, sendHtml, sendJson, sendText } from "./http.mjs";
import { createRoutes } from "./routes/index.mjs";
import { createSseHub } from "./sse.mjs";
import { createStaticHandler } from "./static.mjs";
import { startWatcher } from "../index/watch.mjs";
import { removeServerFile, writeServerFile } from "./server-file.mjs";

export const DEFAULT_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

export function createServer({
  home = os.homedir(),
  repoRoot = process.cwd(),
  token = randomBytes(32).toString("hex"),
  adapters,
  rules,
  setup,
  uiDir = DEFAULT_UI_DIR,
  consent = true,
  autoIndex = true,
  concurrency = 4,
  roots = {},
  env = process.env,
  warn = (message) => console.error(message),
  /** Clock for time ranges (`since`, the 30-day default); tests pin it so fixture dates never age out. */
  now = () => Date.now(),
  /** Write ~/.contextscope/server.json while listening (ADR-005 §6); off for embedded servers that must leave no trace. */
  serverFile = true,
  version,
} = {}) {
  repoRoot = path.resolve(repoRoot);
  const index = createIndex({ home, roots, env, adapters, rules, concurrency, warn });
  const sse = createSseHub();
  const routes = createRoutes({ index, home, repoRoot, rules, setup, sse, warn, now, authorize, isAuthorized: () => authorized });
  const serveStatic = createStaticHandler(uiDir);
  const resolvedRoots = resolveRoots({ home, env, roots });
  const scopeRows = [resolvedRoots.codexHome, resolvedRoots.claudeHome, repoRoot].map((root) => displayPath(root, home));
  let authorized = !consent;
  let serverFileWritten = false;

  const forward = (event) => sse.broadcast(event);
  index.events.on("event", forward);
  let watcher = null;

  /** The live watcher lists and stats session directories, so it starts only once the user has authorized (or `--yes`). */
  function startLive() {
    if (watcher || !authorized) return watcher;
    watcher = startWatcher({ index, sse, home, env, roots, warn, isLive: () => authorized });
    return watcher;
  }
  if (authorized) startLive();

  function kickIndex({ force = false } = {}) {
    if (index.running && !force) return;
    index.ensure({ force }).then(() => routes.invalidateSetup()).catch((error) => warn(`ContextScope: indexing failed (${publicError(error)}).`));
  }

  async function authorize() {
    authorized = true;
    startLive();
    kickIndex();
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (!isLocalHost(request)) {
        sendText(response, 403, "ContextScope accepts loopback requests only.");
        return;
      }
      const url = new URL(request.url, "http://localhost");
      const { pathname } = url;

      if (pathname === "/" || pathname === "/index.html") {
        if (!authorized) {
          if (!hasCapability(request, token, { allowQuery: true })) {
            sendText(response, 401, "Open the URL printed in the terminal (it carries the launch token).");
            return;
          }
          sendHtml(response, 200, renderConsentPage({ repositoryName: path.basename(repoRoot), roots: scopeRows }));
          return;
        }
        if (await serveStatic(request, response, "/")) return;
        sendText(response, 503, "The ContextScope UI bundle is missing. Run `npm run build` in packages/ui.");
        return;
      }
      if (!pathname.startsWith("/api/")) {
        if (await serveStatic(request, response, pathname)) return;
        sendText(response, 404, "Not found");
        return;
      }

      const allowQuery = Boolean(routes.match(request.method, pathname)?.route.queryToken);
      if (!hasCapability(request, token, { allowQuery })) {
        sendText(response, 401, "Missing or invalid ContextScope launch token.");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD" && !hasSafeOrigin(request)) {
        sendText(response, 403, "Cross-origin changes are not allowed.");
        return;
      }
      if (await routes.handle(request, response, url)) return;
      if (!authorized) {
        sendJson(response, 409, { status: "authorization-required" });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: publicError(error) });
      else response.end();
    }
  });

  return {
    server,
    index,
    routes,
    sse,
    /** null until consent (the watcher is created by `authorize()` or at construction with `consent: false`). */
    get watcher() { return watcher; },
    token,
    repoRoot,
    get authorized() { return authorized; },
    authorize,
    kickIndex,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          if (authorized && autoIndex) kickIndex();
          const result = { port: actualPort, url: `http://${host}:${actualPort}/?token=${token}` };
          if (!serverFile) { resolve(result); return; }
          // The file never carries the token: `status` learns pid, port and repo; a capability stays in the terminal.
          writeServerFile(home, { port: actualPort, url: `http://${host}:${actualPort}/`, repoRoot, version })
            .then(() => { serverFileWritten = true; })
            .catch((error) => warn(`ContextScope: could not write server.json (${publicError(error)}).`))
            .finally(() => resolve(result));
        });
      });
    },
    /** Aborts an in-flight index pass (the manifest keeps what finished), then closes every connection. */
    async close() {
      index.abort();
      await watcher?.stop();
      if (index.running) await index.ensure().catch(() => {});
      await index.close?.();
      index.events.off("event", forward);
      routes.close();
      sse.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      if (serverFileWritten) { serverFileWritten = false; await removeServerFile(home).catch(() => {}); }
    },
  };
}
