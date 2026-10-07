/**
 * Live watcher (ADR-003 section 3, no append-resume): watches the vendor
 * session directories and re-parses a changed transcript through
 * `index.ensure({ only: [mainFile] })` with a per-file leading-edge +
 * trailing debounce: the first change of a quiet file is parsed at once;
 * while changes keep landing the file is re-parsed every `debounceMs`
 * (a session in a tool loop writes every 0.5-1.5 s and must not starve
 * the UI until the burst ends). A run is idle after `idleMs` without a
 * change. The watcher is started only after consent (server/app.mjs).
 *
 *   Claude: <claudeProjects>/<project-dir>/<uuid>.jsonl plus, for sessions that
 *           changed recently, <project-dir>/<uuid>/subagents/ (a subagent file
 *           maps to its parent main file)
 *   Codex:  <codexSessions>/YYYY/MM/DD/rollout-*.jsonl (the day directories are
 *           re-listed on every rescan, so midnight needs no special case)
 *
 * Mechanics: one non-recursive `fs.watch` per directory (portable; capped at
 * `maxDirs`, most recently modified directories first). When `fs.watch`
 * throws or errors (EMFILE, ENOSPC, network homes) the watcher falls back to
 * polling: every `pollMs` it stats the active set (files whose mtime is within
 * `liveWindowMs`). The directory set is rebuilt every `rescanMs`.
 *
 * Events on the SSE hub after each live pass:
 *   { type: "live", runId, vendor, at, requests, peak, last, parseMs, file }   (sticky per run)
 *   { type: "live-idle", runId, at }                                           after `idleMs` without a change
 * The manifest on disk lags a live pass by up to LIVE_SAVE_INTERVAL_MS
 * (index/writer.mjs); the in-memory manifest the routes read is current.
 * Index events emitted during a pass the watcher started carry `live: true`
 * (prepended listener) so the UI can tell a live re-parse from a full pass.
 *
 * `index.liveRuns()` is attached here for the overview (S1): it returns
 * `Map<runId, { at: ISO string, vendor, requests, peak }>` of the runs whose
 * transcript changed within `idleMs`. Nothing outside the resolved vendor
 * roots is ever watched or stat'ed; no file content is read here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { resolveRoots } from "../util/fs.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_FILE = /^agent-[0-9a-f]+\.jsonl$/;
const CODEX_FILE = /^rollout-.+\.jsonl$/;
const DAY_DIR = /^\d{2}$/;

export const DEFAULTS = Object.freeze({
  debounceMs: 2_000,
  idleMs: 120_000,
  pollMs: 5_000,
  rescanMs: 60_000,
  liveWindowMs: 15 * 60_000,
  maxDirs: 300,
});

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Maps a changed path to the main session file it belongs to, or null when the
 * path is not a session transcript under the allowlisted roots.
 */
export function mainFileFor(filePath, { claudeProjects, codexSessions }) {
  const abs = path.resolve(filePath);
  const name = path.basename(abs);
  if (!name.endsWith(".jsonl")) return null;
  if (inside(claudeProjects, abs)) {
    const rel = path.relative(claudeProjects, abs).split(path.sep);
    // <project-dir>/<uuid>.jsonl
    if (rel.length === 2 && UUID.test(name.slice(0, -6))) return abs;
    // <project-dir>/<uuid>/subagents/agent-*.jsonl
    if (rel.length === 4 && rel[2] === "subagents" && UUID.test(rel[1]) && SUBAGENT_FILE.test(name)) {
      return path.join(claudeProjects, rel[0], `${rel[1]}.jsonl`);
    }
    return null;
  }
  if (inside(codexSessions, abs)) {
    const rel = path.relative(codexSessions, abs).split(path.sep);
    if (rel.length === 4 && CODEX_FILE.test(name)) return abs;
    return null;
  }
  return null;
}

