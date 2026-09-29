/**
 * The analysis provider behind the routes and `contextscope scan`: overview,
 * findings (with recurrence, groups and the first change), run and scope
 * payloads, setup inventory + setup findings, thresholds. Rules and setup
 * modules are loaded lazily; if either is missing the results degrade to
 * empty so the server still starts.
 */
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { contextscopeDir } from "../index/manifest.mjs";
import { projectKeyFor } from "../adapters/discover.mjs";
import { rankFindings, rankFirstChange } from "../index/entry.mjs";
import { aggregateStats, attachRecurrence, buildOverviewFromEntries, emptyStats, groupFindings, recurrenceByRule } from "../index/overview.mjs";
import { repoSessions } from "../index/reader.mjs";
import { changesFor } from "../index/changes.mjs";
import { writeJsonAtomic } from "../util/fs.mjs";
import { publicMessage, shortError } from "../util/errors.mjs";

const SETUP_CACHE_MS = 30_000;
const ANCHOR_CACHE_MS = 60_000;
const REPO_FILES_CACHE_MS = 60_000;
const MAX_REPO_FILES = 20_000;
export const SCOPES = new Set(["setup", "session", "subagent", "habit"]);
export const VENDORS = new Set(["claude", "codex", "gemini"]);

export function emptySetupInventory(repoRoot) {
  return {
    repo: { name: path.basename(repoRoot), root: "cwd", git: false },
    vendorsDetected: [],
    instructionFiles: [],
    skills: [],
    agents: [],
    hooks: [],
    mcpServers: [],
    commands: [],
    memory: { present: false, bytes: 0, files: 0, indexBytes: 0 },
    settings: [],
    startupBudget: {},
  };
}

function localValidateThresholds(body, known) {
  const errors = [];
  const values = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(known, key)) { errors.push(`unknown key "${key}"`); continue; }
    if (typeof value !== "number" || !Number.isFinite(value)) { errors.push(`"${key}" must be a finite number`); continue; }
    if (value < 0) { errors.push(`"${key}" must not be negative`); continue; }
    values[key] = value;
  }
  return { valid: errors.length === 0, errors, values };
}

