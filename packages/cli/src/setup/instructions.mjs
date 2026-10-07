/**
 * Instruction-file inventory: CLAUDE.md / AGENTS.md / GEMINI.md chains with
 * precedence, load state, broken references, Claude imports, and normalized
 * duplicate blocks between files (line hashes only; content never leaves).
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { estimateTokens } from "../ir/estimate.mjs";
import { parseFrontmatter, asStringList } from "./frontmatter.mjs";
import { extractImports, extractPathCandidates, findBrokenRefs, suffixIndex } from "./references.mjs";
import { precedenceFor } from "./precedence.mjs";
import { displayPath, exists, isInside, listEntries, readTextSafe, toPosix, walk } from "./fs.mjs";
import { countCommitsSince, hasGitDir, ignoredPaths, listIgnoredDirs, listRepoFiles } from "./git.mjs";

const MAX_NESTED = 200;
const MAX_SKIPPED_DIRS = 50;
const MAX_GIT_QUERIES = 20;
export const DUPLICATE_WINDOW = 3; // smallest block the inventory records; rules apply their own minimum

function normalizeLine(line) {
  return line.toLowerCase().replace(/[`*_>#|-]/g, " ").replace(/\s+/g, " ").trim();
}

function lineHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function hashedLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const normalized = normalizeLine(raw);
    if (normalized.length < 4) continue; // blank/decoration lines never anchor a block
    out.push(lineHash(normalized));
  }
  return out;
}

/** Runs of >= DUPLICATE_WINDOW identical normalized lines shared by two files. */
export function duplicateBlocks(a, b) {
  const positions = new Map();
  a.lines.forEach((hash, index) => {
    const list = positions.get(hash) ?? [];
    list.push(index);
    positions.set(hash, list);
  });
  const blocks = [];
  const usedB = new Set();
  for (let j = 0; j < b.lines.length; j += 1) {
    if (usedB.has(j)) continue;
    let best = 0;
    let bestI = -1;
    for (const i of positions.get(b.lines[j]) ?? []) {
      let length = 0;
      while (i + length < a.lines.length && j + length < b.lines.length && a.lines[i + length] === b.lines[j + length]) length += 1;
      if (length > best) { best = length; bestI = i; }
    }
    if (best >= DUPLICATE_WINDOW) {
      for (let k = 0; k < best; k += 1) usedB.add(j + k);
      blocks.push({
        a: a.path, b: b.path, lines: best,
        hash: lineHash(a.lines.slice(bestI, bestI + best).join("")),
      });
      j += best - 1;
    }
  }
  return blocks;
}

function candidateList(repoRoot, home) {
  return [
    { abs: path.join(home, ".claude", "CLAUDE.md"), scope: "user", vendors: ["claude"] },
    { abs: path.join(repoRoot, "CLAUDE.md"), scope: "project", vendors: ["claude"] },
    { abs: path.join(repoRoot, ".claude", "CLAUDE.md"), scope: "project", vendors: ["claude"] },
    { abs: path.join(repoRoot, "CLAUDE.local.md"), scope: "local", vendors: ["claude"] },
    { abs: path.join(home, ".codex", "AGENTS.md"), scope: "user", vendors: ["codex"] },
    { abs: path.join(repoRoot, "AGENTS.md"), scope: "project", vendors: ["codex"] },
    { abs: path.join(repoRoot, "AGENTS.override.md"), scope: "override", vendors: ["codex"] },
    { abs: path.join(home, ".gemini", "GEMINI.md"), scope: "user", vendors: ["gemini"] },
    { abs: path.join(repoRoot, "GEMINI.md"), scope: "project", vendors: ["gemini"] },
  ];
}

/**
 * Files proven loaded: `sessionStats.instructionFilesObserved` (index
 * aggregate) plus `captureObserved` (InstructionsLoaded records read directly
 * from ~/.contextscope/capture for this repository, ADR-003 section 6).
 * Entries are repo-relative displays or `~/`-relative paths (the inventory
 * resolves records from descendant working directories before they get here).
 */
function observedSet(sessionStats, captureObserved) {
  const raw = sessionStats?.instructionFilesObserved;
  const values = !raw ? [] : Array.isArray(raw) ? raw : Object.keys(raw);
  return new Set([...values, ...(captureObserved ?? [])].map((value) => normalizeObserved(String(value))));
}