async function listDir(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function mtimeOf(filePath) {
  try {
    const details = await stat(filePath);
    return { mtimeMs: details.mtimeMs, size: details.size, isFile: details.isFile(), isDirectory: details.isDirectory() };
  } catch {
    return null;
  }
}

/**
 * Directories to watch and files to poll, newest first, capped. Pure listing:
 * `{ dirs: string[], files: Map<path, { path, main, mtimeMs, size }> }` where
 * `files` holds every main and subagent transcript changed within the live
 * window (the active set) and `main` is the session file it belongs to.
 */
export async function discoverWatchSet({ claudeProjects, codexSessions }, { now = Date.now(), liveWindowMs = DEFAULTS.liveWindowMs, maxDirs = DEFAULTS.maxDirs } = {}) {
  const dirs = [];
  const files = new Map();
  const liveSince = now - liveWindowMs;
  const remember = (filePath, main, details) => {
    if (details.mtimeMs >= liveSince) files.set(filePath, { path: filePath, main, mtimeMs: details.mtimeMs, size: details.size });
  };

  for (const entry of await listDir(claudeProjects)) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(claudeProjects, entry.name);
    let newest = 0;
    for (const file of await listDir(projectDir)) {
      if (!file.isFile() || !file.name.endsWith(".jsonl") || !UUID.test(file.name.slice(0, -6))) continue;
      const main = path.join(projectDir, file.name);
      const details = await mtimeOf(main);
      if (!details) continue;
      remember(main, main, details);
      let mtimeMs = details.mtimeMs;
      const subagents = path.join(projectDir, file.name.slice(0, -6), "subagents");
      const subDetails = await mtimeOf(subagents);
      if (subDetails?.isDirectory) {
        for (const sub of await listDir(subagents)) {
          if (!sub.isFile() || !SUBAGENT_FILE.test(sub.name)) continue;
          const subPath = path.join(subagents, sub.name);
          const d = await mtimeOf(subPath);
          if (!d) continue;
          remember(subPath, main, d);
          mtimeMs = Math.max(mtimeMs, d.mtimeMs);
        }
        if (mtimeMs >= liveSince) dirs.push({ dir: subagents, mtimeMs });
      }
      newest = Math.max(newest, mtimeMs);
    }
    dirs.push({ dir: projectDir, mtimeMs: newest });
  }

  for (const year of await listDir(codexSessions)) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const month of await listDir(path.join(codexSessions, year.name))) {
      if (!month.isDirectory() || !DAY_DIR.test(month.name)) continue;
      for (const day of await listDir(path.join(codexSessions, year.name, month.name))) {
        if (!day.isDirectory() || !DAY_DIR.test(day.name)) continue;
        const dayDir = path.join(codexSessions, year.name, month.name, day.name);
        let newest = 0;
        for (const file of await listDir(dayDir)) {
          if (!file.isFile() || !CODEX_FILE.test(file.name)) continue;
          const full = path.join(dayDir, file.name);
          const details = await mtimeOf(full);
          if (!details) continue;
          newest = Math.max(newest, details.mtimeMs);
          remember(full, full, details);
        }
        dirs.push({ dir: dayDir, mtimeMs: newest });
      }
    }
  }

  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dirs: dirs.slice(0, maxDirs).map((d) => d.dir), files };
}

/**
 * Starts watching. `isLive()` gates the re-parse (false before consent; the
 * server also defers `startWatcher` itself until consent so nothing under the
 * vendor roots is listed or stat'ed before the user agreed);
 * `watchFn` and `now` are injectable for tests. Returns `{ stop, mode, touch, rescan, liveRuns, watchedDirs, activeFiles, passes }`.
 */
