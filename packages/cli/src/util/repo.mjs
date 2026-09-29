/**
 * Repository root resolution (ADR-004 fix 6): the repo a command reports on is
 * the git top level of the directory it was launched from, not the cwd itself,
 * so `scan --all` from `packages/cli` reports `context-viewer`. A `.git`
 * entry may be a directory (a checkout) or a file (a worktree or submodule).
 * No git process is spawned; nothing is read but directory entries.
 */
import path from "node:path";
import { statSync } from "node:fs";

function hasGitEntry(dir) {
  try {
    const info = statSync(path.join(dir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

/** Nearest ancestor of `dir` (inclusive) that holds a `.git` entry, else `null`. */
export function gitTopLevel(dir) {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 128; depth += 1) {
    if (hasGitEntry(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * The repo root for a command: `explicit` (a `--repo` value) as given, else the
 * git top level above `cwd`, else `cwd`. An explicit path is honoured verbatim
 * so a sub-package or a fixture directory inside a larger checkout can be
 * checked on its own.
 */
export function resolveRepoRoot(cwd, explicit) {
  if (explicit) return path.resolve(cwd ?? process.cwd(), explicit);
  const base = path.resolve(cwd ?? process.cwd());
  return gitTopLevel(base) ?? base;
}
