/**
 * API client with three backends behind one `api` object (ADR-003 section 4):
 *
 *   companion  today's fetch client for the loopback server (/api/v1, Bearer token)
 *   static     the hosted demo: JSON files served next to the bundle (`./demo/*.json`)
 *   memory     a `contextscope.export/1` document opened from a file or drop (export.ts)
 *
 * Selection: `?demo=1`, `<meta name="contextscope-mode" content="demo">`, or no
 * token under `/app` → static; `loadExport()` → memory; otherwise companion.
 * Outside companion mode the SSE subscription is a no-op that reports one
 * `done` event, thresholds edits stay in memory, and refresh re-emits `done`.
 * Every backend switch bumps `backendVersion`, so the index-event subscription
 * restarts against the new backend (review cycle 2, #2).
 *
 * Every call accepts an AbortSignal so screens can cancel in-flight downloads
 * on navigation; a 30 s timeout turns a hung companion into a NetworkError.
 * Responses may be gzip-encoded; fetch decodes them transparently.
 */
import { signal } from "@preact/signals";
import type { AgentScope, ChangesResponse, CostResponse, Export, Finding, Overview, Run, RunTail, SetupInventory, Severity, Thresholds, ToolCostRow } from "@ir/types.ts";

const TOKEN_KEY = "contextscope.token";
const TIMEOUT_MS = 30_000;
export const EXPORT_SCHEMA = "contextscope.export/1";
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

export function resolveToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}

/** The companion answered with a non-2xx status. */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ApiError"; }
}

/** The companion could not be reached (connection refused, DNS, timeout). */
export class NetworkError extends Error {
  constructor(message: string, public timedOut = false) { super(message); this.name = "NetworkError"; }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : (error as { name?: string } | null)?.name === "AbortError";
}

/** Run response: the main scope in full, child scopes as summaries (`partial: true`). */
export type RunResponse = Run & { findings: Finding[] };
/** One row per rule as grouped by the companion (`index/overview.mjs` groupFindings); the client adds `primary`/`vendor`. */
export interface ApiRuleGroup { ruleId: string; title: string; severity: Severity; scope: Finding["scope"]; sessions: number; occurrences: number; tokensAffected: number; findings: Finding[] }
/** The leverage-ranked "one change to make first" (`index/entry.mjs` rankFirstChange). */
export type FirstChange = Finding & { leverage?: number; removes?: { findings: number; sessions: number } };
export type FindingsResponse = { findings: Finding[]; groups?: ApiRuleGroup[]; firstFinding?: FirstChange; firstChange?: FirstChange };
export type SetupResponse = SetupInventory & { findings: Finding[] };
export type IndexEvent = { type: string; [key: string]: unknown };
export type IndexEventHandlers = { onEvent: (event: IndexEvent) => void; onOpen?: () => void; onError?: () => void };
/** `kind: "harness"` lists the machine's harness runs (SDK-driven, no tool use; ADR-005 §2) instead of a population. */
export type OverviewParams = { since?: string; limit?: number; scope?: "repo" | "all"; kind?: "harness" };
export type FindingsParams = { scope?: string; vendor?: string };
export type ExportOptions = { redact?: boolean; scopes?: "main" | "all" | string };
export type TailParams = { after: number; scope?: string; sig?: string };
/** `GET /api/v1/cost`: one run (`run`, optional scope id in `scope`) or the population (`scope: repo|all`, `since`). */
export type CostParams = { run?: string; scope?: string; since?: string };
/** GET /api/v1/changes (ADR-005 §1): `since` bounds the sessions, `file` narrows to one instruction file. */
export type ChangesParams = { since?: string; file?: string };
/** Live tail response (RunTail plus the server's live marker). */
export type TailResponse = RunTail & { requestCount?: number; live?: { at: string } };
/**
 * Index status as served today (`files`, `indexed`, `runsInRange`, `lastPass`)
 * with the legacy `total/done` aliases; `types.ts` still declares the cycle-1
 * shape, so the extra keys live here until the IR catches up (#13).
 */
