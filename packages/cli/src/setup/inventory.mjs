/**
 * Setup inventory (Context Bill of Materials) for one repository.
 * Shape: SetupInventory in src/ir/types.ts, plus two additive fields the S-*
 * rules need because rules cannot touch the filesystem:
 *   - instructionFiles[i].commitsSinceMtime (git commits under the file's dir since its mtime)
 *   - instructionDuplicates: [{ a, b, lines, hash }] (normalized line-hash runs shared by two files)
 *   - mcpServers[i].vendor ("claude" | "codex"), skills[i].frontmatterError
 *   - hookScripts: names under .claude/hooks/ (never read or executed)
 *   - sessionCount: copied from sessionStats when provided
 *   - excluded: [{ path, reason: "fixture" }] instruction/skill/agent/command files, plus
 *     [{ path: "dir/", reason: "nested-repo" | "gitignored" }] directories the repo walk skipped
 *     under test fixture directories (test/fixtures, __fixtures__, spec/fixtures ...):
 *     listed for the Setup screen, never part of the chain, the budget, the
 *     trend markers or the S-* rules (a repo that ships fixture CLAUDE.md files
 *     is not "loading" them)
 * Only allowlisted config locations are read; nothing is executed except a
 * read-only `git log` when the repo has a .git directory.
 */
import path from "node:path";
import { IGNORED_DIRS, isDirectory, isInside, listEntries, resolveRoot, toPosix } from "./fs.mjs";
import { collectInstructionFiles, listHookScripts } from "./instructions.mjs";
import { collectSettings, attachObservations } from "./config.mjs";
import { collectSkills, collectAgents, collectCommands, collectMemory } from "./extensions.mjs";
import { buildStartupBudget } from "./budget.mjs";
import { readRecentCaptureRecords } from "../capture/reader.mjs";
import { projectKeyFor } from "../ir/project.mjs";

const VENDORS = ["claude", "codex", "gemini"];
const CAPTURE_MAX_FILES = 50;
/** Descendant working directories considered for capture attribution (bounded walk). */
const CWD_WALK_DEPTH = 5;
const CWD_WALK_MAX_DIRS = 3000;
const FIXTURE_DIRS = [/(^|\/)(?:test|tests|__tests__|spec|specs)\/fixtures?\//, /(^|\/)__fixtures__\//];

/** True for a repo-relative path under a test fixture directory. */
export function isFixturePath(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  return FIXTURE_DIRS.some((pattern) => pattern.test(normalized));
}

/** Splits `items` (objects with `path`) into kept and fixture-excluded; `excluded` collects `{ path, reason }`. */
function withoutFixtures(items, excluded) {
  const kept = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (isFixturePath(item?.path)) excluded.push({ path: item.path, reason: "fixture" });
    else kept.push(item);
  }
  return kept;
}

/**
 * `projectKeyFor(dir)` -> dir for the repo root (resolved and raw) and its
 * descendant directories (bounded: depth CWD_WALK_DEPTH, CWD_WALK_MAX_DIRS,
 * skipping IGNORED_DIRS and dot-directories other than `.claude`, whose
 * `worktrees/` hold checkouts). A session launched in `packages/cli` or in a
 * worktree is attributed to the repo, the same rule the index applies to cwd.
 */