function normalizeObserved(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Exact identity only: the record must name this file (its repo-relative
 * display, its absolute path, or its `~/` form). A suffix match would let
 * `~/.claude/CLAUDE.md` or `packages/api/CLAUDE.md` mark the root `CLAUDE.md`
 * as observed (review #3).
 */
export function wasObserved(observed, display, abs, { home } = {}) {
  if (!observed.size) return false;
  const candidates = new Set([normalizeObserved(display), normalizeObserved(abs)]);
  if (home && isInside(home, abs)) candidates.add("~/" + normalizeObserved(path.relative(home, abs)));
  for (const candidate of candidates) if (observed.has(candidate)) return true;
  return false;
}

export async function collectInstructionFiles({ repoRoot, home, vendorsDetected, sessionStats, captureObserved }) {
  const roots = [repoRoot, home];
  const observed = observedSet(sessionStats, captureObserved);
  const detected = new Set(vendorsDetected);
  const records = new Map(); // abs -> record (with private _lines)
  const basenames = new Set(); // every file name seen in the repo walk (for bare-name refs)
  let suffixes = null; // segment-suffixes of every repo file/dir (module-relative refs), built after the walk
  const skippedDirs = []; // [{ path, reason }]: nested repositories / worktrees and git-ignored directories

  async function addFile(abs, { scope, vendors, pathsFrontmatter, discoverable = false }) {
    const existing = records.get(abs);
    if (existing) {
      for (const vendor of vendors) if (!existing.vendors.includes(vendor)) existing.vendors.push(vendor);
      return existing;
    }
    const read = await readTextSafe(abs, { roots });
    if (!read) return null;
    const display = displayPath(abs, { repoRoot, home });
    let text = read.text;
    let paths = pathsFrontmatter;
    if (scope === "rules") {
      const fm = parseFrontmatter(text);
      paths = asStringList(fm.data?.paths ?? fm.data?.globs);
      text = fm.body;
    }
    const imports = vendors.includes("claude") ? extractImports(text) : [];
    const candidates = extractPathCandidates(text);
    let brokenRefs = await findBrokenRefs(candidates, { repoRoot, home, fileDir: path.dirname(abs), basenames, suffixes });
    if (brokenRefs.length && isInside(repoRoot, abs)) {
      // A path git would ignore (`.mercato/generated/`, build output) may legitimately not exist yet.
      const relDir = toPosix(path.relative(repoRoot, path.dirname(abs)));
      const asRepo = (ref) => ref.replace(/^\.\//, "");
      const asLocal = (ref) => toPosix(path.normalize(path.join(relDir, ref)));
      const ignored = await ignoredPaths(repoRoot, brokenRefs.flatMap((ref) => (ref.startsWith("~/") ? [] : [asRepo(ref), asLocal(ref)])));
      brokenRefs = brokenRefs.filter((ref) => !(ignored.has(asRepo(ref)) || ignored.has(asLocal(ref))));
    }
    const anyDetected = vendors.some(v => detected.has(v));
    let loadState = "discoverable";
    if (!discoverable && anyDetected && !(scope === "rules" && paths?.length)) loadState = "expected.load";
    if (wasObserved(observed, display, abs, { home })) loadState = "observed.loaded";
    const record = {
      path: display,
      scope,
      vendors: [...vendors],
      bytes: read.bytes,
      hash: createHash("sha1").update(read.text).digest("hex"), // observed.artifact; joins a session's nested_memory / AGENTS.md block hash (ADR-005 section 2)
      estTokens: estimateTokens(read.text, "prose"),
      precedence: precedenceFor(vendors[0], scope),
      mtime: read.mtime,
      loadState,
      brokenRefs,
    };
    if (scope === "rules") record.pathsFrontmatter = paths ?? [];
    if (vendors.includes("claude")) record.imports = imports;
    records.set(abs, record);
    Object.defineProperty(record, "_lines", { value: hashedLines(text), enumerable: false });
    Object.defineProperty(record, "_abs", { value: abs, enumerable: false });
    return record;
  }

  // One bounded walk of the repo: nested instruction files + the set of file names.
  const INSTRUCTION_NAMES = new Set(["CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md"]);
  // Skipped: nested repositories (a `.git` file or directory: worktrees, submodules, vendored clones) and
  // directories git ignores. Their instruction files belong to another checkout or to nobody.
  const ignoredDirs = await listIgnoredDirs(repoRoot);
  const walkedFiles = [];
  const nested = await walk(repoRoot, {
    maxDepth: 6, maxFiles: 20000,
    skipDir: async (abs) => {
      const rel = toPosix(path.relative(repoRoot, abs));
      const reason = ignoredDirs.has(rel) ? "gitignored" : (await exists(path.join(abs, ".git"))) ? "nested-repo" : null;
      if (reason && skippedDirs.length < MAX_SKIPPED_DIRS) skippedDirs.push({ path: rel + "/", reason });
      return Boolean(reason);
    },
    onFile: (abs) => { if (walkedFiles.length < 50_000) walkedFiles.push(toPosix(path.relative(repoRoot, abs))); },
    accept: (abs, name) => {
      basenames.add(name);
      return INSTRUCTION_NAMES.has(name) && path.dirname(abs) !== repoRoot;
    },
  });
  suffixes = suffixIndex((await listRepoFiles(repoRoot)) ?? walkedFiles);

  for (const candidate of candidateList(repoRoot, home)) await addFile(candidate.abs, candidate);

  // .claude/rules/**/*.md
  const rulesDir = path.join(repoRoot, ".claude", "rules");
  for (const abs of await walk(rulesDir, { maxDepth: 3, maxFiles: 200, accept: (_, name) => name.endsWith(".md") })) {
    await addFile(abs, { scope: "rules", vendors: ["claude"] });
  }
  for (const abs of await walk(path.join(home, ".claude", "rules"), { maxDepth: 3, maxFiles: 100, accept: (_, name) => name.endsWith(".md") })) {
    await addFile(abs, { scope: "rules", vendors: ["claude"] });
  }

  // Nested instruction files (lazy loaded by the vendors).
  for (const abs of nested.slice(0, MAX_NESTED)) {
    if (isInside(path.join(repoRoot, ".claude"), abs)) continue;
    const name = path.basename(abs);
    const vendors = name === "GEMINI.md" ? ["gemini"] : name.startsWith("AGENTS") ? ["codex"] : ["claude"];
    await addFile(abs, { scope: "nested", vendors, discoverable: true });
  }

  // Claude @imports: an imported file joins the Claude chain with the importer's scope.
  for (const record of [...records.values()]) {
    if (!record.imports?.length) continue;
    for (const imp of record.imports.slice(0, 20)) {
      const target = imp.startsWith("~/") ? path.join(home, imp.slice(2)) : path.resolve(path.dirname(record._abs), imp);
      if (!(isInside(repoRoot, target) || isInside(home, target))) continue;
      if (!(await exists(target))) continue;
      const imported = await addFile(target, { scope: record.scope === "rules" ? "rules" : record.scope, vendors: ["claude"] });
      if (imported && imported.loadState === "discoverable" && (record.loadState !== "discoverable")) imported.loadState = record.loadState;
      if (imported && !imported.vendors.includes("claude")) imported.vendors.push("claude");
    }
  }

  const files = [...records.values()].sort((a, b) => a.precedence - b.precedence || a.path.localeCompare(b.path));

  // Commit counts since mtime under each file's directory (for S-07), only inside a git repo.
  if (await hasGitDir(repoRoot)) {
    let queries = 0;
    for (const file of files) {
      if (!isInside(repoRoot, file._abs) || queries >= MAX_GIT_QUERIES) continue;
      queries += 1;
      const scopeDir = path.relative(repoRoot, path.dirname(file._abs)) || ".";
      const count = await countCommitsSince({ repoRoot, sinceIso: file.mtime, scopeDir, excludeFile: file.path });
      if (typeof count === "number") file.commitsSinceMtime = count;
    }
  }

  // Duplicate blocks between files sharing a vendor.
  const duplicates = [];
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const a = files[i];
      const b = files[j];
      if (!a.vendors.some(v => b.vendors.includes(v))) continue;
      for (const block of duplicateBlocks({ path: a.path, lines: a._lines }, { path: b.path, lines: b._lines })) duplicates.push(block);
    }
  }

  return { files, duplicates, skippedDirs };
}

/** Lists `.claude/hooks/` scripts by name only (never read or executed). */
export async function listHookScripts(repoRoot) {
  const dir = path.join(repoRoot, ".claude", "hooks");
  return (await listEntries(dir)).filter(e => e.isFile()).map(e => `.claude/hooks/${e.name}`).slice(0, 50);
}
