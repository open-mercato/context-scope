/**
 * Fixture dev server: serves packages/cli/ui statically and answers /api/v1/*
 * from JSON files in packages/ui/dev/fixtures. Run `npm run watch` in another
 * terminal, then `npm run dev` and open the printed URL.
 *
 * Fixture mapping (ADR-002 C shapes):
 *   /api/v1/overview                          -> fixtures/overview.json
 *   /api/v1/runs/<vendor>/<id>                -> fixtures/runs/<vendor>--<id>.json, else run-<id>.json, else run-sample.json
 *                                                (main scope full, child scopes as summaries with partial: true)
 *   /api/v1/runs/<vendor>/<id>/scopes/<scope> -> the matching *.scopes.json (full AgentScope), 404 when unknown
 *   /api/v1/setup                             -> fixtures/setup.json
 *   /api/v1/findings                          -> fixtures/findings.json
 *   /api/v1/thresholds                        -> fixtures/thresholds.json (PUT parses and echoes the body)
 *   /api/v1/index/events                      -> SSE: one "done" event
 * Bodies over 8 KB are gzip-encoded when the client accepts it.
 *
 * `npm run dev -- --live` (review cycle 2, #39) replays the companion's live
 * protocol for `claude:sample`: the run starts truncated at TRUNC requests,
 * the SSE hub emits `live` every LIVE_MS (plus a `done` pass with live: true),
 * `/tail?after=&scope=&sig=` returns the next STEP requests with a signature
 * check, event REBASE_AT answers `rebased: true` once, and after IDLE_AFTER
 * events a `live-idle` is sent. Env: TRUNC, STEP, LIVE_MS, REBASE_AT, IDLE_AFTER.
 */
import http from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, "../../cli/ui");
const fixtures = path.join(here, "fixtures");
const port = Number(process.env.PORT || 4177);
const LIVE = process.argv.includes("--live");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json" };
const GZIP_MIN = 8 * 1024;
const LIVE_RUN = "claude:sample";

async function readFirst(names) {
  for (const name of names) {
    try { return { body: await readFile(path.join(fixtures, name), "utf8"), name }; } catch { /* next */ }
  }
  return null;
}

/** Run fixture names to try for a vendor/id pair, most specific first. */
function runCandidates(vendor, id) {
  return [`runs/${vendor}--${id}.json`, `run-${id}.json`, "run-sample.json"];
}

// ---------- live replay (--live) ----------

