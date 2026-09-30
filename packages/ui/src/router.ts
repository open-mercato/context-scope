import { signal } from "@preact/signals";

export type Route =
  | { name: "overview" }
  | { name: "session"; vendor: string; id: string; scope?: string; request?: number }
  | { name: "setup"; file?: string }
  | { name: "findings"; scope?: string; vendor?: string }
  | { name: "open" }
  | { name: "tokens" }
  | { name: "notfound"; path: string };

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart = ""] = raw.split("?");
  const query = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length === 0) return { name: "overview" };
  if (segments[0] === "session" && segments.length >= 3) {
    const requestParam = query.get("request");
    const requestIndex = requestParam !== null && /^\d+$/.test(requestParam) ? Number(requestParam) : undefined;
    return { name: "session", vendor: safeDecode(segments[1]), id: safeDecode(segments[2]), scope: query.get("scope") ?? undefined, request: requestIndex };
  }
  if (segments[0] === "setup") return { name: "setup", file: query.get("file") ?? undefined };
  if (segments[0] === "findings") return { name: "findings", scope: query.get("scope") ?? undefined, vendor: query.get("vendor") ?? undefined };
  if (segments[0] === "open") return { name: "open" };
  if (segments[0] === "tokens") return { name: "tokens" };
  return { name: "notfound", path: pathPart };
}

/** Identity of the screen instance: the error boundary and scroll reset key on this. */
export function routeKey(route: Route): string {
  switch (route.name) {
    case "session": return `session/${route.vendor}/${route.id}`;
    case "setup": return "setup";
    case "findings": return "findings";
    case "overview": return "overview";
    case "open": return "open";
    case "tokens": return "tokens";
    default: return `notfound/${route.path}`;
  }
}

/** True when the route carries an in-page anchor (do not scroll to top on change). */
export function routeHasAnchor(route: Route): boolean {
  return (route.name === "session" && route.request !== undefined) || (route.name === "setup" && !!route.file);
}

export const route = signal<Route>(parseHash(location.hash));
window.addEventListener("hashchange", () => { route.value = parseHash(location.hash); });

export function navigate(hash: string) {
  if (location.hash === hash) route.value = parseHash(hash);
  else location.hash = hash;
}

export const hrefs = {
  overview: () => "#/",
  session: (vendor: string, id: string, options: { scope?: string; request?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.scope && options.scope !== "main") query.set("scope", options.scope);
    if (options.request !== undefined) query.set("request", String(options.request));
    return `#/session/${encodeURIComponent(vendor)}/${encodeURIComponent(id)}${query.size ? `?${query}` : ""}`;
  },
  setup: (options: { file?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.file) query.set("file", options.file);
    return `#/setup${query.size ? `?${query}` : ""}`;
  },
  /** Drop zone / file picker for a `contextscope.export/1` document. */
  open: () => "#/open",
  /** Paste text or add files and count tokens locally. */
  tokens: () => "#/tokens",
  findings: (options: { scope?: string; vendor?: string; run?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.scope) query.set("scope", options.scope);
    if (options.vendor) query.set("vendor", options.vendor);
    return `#/findings${query.size ? `?${query}` : ""}`;
  },
};

export function splitRunId(runId: string): { vendor: string; id: string } {
  const at = runId.indexOf(":");
  return at < 0 ? { vendor: "claude", id: runId } : { vendor: runId.slice(0, at), id: runId.slice(at + 1) };
}
