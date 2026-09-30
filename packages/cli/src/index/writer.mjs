/**
 * The incremental index. `createIndex({ home })` returns one index instance
 * bound to a home directory; `ensure()` discovers session files, re-parses the
 * ones whose (size, mtimeMs, adapterVersion, estimatorVersion, calibrationVersion)
 * changed, re-evaluates rules when thresholds or the rule sources changed
 * (`rulesHash`, ADR-003 section 9; counted in `lastPass.reevaluated` and
 * `lastPass.rulesChanged`), writes per-run files
 * atomically, and keeps the manifest (saved at most every 2 s plus once at the
 * end of a pass).
 *
 * `ensure({ only: [absPath] })` is the live pass (index/watch.mjs): no
 * discovery walk and no fresh worker pool. Only the listed files (and their
 * subagents directories) are stat'ed, their cwd / parent come from the
 * manifest entry (`discoverFiles`), one persistent worker parses them
 * (closed after LIVE_POOL_IDLE_MS without a live pass), the result is
 * recorded in `manifest.lastLivePass` (never `lastPass`, which describes the
 * last full pass), and the manifest is saved at most once per
 * LIVE_SAVE_INTERVAL_MS (flushed by the next full pass or `close()`).
 *
 * Reads: `readScope` keeps parsed scopes in a byte-bounded LRU keyed by the
 * entry's (indexedAt, mtimeMs) so a live tail does not re-read a large scope
 * file more than once per pass. The returned object is shared: callers must
 * not mutate it. `scope.forecast` is served only while the run is live
 * (`index.liveRuns()`); a finished session carries none.
 * `abort()` stops the in-flight pass after the current tasks.
 */
import { HABITS_VERSION } from "./entry.mjs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import { discoverAll, discoverFiles, projectKeyFor } from "../adapters/discover.mjs";
import { displayPath } from "../util/fs.mjs";
import { publicMessage } from "../util/errors.mjs";
import {
  emptyManifest, ensureIndexDirs, findingsFilePath, hashThresholds, indexRoot, loadManifest, removeIndex, removeRunFiles, runDir, saveManifest, scopeFilePath, shellFilePath,
} from "./manifest.mjs";
import { createPool, WorkerFailure } from "./pool.mjs";
import { loadDeps, processFile, sanitizeDisplayFile } from "./worker.mjs";
import { errorEntry, summarizeScope } from "./entry.mjs";
import { createByteCache, entryMatchesRepo, filterEntries, readFindingsFile, toOverviewRun } from "./reader.mjs";
import { aggregateStats, buildOverviewFromEntries } from "./overview.mjs";

const WORKER_URL = new URL("./worker.mjs", import.meta.url);
const SAVE_INTERVAL_MS = 2_000;
/** Live passes: the manifest is written at most this often (the in-memory manifest is always current). */
export const LIVE_SAVE_INTERVAL_MS = 5_000;
/** The persistent live worker is terminated after this long without a live pass. */
export const LIVE_POOL_IDLE_MS = 120_000;
/** Parsed-scope cache budget (JSON text bytes; the object graph is larger). */
export const SCOPE_CACHE_BYTES = 64 * 1024 * 1024;

function normalizeAdapters(adapters) {
  if (!adapters) return null;
  const out = {};
  for (const [vendor, value] of Object.entries(adapters)) {
    if (!value) continue;
    if (typeof value === "function") out[vendor] = { parse: value, version: `${vendor}-test` };
    else if (typeof value.parse === "function") out[vendor] = { parse: value.parse, version: value.version ?? `${vendor}-v1` };
  }
  return out;
}

