/**
 * Read side of the index: run shells and scope files on demand, a byte-bounded
 * LRU for serialised payloads, and overview rows projected from manifest
 * entries with every absolute path removed.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { projectKeyFor } from "../ir/project.mjs";
import { TOP_BLOCKS } from "./entry.mjs";

export const RUN_CACHE_BYTES = 200 * 1024 * 1024;

/**
 * LRU keyed by string with a byte budget. Values must expose `bytes`
 * (a number); the cache evicts the least recently used entries until the sum
 * fits. A single value larger than the budget is served but not kept.
 */
export function createByteCache(limitBytes = RUN_CACHE_BYTES) {
  const cache = new Map();
  let bytes = 0;
  return {
    get(key) {
      if (!cache.has(key)) return undefined;
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return value;
    },
    set(key, value) {
      const size = Number(value?.bytes) || 0;
      if (cache.has(key)) { bytes -= Number(cache.get(key)?.bytes) || 0; cache.delete(key); }
      if (size > limitBytes) return value;
      cache.set(key, value);
      bytes += size;
      while (bytes > limitBytes && cache.size) {
        const oldest = cache.keys().next().value;
        bytes -= Number(cache.get(oldest)?.bytes) || 0;
        cache.delete(oldest);
      }
      return value;
    },
    delete(key) {
      if (!cache.has(key)) return;
      bytes -= Number(cache.get(key)?.bytes) || 0;
      cache.delete(key);
    },
    /** Drops every key that starts with `prefix`. */
    deletePrefix(prefix) {
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) this.delete(key);
    },
    clear() { cache.clear(); bytes = 0; },
    get size() { return cache.size; },
    get bytes() { return bytes; },
  };
}

export async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function readFindingsFile(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Projects a manifest entry to the public OverviewRun shape (no cwd, no absolute paths, no topBlocks/findingIds). */
export function toOverviewRun(entry) {
  if (!entry || entry.error || !entry.summary) return null;
  const { topBlocks, findingIds, ...summary } = entry.summary;
  return {
    id: entry.runId,
    vendor: entry.vendor,
    project: entry.project ?? { key: entry.projectKey, displayName: entry.projectDisplay, cwdHash: entry.projectKey },
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    activeMs: entry.activeMs ?? 0,
    summary,
    window: entry.window,
    findingsCount: entry.findingsCount ?? 0,
    findingsHigh: entry.findingsHigh ?? 0,
    parentRunId: entry.parentThreadId ? `codex:${entry.parentThreadId}` : undefined,
  };
}

export function topBlocksOfEntry(entry, runId = entry?.runId) {
  return (entry?.summary?.topBlocks ?? []).slice(0, TOP_BLOCKS).map((block) => ({
    runId, scopeId: block.scopeId, blockId: block.id, category: block.category,
    estTokens: block.estTokens, firstRequest: block.firstRequest, tool: block.tool, label: block.label,
  }));
}

// --- repo attribution (ADR-003 section 1) ---

const TEMP_CWD = /^(?:\/private)?\/(?:var\/folders|tmp)\//;

/** "temp" for isolation/temp dirs, "unknown" when there is no cwd, "repo" otherwise. */
export function cwdKindOf(cwd) {
  if (typeof cwd !== "string" || !cwd) return "unknown";
  return TEMP_CWD.test(cwd.replace(/\\/g, "/")) ? "temp" : "repo";
}

function trimSlash(value) {
  return String(value ?? "").replace(/[\\/]+$/, "");
}

const realpathCache = new Map();

/** realpath of a directory, cached per call site; the input itself when it cannot be resolved. */
export function realpathOf(dir) {
  const key = trimSlash(dir);
  if (!key) return key;
  if (realpathCache.has(key)) return realpathCache.get(key);
  let real = key;
  try { real = trimSlash(realpathSync(key)); } catch {}
  if (realpathCache.size > 4096) realpathCache.clear();
  realpathCache.set(key, real);
  return real;
}

function underRoot(cwd, root) {
  if (!cwd || !root) return false;
  return cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
}

/**
 * Population rule: a session belongs to the repo when
 *   1. realpath(entry.cwd) is the repo root (realpath) or under it (worktrees under <repo>/.claude/worktrees count),
 *   2. else entry.projectKey === projectKey,
 *   3. else entry.discoveryKey === projectKey, only when the entry has no cwd.
 * Temp isolation dirs never attribute to a repo. Entries indexed before `cwdReal`
 * existed fall back to the raw cwd (a re-index fills the field).
 */
export function entryMatchesRepo(entry, { repoRoot, projectKey } = {}) {
  if (!entry) return false;
  if (repoRoot && entry.cwd) {
    const root = trimSlash(repoRoot);
    const real = realpathOf(root);
    const cwd = trimSlash(entry.cwd);
    const cwdReal = entry.cwdReal ? trimSlash(entry.cwdReal) : realpathOf(cwd);
    if (underRoot(cwdReal, real) || underRoot(cwd, root) || underRoot(cwdReal, root) || underRoot(cwd, real)) return true;
  }
  // A temp isolation dir is never attributed through a key: the launched root matched above or not at all.
  if ((entry.cwdKind ?? cwdKindOf(entry.cwd)) === "temp") return false;
  if (projectKey) {
    if (entry.projectKey === projectKey) return true;
    if (!entry.cwd && entry.discoveryKey === projectKey) return true;
  }
  return false;
}

/**
 * True when the entry cannot be attributed to any project: a temp isolation
 * cwd (unless it is under the launched root), or no cwd and a discovery key
 * that cannot be decoded back to a path.
 */
export function entryUnattributed(entry, { repoRoot } = {}) {
  if (!entry) return false;
  const kind = entry.cwdKind ?? cwdKindOf(entry.cwd);
  if (kind === "temp") return !(repoRoot && entryMatchesRepo(entry, { repoRoot }));
  if (kind === "unknown") return entry.cwdReversible === undefined ? true : !entry.cwdReversible;
  return false;
}

// --- session kind and minimal attribution (ADR-005 section 2) ---

/** "harness" or "interactive"; an entry indexed before the field existed is interactive (a re-index fills it). */
export function sessionKindOfEntry(entry) {
  return entry?.kind === "harness" ? "harness" : "interactive";
}

/** Human label of an attribution method, for population lines and badges. */
export const ATTRIBUTION_METHOD_LABELS = {
  cwd: "working directory",
  "nested-hash": "nested instruction file",
  "instructions-hash": "AGENTS.md content",
  "path-overlap": "file-path overlap",
};

const PATH_OVERLAP_MIN_TARGETS = 5;
const PATH_OVERLAP_MIN_SHARE = 0.8;

function hashSet(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) if (typeof value === "string" && value) out.add(value.slice(0, 16));
  return out;
}