export type IndexInfo = Overview["index"] & {
  files?: number; indexed?: number; runsInRange?: number;
  lastPass?: { parsed?: number; skipped?: number; failed?: number; ms?: number; at?: string; total?: number; done?: number };
};

/** What every backend answers; `api` delegates to the active one. */
export interface Backend {
  overview(params: OverviewParams, signal?: AbortSignal): Promise<Overview>;
  run(vendor: string, id: string, signal?: AbortSignal): Promise<RunResponse>;
  scope(vendor: string, id: string, scopeId: string, signal?: AbortSignal): Promise<AgentScope>;
  /** Live tail (companion only; the others answer 404). */
  tail(vendor: string, id: string, params: TailParams, signal?: AbortSignal): Promise<TailResponse>;
  setup(signal?: AbortSignal): Promise<SetupResponse>;
  findings(params: FindingsParams, signal?: AbortSignal): Promise<FindingsResponse>;
  thresholds(signal?: AbortSignal): Promise<Thresholds>;
  saveThresholds(thresholds: Thresholds): Promise<Thresholds>;
  refreshIndex(): Promise<{ ok: true }>;
  indexEvents(handlers: IndexEventHandlers): () => void;
  exportRun(vendor: string, id: string, options?: ExportOptions): Promise<Export>;
  /** Before/after per instruction-file edit (companion only; the file-backed backends answer 404). */
  changes?(params: ChangesParams, signal?: AbortSignal): Promise<ChangesResponse>;
  /** Per-tool cost (ADR-005 section 5); optional: the file-backed backends answer a `run` query from the loaded run (`localCost`). */
  cost?(params: CostParams, signal?: AbortSignal): Promise<CostResponse>;
}

// ---------- fetch with timeout ----------

