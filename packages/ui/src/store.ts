/**
 * App-wide signals: theme, toasts, index status, keyboard map, threshold drawer.
 * Screens and components import from here instead of threading props.
 */
import { signal } from "@preact/signals";
import type { Request, Thresholds } from "@ir/types.ts";
import { api, backend } from "./api.ts";

// ---------- theme ----------
export type Theme = "light" | "dark" | "system";
const THEME_KEY = "contextscope.theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* storage unavailable */ }
  return "system";
}

export const theme = signal<Theme>(readTheme());
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
/** Mirrors the OS preference so "system" mode re-renders when the OS switches. */
export const systemDark = signal<boolean>(darkQuery?.matches ?? false);
darkQuery?.addEventListener?.("change", (event) => { systemDark.value = event.matches; });

export function applyTheme(value: Theme) {
  const root = document.documentElement;
  if (value === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", value);
}

export function setTheme(value: Theme) {
  theme.value = value;
  applyTheme(value);
  try {
    if (value === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch { /* storage unavailable */ }
}

export function effectiveTheme(): "light" | "dark" {
  if (theme.value !== "system") return theme.value;
  return systemDark.value ? "dark" : "light";
}

export function toggleTheme() {
  setTheme(effectiveTheme() === "dark" ? "light" : "dark");
}

applyTheme(theme.value);

// ---------- toasts ----------
export interface ToastItem { id: number; message: string; tone: "info" | "success" | "error" }
export const toasts = signal<ToastItem[]>([]);
let toastSeq = 0;

export function toast(message: string, tone: ToastItem["tone"] = "info", ttlMs = 3200) {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, message, tone }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, ttlMs);
}

// ---------- index status ----------
export interface IndexStatus {
  state: "connecting" | "indexing" | "idle" | "offline";
  /** Progress of the running pass (files touched so far / files in this pass). */
  done: number;
  total: number;
  /** Corpus size (files known to the index), from the overview `index.files` or the SSE `done` event. */
  files?: number;
  lastRunAt?: number;
}
export const indexStatus = signal<IndexStatus>({ state: "connecting", done: 0, total: 0 });
/** Bumped every time indexing finishes so screens can refetch. */
export const indexVersion = signal(0);
/** Bumped after thresholds are saved (rules re-run server-side) so every screen refetches its findings. */
export const rulesVersion = signal(0);

let stopEvents: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_TIMEOUT_MS = 120_000;

export function startIndexEvents() {
  stopEvents?.();
  stopEvents = api.indexEvents({
    onOpen: () => {
      if (indexStatus.value.state === "connecting" || indexStatus.value.state === "offline") indexStatus.value = { ...indexStatus.value, state: "idle" };
    },
    onError: () => { indexStatus.value = { ...indexStatus.value, state: "offline" }; },
    onEvent: (event) => {
      if (event.type === "live" || event.type === "live-idle") { noteLiveEvent(event); return; }
      // A pass started by the live watcher (one re-parsed transcript) carries `live: true`:
      // the session screen appends its tail instead of reloading, and the pill stays quiet.
      if (event.live === true) {
        if (event.type === "done" && indexStatus.value.state !== "indexing") indexStatus.value = { ...indexStatus.value, lastRunAt: Date.now() };
        return;
      }
      if (event.type === "progress") {
        indexStatus.value = { ...indexStatus.value, state: "indexing", done: Number(event.done ?? 0), total: Number(event.total ?? 0) };
      } else if (event.type === "done") {
        const total = Number(event.total ?? indexStatus.value.total);
        const files = event.files !== undefined ? Number(event.files) : indexStatus.value.files;
        indexStatus.value = { state: "idle", done: total, total, files, lastRunAt: Date.now() };
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        indexVersion.value++;
      } else if (event.type === "error") {
        indexStatus.value = { ...indexStatus.value, state: "offline" };
      }
    },
  });
}

/** Fold the overview's `index` block into the pill (corpus size, last pass time). */
export function noteIndexFromOverview(index: { files?: number; total?: number; lastPass?: { at?: string }; lastRunAt?: string; state?: string } | undefined) {
  if (!index) return;
  const at = index.lastPass?.at ?? index.lastRunAt;
  const stamp = at ? Date.parse(at) : NaN;
  const current = indexStatus.value;
  indexStatus.value = {
    ...current,
    state: current.state === "indexing" || current.state === "offline" ? current.state : index.state === "indexing" ? "indexing" : "idle",
    files: index.files ?? index.total ?? current.files,
    lastRunAt: Number.isFinite(stamp) ? Math.max(stamp, current.lastRunAt ?? 0) : current.lastRunAt,
  };
}

export async function refreshIndex() {
  const mode = backend.value.mode;
  if (mode !== "companion") {
    // No index outside the companion: the file-backed backends re-emit `done` on the next tick, which
    // bumps `indexVersion` so every screen refetches its JSON (demo) or re-reads the document (export).
    try { await api.refreshIndex(); toast(mode === "static" ? "Reloaded the demo files" : "Reloaded the opened export", "info"); }
    catch (error) { toast(`Reload failed: ${(error as Error).message}`, "error"); }
    return;
  }
  try {
    indexStatus.value = { ...indexStatus.value, state: "indexing" };
    await api.refreshIndex();
    toast("Re-indexing sessions", "info");
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (indexStatus.value.state === "indexing") {
        indexStatus.value = { ...indexStatus.value, state: "idle" };
        toast("No completion event from the companion; the index may still be running", "error");
      }
    }, REFRESH_TIMEOUT_MS);
  } catch (error) {
    indexStatus.value = { ...indexStatus.value, state: "offline" };
    toast(`Refresh failed: ${(error as Error).message}`, "error");
  }
}

