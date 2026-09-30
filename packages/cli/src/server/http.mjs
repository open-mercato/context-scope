/**
 * HTTP hardening helpers: loopback Host check (IPv4, IPv6 and localhost),
 * per-launch token (Bearer header; `?token=` only where the caller allows it),
 * Origin check for state-changing requests, bounded JSON bodies, path-free
 * error messages, gzip for large JSON bodies, `referrer-policy: no-referrer`
 * on every response.
 */
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { gzip as gzipCallback, gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { publicMessage } from "../util/errors.mjs";
import { createByteCache, RUN_CACHE_BYTES } from "../index/reader.mjs";

const gzipAsync = promisify(gzipCallback);
export const GZIP_MIN_BYTES = 8 * 1024;
const GZIP_LEVEL = 6;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const BASE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

export function isLocalHost(request) {
  const raw = request.headers.host;
  if (typeof raw !== "string" || !raw) return false;
  let hostname;
  try {
    hostname = new URL(`http://${raw}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function sameToken(candidate, token) {
  if (typeof candidate !== "string" || typeof token !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when the request carries the launch token. The query form is accepted
 * only when `allowQuery` is set (the SSE route: EventSource cannot send headers).
 */
export function hasCapability(request, token, { allowQuery = false } = {}) {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ") && sameToken(header.slice("Bearer ".length), token)) return true;
  if (!allowQuery) return false;
  try {
    return sameToken(new URL(request.url, "http://localhost").searchParams.get("token"), token);
  } catch {
    return false;
  }
}

export function queryToken(request) {
  try {
    return new URL(request.url, "http://localhost").searchParams.get("token");
  } catch {
    return null;
  }
}

export function hasSafeOrigin(request) {
  if (!request.headers.origin) return true;
  return request.headers.origin === `http://${request.headers.host}`;
}

export function acceptsGzip(request) {
  const header = request?.headers?.["accept-encoding"];
  return typeof header === "string" && /(^|,)\s*gzip\s*(;|,|$)/i.test(header);
}

/** Serialises once; the gzip variant is produced only for bodies above GZIP_MIN_BYTES. */
export async function prepareJson(value) {
  const json = Buffer.from(JSON.stringify(value));
  const gzip = json.length >= GZIP_MIN_BYTES ? await gzipAsync(json, { level: GZIP_LEVEL }) : null;
  return { json, gzip, bytes: json.length + (gzip?.length ?? 0) };
}

export function sendPrepared(request, response, prepared, status = 200) {
  const useGzip = Boolean(prepared.gzip) && acceptsGzip(request);
  const body = useGzip ? prepared.gzip : prepared.json;
  const headers = { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": body.length, vary: "accept-encoding" };
  if (useGzip) headers["content-encoding"] = "gzip";
  response.writeHead(status, headers);
  response.end(request?.method === "HEAD" ? undefined : body);
}

/** JSON response; gzip when the client accepts it, the body exceeds 8 KB and `request` is given. */
export function sendJson(response, status, value, { request } = {}) {
  const json = Buffer.from(JSON.stringify(value));
  if (request && json.length >= GZIP_MIN_BYTES && acceptsGzip(request)) {
    const body = gzipSync(json, { level: GZIP_LEVEL });
    response.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", "content-length": body.length, vary: "accept-encoding" });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  response.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": json.length });
  response.end(json);
}

export function sendText(response, status, text, contentType = "text/plain; charset=utf-8") {
  const body = Buffer.from(String(text));
  response.writeHead(status, { ...BASE_HEADERS, "content-type": contentType, "content-length": body.length });
  response.end(body);
}

export function sendHtml(response, status, html) {
  sendText(response, status, html, "text/html; charset=utf-8");
}

export function publicError(error) {
  return publicMessage(error, 500);
}

export async function readJsonBody(request, byteLimit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > byteLimit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** Percent-decodes one path segment; malformed input is returned as-is. */
export function decodeParam(part) {
  try { return decodeURIComponent(part); } catch { return part; }
}

/**
 * Byte-bounded LRU of prepared (serialised + optionally gzipped) JSON payloads
 * keyed by `run:<runId>` / `scope:<runId>:<scopeId>`; the index invalidates
 * per run as files change and drops everything on `cleared`.
 */
export function createPreparedCache({ index, cacheBytes = RUN_CACHE_BYTES } = {}) {
  const cache = createByteCache(cacheBytes);
  const onIndexEvent = (event) => {
    if (event?.type === "cleared") { cache.clear(); return; }
    if (typeof event?.runId === "string") {
      cache.deletePrefix(`run:${event.runId}`);
      cache.deletePrefix(`scope:${event.runId}:`);
    }
  };
  index?.events?.on("event", onIndexEvent);

  /** Returns the prepared payload for `key`, producing and caching it on a miss; null when `produce` yields nothing. */
  async function cached(key, produce) {
    const hit = cache.get(key);
    if (hit) return hit;
    const value = await produce();
    if (value === null || value === undefined) return null;
    return cache.set(key, await prepareJson(value));
  }

  return {
    cache,
    cached,
    close() { index?.events?.off("event", onIndexEvent); cache.clear(); },
  };
}

export function openBrowser(url) {
  const commands = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(commands[0], commands[1], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