function fileSet(values) {
  if (values instanceof Set) return values;
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) if (typeof value === "string" && value) out.add(value.replace(/\\/g, "/").replace(/^\.\//, ""));
  return out;
}

/**
 * Attribution of a temp-cwd entry to the launched repo, from evidence only
 * (never from the temp directory's name):
 *   nested-hash        a `nested_memory` instruction-file hash of the entry equals a hash in
 *                      `chainHashes` (the repo's CLAUDE.md/AGENTS.md chain, `InstructionFile.hash`); exact
 *   instructions-hash  the entry's Codex request-0 instructions hash equals one of those hashes; exact
 *   path-overlap       >= 5 distinct repo-relative targets and >= 80 % of them exist in `repoFiles`; derived
 * Returns { key, method, confidence, files? } or null. Never fires for a `repo`/`unknown` cwd (those are
 * attributed by the population rule or not at all) and never for a harness run.
 */
export function attributionOf(entry, { repoRoot, projectKey, repoFiles, chainHashes } = {}) {
  if (!entry || (entry.cwdKind ?? cwdKindOf(entry.cwd)) !== "temp" || sessionKindOfEntry(entry) === "harness") return null;
  const key = projectKey ?? (repoRoot ? projectKeyFor(trimSlash(repoRoot)) : undefined);
  if (!key) return null;
  const hashes = hashSet(chainHashes);
  if (hashes.size) {
    for (const hash of entry.nestedHashes ?? []) if (typeof hash === "string" && hashes.has(hash.slice(0, 16))) return { key, method: "nested-hash", confidence: "exact" };
    if (typeof entry.instructionHash === "string" && hashes.has(entry.instructionHash.slice(0, 16))) return { key, method: "instructions-hash", confidence: "exact" };
  }
  const files = fileSet(repoFiles);
  const targets = Array.isArray(entry.targets) ? [...new Set(entry.targets.filter((target) => typeof target === "string" && target))] : [];
  if (files.size && targets.length >= PATH_OVERLAP_MIN_TARGETS) {
    const matched = targets.filter((target) => files.has(target)).length;
    if (matched / targets.length >= PATH_OVERLAP_MIN_SHARE) return { key, method: "path-overlap", confidence: "derived", files: matched };
  }
  return null;
}

export function entryTime(entry) {
  const value = Date.parse(entry.endedAt || entry.startedAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function sinceMsOf(since) {
  return since instanceof Date ? since.getTime() : typeof since === "string" ? Date.parse(since) : typeof since === "number" ? since : null;
}

export function filterEntries(entries, { projectKey, repoRoot, vendor, since } = {}) {
  const sinceMs = sinceMsOf(since);
  return entries.filter((entry) => {
    if (entry.error || !entry.summary) return false;
    if (vendor && entry.vendor !== vendor) return false;
    if ((projectKey || repoRoot) && !entryMatchesRepo(entry, { projectKey, repoRoot })) return false;
    if (sinceMs && entryTime(entry) < sinceMs) return false;
    return true;
  });
}

// --- one population rule (ADR-004 section 2) ---

const MAX_PARENT_DEPTH = 32;

/** Map<runId, entry> over the usable (parsed, non-error) entries of a manifest. */
export function indexByRunId(entries) {
  const byRunId = new Map();
  for (const entry of entries ?? []) if (entry && !entry.error && entry.summary && entry.runId) byRunId.set(entry.runId, entry);
  return byRunId;
}

/** The run id of the entry's direct parent (`vendor:parentThreadId`), or undefined for a top-level run. */
export function parentRunIdOf(entry) {
  return entry?.parentThreadId ? `${entry.vendor}:${entry.parentThreadId}` : undefined;
}

/**
 * Root run of an entry: the nearest ancestor without `parentThreadId`, resolved
 * transitively over the whole manifest (`byRunId`), same vendor. Falls back to
 * the entry itself when its parent is not indexed (the parent is then unknown,
 * so the child is the best top-level run we have) or when the chain loops.
 */
export function rootRunIdOf(entry, byRunId) {
  if (!entry?.runId) return undefined;
  let current = entry;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parentId = parentRunIdOf(current);
    if (!parentId) return current.runId;
    const parent = byRunId?.get(parentId);
    if (!parent || parent === entry) return depth === 0 ? entry.runId : current.runId;
    current = parent;
  }
  return current.runId;
}

/** True when the entry is a child (subagent) rollout of an indexed run. */
export function isChildEntry(entry, byRunId) {
  return rootRunIdOf(entry, byRunId) !== entry?.runId;
}

/**
 * The one population rule: a session is a top-level run; a Codex `thread_spawn`
 * child rollout (and its children, transitively) is a subagent of its root, as a
 * Claude subagent transcript is. Attribution and the time range are decided on
 * the root: a child belongs to the repo and the range its root belongs to.
 *
 * Returns
 *   roots        top-level entries in the population, newest first,
 *   children     Map<rootRunId, descendants[]> (every depth, flattened),
 *   unattributed top-level entries no project can claim (temp cwd without evidence, undecodable key),
 *   harness      top-level harness runs in range (ADR-005 section 2), excluded from roots unless `kind: "harness"`,
 *   attributions Map<runId, Attribution> for temp-cwd roots that joined the repo through evidence
 *                (`repoFiles` = the repo's file list, `chainHashes` = its instruction-file hashes),
 *   rootOf(entry) / isChild(entry) / attributionOf(entry) / byRunId for callers that need the mapping,
 *   entries      roots + children in one list.
 * Without `repoRoot`/`projectKey` the population is the machine.
 */
export function repoSessions({ entries, repoRoot, projectKey, since, vendor, kind = "interactive", repoFiles, chainHashes } = {}) {
  const byRunId = indexByRunId(entries);
  const sinceMs = sinceMsOf(since) || 0;
  const rootCache = new Map();
  const rootOf = (entry) => {
    if (!entry?.runId) return undefined;
    if (!rootCache.has(entry.runId)) rootCache.set(entry.runId, rootRunIdOf(entry, byRunId));
    return rootCache.get(entry.runId);
  };
  const scoped = Boolean(repoRoot || projectKey);
  const attributionContext = { repoRoot, projectKey, repoFiles, chainHashes };
  const attributions = new Map();
  // ADR-005 section 2: a temp-cwd root with evidence (nested instruction hash, AGENTS.md hash, file-path overlap)
  // joins the repo; `attributions` records how. The cwd rule stays first and is the only rule for repo cwds.
  const inRepo = (entry) => {
    if (!scoped) return true;
    if (entryMatchesRepo(entry, { repoRoot, projectKey })) return true;
    const attribution = attributionOf(entry, attributionContext);
    if (!attribution) return false;
    attributions.set(entry.runId, attribution);
    return true;
  };
  const roots = [];
  const children = new Map();
  const unattributed = [];
  const harness = [];
  const accepted = new Map();
  for (const entry of byRunId.values()) {
    const rootId = rootOf(entry);
    if (rootId !== entry.runId) continue;
    if (vendor && entry.vendor !== vendor) continue;
    if (sinceMs && entryTime(entry) < sinceMs) continue;
    // Harness runs (SDK-driven, no tool use) are never part of a repo or machine population; they are listed only
    // when asked for by kind, and counted on the header (ADR-005 section 2).
    if (sessionKindOfEntry(entry) === "harness") {
      harness.push(entry);
      if (kind !== "harness") continue;
    } else if (kind === "harness") continue;
    if (!inRepo(entry)) {
      if (scoped && entryUnattributed(entry, { repoRoot })) unattributed.push(entry);
      continue;
    }
    roots.push(entry);
    accepted.set(entry.runId, entry);
  }
  for (const entry of byRunId.values()) {
    const rootId = rootOf(entry);
    if (rootId === entry.runId || !accepted.has(rootId)) continue;
    if (!children.has(rootId)) children.set(rootId, []);
    children.get(rootId).push(entry);
  }
  roots.sort((a, b) => entryTime(b) - entryTime(a));
  harness.sort((a, b) => entryTime(b) - entryTime(a));
  for (const list of children.values()) list.sort((a, b) => entryTime(a) - entryTime(b));
  const all = [...roots];
  for (const root of roots) all.push(...(children.get(root.runId) ?? []));
  return {
    roots, children, unattributed, harness, attributions, rootOf,
    isChild: (entry) => rootOf(entry) !== entry?.runId,
    attributionOf: (entry) => attributions.get(entry?.runId) ?? null,
    byRunId, entries: all, sessions: roots.length,
  };
}