async function fetchJson<T>(path: string, init: RequestInit = {}, signal?: AbortSignal, { auth = true } = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    let response: Response;
    try {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}), accept: "application/json" };
      if (auth) headers.authorization = `Bearer ${resolveToken()}`;
      response = await fetch(path, { ...init, signal: controller.signal, headers });
    } catch (error) {
      if (signal?.aborted && !timedOut) throw error; // caller cancelled: propagate the AbortError untouched
      if (timedOut) throw new NetworkError(`No answer from the companion after ${TIMEOUT_MS / 1000} s`, true);
      throw new NetworkError((error as Error)?.message || "Failed to fetch");
    }
    if (!response.ok) {
      let detail = "";
      try { const body = await response.json() as { error?: string }; if (body?.error) detail = `: ${body.error}`; } catch { /* no body */ }
      throw new ApiError(response.status, `${response.status} ${response.statusText}${detail}`);
    }
    try { return await response.json() as T; }
    catch (error) {
      if (signal?.aborted && !timedOut) throw error;
      throw new NetworkError(`Malformed response from the companion (${(error as Error)?.message ?? "invalid JSON"})`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

const request = <T,>(path: string, init: RequestInit = {}, signal?: AbortSignal) => fetchJson<T>(path, init, signal);
const seg = (value: string) => encodeURIComponent(value);

// ---------- companion ----------

const companion: Backend = {
  overview: (params = {}, signal) => {
    const query = new URLSearchParams();
    if (params.since) query.set("since", params.since);
    if (params.scope) query.set("scope", params.scope);
    if (params.kind) query.set("kind", params.kind);
    if (params.limit) query.set("limit", String(params.limit));
    return request<Overview>(`/api/v1/overview${query.size ? `?${query}` : ""}`, {}, signal);
  },
  run: (vendor, id, signal) => request<RunResponse>(`/api/v1/runs/${seg(vendor)}/${seg(id)}`, {}, signal),
  scope: (vendor, id, scopeId, signal) => request<AgentScope>(`/api/v1/runs/${seg(vendor)}/${seg(id)}/scopes/${seg(scopeId)}`, {}, signal),
  tail: (vendor, id, params, signal) => {
    const query = new URLSearchParams({ after: String(params.after) });
    if (params.scope) query.set("scope", params.scope);
    if (params.sig) query.set("sig", params.sig);
    return request<TailResponse>(`/api/v1/runs/${seg(vendor)}/${seg(id)}/tail?${query}`, {}, signal);
  },
  setup: (signal) => request<SetupResponse>("/api/v1/setup", {}, signal),
  findings: (params = {}, signal) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<FindingsResponse>(`/api/v1/findings${query.size ? `?${query}` : ""}`, {}, signal);
  },
  thresholds: (signal) => request<Thresholds>("/api/v1/thresholds", {}, signal),
  saveThresholds: (thresholds) => request<Thresholds | { thresholds: Thresholds; reevaluating?: boolean }>("/api/v1/thresholds", { method: "PUT", body: JSON.stringify(thresholds), headers: { "content-type": "application/json" } }).then((result) => ("thresholds" in result && typeof result.thresholds === "object" ? result.thresholds : result) as Thresholds),
  refreshIndex: () => request<{ ok: true }>("/api/v1/index/refresh", { method: "POST" }),
  indexEvents(handlers) {
    const token = resolveToken();
    const source = new EventSource(`/api/v1/index/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (message) => { try { handlers.onEvent(JSON.parse(message.data)); } catch { /* ignore */ } };
    source.onopen = () => handlers.onOpen?.();
    source.onerror = () => handlers.onError?.();
    return () => source.close();
  },
  exportRun: (vendor, id, options = {}) => {
    const query = new URLSearchParams();
    if (options.redact) query.set("redact", "1");
    if (options.scopes) query.set("scopes", options.scopes);
    return request<Export>(`/api/v1/runs/${seg(vendor)}/${seg(id)}/export${query.size ? `?${query}` : ""}`);
  },
  cost: (params = {}, signal) => {
    const query = new URLSearchParams();
    if (params.run) query.set("run", params.run);
    if (params.scope) query.set("scope", params.scope);
    if (params.since) query.set("since", params.since);
    return request<CostResponse>(`/api/v1/cost${query.size ? `?${query}` : ""}`, {}, signal);
  },
  changes: (params = {}, signal) => {
    const query = new URLSearchParams();
    if (params.since) query.set("since", params.since);
    if (params.file) query.set("file", params.file);
    return request<ChangesResponse>(`/api/v1/changes${query.size ? `?${query}` : ""}`, {}, signal);
  },
};

// ---------- shared pieces for the file-backed backends ----------

/** One `done` event on the next tick; `refreshIndex` re-emits it so the pill and the screens settle. */
export function localEvents(files: number) {
  let listeners: IndexEventHandlers[] = [];
  const done = (): IndexEvent => ({ type: "done", total: state.files, done: state.files, files: state.files });
  const state = {
    files,
    subscribe(handlers: IndexEventHandlers): () => void {
      listeners.push(handlers);
      setTimeout(() => { if (listeners.includes(handlers)) { handlers.onOpen?.(); handlers.onEvent(done()); } }, 0);
      return () => { listeners = listeners.filter((h) => h !== handlers); };
    },
    async refresh(): Promise<{ ok: true }> {
      setTimeout(() => { for (const handlers of listeners) handlers.onEvent(done()); }, 0);
      return { ok: true };
    },
  };
  return state;
}

export function localThresholds(initial: () => Promise<Thresholds>) {
  let current: Thresholds | null = null;
  return {
    async get(): Promise<Thresholds> { current ??= { ...(await initial()) }; return { ...current }; },
    async save(patch: Thresholds): Promise<Thresholds> {
      const base = await this.get();
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ApiError(400, `400 Bad Request: "${key}" must be a non-negative number`);
      }
      current = { ...base, ...patch };
      return { ...current };
    },
  };
}

export function filterFindings(list: Finding[], params: FindingsParams): Finding[] {
  return list.filter((finding) => (!params.scope || finding.scope === params.scope) && (!params.vendor || !finding.vendor || finding.vendor === params.vendor));
}

const noTail = async (): Promise<TailResponse> => { throw new ApiError(404, "404 Not Found: live tail is not available outside the companion"); };

// ---------- static (hosted demo) ----------

/** `./demo/` next to the bundle, or the `contextscope-demo-base` meta content. */
export function demoBase(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="contextscope-demo-base"]')?.content;
  return new URL(meta || "./demo/", document.baseURI).href;
}

function createStaticBackend(base: string): Backend {
  const file = <T,>(name: string, signal?: AbortSignal) => fetchJson<T>(new URL(name, base).href, {}, signal, { auth: false });
  const runFile = (vendor: string, id: string) => `runs/${seg(vendor)}--${seg(id)}.json`;
  const events = localEvents(0);
  const thresholds = localThresholds(() => file<Thresholds>("thresholds.json"));
  return {
    async overview(params = {}, signal) {
      // `overview-all.json` (every project of the demo machine) exists when the dataset ships it;
      // otherwise the repo overview is served with `scope.mode` flipped so the header stays honest.
      let overview: Overview;
      if (params.scope === "all") {
        overview = await file<Overview>("overview-all.json", signal).catch(async (error: unknown) => {
          if (error instanceof ApiError && error.status === 404) { const repo = await file<Overview>("overview.json", signal); return repo.scope ? { ...repo, scope: { ...repo.scope, mode: "all" as const } } : repo; }
          throw error;
        });
      } else overview = await file<Overview>("overview.json", signal);
      events.files = (overview.index as IndexInfo | undefined)?.files ?? overview.runs.length;
      return params.limit && overview.runs.length > params.limit ? { ...overview, runs: overview.runs.slice(0, params.limit) } : overview;
    },
    run: (vendor, id, signal) => file<RunResponse>(runFile(vendor, id), signal),
    scope: (vendor, id, scopeId, signal) => file<AgentScope>(`runs/${seg(vendor)}--${seg(id)}.scopes/${seg(scopeId)}.json`, signal),
    tail: noTail,
    setup: (signal) => file<SetupResponse>("setup.json", signal),
    async findings(params = {}, signal) {
      const all = await file<FindingsResponse>("findings.json", signal);
      const findings = filterFindings(all.findings ?? [], params);
      const first = all.firstChange ?? all.firstFinding;
      const groups = params.scope || params.vendor ? undefined : all.groups;
      return { findings, groups, firstChange: first && findings.some((f) => f.id === first.id) ? first : findings[0] };
    },
    thresholds: () => thresholds.get(),
    saveThresholds: (patch) => thresholds.save(patch),
    refreshIndex: () => events.refresh(),
    indexEvents: (handlers) => events.subscribe(handlers),
    async exportRun(vendor, id, options = {}) {
      const run = await this.run(vendor, id);
      const main = run.scopes[0];
      const full = main.partial || !main.requests ? await this.scope(vendor, id, main.id) : main;
      const { buildClientExport } = await import("./export.ts");
      return buildClientExport(run, { [main.id]: { ...main, ...full, partial: false } }, await thresholds.get(), options);
    },
  };
}

// ---------- selection ----------

export type BackendMode = "companion" | "static" | "memory";
export interface BackendInfo { mode: BackendMode; /** Short label for the banner: dataset name, file name. */ label?: string }

function detectMode(): BackendMode {
  try {
    if (new URLSearchParams(location.search).get("demo") === "1") return "static";
    if (document.querySelector('meta[name="contextscope-mode"][content="demo"]')) return "static";
    if (!resolveToken() && location.pathname.startsWith("/app")) return "static";
  } catch { /* no DOM */ }
  return "companion";
}

const initialMode = detectMode();
let active: Backend = initialMode === "static" ? createStaticBackend(demoBase()) : companion;

/**
 * Outside companion mode, same-origin `/api/v1/*` fetches are answered by the
 * active backend, so code that talks to the companion directly works on the
 * demo and on an opened export without knowing which backend is active.
 * Routes with no local equivalent (`tail`, `habits`) answer 404 so callers
 * fall back cleanly.
 */
const nativeFetch = typeof window !== "undefined" ? window.fetch.bind(window) : null;
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
async function answerLocally(url: URL, init: RequestInit | undefined): Promise<Response> {
  const rest = url.pathname.slice("/api/v1/".length);
  const method = (init?.method ?? "GET").toUpperCase();
  const signal = init?.signal ?? undefined;
  try {
    if (rest === "overview") {
      const wanted = url.searchParams.get("scope");
      return jsonResponse(await active.overview({ since: url.searchParams.get("since") ?? undefined, limit: Number(url.searchParams.get("limit")) || undefined, scope: wanted === "all" ? "all" : "repo" }, signal));
    }
    if (rest === "setup") return jsonResponse(await active.setup(signal));
    if (rest === "findings") return jsonResponse(await active.findings({ scope: url.searchParams.get("scope") ?? undefined, vendor: url.searchParams.get("vendor") ?? undefined }, signal));
    if (rest === "thresholds" && method === "GET") return jsonResponse(await active.thresholds(signal));
    if (rest === "thresholds" && method === "PUT") return jsonResponse(await active.saveThresholds(JSON.parse(String(init?.body ?? "{}")) as Thresholds));
    if (rest === "index/refresh") return jsonResponse(await active.refreshIndex());
    const run = /^runs\/([^/]+)\/([^/]+)(?:\/(scopes\/([^/]+)|export|tail))?$/.exec(rest);
    if (run) {
      const vendor = decodeURIComponent(run[1]);
      const id = decodeURIComponent(run[2]);
      if (!run[3]) return jsonResponse(await active.run(vendor, id, signal));
      if (run[4]) return jsonResponse(await active.scope(vendor, id, decodeURIComponent(run[4]), signal));
      if (run[3] === "export") return jsonResponse(await active.exportRun(vendor, id, { redact: url.searchParams.get("redact") === "1", scopes: url.searchParams.get("scopes") ?? undefined }));
      return jsonResponse({ error: "Live tail is not available outside the companion." }, 404);
    }
    return jsonResponse({ error: `No local equivalent for /api/v1/${rest} in ${backend.value.mode} mode.` }, 404);
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    if (isAbortError(error)) throw error;
    return jsonResponse({ error: (error as Error)?.message ?? "failed" }, 502);
  }
}
let shimInstalled = false;
function installFetchShim(): void {
  if (shimInstalled || !nativeFetch) return;
  shimInstalled = true;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (backend.value.mode !== "companion") {
      try {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.origin === location.origin && url.pathname.startsWith("/api/v1/")) return answerLocally(url, init);
      } catch { /* fall through to the network */ }
    }
    return nativeFetch(input, init);
  };
}
/** The active backend; screens read it to show the demo banner and to hide companion-only affordances. */
export const backend = signal<BackendInfo>({ mode: initialMode, label: initialMode === "static" ? "synthetic sessions" : undefined });
/** Bumped on every backend switch; the index-event subscription is keyed on it. */
export const backendVersion = signal(0);
if (initialMode !== "companion") installFetchShim();
/** The export currently loaded in memory mode, if any. */
export const loadedExport = signal<Export | null>(null);

export function isCompanion(): boolean { return backend.value.mode === "companion"; }
/** The mode the page started in (what "Back to …" returns to). */
export function startedInCompanion(): boolean { return initialMode === "companion"; }

/** Switches to `memoryBackend` for `doc`; returns the run's vendor and id for navigation. */
export function loadExport(memoryBackend: Backend, doc: Export, label?: string): { vendor: string; id: string } {
  active = memoryBackend;
  loadedExport.value = doc;
  backend.value = { mode: "memory", label: label ?? doc.run.id };
  installFetchShim();
  backendVersion.value++;
  const at = doc.run.id.indexOf(":");
  return { vendor: doc.run.id.slice(0, at), id: doc.run.id.slice(at + 1) };
}

/** Back to the demo dataset (static) or the companion, whichever the page started with. */
export function unloadExport(): void {
  loadedExport.value = null;
  active = initialMode === "static" ? createStaticBackend(demoBase()) : companion;
  backend.value = { mode: initialMode, label: initialMode === "static" ? "synthetic sessions" : undefined };
  backendVersion.value++;
}

/** Hands the browser a JSON file (used by an "Export" button; the page itself never uploads anything). */
export function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Mirrors TOOL_COST_CAVEATS in packages/cli/src/ir/finalize.mjs (what a token-request is not). */
export const COST_CAVEATS: readonly string[] = [
  "Presence is not attention: a block counts for every request it sits in, whether the model used it or not.",
  "A cached token costs roughly a tenth of a fresh one on Claude; uncached weights each request by its uncached share and sits next to token-requests.",
  "Residue of blocks dropped at a compaction lives inside the compaction summary and is attributed to the summary, not to the tool.",
  "Clamped requests use the clamped scale k.",
];

/** `api.cost` outside the companion: one run's (or one scope's) table from the loaded run; no population to sum. */
async function localCost(params: CostParams, signal?: AbortSignal): Promise<CostResponse> {
  if (!params.run) throw new ApiError(404, "404 Not Found: the population cost table needs the companion");
  const at = params.run.indexOf(":");
  const run = await active.run(params.run.slice(0, at), params.run.slice(at + 1), signal);
  const scopeId = params.scope || undefined;
  const scope = scopeId ? run.scopes.find((s) => s.id === scopeId) : undefined;
  if (scopeId && !scope) throw new ApiError(404, `404 Not Found: scope ${scopeId} is not in ${run.id}`);
  const rows: ToolCostRow[] = (scope ? scope.toolCost : run.summary.toolCost) ?? [];
  return { unit: "token-requests", provenance: "estimated.local", scope: scopeId ? { mode: "run", runId: run.id, scopeId } : { mode: "run", runId: run.id }, denominator: scope ? scope.processedInputTokens : run.summary.processedInputTokens, rows, caveats: [...COST_CAVEATS] };
}

export const api = {
  overview: (params: OverviewParams = {}, signal?: AbortSignal) => active.overview(params, signal),
  run: (vendor: string, id: string, signal?: AbortSignal) => active.run(vendor, id, signal),
  scope: (vendor: string, id: string, scopeId: string, signal?: AbortSignal) => active.scope(vendor, id, scopeId, signal),
  tail: (vendor: string, id: string, params: TailParams, signal?: AbortSignal) => active.tail(vendor, id, params, signal),
  setup: (signal?: AbortSignal) => active.setup(signal),
  findings: (params: FindingsParams = {}, signal?: AbortSignal) => active.findings(params, signal),
  thresholds: (signal?: AbortSignal) => active.thresholds(signal),
  saveThresholds: (thresholds: Thresholds) => active.saveThresholds(thresholds),
  refreshIndex: () => active.refreshIndex(),
  indexEvents: (handlers: IndexEventHandlers): (() => void) => active.indexEvents(handlers),
  /** `contextscope.export/1` for a run: the companion route, the loaded document, or a browser-side assembly of the demo run. */
  exportRun: (vendor: string, id: string, options: ExportOptions = {}) => active.exportRun(vendor, id, options),
  /** Before/after per instruction-file edit; outside the companion there is no session population to pair, so this rejects with a 404 ApiError. */
  changes: (params: ChangesParams = {}, signal?: AbortSignal): Promise<ChangesResponse> => active.changes ? active.changes(params, signal) : Promise.reject(new ApiError(404, "404 Not Found: before/after needs the companion")),
  /** Per-tool cost table: the companion route, or (`run` given) the rows the loaded run already carries; the population table needs the companion. */
  cost: (params: CostParams = {}, signal?: AbortSignal): Promise<CostResponse> => (active.cost ? active.cost(params, signal) : localCost(params, signal)),
};
