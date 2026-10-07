/**
 * Guarded filesystem helpers for the setup inventory.
 *
 * Security rules (ADR 5.6): only files under an allowlisted root (repoRoot or
 * home) are opened; symlinks are resolved and rejected when they escape those
 * roots; files over MAX_FILE_BYTES are skipped; nothing is executed here.
 */
import path from "node:path";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const IGNORED_DIRS = new Set([
  ".git", ".next", ".vinext", ".wrangler", "build", "coverage", "dist", "node_modules",
  ".turbo", ".cache", "vendor", "target", "out", ".venv", "venv", "__pycache__",
]);

export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveRoot(dir) {
  try {
    return await realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

export async function statSafe(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

export async function exists(filePath) {
  return (await statSafe(filePath)) !== null;
}

export async function isDirectory(filePath) {
  const info = await statSafe(filePath);
  return Boolean(info && info.isDirectory());
}

/**
 * Returns { text, bytes, mtime } or null when the file is missing, too large,
 * or a symlink pointing outside the allowed roots.
 */
export async function readTextSafe(filePath, { roots = [] } = {}) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    return null;
  }
  let target = filePath;
  if (info.isSymbolicLink()) {
    try {
      target = await realpath(filePath);
    } catch {
      return null;
    }
    if (roots.length && !roots.some(root => isInside(root, target))) return null;
    info = await statSafe(target);
    if (!info) return null;
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_FILE_BYTES) return null;
  try {
    const text = await readFile(target, "utf8");
    return { text, bytes: info.size, mtime: info.mtime.toISOString(), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

export async function listEntries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Breadth-first walk bounded by depth and file count; symlinked directories are not followed.
 * `skipDir(abs, name)` may veto a directory (return true); `onFile(abs, name)` sees every file visited.
 */
export async function walk(root, { maxDepth = 6, maxFiles = 5000, accept = () => true, ignore = IGNORED_DIRS, skipDir, onFile } = {}) {
  if (!(await isDirectory(root))) return [];
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && found.length < maxFiles) {
    const current = queue.shift();
    for (const entry of await listEntries(current.dir)) {
      if (found.length >= maxFiles) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isFile()) {
        onFile?.(full, entry.name);
        if (accept(full, entry.name)) found.push(full);
      } else if (entry.isDirectory() && current.depth < maxDepth && !ignore.has(entry.name) && !(skipDir && (await skipDir(full, entry.name)))) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Repo-relative or ~-relative display path; falls back to the basename for anything else. */
export function displayPath(absPath, { repoRoot, home }) {
  if (repoRoot && isInside(repoRoot, absPath)) return toPosix(path.relative(repoRoot, absPath)) || ".";
  if (home && isInside(home, absPath)) return "~/" + toPosix(path.relative(home, absPath));
  return path.basename(absPath);
}