/** Mirrors `requestsSignature` in packages/cli/src/server/routes/runs.mjs and packages/ui/src/store.ts. */
function requestsSignature(requests, upTo) {
  let text = "";
  const end = Math.min(upTo, requests.length - 1);
  for (let i = 0; i <= end; i += 1) {
    const r = requests[i]; const comp = r.composition ?? {}; let parts = "";
    for (const key of Object.keys(comp).sort()) if (comp[key]) parts += `${key}=${Math.round(comp[key])},`;
    text += `${r.index}:${r.usage?.total ?? 0}:${parts}\n`;
  }
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function createLiveReplay() {
  const TRUNC = Number(process.env.TRUNC || 300);
  const STEP = Number(process.env.STEP || 5);
  const LIVE_MS = Number(process.env.LIVE_MS || 4000);
  const REBASE_AT = Number(process.env.REBASE_AT || 6);
  const IDLE_AFTER = Number(process.env.IDLE_AFTER || 9);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[live]", ...a);
  let full = null, main = null;
  let known = TRUNC, events = 0, rebasedOnce = false;
  const clients = new Set();

  async function ensure() {
    if (full) return;
    full = JSON.parse((await readFirst(["run-sample.json"])).body);
    main = full.scopes[0];
    known = Math.min(TRUNC, main.requests.length);
  }
  function forecastOf(requests, window) {
    const last = requests[requests.length - 1];
    const seg = requests.slice(-20);
    const slope = seg.length > 1 ? (seg[seg.length - 1].usage.total - seg[0].usage.total) / (seg.length - 1) : 0;
    const threshold = { value: Math.round(window * 0.95), provenance: "estimated.local", basis: { events: 5, min: Math.round(window * 0.92), max: Math.round(window * 0.98), source: "calibration.json" } };
    const base = { threshold, basis: { requests: seg.length, from: seg[0]?.index ?? 0, to: last?.index ?? 0 }, provenance: "derived.exact" };
    if (!(slope > 0) || !last || last.usage.total >= threshold.value) return { ...base, status: "flat", perRequest: 0, perMinute: 0, requestsLeft: 0, minutesLeft: 0 };
    const minutes = (Date.parse(last.at) - Date.parse(seg[0].at)) / 60_000;
    const perMinute = minutes > 0 ? slope * ((seg.length - 1) / minutes) : slope * 3;
    return { ...base, status: "ok", perRequest: Math.round(slope), perMinute: Math.round(perMinute), requestsLeft: (threshold.value - last.usage.total) / slope, minutesLeft: (threshold.value - last.usage.total) / perMinute };
  }
  function truncatedMain(n) {
    const requests = main.requests.slice(0, n);
    const blocks = main.blocks.filter((b) => b.firstRequest < n).map((b) => (b.lastRequest !== undefined && b.lastRequest >= n ? { ...b, lastRequest: undefined, droppedBy: undefined } : b));
    const compactions = main.compactions.filter((c) => c.atRequest < n);
    let peak = 0; for (const r of requests) peak = Math.max(peak, r.usage.total);
    return { ...main, requests, blocks, compactions, peak: { value: peak, provenance: "observed.vendor" }, requestCount: n, forecast: forecastOf(requests, full.window.value) };
  }
  function shell(n) {
    const m = truncatedMain(n);
    return { ...full, scopes: [m, ...full.scopes.slice(1)], summary: { ...full.summary, requests: full.summary.requests - (main.requests.length - n), peak: m.peak } };
  }
  function tail(after, sig) {
    const m = truncatedMain(known);
    const s = shell(known);
    const base = { summary: s.summary, peak: m.peak, forecast: m.forecast, requestCount: m.requests.length, live: { at: new Date().toISOString() } };
    if (sig && after >= 0 && m.requests.length) {
      const expected = requestsSignature(m.requests, Math.min(after, m.requests.length - 1));
      const rebase = events === REBASE_AT && !rebasedOnce;
      if (expected !== sig || rebase) { rebasedOnce = rebasedOnce || rebase; log("tail after", after, "→ REBASED", { expected, sig, forced: rebase }); return { ...base, requests: [], blocks: [], closed: [], compactions: [], rebased: true }; }
    }
    if (after >= m.requests.length) return { ...base, requests: [], blocks: [], closed: [], compactions: [], rebased: true };
    const closed = []; const fresh = [];
    for (const b of m.blocks) { if (b.firstRequest > after) fresh.push(b); else if (b.lastRequest !== undefined && b.lastRequest >= after) closed.push({ id: b.id, lastRequest: b.lastRequest, droppedBy: b.droppedBy }); }
    const out = { ...base, requests: m.requests.filter((r) => r.index > after), blocks: fresh, closed, compactions: m.compactions.filter((c) => c.atRequest > after), rebased: false };
    log("tail after", after, "→", out.requests.length, "requests,", fresh.length, "blocks,", closed.length, "closed");
    return out;
  }
  function broadcast(event) { const payload = `data: ${JSON.stringify(event)}\n\n`; for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } } }
  function liveEvent() {
    const m = truncatedMain(known);
    const last = m.requests[m.requests.length - 1];
    return { type: "live", runId: LIVE_RUN, vendor: "claude", at: new Date().toISOString(), requests: m.requests.length, peak: m.peak.value, last: { index: last.index, total: last.usage.total, at: last.at, model: last.model }, parseMs: 120 + events };
  }
  setInterval(async () => {
    if (!clients.size) return;
    await ensure();
    if (events >= IDLE_AFTER) { if (events === IDLE_AFTER) { log("live-idle"); broadcast({ type: "live-idle", runId: LIVE_RUN, at: new Date().toISOString() }); events++; } return; }
    events++;
    if (known < main.requests.length) known = Math.min(main.requests.length, known + STEP);
    log("live event", events, "known", known);
    broadcast(liveEvent());
    broadcast({ type: "done", total: 1, done: 1, files: 14, live: true });
  }, LIVE_MS);
  return {
    async sse(res) {
      await ensure();
      res.write("retry: 2000\n\n");
      if (events > 0 && events < IDLE_AFTER) res.write(`data: ${JSON.stringify(liveEvent())}\n\n`);
      clients.add(res); res.on("close", () => clients.delete(res));
    },
    async overview(doc) { await ensure(); return { ...doc, runs: doc.runs.map((r, i) => (r.id === LIVE_RUN || i === 0 ? { ...r, ...(events < IDLE_AFTER ? { live: { at: new Date().toISOString() } } : {}) } : r)) }; },
    async run() { await ensure(); return shell(known); },
    async tail(url) {
      await ensure();
      const after = Number(url.searchParams.get("after") ?? -1);
      const scope = url.searchParams.get("scope") || "main";
      if (scope !== "main") return { summary: shell(known).summary, peak: { value: 0, provenance: "observed.vendor" }, requestCount: 0, requests: [], blocks: [], closed: [], compactions: [], rebased: false };
      return tail(after, url.searchParams.get("sig") ?? undefined);
    },
    describe: () => `live replay: ${LIVE_RUN} truncated at ${TRUNC}, +${STEP} every ${LIVE_MS} ms, rebase at event ${REBASE_AT}, idle after ${IDLE_AFTER}`,
  };
}
const live = LIVE ? createLiveReplay() : null;
const [liveVendor, liveId] = LIVE_RUN.split(":");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body, type = "application/json; charset=utf-8") => {
    const headers = { "content-type": type, "cache-control": "no-store" };
    let payload = body;
    if (typeof body === "string" && Buffer.byteLength(body) > GZIP_MIN && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      payload = gzipSync(body, { level: 6 });
      headers["content-encoding"] = "gzip";
      headers.vary = "accept-encoding";
    }
    res.writeHead(status, headers);
    res.end(payload);
  };
  if (url.pathname.startsWith("/api/v1/")) {
    const rest = url.pathname.slice("/api/v1/".length);
    if (rest === "index/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(`data: ${JSON.stringify({ type: "done", total: 3, done: 3, files: 14 })}\n\n`);
      if (live) await live.sse(res);
      return;
    }
    if (rest === "index/refresh") return send(200, JSON.stringify({ ok: true }));
    if (rest === "thresholds" && req.method === "PUT") {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        try { send(200, JSON.stringify(JSON.parse(body || "{}"))); }
        catch { send(400, JSON.stringify({ error: "thresholds body must be a JSON object" })); }
      });
      return;
    }
    if (rest.startsWith("runs/")) {
      const parts = rest.split("/").map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
      const [, vendor, id, sub, scopeId] = parts;
      if (!vendor || !id) return send(404, JSON.stringify({ error: "Run not found." }));
      const isLiveRun = live && vendor === liveVendor && id === liveId;
      if (sub === "tail") return isLiveRun ? send(200, JSON.stringify(await live.tail(url))) : send(404, JSON.stringify({ error: "Live tail is only replayed for claude:sample with --live." }));
      if (sub === "scopes" && scopeId) {
        const found = await readFirst(runCandidates(vendor, id).map((n) => n.replace(/\.json$/, ".scopes.json")));
        if (!found) return send(404, JSON.stringify({ error: "Run not found.", runId: `${vendor}:${id}` }));
        const scopes = JSON.parse(found.body);
        const scope = scopes[scopeId];
        return scope ? send(200, JSON.stringify(scope)) : send(404, JSON.stringify({ error: "Scope not found.", scopeId }));
      }
      if (sub) return send(404, JSON.stringify({ error: "Unknown run resource." }));
      if (isLiveRun) return send(200, JSON.stringify(await live.run()));
      const found = await readFirst(runCandidates(vendor, id));
      return found ? send(200, found.body) : send(404, JSON.stringify({ error: "Run not found.", runId: `${vendor}:${id}` }));
    }
    const name = rest.split("?")[0];
    const file = { overview: "overview.json", setup: "setup.json", findings: "findings.json", thresholds: "thresholds.json" }[name];
    const found = file ? await readFirst([file]) : null;
    if (found && name === "overview" && live) return send(200, JSON.stringify(await live.overview(JSON.parse(found.body))));
    return found ? send(200, found.body) : send(404, JSON.stringify({ error: "no fixture for " + rest }));
  }
  let filePath = path.join(uiDir, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    if (!(await stat(filePath)).isFile()) throw new Error();
  } catch { filePath = path.join(uiDir, "index.html"); }
  try { send(200, await readFile(filePath), types[path.extname(filePath)] ?? "application/octet-stream"); }
  catch { send(404, "not found", "text/plain"); }
});

server.listen(port, "127.0.0.1", () => console.log(`fixture dev server: http://127.0.0.1:${port}/?token=dev  (session: #/session/claude/sample · stress: #/session/claude/stress)${live ? `\n${live.describe()}` : ""}`));