export function startWatcher({
  index,
  sse,
  home = os.homedir(),
  env = process.env,
  roots = {},
  isLive = () => true,
  warn = (message) => console.error(message),
  watchFn = fs.watch,
  now = Date.now,
  debounceMs = DEFAULTS.debounceMs,
  idleMs = DEFAULTS.idleMs,
  pollMs = DEFAULTS.pollMs,
  rescanMs = DEFAULTS.rescanMs,
  liveWindowMs = DEFAULTS.liveWindowMs,
  maxDirs = DEFAULTS.maxDirs,
} = {}) {
  const resolved = resolveRoots({ home, env, roots });
  const allow = { claudeProjects: resolved.claudeProjects, codexSessions: resolved.codexSessions };
  const watchers = new Map();      // dir -> FSWatcher
  const pending = new Map();       // mainFile -> { timer, dirty, running } (leading-edge + trailing debounce state)
  const idleTimers = new Map();    // mainFile -> idle timer
  const liveRuns = new Map();      // runId -> { at, vendor, requests, peak, file }
  let known = new Map();           // file -> { main, mtimeMs, size } (active set: main + subagent transcripts)
  let mode = "watch";
  let pollTimer = null;
  let rescanTimer = null;
  let stopped = false;
  let livePass = false;
  let passes = 0;

  // Tag the index events of a pass this watcher started so the UI can keep its run in place.
  const tagger = (event) => { if (livePass && event && typeof event === "object") event.live = true; };
  index.events.prependListener("event", tagger);

  function switchToPolling(reason) {
    if (mode === "poll") return;
    mode = "poll";
    warn(`ContextScope: fs.watch unavailable (${reason}); polling live sessions every ${Math.round(pollMs / 1000)} s.`);
    for (const watcher of watchers.values()) { try { watcher.close(); } catch {} }
    watchers.clear();
    ensurePollTimer();
  }

  function ensurePollTimer() {
    if (pollTimer || stopped) return;
    pollTimer = setInterval(() => { poll().catch(() => {}); }, pollMs);
    pollTimer.unref?.();
  }

  /**
   * Stats `file`; true when it is new or its (mtime, size) moved since the last
   * look. Synchronous on purpose: two fs events for one write must not both
   * see the old stamp (the second would schedule a second, empty re-parse).
   */
  function changed(file, main) {
    let details;
    try { details = fs.statSync(file); } catch { return false; }
    if (!details.isFile()) return false;
    const previous = known.get(file);
    if (previous && previous.mtimeMs === details.mtimeMs && previous.size === details.size) return false;
    known.set(file, { main, mtimeMs: details.mtimeMs, size: details.size });
    return true;
  }

  async function poll() {
    if (stopped) return;
    for (const [file, info] of [...known]) {
      if (changed(file, info.main)) touch(info.main);
    }
  }

  function watchDir(dir) {
    if (watchers.has(dir) || mode !== "watch") return;
    if (!inside(allow.claudeProjects, dir) && !inside(allow.codexSessions, dir)) return;
    try {
      const watcher = watchFn(dir, { persistent: false }, (_eventType, filename) => {
        if (!filename) { rescan().catch(() => {}); return; }
        const full = path.join(dir, String(filename));
        const main = mainFileFor(full, allow);
        // FSEvents can replay a write that landed just before the watch started: only a moved (mtime, size) counts.
        if (main) { if (changed(full, main)) touch(main); }
        else if (inside(allow.claudeProjects, full) && !String(filename).includes(".")) rescan().catch(() => {}); // new <uuid>/ directory: pick up its subagents dir
      });
      watcher.on("error", (error) => switchToPolling(error?.code ?? error?.message ?? "error"));
      watchers.set(dir, watcher);
    } catch (error) {
      switchToPolling(error?.code ?? error?.message ?? "error");
    }
  }

  async function rescan() {
    if (stopped) return;
    const set = await discoverWatchSet(allow, { now: now(), liveWindowMs, maxDirs });
    // Polling covers the active set in both modes: a subagent file created after the dir scan is caught on the next rescan.
    const next = new Map();
    for (const [file, info] of set.files) next.set(file, known.get(file) ?? { main: info.main, mtimeMs: info.mtimeMs, size: info.size });
    known = next;
    if (mode === "watch") {
      const wanted = new Set(set.dirs);
      for (const [dir, watcher] of watchers) if (!wanted.has(dir)) { try { watcher.close(); } catch {} watchers.delete(dir); }
      for (const dir of set.dirs) watchDir(dir);
    } else {
      ensurePollTimer();
    }
  }

  /**
   * Schedules a re-parse of `mainFile`. Leading edge: a quiet file is parsed
   * at once. Trailing edge: changes that land while a parse runs or within
   * `debounceMs` after it are folded into one more parse at the end of that
   * hold, and so on while the transcript keeps growing.
   */
  function touch(mainFile) {
    if (stopped || !isLive()) return;
    const main = path.resolve(mainFile);
    if (!mainFileFor(main, allow)) return;
    const slot = pending.get(main) ?? { timer: null, dirty: false, running: false };
    pending.set(main, slot);
    if (slot.running || slot.timer) { slot.dirty = true; return; }
    runSlot(main, slot);
  }

  function runSlot(main, slot) {
    slot.dirty = false;
    slot.running = true;
    reparse(main)
      .catch((error) => warn(`ContextScope: live re-parse failed (${error?.message ?? error}).`))
      .finally(() => {
        slot.running = false;
        if (stopped) { pending.delete(main); return; }
        slot.timer = setTimeout(() => {
          slot.timer = null;
          if (slot.dirty) runSlot(main, slot);
          else pending.delete(main);
        }, debounceMs);
        slot.timer.unref?.();
      });
  }

  async function reparse(main) {
    if (stopped || !isLive()) return;
    const startedAt = now();
    const ownPass = !index.running;
    if (ownPass) livePass = true;
    try {
      await index.ensure({ only: [main] });
    } finally {
      if (ownPass) livePass = false;
    }
    passes += 1;
    if (stopped) return;
    const manifest = await index.manifest();
    const entry = manifest?.files?.[main];
    changed(main, main);
    if (!entry || entry.error || !entry.summary) return;
    const at = new Date(now()).toISOString();
    const info = { at, vendor: entry.vendor, requests: entry.summary.requests, peak: entry.summary.peak?.value ?? 0, file: entry.file };
    liveRuns.set(entry.runId, info);
    const event = { type: "live", runId: entry.runId, vendor: entry.vendor, at, requests: info.requests, peak: info.peak, parseMs: now() - startedAt, file: entry.file };
    sse?.broadcast(event, { sticky: `live:${entry.runId}` });
    armIdle(main, entry.runId);
  }

  function armIdle(main, runId) {
    if (idleTimers.has(main)) clearTimeout(idleTimers.get(main));
    const timer = setTimeout(() => {
      idleTimers.delete(main);
      liveRuns.delete(runId);
      sse?.forget(`live:${runId}`);
      sse?.broadcast({ type: "live-idle", runId, at: new Date(now()).toISOString() });
    }, idleMs);
    timer.unref?.();
    idleTimers.set(main, timer);
  }

  const api = {
    get mode() { return mode; },
    get watchedDirs() { return [...watchers.keys()]; },
    get activeFiles() { return [...known.keys()]; },
    /** Live passes completed so far (diagnostics, tests). */
    get passes() { return passes; },
    liveRuns: () => new Map(liveRuns),
    touch,
    rescan,
    /** Stops watching; resolves once a live pass still in flight has finished. */
    async stop() {
      stopped = true;
      index.events.off("event", tagger);
      for (const slot of pending.values()) if (slot.timer) clearTimeout(slot.timer);
      pending.clear();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      for (const watcher of watchers.values()) { try { watcher.close(); } catch {} }
      watchers.clear();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (rescanTimer) clearInterval(rescanTimer);
      rescanTimer = null;
      if (index.liveRuns === api.liveRuns) delete index.liveRuns;
      if (index.running) await index.ensure().catch(() => {});
    },
  };
  // Accessor for the overview (S1): `index.liveRuns()` -> Map<runId, { at, vendor, requests, peak, file }>.
  if (typeof index.liveRuns !== "function") index.liveRuns = api.liveRuns;

  rescan().catch((error) => warn(`ContextScope: live watcher could not list session directories (${error?.message ?? error}).`));
  rescanTimer = setInterval(() => { rescan().catch(() => {}); }, rescanMs);
  rescanTimer.unref?.();
  ensurePollTimer();
  return api;
}

