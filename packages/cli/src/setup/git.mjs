/**
 * Read-only git queries for S-07 (stale instructions). Runs `git log` through
 * execFile with a hard timeout; never shells out through a string command.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { isDirectory } from "./fs.mjs";

const GIT_TIMEOUT_MS = 3000;

export async function hasGitDir(repoRoot) {
  return isDirectory(path.join(repoRoot, ".git"));
}

function runGit(args, cwd, { maxBuffer = 4 * 1024 * 1024, input, okCodes = [] } = {}) {
  return new Promise(resolve => {
    try {
      const child = execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true }, (error, stdout) => {
        resolve(error && !okCodes.includes(error.code) ? null : String(stdout));
      });
      if (input !== undefined) child.stdin.end(input);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Number of commits since `sinceIso` that touched `scopeDir` (repo-relative,
 * "." for the root), excluding the instruction file itself. Returns null when
 * git is unavailable, times out, or the directory is not a repository.
 */
export async function countCommitsSince({ repoRoot, sinceIso, scopeDir = ".", excludeFile }) {
  if (!(await hasGitDir(repoRoot))) return null;
  const args = ["log", "--oneline", `--since=${sinceIso}`, "--", scopeDir];
  if (excludeFile) args.push(`:(exclude)${excludeFile}`);
  const output = await runGit(args, repoRoot);
  if (output === null) return null;
  return output.split("\n").filter(line => line.trim()).length;
}

const MAX_ANCHOR_FILES = 10;
export const MAX_LOG_ANCHORS = 10;

/**
 * Edit anchors of instruction files (ADR-005 §1): for each repo-relative path,
 * the last `MAX_LOG_ANCHORS` commits that touched it (`git log --follow`,
 * newest first) as `{ at, anchor: "commit", commit, bytes? }`, sizes joined
 * from one `git cat-file --batch-check` process. A path that is untracked,
 * outside the repo (`~/...`) or beyond the cap maps to `null`, and the caller
 * falls back to the file mtime. Never throws; no git → an empty map.
 */
export async function instructionAnchors({ repoRoot, paths }) {
  const anchors = new Map();
  if (!Array.isArray(paths) || !paths.length || !(await hasGitDir(repoRoot))) return anchors;
  const specs = [];
  let queries = 0;
  for (const file of paths) {
    if (typeof file !== "string" || !file || file.startsWith("~") || path.isAbsolute(file) || file.includes("..")) continue;
    if (queries >= MAX_ANCHOR_FILES) break;
    queries += 1;
    const output = await runGit(["log", `--format=%H%x09%cI`, "--follow", `-n`, String(MAX_LOG_ANCHORS), "--", file], repoRoot);
    if (output === null) continue;
    const list = [];
    for (const line of output.split("\n")) {
      const [commit, at] = line.split("\t");
      if (!commit || !Number.isFinite(Date.parse(at ?? ""))) continue;
      list.push({ at, anchor: "commit", commit: commit.slice(0, 12) });
      specs.push({ spec: `${commit}:${file}`, entry: list[list.length - 1] });
    }
    anchors.set(file, list.length ? list : null);
  }
  if (specs.length) {
    const sizes = await runGitWithInput(["cat-file", "--batch-check=%(objectsize)"], repoRoot, specs.map((item) => item.spec).join("\n") + "\n");
    if (sizes !== null) {
      const lines = sizes.split("\n");
      specs.forEach((item, index) => {
        const size = Number(lines[index]);
        if (Number.isFinite(size) && size >= 0) item.entry.bytes = size;
      });
    }
  }
  return anchors;
}

function runGitWithInput(args, cwd, input) {
  return new Promise(resolve => {
    try {
      const child = execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } catch {
      resolve(null);
    }
  });
}

const MAX_LISTED_FILES = 100_000;

/**
 * Repository files for reference resolution: tracked plus untracked-not-ignored
 * (`git ls-files -co --exclude-standard`), repo-relative POSIX paths. Null when
 * git is unavailable, so the caller falls back to its own walk.
 */
export async function listRepoFiles(repoRoot) {
  const output = await runGit(["ls-files", "-co", "--exclude-standard", "-z"], repoRoot, { maxBuffer: 64 * 1024 * 1024 });
  if (output === null) return null;
  return output.split("\0").filter(Boolean).slice(0, MAX_LISTED_FILES);
}

/**
 * Directories git ignores (`git ls-files -oi --exclude-standard --directory`),
 * repo-relative without the trailing slash. Empty when git is unavailable.
 */
export async function listIgnoredDirs(repoRoot) {
  const output = await runGit(["ls-files", "-oi", "--exclude-standard", "--directory", "-z"], repoRoot, { maxBuffer: 64 * 1024 * 1024 });
  if (output === null) return new Set();
  return new Set(output.split("\0").filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)));
}

/**
 * The subset of repo-relative paths git would ignore (`git check-ignore --no-index --stdin`),
 * whether or not they exist: build outputs a doc may name before they are generated.
 * Exit 1 means "none ignored". Empty set when git is unavailable.
 */
export async function ignoredPaths(repoRoot, paths) {
  const list = [...new Set(paths)].filter((entry) => entry && !entry.startsWith("..") && !path.isAbsolute(entry));
  if (!list.length) return new Set();
  const output = await runGit(["check-ignore", "--no-index", "--stdin", "-z"], repoRoot, { input: list.join("\0") + "\0", okCodes: [1] });
  return new Set((output ?? "").split("\0").filter(Boolean));
}