export async function repoCwdKeys({ repoRoot, repoRootRaw }) {
  const keys = new Map();
  const add = (dir) => keys.set(projectKeyFor(dir), dir);
  add(repoRoot);
  if (repoRootRaw && repoRootRaw !== repoRoot) add(repoRootRaw);
  const queue = [{ dir: repoRoot, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < CWD_WALK_MAX_DIRS) {
    const { dir, depth } = queue.shift();
    for (const entry of await listEntries(dir)) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const full = path.join(dir, entry.name);
      add(full);
      seen += 1;
      if (seen >= CWD_WALK_MAX_DIRS) break;
      if (depth + 1 < CWD_WALK_DEPTH) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return keys;
}

/**
 * Instruction files the InstructionsLoaded hook saw for this repository: records
 * whose `cwdKey` is the repo root or a descendant directory (`repoCwdKeys`),
 * read from the newest capture files. A cwd-relative `file` is resolved against
 * that directory and returned repo-relative (`CLAUDE.md` recorded from
 * `packages/cli` means `packages/cli/CLAUDE.md`, never the root file); `~/`
 * paths are kept as recorded. Bounded and best-effort; `capture: false`
 * (CI `check`) skips ~/.contextscope.
 */
export async function captureObservedFiles({ home, repoRoot, repoRootRaw }) {
  const files = new Set();
  try {
    const keys = await repoCwdKeys({ repoRoot, repoRootRaw });
    const records = await readRecentCaptureRecords({ home, maxFiles: CAPTURE_MAX_FILES, events: ["InstructionsLoaded"] });
    for (const record of records) {
      const dir = keys.get(record.cwdKey);
      if (!dir || typeof record.file !== "string" || !record.file) continue;
      const resolved = resolveObservedFile(record.file, { dir, repoRoot });
      if (resolved) files.add(resolved);
    }
  } catch {}
  return [...files];
}

/** Repo-relative display for a record's file, or the `~/` form as recorded; null for a path that leaves the repo. */
export function resolveObservedFile(file, { dir, repoRoot }) {
  const text = String(file).replace(/\\/g, "/");
  if (text.startsWith("~/")) return text;
  if (path.isAbsolute(text)) return null;
  const abs = path.resolve(dir, text);
  if (!isInside(repoRoot, abs)) return null;
  return toPosix(path.relative(repoRoot, abs)) || ".";
}

export async function detectVendors({ home, sessionStats }) {
  const vendors = new Set();
  if (await isDirectory(path.join(home, ".claude"))) vendors.add("claude");
  if (await isDirectory(path.join(home, ".codex"))) vendors.add("codex");
  for (const vendor of sessionStats?.vendorsWithSessions ?? []) if (VENDORS.includes(vendor)) vendors.add(vendor);
  return VENDORS.filter(v => vendors.has(v));
}

export async function buildSetupInventory({ repoRoot, home, sessionStats, capture = true } = {}) {
  const resolvedRepo = await resolveRoot(repoRoot ?? process.cwd());
  const resolvedHome = await resolveRoot(home ?? process.env.HOME ?? "");
  const ctx = { repoRoot: resolvedRepo, home: resolvedHome, sessionStats, repoRootRaw: path.resolve(repoRoot ?? process.cwd()) };

  const vendorsDetected = await detectVendors({ home: resolvedHome, sessionStats });
  const captureObserved = capture ? await captureObservedFiles(ctx) : [];
  const collected = await collectInstructionFiles({ ...ctx, vendorsDetected, captureObserved });
  const [allSkills, allAgents, allCommands, memory, config, hookScripts] = await Promise.all([
    collectSkills(ctx),
    collectAgents(ctx),
    collectCommands(ctx),
    collectMemory(ctx),
    collectSettings(ctx),
    listHookScripts(resolvedRepo),
  ]);
  attachObservations(config, sessionStats);

  // Fixture files are inventoried but never counted (see the header note).
  const excluded = [];
  const instructionFiles = withoutFixtures(collected.files, excluded);
  const skills = withoutFixtures(allSkills, excluded);
  const agents = withoutFixtures(allAgents, excluded);
  const commands = withoutFixtures(allCommands, excluded);
  const excludedPaths = new Set(excluded.map((item) => item.path));
  const duplicates = (collected.duplicates ?? []).filter((block) => !excludedPaths.has(block.a) && !excludedPaths.has(block.b));
  for (const dir of collected.skippedDirs ?? []) excluded.push(dir);
  excluded.sort((a, b) => a.path.localeCompare(b.path));

  const inventory = {
    repo: { name: path.basename(resolvedRepo), root: "cwd", git: await isDirectory(path.join(resolvedRepo, ".git")) },
    vendorsDetected,
    instructionFiles,
    skills,
    agents,
    hooks: config.hooks,
    hookScripts,
    mcpServers: config.mcpServers,
    commands,
    memory,
    settings: config.settings,
    startupBudget: buildStartupBudget({ vendorsDetected, instructionFiles, skills, agents, mcpServers: config.mcpServers, sessionStats }),
    instructionDuplicates: duplicates,
    excluded,
  };
  if (sessionStats && typeof sessionStats.sessionCount === "number") inventory.sessionCount = sessionStats.sessionCount;
  return inventory;
}