/**
 * Capability probe for `contextscope status` (ADR-005 §6): opens one
 * non-persistent `fs.watch` on the first vendor session directory that exists
 * and closes it at once. `{ mode: "watch" | "poll" | "none", dir, reason }`;
 * "poll" is what `startWatcher` would fall back to (EMFILE, ENOSPC, a network
 * home), "none" means no session directory exists yet. Nothing is listed or
 * read; the probe touches no file.
 */
export async function probeWatchCapability({ home = os.homedir(), env = process.env, roots = {}, watchFn = fs.watch } = {}) {
  const resolved = resolveRoots({ home, env, roots });
  for (const dir of [resolved.claudeProjects, resolved.codexSessions]) {
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      const watcher = watchFn(dir, { persistent: false }, () => {});
      const result = await new Promise((resolve) => {
        const finish = (value) => { try { watcher.close(); } catch {} resolve(value); };
        watcher.once("error", (error) => finish({ mode: "poll", dir, reason: error?.code ?? error?.message ?? "error" }));
        setImmediate(() => finish({ mode: "watch", dir, reason: null }));
      });
      return result;
    } catch (error) {
      return { mode: "poll", dir, reason: error?.code ?? error?.message ?? "error" };
    }
  }
  return { mode: "none", dir: null, reason: "no session directory yet" };
}
