/**
 * Session discovery for the index. Lists candidate main session files for
 * every vendor with the cheapest possible metadata: a stat, and a bounded head
 * read to learn the working directory (and, for Codex, the parent thread).
 *
 * Claude: ~/.claude/projects/<project-dir>/<uuid>.jsonl (main files only;
 *         <uuid>/subagents/ belongs to the main file and is folded into its stat)
 * Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (first line = session_meta)
 * Gemini: ~/.gemini/tmp/<project>/chats/*.json[l] — detected and counted only;
 *         there is no Gemini adapter yet (ADR-002 section G), so nothing is parsed.
 *
 * Head reads are skipped for files the index already knows (`known` = the
 * manifest's `files` map) whose (size, mtimeMs) did not move; their cwd /
 * session id / parent thread come from the entry. `discoverFiles` is the
 * bounded form used by live passes: it stats only the listed files (plus
 * their subagents directories) and reads a head only for a file the manifest
 * has never seen (or one whose entry never learned a cwd).
 *
 * Never walks the whole home directory. Never returns message text.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { directoryExists, mapLimit, readFirstLine, readHead, resolveRoots, walkFiles } from "../util/fs.mjs";

const MIN_FILE_BYTES = 200;
const HEAD_BYTES_CLAUDE = 64 * 1024;
const CODEX_META_LINE_BYTES = 4 * 1024 * 1024;
const STAT_CONCURRENCY = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localProjectKeyFor(cwd) {
  const normalized = String(cwd ?? "").replace(/[\\/]+$/, "");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

// The project-key functions are shared with the adapters through src/ir/project.mjs
// so manifest keys match `run.project.key`. Fall back to the local implementation
// while that module is absent (tests inject fake adapters that never read it).
const projectModule = await import("../ir/project.mjs").catch(() => null);

/** Stable key for a working directory. No path leaves the machine through this. */
export const projectKeyFor = typeof projectModule?.projectKeyFor === "function" ? projectModule.projectKeyFor : localProjectKeyFor;

/** Key for a Claude project directory name (`-Users-me-repo`) when the cwd is unknown. */
export const encodedProjectDirToKey = typeof projectModule?.encodedProjectDirToKey === "function"
  ? projectModule.encodedProjectDirToKey
  : (dirName) => localProjectKeyFor(`encoded:${dirName}`);

export function projectDisplayFor(cwd) {
  const normalized = String(cwd ?? "").replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized || "unknown";
}

export async function discoverSessionFiles({ home = os.homedir(), roots = {}, env = process.env, known } = {}) {
  const resolved = resolveRoots({ home, env, roots });
  const [claude, codex] = await Promise.all([
    discoverClaude(resolved.claudeProjects, { known }),
    discoverCodex(resolved.codexSessions, { known }),
  ]);
  return [...claude, ...codex.files];
}

/** Like discoverSessionFiles but also returns the Codex sibling index and the vendor presence table. */
export async function discoverAll({ home = os.homedir(), roots = {}, env = process.env, known } = {}) {
  const resolved = resolveRoots({ home, env, roots });
  const [claude, codex, gemini] = await Promise.all([
    discoverClaude(resolved.claudeProjects, { known }),
    discoverCodex(resolved.codexSessions, { known }),
    detectGemini(resolved.geminiTmp),
  ]);
  const vendors = [
    { vendor: "claude", detected: await directoryExists(resolved.claudeProjects), files: claude.length, parsed: true },
    { vendor: "codex", detected: await directoryExists(resolved.codexSessions), files: codex.files.length, parsed: true },
    gemini,
  ];
  return { files: [...claude, ...codex.files], siblingIndex: codex.siblingIndex, roots: resolved, vendors };
}

function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Bounded discovery for a live pass: only `paths` are stat'ed (a Claude main
 * file folds its subagents directory as in the full pass); metadata comes
 * from the manifest entry when there is one, so no head is read for a known
 * file. The Codex sibling index is rebuilt from the manifest's Codex entries
 * plus the listed files. Paths outside the vendor roots are ignored.
 */