// ---------- live sessions (ADR-003 section 3) ----------
export interface LiveInfo {
  /** ISO time of the last live re-parse. */
  at: string;
  vendor?: string;
  requests?: number;
  peak?: number;
  parseMs?: number;
  /** Bumped on every `live` event for this run; the session screen keys its tail fetch on it. */
  seq: number;
}
/** Runs whose transcript changed recently, keyed by run id (`vendor:sessionId`). Folded from SSE `live` / `live-idle`. */
export const liveRuns = signal<ReadonlyMap<string, LiveInfo>>(new Map());
/**
 * Runs the watcher declared idle (`live-idle`) since the page loaded. The overview
 * carries a `live` marker fetched at load time; this set overrides it so a row
 * stops saying "live" the moment the watcher says so, not after a refetch (#5).
 */
export const liveIdle = signal<ReadonlySet<string>>(new Set());

export function noteLiveEvent(event: { type: string; [key: string]: unknown }) {
  const runId = typeof event.runId === "string" ? event.runId : "";
  if (!runId) return;
  const next = new Map(liveRuns.value);
  if (event.type === "live-idle") {
    if (!liveIdle.value.has(runId)) liveIdle.value = new Set([...liveIdle.value, runId]);
    if (!next.delete(runId)) return;
    liveRuns.value = next;
    return;
  }
  if (liveIdle.value.has(runId)) { const idle = new Set(liveIdle.value); idle.delete(runId); liveIdle.value = idle; }
  const previous = next.get(runId);
  next.set(runId, {
    at: typeof event.at === "string" ? event.at : new Date().toISOString(),
    vendor: typeof event.vendor === "string" ? event.vendor : previous?.vendor,
    requests: typeof event.requests === "number" ? event.requests : previous?.requests,
    peak: typeof event.peak === "number" ? event.peak : previous?.peak,
    parseMs: typeof event.parseMs === "number" ? event.parseMs : previous?.parseMs,
    seq: (previous?.seq ?? 0) + 1,
  });
  liveRuns.value = next;
}

/**
 * Order-sensitive signature of requests[0..upTo] (index, total, reconciled
 * composition); mirrors `requestsSignature` in packages/cli/src/server/routes/runs.mjs.
 * Resolves to "" when SubtleCrypto is unavailable (the server then skips the check).
 */
export async function requestsSignature(requests: Request[], upTo: number): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "";
  let text = "";
  const end = Math.min(upTo, requests.length - 1);
  for (let i = 0; i <= end; i++) {
    const r = requests[i];
    const comp = (r.composition ?? {}) as Record<string, number | undefined>;
    let parts = "";
    for (const key of Object.keys(comp).sort()) if (comp[key]) parts += `${key}=${Math.round(comp[key] as number)},`;
    text += `${r.index}:${r.usage?.total ?? 0}:${parts}\n`;
  }
  try {
    const digest = await subtle.digest("SHA-1", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch {
    return "";
  }
}

// ---------- files dropped outside #/open ----------
/** A file dropped anywhere in the app; the Open screen picks it up and opens it (#21). */
export const pendingFile = signal<File | null>(null);

// ---------- keyboard map, command palette ----------
export const keyboardMapOpen = signal(false);
/** ⌘K / Ctrl+K: jump to a session, screen or action. */
export const paletteOpen = signal(false);

/** True while any modal (keyboard map, palette, thresholds drawer) is open; screen key handlers must stand down. */
export function modalOpen(): boolean {
  return keyboardMapOpen.value || paletteOpen.value || thresholdsDrawerOpen.value;
}

/** Live runs that are neither idle nor stale: what the top bar and the overview hero show. */
export function activeLiveRuns(now = Date.now(), staleMs = 3 * 60_000): Array<[string, LiveInfo]> {
  const out: Array<[string, LiveInfo]> = [];
  for (const [id, info] of liveRuns.value) {
    if (liveIdle.value.has(id)) continue;
    const at = Date.parse(info.at);
    if (Number.isFinite(at) && now - at <= staleMs) out.push([id, info]);
  }
  return out;
}

// ---------- thresholds ----------
export const thresholds = signal<Thresholds | null>(null);
/** When set, the findings screen opens the thresholds drawer and highlights this key. */
export const thresholdEditKey = signal<string | null>(null);
export const thresholdsDrawerOpen = signal(false);

let thresholdsInFlight: Promise<Thresholds | null> | null = null;

/** Fetch thresholds once; concurrent callers share the same promise. */
export function loadThresholds(force = false): Promise<Thresholds | null> {
  if (thresholds.value && !force) return Promise.resolve(thresholds.value);
  if (thresholdsInFlight && !force) return thresholdsInFlight;
  thresholdsInFlight = api.thresholds()
    .then((value) => { thresholds.value = value; return value; })
    .catch(() => thresholds.value) // leave as-is; cards then omit the "fires above" line
    .finally(() => { thresholdsInFlight = null; });
  return thresholdsInFlight;
}

// ---------- clipboard ----------
export async function copyText(text: string, label = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "success");
    return true;
  } catch {
    // Fallback for non-secure contexts: a temporary textarea + execCommand.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      toast(ok ? label : "Copy failed", ok ? "success" : "error");
      return ok;
    } catch {
      toast("Copy failed", "error");
      return false;
    }
  }
}