export function createAnalysis({ index, home, repoRoot, rules, setup, habits, warn = (message) => console.error(message) }) {
  let depsPromise = null;
  let setupCache = null;
  let setupPending = null;
  const warned = new Set();

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(`ContextScope: ${message}`);
  }

  async function deps() {
    depsPromise ??= (async () => {
      let rulesModule = rules ?? null;
      let setupModule = setup ?? null;
      let habitsModule = habits ?? null;
      if (!rulesModule) {
        try { rulesModule = await import("../rules/index.mjs"); }
        catch (error) { warnOnce("rules", `rules engine unavailable (${shortError(error)}); thresholds and setup findings are empty.`); }
      }
      if (!setupModule) {
        try { setupModule = await import("../setup/inventory.mjs"); }
        catch (error) { warnOnce("setup", `setup inventory unavailable (${shortError(error)}); the setup view is empty.`); }
      }
      if (!habitsModule) {
        try { habitsModule = await import("../rules/habits.mjs"); }
        catch (error) { warnOnce("habits", `habit rules unavailable (${shortError(error)}); habit findings are empty.`); }
      }
      return { rules: rulesModule, setup: setupModule, habits: habitsModule };
    })();
    return depsPromise;
  }

  async function thresholds() {
    const { rules: rulesModule } = await deps();
    if (!rulesModule?.loadThresholds) return {};
    try { return (await rulesModule.loadThresholds({ home })) ?? {}; }
    catch (error) { warnOnce("thresholds", `thresholds could not be loaded (${publicMessage(error)}).`); return {}; }
  }

  /** The repo's population (ADR-004 §2): root runs + their descendants, resolved over the whole manifest. */
  async function population({ since } = {}) {
    const entries = typeof index.entries === "function" ? await index.entries() : await index.repoEntries({ repoRoot });
    return repoSessions({ entries, repoRoot, projectKey: repoRoot ? projectKeyFor(repoRoot) : undefined, since });
  }

  async function computeSetup() {
    const { rules: rulesModule, setup: setupModule } = await deps();
    let sessionStats = emptyStats();
    try {
      const pop = await population();
      sessionStats = aggregateStats(pop.entries, { sessions: pop.roots.length });
    } catch {}
    let inventory = emptySetupInventory(repoRoot);
    if (setupModule?.buildSetupInventory) {
      try { inventory = (await setupModule.buildSetupInventory({ repoRoot, home, sessionStats })) ?? inventory; }
      catch (error) { warnOnce("setup-build", `setup inventory failed (${publicMessage(error)}).`); }
    }
    let findings = [];
    if (rulesModule?.evaluateSetup) {
      try { findings = (await rulesModule.evaluateSetup(inventory, { thresholds: await thresholds(), runs: [], sessionStats })) ?? []; }
      catch (error) { warnOnce("setup-rules", `setup rules failed (${publicMessage(error)}).`); }
    }
    const recurrence = await repoRecurrence();
    attachRecurrence(findings, recurrence.byRule, { sessionCount: recurrence.sessionCount });
    return { ...inventory, findings, sessionStats };
  }

  async function getSetup({ maxAgeMs = SETUP_CACHE_MS } = {}) {
    if (setupCache && Date.now() - setupCache.at < maxAgeMs) return setupCache.value;
    setupPending ??= computeSetup().then((value) => { setupCache = { at: Date.now(), value }; return value; }).finally(() => { setupPending = null; });
    return setupPending;
  }

  function invalidateSetup() {
    setupCache = null;
    habitsCache = null;
    anchorCache = null;
  }

  /** Recurrence table of the launched repo (manifest only): distinct root runs per rule, sessions = roots. */
  async function repoRecurrence() {
    const pop = await population();
    return { byRule: recurrenceByRule(pop.roots, pop.children), sessionCount: pop.roots.length };
  }

  /**
   * Habit findings of the launched repo (ADR-003 §2): evaluated at read time
   * over the manifest's habit records; no run file is opened. Cached for the
   * setup cache window and invalidated with it.
   */
  let habitsCache = null;
  let habitsPending = null;
  async function computeHabits() {
    const { habits: habitsModule } = await deps();
    const pop = await population();
    const sessions = pop.roots.length;
    if (!habitsModule?.evaluateHabitsDetailed) return { findings: [], notes: [], sessions, evaluated: 0 };
    let setupInventory;
    try { setupInventory = await withAnchors(await getSetup()); } catch {}
    try {
      const result = await habitsModule.evaluateHabitsDetailed(pop.entries, { thresholds: await thresholds(), setup: setupInventory, rootOf: pop.rootOf, onWarning: (message) => warnOnce(`habit:${message}`, message) });
      return { findings: result.findings, notes: result.notes, sessions, evaluated: result.sessions, stale: result.stale ?? 0 };
    } catch (error) {
      warnOnce("habit-rules", `habit rules failed (${publicMessage(error)}).`);
      return { findings: [], notes: [], sessions, evaluated: 0 };
    }
  }

  async function getHabits({ maxAgeMs = SETUP_CACHE_MS } = {}) {
    if (habitsCache && Date.now() - habitsCache.at < maxAgeMs && habitsCache.indexAt === index.state?.lastRunAt) return habitsCache.value;
    habitsPending ??= computeHabits().then((value) => { habitsCache = { at: Date.now(), indexAt: index.state?.lastRunAt, value }; return value; }).finally(() => { habitsPending = null; });
    return habitsPending;
  }

  /** GET /api/v1/habits: findings with recurrence attached, the repo trends, notes on suppressed rules. */
  async function habitsResponse({ since } = {}) {
    const result = await getHabits();
    const recurrence = await repoRecurrence();
    const findings = attachRecurrence(result.findings.map((finding) => ({ ...finding })), recurrence.byRule, { sessionCount: recurrence.sessionCount });
    const trends = (await overview({ since, scope: "repo", limit: 1 })).trends;
    return { findings, groups: groupFindings(findings), notes: result.notes, sessions: result.sessions, evaluated: result.evaluated, stale: result.stale ?? 0, since: since ?? "all", trends };
  }

  async function findings({ scope = "", vendor = "" } = {}) {
    if (scope && !SCOPES.has(scope)) throw Object.assign(new Error("scope must be setup, session, subagent, or habit."), { status: 400 });
    if (vendor && !VENDORS.has(vendor)) throw Object.assign(new Error("vendor must be claude, codex, or gemini."), { status: 400 });
    const setupFindings = scope && scope !== "setup" ? [] : (await getSetup()).findings;
    const sessionFindings = scope === "setup" || scope === "habit" ? [] : await populationFindings({ vendor: vendor || undefined });
    const habitFindings = scope && scope !== "habit" ? [] : (await getHabits()).findings.map((finding) => ({ ...finding }));
    const recurrence = await repoRecurrence();
    const seen = new Set();
    const list = attachRecurrence(rankFindings([...setupFindings, ...sessionFindings, ...habitFindings]), recurrence.byRule, { sessionCount: recurrence.sessionCount }).filter((finding) => {
      if (scope && finding.scope !== scope) return false;
      if (vendor && finding.vendor && finding.vendor !== vendor) return false;
      if (seen.has(finding.id)) return false;
      seen.add(finding.id);
      return true;
    });
    const groups = groupFindings(list);
    return { findings: list, groups, firstChange: rankFirstChange(list) };
  }

  /** Stored findings of every run in the population (roots and their child rollouts), tagged with the root run. */
  async function populationFindings({ vendor } = {}) {
    const pop = await population();
    const findings = [];
    for (const entry of pop.entries) {
      if (vendor && entry.vendor !== vendor) continue;
      if (!entry.findingsCount) continue;
      const rootRunId = pop.rootOf(entry);
      for (const finding of await index.readFindings(entry.runId)) findings.push(rootRunId === entry.runId ? finding : { ...finding, rootRunId });
    }
    return findings;
  }

  /** Rule catalogue (title, whyItMatters) so manifest heads can be served as findings without storing prose per entry. */
  let catalogue = null;
  async function ruleCatalogue() {
    catalogue ??= (async () => {
      const map = new Map();
      const { rules: rulesModule } = await deps();
      if (typeof rulesModule?.loadRules !== "function") return map;
      try {
        for (const rule of await rulesModule.loadRules({ onWarning: false })) map.set(rule.id, { title: rule.title, whyItMatters: rule.whyItMatters });
      } catch {}
      return map;
    })();
    return catalogue;
  }

  async function hydrate(finding) {
    if (!finding || typeof finding.whyItMatters === "string") return finding;
    const rule = (await ruleCatalogue()).get(finding.ruleId);
    return { ...finding, title: finding.title ?? rule?.title ?? finding.ruleId, whyItMatters: rule?.whyItMatters ?? "" };
  }

  /**
   * Overview for `scope` ("repo" by default, "all" for the machine); `nested`
   * shows Codex child rollouts (`all` is the cycle-1 alias). Setup and habit
   * findings take part in the "first change" ranking, so the first call waits
   * for the (cached, cheap) inventory; instruction-file mtimes feed the trend markers.
   */
  async function overview({ since, limit, scope = "repo", nested, all = false, now } = {}) {
    let setupFindings = [];
    let instructionFiles = [];
    try {
      const inventory = await getSetup();
      setupFindings = inventory.findings ?? [];
      instructionFiles = inventory.instructionFiles ?? [];
    } catch {}
    let habitFindings = [];
    try { habitFindings = (await getHabits()).findings; } catch {}
    const entries = await index.entries();
    const manifest = typeof index.manifest === "function" ? await index.manifest() : {};
    const result = buildOverviewFromEntries(entries, {
      repoRoot, projectKey: repoRoot ? projectKeyFor(repoRoot) : undefined,
      scope, nested: nested ?? all, since, limit, now, setupFindings, habitFindings, instructionFiles,
      indexState: index.state ?? {},
      vendors: manifest?.vendors ?? [],
    });
    if (result.firstFinding) result.firstFinding = await hydrate(result.firstFinding);
    markLive(result.runs);
    return result;
  }

  /** `OverviewRun.live` from the watcher's accessor (index/watch.mjs attaches `index.liveRuns()`); absent outside `start`. */
  function markLive(rows) {
    if (typeof index.liveRuns !== "function") return;
    let live;
    try { live = index.liveRuns(); } catch { return; }
    if (!(live instanceof Map) || !live.size) return;
    const visit = (row) => {
      const info = live.get(row.id);
      if (info?.at) row.live = { at: info.at };
      for (const child of row.children ?? []) visit(child);
    };
    for (const row of rows ?? []) visit(row);
  }

  async function run(runId) {
    const payload = await index.readRunResponse(runId);
    if (!payload) return null;
    const recurrence = await repoRecurrence();
    attachRecurrence(payload.findings ?? [], recurrence.byRule, { sessionCount: recurrence.sessionCount });
    return payload;
  }

  async function scope(runId, scopeId) {
    return index.readScope(runId, scopeId);
  }

  /** Validates and persists a thresholds patch; throws { status: 400 } on invalid input. */
  async function saveThresholds(body) {
    const { rules: rulesModule } = await deps();
    if (!rulesModule?.loadThresholds) throw Object.assign(new Error("The rules engine is not available; thresholds cannot be saved."), { status: 503 });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Thresholds must be a JSON object."), { status: 400 });
    const known = await thresholds();
    const validate = typeof rulesModule.validateThresholds === "function"
      ? (object) => rulesModule.validateThresholds(object, { known })
      : (object) => localValidateThresholds(object, known);
    const result = validate(body);
    if (!result.valid) throw Object.assign(new Error(`Invalid thresholds: ${result.errors.join("; ")}`), { status: 400 });
    const dir = contextscopeDir(home);
    const file = path.join(dir, "thresholds.json");
    let existing = {};
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      // Only known, valid entries of the existing file survive the merge; stale keys do not persist forever.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = validate(parsed).values;
    } catch {}
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(file, { ...existing, ...result.values });
    invalidateSetup();
    // Stored session findings move only when the index re-evaluates them (review #2): the rules hash covers the
    // user thresholds file, so a pass re-runs the rules over every stored run without re-parsing; progress and
    // `done` arrive over SSE. Not awaited: the response returns as soon as the file is written.
    let reevaluating = false;
    if (typeof index.ensure === "function") {
      reevaluating = true;
      Promise.resolve().then(() => index.ensure({ force: false })).then(() => invalidateSetup()).catch((error) => warnOnce("thresholds-reevaluate", `re-evaluation after a thresholds change failed (${publicMessage(error)}).`));
    }
    return { thresholds: await thresholds(), reevaluating };
  }

  /**
   * Edit anchors per instruction file (ADR-005 §1): git commits that touched the
   * file (setup/git.mjs), cached for 60 s and keyed on the file list; a file
   * without anchors keeps its mtime as the one anchor (changes.mjs decides).
   */
  let anchorCache = null;
  async function instructionAnchorsFor(files) {
    const paths = files.map((file) => file.path).filter((p) => typeof p === "string" && !p.startsWith("~"));
    const key = paths.join("\0");
    if (anchorCache && anchorCache.key === key && Date.now() - anchorCache.at < ANCHOR_CACHE_MS) return anchorCache.value;
    let value = new Map();
    if (repoRoot && paths.length) {
      try {
        const git = await import("../setup/git.mjs");
        value = (await git.instructionAnchors({ repoRoot, paths })) ?? new Map();
      } catch (error) { warnOnce("anchors", `git anchors unavailable (${shortError(error)}); instruction edits use file mtimes.`); }
    }
    anchorCache = { key, at: Date.now(), value };
    return value;
  }

  /** The setup inventory with `instructionFiles[i].anchors` filled from git where the file is tracked (H-05 and changes share it). */
  async function withAnchors(inventory) {
    const files = Array.isArray(inventory?.instructionFiles) ? inventory.instructionFiles : [];
    if (!files.length) return inventory;
    const anchors = await instructionAnchorsFor(files);
    return { ...inventory, instructionFiles: files.map((file) => { const list = anchors.get(file.path); return list ? { ...file, anchors: list } : file; }) };
  }

  /**
   * GET /api/v1/changes (ADR-005 §1): before/after per instruction-file edit
   * over the repo population, manifest only. `since` bounds the sessions;
   * `file` narrows to one instruction file. Newest anchor first, at most 20;
   * anchors with an empty side are `notes`.
   */
  async function changes({ since, file } = {}) {
    let inventory = null;
    try { inventory = await withAnchors(await getSetup()); } catch {}
    const files = Array.isArray(inventory?.instructionFiles) ? inventory.instructionFiles : [];
    const pop = await population({ since });
    const sessions = pop.roots.map((root) => ({ root, descendants: pop.children.get(root.runId) ?? [] }));
    const catalogue = await ruleCatalogue();
    const result = changesFor({ files, sessions, file, titleOf: (ruleId) => catalogue.get(ruleId)?.title });
    return { ...result, since: since ?? "all", sessions: pop.roots.length, files: files.length };
  }

  /**
   * Repo-relative file list of the launched repo (`git ls-files`, else a bounded
   * walk), cached for 60 s; the attribution of temp-cwd sessions (ADR-005 §2)
   * matches tool targets against it. Never absolute paths.
   */
  let repoFilesCache = null;
  async function repoFiles() {
    if (repoFilesCache && Date.now() - repoFilesCache.at < REPO_FILES_CACHE_MS) return repoFilesCache.value;
    let value = new Set();
    if (repoRoot) {
      try {
        const { execFile } = await import("node:child_process");
        const output = await new Promise((resolve) => {
          try { execFile("git", ["ls-files", "-z"], { cwd: repoRoot, timeout: 3000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout))); }
          catch { resolve(null); }
        });
        if (output !== null) value = new Set(output.split("\0").filter(Boolean).slice(0, MAX_REPO_FILES));
        else {
          const { walkFiles } = await import("../util/fs.mjs");
          const list = await walkFiles(repoRoot, { maxDepth: 8, maxFiles: MAX_REPO_FILES });
          value = new Set(list.map((abs) => path.relative(repoRoot, abs).split(path.sep).join("/")));
        }
      } catch (error) { warnOnce("repo-files", `repo file list unavailable (${shortError(error)}).`); }
    }
    repoFilesCache = { at: Date.now(), value };
    return value;
  }

  return { deps, thresholds, getSetup, setup: getSetup, invalidateSetup, findings, overview, habits: habitsResponse, getHabits, run, scope, saveThresholds, repoRecurrence, population, changes, repoFiles, withAnchors };
}