export async function discoverFiles({ paths = [], known = {}, home = os.homedir(), roots = {}, env = process.env } = {}) {
  const resolved = resolveRoots({ home, env, roots });
  const files = [];
  for (const raw of paths) {
    const filePath = path.resolve(raw);
    const previous = known?.[filePath];
    if (insideRoot(resolved.claudeProjects, filePath) && UUID.test(path.basename(filePath, ".jsonl"))) {
      const projectDir = path.dirname(filePath);
      const candidate = await claudeCandidate({ projectDir, projectDirName: path.basename(projectDir), sessionId: path.basename(filePath, ".jsonl"), path: filePath }, { previous, reuse: "always" });
      if (candidate) files.push(candidate);
    } else if (insideRoot(resolved.codexSessions, filePath) && /^rollout-.+\.jsonl$/.test(path.basename(filePath))) {
      const candidate = await codexCandidate(filePath, { previous, reuse: "always" });
      if (candidate) files.push(candidate);
    }
  }
  const siblingIndex = new Map();
  for (const [absPath, entry] of Object.entries(known ?? {})) {
    if (entry?.vendor === "codex" && typeof entry.sessionId === "string") siblingIndex.set(entry.sessionId, { path: absPath, parentThreadId: entry.parentThreadId ?? null });
  }
  for (const file of files) if (file.vendor === "codex") siblingIndex.set(file.sessionId, { path: file.path, parentThreadId: file.parentThreadId ?? null });
  return { files, siblingIndex, roots: resolved, vendors: undefined };
}

/**
 * Which vendor stores exist on this machine, with file counts only. Gemini is
 * reported as detected-but-unparsed until an adapter exists.
 */
export async function vendorsPresent({ home = os.homedir(), roots = {}, env = process.env } = {}) {
  return (await discoverAll({ home, roots, env })).vendors;
}

async function detectGemini(tmpRoot) {
  const result = { vendor: "gemini", detected: false, files: 0, parsed: false };
  if (!(await directoryExists(tmpRoot))) return result;
  result.detected = true;
  const files = await walkFiles(tmpRoot, {
    maxDepth: 3,
    maxFiles: 5_000,
    accept: (filePath) => /[\\/]chats[\\/][^\\/]+\.jsonl?$/i.test(filePath),
  });
  result.files = files.length;
  return result;
}

/**
 * True when `previous` (a manifest entry) can stand in for a head read:
 * "unchanged" needs the same (size, mtimeMs); "always" (live passes) only
 * needs the entry to have learned a cwd once (a cwd never changes mid-session).
 */
function reusable(previous, { size, mtimeMs, reuse }) {
  if (!previous || typeof previous !== "object") return false;
  if (reuse === "always") return typeof previous.cwd === "string" && previous.cwd.length > 0;
  return previous.size === size && previous.mtimeMs === mtimeMs && "cwd" in previous;
}

async function discoverClaude(projectsRoot, { known } = {}) {
  if (!(await directoryExists(projectsRoot))) return [];
  let projectDirs;
  try {
    projectDirs = (await readdir(projectsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const candidates = [];
  for (const dirEntry of projectDirs) {
    const projectDir = path.join(projectsRoot, dirEntry.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (!UUID.test(sessionId)) continue;
      candidates.push({ projectDir, projectDirName: dirEntry.name, sessionId, path: path.join(projectDir, entry.name) });
    }
  }
  const results = await mapLimit(candidates, STAT_CONCURRENCY, (candidate) => claudeCandidate(candidate, { previous: known?.[candidate.path], reuse: "unchanged" }));
  return results.filter(Boolean);
}

async function claudeCandidate(candidate, { previous, reuse } = {}) {
  let details;
  try {
    details = await stat(candidate.path);
  } catch {
    return null;
  }
  if (!details.isFile() || details.size < MIN_FILE_BYTES) return null;
  let size = details.size;
  let mtimeMs = details.mtimeMs;
  let subagentDir;
  let subagentFiles = 0;
  const subagents = path.join(candidate.projectDir, candidate.sessionId, "subagents");
  try {
    const files = await readdir(subagents, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !/^agent-[0-9a-f]+\.(jsonl|meta\.json)$/.test(file.name)) continue;
      try {
        const sub = await stat(path.join(subagents, file.name));
        size += sub.size;
        mtimeMs = Math.max(mtimeMs, sub.mtimeMs);
        if (file.name.endsWith(".jsonl")) subagentFiles += 1;
      } catch {}
    }
    subagentDir = subagents;
  } catch {}
  const cwd = reusable(previous, { size, mtimeMs, reuse }) ? (previous.cwd ?? null) : await claudeCwd(candidate.path);
  const projectKey = cwd ? projectKeyFor(cwd) : encodedProjectDirToKey(candidate.projectDirName);
  const projectDisplay = cwd ? projectDisplayFor(cwd) : projectDisplayFor(candidate.projectDirName.replace(/^-/, "").replace(/-/g, "/"));
  return {
    vendor: "claude",
    path: candidate.path,
    size,
    mtimeMs,
    sessionId: candidate.sessionId,
    projectKey,
    projectDisplay,
    cwd: cwd ?? null,
    projectDir: candidate.projectDir,
    subagentDir,
    subagentFiles,
  };
}

async function claudeCwd(filePath) {
  let head;
  try {
    head = await readHead(filePath, HEAD_BYTES_CLAUDE);
  } catch {
    return null;
  }
  const lines = head.split("\n");
  // Only lines that parse count: a `"cwd"` inside a pasted payload on a partial line is not evidence.
  for (let index = 0; index < Math.min(lines.length, 40); index += 1) {
    const line = lines[index];
    if (!line.includes('"cwd"')) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.cwd === "string" && record.cwd) return record.cwd;
    } catch {}
  }
  return null;
}

