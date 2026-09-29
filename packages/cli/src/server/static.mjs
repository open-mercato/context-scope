/**
 * Static serving of the prebuilt UI (packages/cli/ui). Path-normalised to the
 * ui directory, no directory listing, `cache-control: no-store` everywhere
 * (the bundle is not content-hashed), correct MIME for the few types we ship.
 *
 * index.html gets a tiny inline script that moves `?token=` from the URL into
 * sessionStorage (the key the SPA reads) and rewrites the address bar with
 * `history.replaceState`, so the token never sits in history or a Referer.
 */
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { BASE_HEADERS } from "./http.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

export const TOKEN_STORAGE_KEY = "contextscope.token";

export const TOKEN_SCRIPT = `<script>(function(){try{var u=new URL(location.href);var t=u.searchParams.get("token");if(t){try{sessionStorage.setItem(${JSON.stringify(TOKEN_STORAGE_KEY)},t)}catch(e){}u.searchParams.delete("token");history.replaceState(null,"",u.pathname+(u.search||"")+u.hash)}}catch(e){}})();</script>`;

export function injectTokenScript(html) {
  const text = String(html);
  if (text.includes(TOKEN_SCRIPT)) return text;
  const head = text.indexOf("</head>");
  if (head >= 0) return `${text.slice(0, head)}${TOKEN_SCRIPT}\n${text.slice(head)}`;
  const script = text.search(/<script[\s>]/i);
  if (script >= 0) return `${text.slice(0, script)}${TOKEN_SCRIPT}\n${text.slice(script)}`;
  return `${TOKEN_SCRIPT}\n${text}`;
}

export function createStaticHandler(uiDir) {
  const root = path.resolve(uiDir);
  return async function serveStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes("\0")) return false;
    const relative = decoded === "/" ? "index.html" : path.posix.normalize(decoded).replace(/^\/+/, "");
    if (!relative || relative.startsWith("..")) return false;
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
    let details;
    try {
      details = await stat(resolved);
    } catch {
      return false;
    }
    if (!details.isFile()) return false;
    const type = MIME[path.extname(resolved).toLowerCase()];
    if (!type) return false;
    let body = await readFile(resolved);
    if (relative === "index.html") body = Buffer.from(injectTokenScript(body.toString("utf8")));
    response.writeHead(200, { ...BASE_HEADERS, "content-type": type, "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  };
}