export function createIndex({ home = os.homedir(), roots = {}, env = process.env, adapters, rules, concurrency = 4, useWorkers, warn = (message) => console.error(message) } = {}) {
  const root = indexRoot(home);
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const injectedAdapters = normalizeAdapters(adapters);
  const injectedRules = rules ?? null;
  const workersAllowed = useWorkers ?? (!injectedAdapters && !injectedRules);
  let manifest = null;
  let loadingManifest = null;
  let inFlight = null;
  let queued = null;
  let queuedOptions = null;
  let controller = null;
  let lastResult = null;
  let livePool = null;
  let livePoolTimer = null;
  let saveTimer = null;
  let saveDirty = false;
  const state = { state: "idle", files: 0, indexed: 0, failed: 0, total: 0, done: 0, lastRunAt: undefined, lastPass: null, lastLivePass: null };
  const stats = { runFilesOpened: 0, manifestSaves: 0, livePoolSpawns: 0 };
  const scopeCache = createByteCache(SCOPE_CACHE_BYTES);
  events.on("event", (event) => {
    if (event?.type === "cleared") { scopeCache.clear(); return; }
    if (typeof event?.runId === "string" && (event.type === "progress" || event.type === "removed")) scopeCache.deletePrefix(`${event.runId}:`);
  });

  async function getManifest() {
    if (manifest) return manifest;
    loadingManifest ??= loadManifest(root).then((loaded) => { manifest = loaded; refreshCounts(); return loaded; });
    return loadingManifest;
  }

  function entries() {
    return Object.values(manifest?.files ?? {});
  }

  function refreshCounts() {
    const all = entries();
    state.files = all.length;
    state.failed = all.filter((entry) => entry.error).length;
    state.indexed = all.length - state.failed;
    state.lastRunAt = manifest?.lastRunAt ?? undefined;
    state.lastPass = manifest?.lastPass ?? null;
    state.lastLivePass = manifest?.lastLivePass ?? null;
  }

  async function persist(current) {
    stats.manifestSaves += 1;
    await saveManifest(root, current);
  }

  /** Live passes: coalesce manifest writes to one per LIVE_SAVE_INTERVAL_MS; `flushSave()` writes a pending one now. */
  function scheduleSave(current) {
    saveDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flushSave(current).catch(() => {}); }, LIVE_SAVE_INTERVAL_MS);
    saveTimer.unref?.();
  }

  async function flushSave(current = manifest) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!saveDirty || !current) return;
    saveDirty = false;
    await persist(current);
  }

  /** One warm worker for live passes; re-armed on every use, terminated after LIVE_POOL_IDLE_MS idle. */
  function acquireLivePool() {
    if (livePool && !livePool.broken && !livePool.closed) { armLivePoolIdle(); return livePool; }
    if (livePool) { livePool.close().catch(() => {}); livePool = null; }
    try {
      livePool = createPool({ size: 1, workerUrl: WORKER_URL, workerData: { home }, onWarning: warn, unref: true });
      stats.livePoolSpawns += 1;
    } catch (error) {
      warn(`ContextScope: live worker unavailable (${publicMessage(error)}); parsing in-process.`);
      livePool = null;
    }
    armLivePoolIdle();
    return livePool;
  }

  function armLivePoolIdle() {
    if (livePoolTimer) clearTimeout(livePoolTimer);
    livePoolTimer = setTimeout(() => { livePoolTimer = null; closeLivePool().catch(() => {}); }, LIVE_POOL_IDLE_MS);
    livePoolTimer.unref?.();
  }

  async function closeLivePool() {
    if (livePoolTimer) { clearTimeout(livePoolTimer); livePoolTimer = null; }
    const pool = livePool;
    livePool = null;
    if (pool) await pool.close();
  }

  function emit(event) {
    events.emit("event", event);
  }

  async function resolveDeps() {
    if (injectedAdapters || injectedRules) {
      const loaded = await loadDeps({ warn: (!injectedAdapters || !injectedRules) ? warn : () => {} });
      return { adapters: injectedAdapters ?? loaded.adapters, rules: injectedRules ?? loaded.rules, estimator: loaded.estimator };
    }
    return loadDeps({ warn });
  }

  async function loadRulesHash(deps) {
    if (typeof deps.rules?.rulesHash !== "function") return null;
    try {
      const hash = await deps.rules.rulesHash({ home });
      return typeof hash === "string" && hash ? hash : null;
    } catch (error) {
      warn(`ContextScope: rules hash unavailable (${publicMessage(error)}); stored findings are kept.`);
      return null;
    }
  }

  async function loadThresholds(deps) {
    if (!deps.rules?.loadThresholds) return {};
    try {
      return (await deps.rules.loadThresholds({ home })) ?? {};
    } catch (error) {
      warn(`ContextScope: thresholds could not be loaded (${publicMessage(error)}); using defaults.`);
      return {};
    }
  }

  function taskFor(candidate, deps) {
    const version = deps.adapters[candidate.vendor].version;
    return {
      vendor: candidate.vendor,
      path: candidate.path,
      runDir: runDir(root, candidate.vendor, candidate.path),
      shellFile: shellFilePath(root, candidate.vendor, candidate.path),
      findingsFile: findingsFilePath(root, candidate.vendor, candidate.path),
      candidate,
      file: sanitizeDisplayFile(displayPath(candidate.path, home)),
      adapterVersion: version,
    };
  }

  async function runEnsure({ onProgress, force = false, only, concurrency: laneCount = concurrency } = {}) {
    const startedAt = Date.now();
    const onlySet = Array.isArray(only) ? new Set(only.map((file) => path.resolve(file))) : null;
    const listener = onProgress ? (event) => { try { onProgress(event); } catch {} } : null;
    if (listener) events.on("event", listener);
    controller = new AbortController();
    const { signal } = controller;
    state.state = "indexing";
    state.done = 0;
    state.total = 0;
    let pool = null;
    let ownPool = false;
    try {
      await ensureIndexDirs(root);
      const current = await getManifest();
      if (!onlySet && !Object.keys(current.files).length) {
        // Fresh or migrated manifest: any run files on disk belong to an older layout.
        await rm(path.join(root, "runs"), { recursive: true, force: true }).catch(() => {});
        await ensureIndexDirs(root);
      }
      const deps = await resolveDeps();
      const adapterVersions = Object.fromEntries(Object.entries(deps.adapters).map(([vendor, adapter]) => [vendor, adapter.version]));
      const estimatorVersion = deps.estimator?.estimatorVersion ?? "unknown";
      const calibrationVersion = deps.estimator?.calibrationVersion ?? "none";
      const thresholds = await loadThresholds(deps);
      const thresholdsHash = hashThresholds(thresholds);
      const rulesHash = await loadRulesHash(deps);
      // A live pass stats the listed files only and takes their metadata from the manifest (no head reads, no walk).
      const discovered = onlySet
        ? await discoverFiles({ paths: [...onlySet], known: current.files, home, roots, env })
        : await discoverAll({ home, roots, env, known: current.files });
      const candidates = discovered.files.filter((candidate) => deps.adapters[candidate.vendor] && (!onlySet || onlySet.has(candidate.path)));
      const context = { home, thresholds, thresholdsHash, rulesHash, siblingIndex: discovered.siblingIndex, adapterVersions, estimatorVersion, calibrationVersion };

      const tasks = [];
      let skipped = 0;
      let estimatorChanged = 0;
      let rulesChanged = 0;
      const seen = new Set();
      for (const candidate of candidates) {
        seen.add(candidate.path);
        const previous = current.files[candidate.path];
        const base = taskFor(candidate, deps);
        const stale = previous && (previous.size !== candidate.size || previous.mtimeMs !== candidate.mtimeMs || previous.adapterVersion !== base.adapterVersion);
        const versions = previous && !previous.error && (previous.estimatorVersion !== estimatorVersion || previous.calibrationVersion !== calibrationVersion);
        if (versions) estimatorChanged += 1;
        // A failed file is retried only when it (or a version) changed, or on --refresh: a poison file must not be re-parsed on every launch.
        const changed = force || !previous || stale || versions;
        if (changed) tasks.push({ ...base, kind: "parse" });
        else if (!previous.error && previous.thresholdsHash !== thresholdsHash) tasks.push({ ...base, kind: "reevaluate" });
        // Rule sources changed since this entry was evaluated (a null hash means no rules engine: nothing to compare).
        else if (!previous.error && rulesHash && (previous.rulesHash ?? null) !== rulesHash) { rulesChanged += 1; tasks.push({ ...base, kind: "reevaluate" }); }
        else if (!previous.error && previous.habits && previous.habits.v !== HABITS_VERSION) tasks.push({ ...base, kind: "reevaluate" });
        // One-time backfill: entries indexed before the summary carried the session-end composition.
        else if (!previous.error && previous.summary && !previous.summary.compositionAtEnd) tasks.push({ ...base, kind: "reevaluate" });
        else skipped += 1;
      }
      // Drop entries whose files disappeared, and files of vendors we can no longer parse (within `only` when restricted).
      let removed = 0;
      for (const [absPath, entry] of Object.entries(current.files)) {
        if (seen.has(absPath)) continue;
        if (onlySet && !onlySet.has(absPath)) continue;
        if (!deps.adapters[entry.vendor] && discovered.files.some((file) => file.path === absPath)) continue;
        // A live pass never drops a file that still exists (only a missing vendor adapter or a deleted file counts).
        if (onlySet && await fileExists(absPath)) continue;
        delete current.files[absPath];
        removed += 1;
        await removeRunFiles(root, entry.vendor, absPath);
        emit({ type: "removed", runId: entry.runId });
      }

      state.total = tasks.length;
      emit({ type: "start", total: tasks.length, skipped, estimatorChanged, estimatorVersion, rulesChanged, rulesHash });

      if (workersAllowed && tasks.length) {
        if (onlySet) {
          pool = acquireLivePool();
        } else {
          try {
            pool = createPool({ size: Math.min(laneCount, tasks.length), workerUrl: WORKER_URL, workerData: context, signal, onWarning: warn });
            ownPool = true;
          } catch (error) {
            warn(`ContextScope: worker pool unavailable (${publicMessage(error)}); indexing in-process.`);
            pool = null;
          }
        }
      }

      let parsed = 0;
      let reevaluated = 0;
      let failed = 0;
      let lastSaveAt = Date.now();
      let cursor = 0;
      const runTask = async (task) => {
        let entry;
        try {
          if (pool && !pool.broken && !pool.closed) {
            try {
              // The persistent live worker carries no pass context in its workerData: send it per task.
              entry = await (ownPool ? pool.run(task) : pool.run(task, context));
            } catch (error) {
              if (error instanceof WorkerFailure && error.aborted) return;
              if (error instanceof WorkerFailure && (pool.broken || pool.closed)) {
                if (signal.aborted) return;
                warn("ContextScope: worker failed; continuing in-process.");
                entry = await processFile(task, context, deps);
              } else if (error instanceof WorkerFailure && !error.message.includes("invalid reply")) {
                // A worker crashed on this file (respawned by the pool): run it once in-process so the error is attributed.
                entry = await processFile(task, context, deps);
              } else {
                throw error;
              }
            }
          } else {
            if (signal.aborted) return;
            entry = await processFile(task, context, deps);
          }
          if (task.kind === "reevaluate") reevaluated += 1;
          else parsed += 1;
          if (rulesHash) entry.rulesHash = rulesHash;
        } catch (error) {
          failed += 1;
          entry = errorEntry({ candidate: task.candidate, adapterVersion: task.adapterVersion, estimatorVersion, calibrationVersion, thresholdsHash, file: task.file, error: publicMessage(error) });
          await removeRunFiles(root, task.vendor, task.path);
        }
        current.files[task.path] = entry;
        state.done += 1;
        emit({ type: "progress", done: state.done, total: tasks.length, file: task.file, runId: entry.runId, error: entry.error });
        if (!onlySet && Date.now() - lastSaveAt >= SAVE_INTERVAL_MS) {
          lastSaveAt = Date.now();
          await persist(current).catch(() => {});
        }
      };
      const lanes = Array.from({ length: Math.max(1, Math.min(laneCount, tasks.length)) }, async () => {
        while (cursor < tasks.length && !signal.aborted) {
          const task = tasks[cursor];
          cursor += 1;
          await runTask(task);
        }
      });
      await Promise.all(lanes);

      const aborted = signal.aborted;
      const ms = Date.now() - startedAt;
      current.lastRunAt = new Date().toISOString();
      const pass = { total: tasks.length, parsed, reevaluated, skipped, failed, removed, ms, at: current.lastRunAt, aborted, estimatorChanged, rulesChanged };
      if (onlySet) {
        // A live pass leaves `lastPass` (the last full pass) alone and writes the manifest at most every LIVE_SAVE_INTERVAL_MS.
        current.lastLivePass = { ...pass, files: [...onlySet].length };
        scheduleSave(current);
      } else {
        current.adapterVersions = adapterVersions;
        current.estimatorVersion = estimatorVersion;
        current.calibrationVersion = calibrationVersion;
        current.thresholdsHash = thresholdsHash;
        current.rulesHash = rulesHash;
        current.vendors = discovered.vendors ?? current.vendors;
        current.lastPass = pass;
        saveDirty = false;
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        await persist(current);
      }
      refreshCounts();
      lastResult = { type: "done", parsed, reevaluated, skipped, failed, removed, total: tasks.length, ms, aborted, files: state.files, live: Boolean(onlySet) || undefined };
      emit(lastResult);
      return { ...state, parsed, reevaluated, skipped, failed, removed, ms, aborted, estimatorChanged, rulesChanged, files: state.files };
    } finally {
      state.state = "idle";
      controller = null;
      if (pool && ownPool) await pool.close();
      if (listener) events.off("event", listener);
    }
  }

  async function fileExists(absPath) {
    try { return (await stat(absPath)).isFile(); } catch { return false; }
  }

  /** Parsed JSON for a run file, served from the LRU while the entry's (indexedAt, mtimeMs) stands; null when unreadable. */
  async function readCachedJson(key, found, filePath) {
    const stamp = `${found.entry.indexedAt ?? ""}|${found.entry.mtimeMs ?? ""}|${found.absPath}`;
    const hit = scopeCache.get(key);
    if (hit && hit.stamp === stamp) return hit.value;
    try {
      stats.runFilesOpened += 1;
      const text = await readFile(filePath, "utf8");
      const value = JSON.parse(text);
      scopeCache.set(key, { value, stamp, bytes: text.length });
      return value;
    } catch {
      return null;
    }
  }

  /** `scope.forecast` is a live affordance: it is dropped from a run that is not live right now (the cached object is left untouched). */
  function withLiveForecast(runId, scope) {
    if (!scope || scope.forecast === undefined) return scope;
    let live = null;
    if (typeof index.liveRuns === "function") { try { live = index.liveRuns().get(runId) ?? null; } catch { live = null; } }
    if (live) return scope;
    const { forecast, ...rest } = scope;
    return rest;
  }

  async function findEntryWithPath(runId) {
    await getManifest();
    let best = null;
    for (const [absPath, entry] of Object.entries(manifest.files)) {
      if (entry.runId !== runId || entry.error) continue;
      // Duplicate run ids (a moved repo, a resumed thread): the newest file wins.
      if (!best || (entry.mtimeMs ?? 0) > (best.entry.mtimeMs ?? 0)) best = { absPath, entry };
    }
    return best;
  }

  const index = {
    home,
    root,
    events,
    stats,
    get state() { return { ...state, lastPass: state.lastPass ? { ...state.lastPass } : null, lastLivePass: state.lastLivePass ? { ...state.lastLivePass } : null }; },
    get lastResult() { return lastResult; },
    ensure(options = {}) {
      if (inFlight) {
        if (!options.force && !options.only) return inFlight;
        // --refresh (or a live `only` change) while a pass runs: queue exactly one more pass after the
        // current one; several requests fold into it (a full pass absorbs the `only` lists).
        if (queuedOptions) {
          if (options.force) queuedOptions.force = true;
          if (!options.only) queuedOptions.only = undefined;
          else if (queuedOptions.only) queuedOptions.only = [...new Set([...queuedOptions.only, ...options.only])];
        } else {
          queuedOptions = { ...options, only: options.only ? [...options.only] : undefined };
          queued = inFlight.catch(() => {}).then(() => { const next = queuedOptions; queued = null; queuedOptions = null; return index.ensure(next); });
        }
        return queued;
      }
      inFlight = runEnsure(options).finally(() => { inFlight = null; });
      return inFlight;
    },
    get running() { return Boolean(inFlight); },
    /** Stops the in-flight pass after the tasks already running; the manifest keeps what finished. */
    abort() {
      const active = Boolean(controller);
      controller?.abort();
      return active;
    },
    /** Terminates the persistent live worker and writes a pending live manifest save. Safe to call more than once. */
    async close() {
      await closeLivePool();
      await flushSave().catch(() => {});
    },
    async clear() {
      index.abort();
      if (inFlight) await inFlight.catch(() => {});
      await closeLivePool();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      saveDirty = false;
      scopeCache.clear();
      await removeIndex(root);
      manifest = emptyManifest();
      loadingManifest = null;
      lastResult = null;
      state.total = 0;
      state.done = 0;
      state.files = 0;
      state.indexed = 0;
      state.failed = 0;
      state.lastRunAt = undefined;
      state.lastPass = null;
      state.lastLivePass = null;
      emit({ type: "cleared" });
    },
    async manifest() {
      return getManifest();
    },
    async entries() {
      await getManifest();
      return entries();
    },
    async findEntry(runId) {
      return (await findEntryWithPath(runId))?.entry ?? null;
    },
    /** Run shell: run metadata + scope summaries (no requests/blocks), no findings. Cached like scopes; shared, read-only. */
    async readRunShell(runId) {
      const found = await findEntryWithPath(runId);
      if (!found) return null;
      return readCachedJson(`${runId}:#shell`, found, shellFilePath(root, found.entry.vendor, found.absPath));
    },
    /**
     * One full AgentScope, or null when the run or scope is unknown. Served from
     * the parsed-scope cache when the entry has not been re-indexed since; the
     * object is shared, so callers must treat it as read-only.
     */
    async readScope(runId, scopeId) {
      const found = await findEntryWithPath(runId);
      if (!found || typeof scopeId !== "string" || !scopeId) return null;
      const scope = await readCachedJson(`${runId}:${scopeId}`, found, scopeFilePath(root, found.entry.vendor, found.absPath, scopeId));
      return scope ? withLiveForecast(runId, scope) : null;
    },
    /** Parsed shell/scope cache statistics (tests, diagnostics). */
    get scopeCacheStats() { return { entries: scopeCache.size, bytes: scopeCache.bytes }; },
    async readFindings(runId) {
      const found = await findEntryWithPath(runId);
      if (!found) return [];
      return readFindingsFile(findingsFilePath(root, found.entry.vendor, found.absPath));
    },
    /** API payload for GET /runs/:vendor/:id: shell + the full main scope + child summaries + findings. */
    async readRunResponse(runId) {
      const shell = await index.readRunShell(runId);
      if (!shell) return null;
      const mainId = shell.scopes?.[0]?.id ?? "main";
      const main = (await index.readScope(runId, mainId)) ?? shell.scopes[0];
      const findings = await index.readFindings(runId);
      return { ...shell, scopes: [main, ...shell.scopes.slice(1)], findings };
    },
    /** The whole run with every scope in full (terminal rendering, tests). Not used by the HTTP routes. */
    async readRun(runId) {
      const shell = await index.readRunShell(runId);
      if (!shell) return null;
      const scopes = [];
      for (const summary of shell.scopes ?? []) scopes.push((await index.readScope(runId, summary.id)) ?? summary);
      return { ...shell, scopes, findings: await index.readFindings(runId) };
    },
    async listRuns(filter = {}) {
      await getManifest();
      return filterEntries(entries(), filter).map(toOverviewRun).filter(Boolean);
    },
    async repoEntries({ repoRoot, projectKey, since } = {}) {
      await getManifest();
      const key = projectKey ?? (repoRoot ? projectKeyFor(repoRoot) : undefined);
      return entries().filter((entry) => !entry.error && entryMatchesRepo(entry, { repoRoot, projectKey: key }) && (!since || filterEntries([entry], { since }).length));
    },
    async buildOverview({ repoRoot, projectKey, ...options } = {}) {
      await getManifest();
      const key = projectKey ?? (repoRoot ? projectKeyFor(repoRoot) : undefined);
      // Every other option (since, limit, scope, nested/all, setupFindings, habitFindings, instructionFiles, now) passes through.
      return buildOverviewFromEntries(entries(), {
        ...options,
        repoRoot, projectKey: key,
        indexState: index.state,
        vendors: manifest.vendors ?? [],
      });
    },
    async sessionStatsForRepo(projectKeyOrOptions) {
      const options = typeof projectKeyOrOptions === "string" ? { projectKey: projectKeyOrOptions } : (projectKeyOrOptions ?? {});
      return aggregateStats(await index.repoEntries(options));
    },
    async repoFindings({ repoRoot, projectKey, vendor } = {}) {
      const matched = await index.repoEntries({ repoRoot, projectKey });
      const findings = [];
      for (const entry of matched) {
        if (vendor && entry.vendor !== vendor) continue;
        if (!entry.findingsCount) continue;
        findings.push(...(await index.readFindings(entry.runId)));
      }
      return findings;
    },
  };
  return index;
}

export { projectKeyFor, displayPath, summarizeScope };