async function discoverCodex(sessionsRoot, { known } = {}) {
  const siblingIndex = new Map();
  if (!(await directoryExists(sessionsRoot))) return { files: [], siblingIndex };
  const paths = await walkFiles(sessionsRoot, {
    maxDepth: 4,
    accept: (filePath) => /[\\/]rollout-[^\\/]+\.jsonl$/.test(filePath),
  });
  const results = await mapLimit(paths, STAT_CONCURRENCY, (filePath) => codexCandidate(filePath, { previous: known?.[filePath], reuse: "unchanged" }));
  const files = results.filter(Boolean);
  for (const file of files) siblingIndex.set(file.sessionId, { path: file.path, parentThreadId: file.parentThreadId ?? null });
  return { files, siblingIndex };
}

async function codexCandidate(filePath, { previous, reuse } = {}) {
  let details;
  try {
    details = await stat(filePath);
  } catch {
    return null;
  }
  if (!details.isFile() || details.size < MIN_FILE_BYTES) return null;
  const fromName = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/i.exec(filePath)?.[1];
  let meta;
  if (reusable(previous, { size: details.size, mtimeMs: details.mtimeMs, reuse })) {
    meta = { id: typeof previous.sessionId === "string" ? previous.sessionId : null, cwd: previous.cwd ?? null, parentThreadId: previous.parentThreadId ?? null, sourceKind: undefined };
  } else {
    meta = await codexMeta(filePath);
  }
  const sessionId = meta?.id ?? fromName ?? path.basename(filePath, ".jsonl");
  const cwd = meta?.cwd ?? null;
  return {
    vendor: "codex",
    path: filePath,
    size: details.size,
    mtimeMs: details.mtimeMs,
    sessionId,
    projectKey: cwd ? projectKeyFor(cwd) : localProjectKeyFor(`codex:${sessionId}`),
    projectDisplay: cwd ? projectDisplayFor(cwd) : "unknown",
    cwd,
    parentThreadId: meta?.parentThreadId ?? undefined,
    sourceKind: meta?.sourceKind ?? undefined,
  };
}

async function codexMeta(filePath) {
  let first;
  try {
    // The session_meta line can exceed 256 KB (base_instructions + dynamic_tools); read to the first newline.
    first = (await readFirstLine(filePath, { byteLimit: CODEX_META_LINE_BYTES })).line;
  } catch {
    return null;
  }
  let record;
  try {
    record = JSON.parse(first);
  } catch {
    return null;
  }
  if (record?.type !== "session_meta" || !record.payload || typeof record.payload !== "object") return null;
  const payload = record.payload;
  const spawn = payload.source?.subagent?.thread_spawn;
  const sourceKind = typeof payload.source === "string"
    ? payload.source
    : spawn ? "subagent.thread_spawn" : payload.source?.subagent?.other ? `subagent.${payload.source.subagent.other}` : "unknown";
  const parentThreadId = spawn?.parent_thread_id ?? payload.parent_thread_id ?? null;
  return {
    id: typeof payload.id === "string" ? payload.id : null,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    parentThreadId: typeof parentThreadId === "string" && parentThreadId !== payload.id ? parentThreadId : null,
    sourceKind,
  };
}
