/**
 * `contextscope check`: setup-only CI gate (ADR-003 section 7). Evaluates the
 * setup inventory and the S-* rules for one repository against budgets from
 * flags or `<repo>/.contextscope.json`; never opens the index, ~/.contextscope
 * or a transcript, and by default nothing under the developer's home either
 * (`--user-config` opts the user-level CLAUDE.md, settings and MCP servers in;
 * `CI=1` in the environment keeps them out regardless), so the same repo gives
 * the same verdict on a laptop and on a runner. Exit codes: 0 pass, 1
 * violations or findings at/above --fail-on, 2 usage or configuration error,
 * 3 runtime error (unreadable file, a rule that threw).
 */
import { withSources } from "../rules/sources.mjs";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolveRepoRoot } from "../util/repo.mjs";
import { buildSetupInventory } from "../setup/inventory.mjs";
import { isDirectory, exists } from "../setup/fs.mjs";
import { rootInstructionFile } from "../setup/precedence.mjs";
import { defaultThresholds, evaluateSetup, loadRules, severityOrder } from "../rules/index.mjs";
import { formatBasis, formatCount, padLeft, padRight } from "../util/format.mjs";

export const name = "check";
export const usage = "contextscope check [--repo <path>] [--config .contextscope.json] [--budget startup=6000] [--max-instruction-file 3000] [--no-broken-refs] [--fail-on high|medium|low] [--user-config] [--github] [--json]";
export const summary = [
  "CI gate over the setup only (no sessions, no index, no home config unless --user-config):",
  "startup budget, instruction file sizes, broken references and S-* findings.",
  "Exit 0 pass, 1 violations, 2 usage/config error, 3 runtime error.",
];

export const EXIT = { pass: 0, violations: 1, usage: 2, runtime: 3 };

export class CheckUsageError extends Error {}

const SEVERITIES = ["high", "medium", "low"];
/** Rules that need observed sessions to say anything useful; off in `check` unless the config turns them on. */
const SESSION_DEPENDENT_RULES = ["S-09", "S-10", "S-11"];

export const DEFAULT_CONFIG = { budgets: { startupTokens: 6000, instructionFileTokens: 3000 }, failOn: "high", brokenRefs: true, rules: {}, thresholds: {}, vendors: null, ignore: [] };

/** Normalises `.contextscope.json` (both the `budgets` shape and the ADR `check` shape). */
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, budgets: { ...DEFAULT_CONFIG.budgets }, rules: {}, thresholds: {}, ignore: [] };
  if (raw === null || raw === undefined) return config;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new CheckUsageError(".contextscope.json must contain a JSON object");
  const source = raw.check && typeof raw.check === "object" ? { ...raw, ...raw.check } : raw;
  const budgets = source.budgets ?? source.budget ?? {};
  const number = (value, label) => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new CheckUsageError(`.contextscope.json: ${label} must be a non-negative number`);
    return value;
  };
  const startup = number(budgets.startupTokens ?? budgets.startup, "budgets.startupTokens");
  const fileMax = number(budgets.instructionFileTokens ?? source.maxInstructionFile, "budgets.instructionFileTokens");
  if (startup !== undefined) config.budgets.startupTokens = startup;
  if (fileMax !== undefined) config.budgets.instructionFileTokens = fileMax;
  if (source.failOn !== undefined) {
    if (!SEVERITIES.includes(source.failOn)) throw new CheckUsageError(`.contextscope.json: failOn must be one of ${SEVERITIES.join(", ")}`);
    config.failOn = source.failOn;
  }
  if (source.brokenRefs !== undefined) config.brokenRefs = source.brokenRefs !== false;
  if (source.rules && typeof source.rules === "object") {
    for (const [id, state] of Object.entries(source.rules)) {
      if (!/^S-\d{2}$/.test(id)) throw new CheckUsageError(`.contextscope.json: rules keys must be setup rule ids (S-NN), got "${id}"`);
      if (state !== "off" && state !== "on") throw new CheckUsageError(`.contextscope.json: rules.${id} must be "on" or "off"`);
      config.rules[id] = state;
    }
  }
  if (source.thresholds && typeof source.thresholds === "object") {
    for (const [key, value] of Object.entries(source.thresholds)) config.thresholds[key] = number(value, `thresholds.${key}`);
  }
  if (Array.isArray(source.vendors)) config.vendors = source.vendors.filter((vendor) => ["claude", "codex", "gemini"].includes(vendor));
  if (source.ignore !== undefined) {
    if (!Array.isArray(source.ignore) || source.ignore.some((glob) => typeof glob !== "string")) throw new CheckUsageError(".contextscope.json: ignore must be an array of glob strings");
    config.ignore = source.ignore;
  }
  return config;
}

/** Minimal glob (`*`, `**`, `?`) to RegExp over repo-relative POSIX paths. */
export function globToRegExp(glob) {
  let source = "";
  const text = String(glob);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "*" && text[i + 1] === "*") {
      if (text[i + 2] === "/") { source += "(?:.*/)?"; i += 2; } else { source += ".*"; i += 1; }
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp(`^${source}$`);
}

function ignoredBy(config) {
  const patterns = config.ignore.map(globToRegExp);
  return (file) => typeof file === "string" && patterns.some((pattern) => pattern.test(file));
}

/** The file a finding is about: its first file evidence, else a concrete fix path (never a `<placeholder>`). */
export function findingFile(finding) {
  const evidence = finding.evidence?.find((item) => item.kind === "file" && typeof item.ref === "string" && !item.ref.includes("<"));
  if (evidence) return evidence.ref;
  return finding.fix?.path && !finding.fix.path.includes("<") ? finding.fix.path : undefined;
}

export async function readConfig(file, { required = false } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && !required) return normalizeConfig(null);
    throw new CheckUsageError(`cannot read config ${path.basename(file)}: ${error.code ?? error.message}`);
  }
  let raw;
  try { raw = JSON.parse(text); } catch (error) { throw new CheckUsageError(`${path.basename(file)} is not valid JSON: ${error.message}`); }
  return normalizeConfig(raw);
}

function applyFlags(config, args) {
  const budget = args.option("--budget", undefined);
  if (budget !== undefined) {
    for (const part of String(budget).split(",")) {
      const match = /^\s*([a-z]+)\s*=\s*(\d+)\s*$/i.exec(part);
      if (!match) throw new CheckUsageError(`--budget expects name=tokens (e.g. startup=6000), got "${part}"`);
      if (match[1].toLowerCase() === "startup") config.budgets.startupTokens = Number(match[2]);
      else if (match[1].toLowerCase() === "file") config.budgets.instructionFileTokens = Number(match[2]);
      else throw new CheckUsageError(`--budget: unknown budget "${match[1]}" (startup or file)`);
    }
  }
  const fileMax = args.option("--max-instruction-file", undefined);
  if (fileMax !== undefined) {
    if (!/^\d+$/.test(fileMax)) throw new CheckUsageError(`--max-instruction-file expects a token count, got "${fileMax}"`);
    config.budgets.instructionFileTokens = Number(fileMax);
  }
  if (args.has("--no-broken-refs")) config.brokenRefs = false;
  const failOn = args.option("--fail-on", undefined);
  if (failOn !== undefined) {
    if (!SEVERITIES.includes(failOn)) throw new CheckUsageError(`--fail-on must be one of ${SEVERITIES.join(", ")}`);
    config.failOn = failOn;
  }
  return config;
}

/** Vendors a CI runner should evaluate: whatever the repository configures (the runner's home has no ~/.claude). */
async function inferVendors(repoRoot) {
  const vendors = [];
  if ((await exists(path.join(repoRoot, "CLAUDE.md"))) || (await isDirectory(path.join(repoRoot, ".claude")))) vendors.push("claude");
  if ((await exists(path.join(repoRoot, "AGENTS.md"))) || (await isDirectory(path.join(repoRoot, ".codex")))) vendors.push("codex");
  if (await exists(path.join(repoRoot, "GEMINI.md"))) vendors.push("gemini");
  return vendors;
}

function ruleEnabled(id, config) {
  if (config.rules[id] === "off") return false;
  if (config.rules[id] === "on") return true;
  if (id === "S-05" && !config.brokenRefs) return false;
  return !SESSION_DEPENDENT_RULES.includes(id);
}

/**
 * One line per fact (ADR-004 fix 7): findings with the same (rule, title, file)
 * from two vendors merge into one carrying `vendors`; an S-01 "file oversized"
 * finding for a file that is already a size violation is folded into the
 * violation (same fact, same threshold). Returns { findings, folded }.
 */
export function dedupeFindings(findings, violations = []) {
  const oversized = new Set(violations.filter((violation) => violation.kind === "file").map((violation) => violation.file));
  const byKey = new Map();
  let folded = 0;
  for (const finding of findings) {
    const file = findingFile(finding);
    if (finding.ruleId === "S-01" && /^Instruction file oversized/.test(finding.title) && file && oversized.has(file)) { folded += 1; continue; }
    const key = `${finding.ruleId}|${finding.title}|${file ?? finding.id}`;
    const vendor = finding.vendor ?? (finding.fix?.platform && finding.fix.platform !== "both" ? finding.fix.platform : undefined);
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, { ...finding, vendors: vendor ? [vendor] : [] }); continue; }
    if (vendor && !existing.vendors.includes(vendor)) existing.vendors.push(vendor);
    if (severityOrder[finding.severity] < severityOrder[existing.severity]) existing.severity = finding.severity;
    existing.tokensAffected = Math.max(existing.tokensAffected ?? 0, finding.tokensAffected ?? 0);
    if (existing.vendors.length > 1) { delete existing.vendor; existing.fix = { ...existing.fix, platform: "both" }; }
  }
  return { findings: [...byKey.values()], folded };
}

/**
 * Runs the check; pure over the inventory once built. `userConfig: false`
 * (the default) points the inventory at an empty home so nothing under `~`
 * (user CLAUDE.md/AGENTS.md, settings, MCP servers) takes part.
 * Returns { ok, exitCode, repo, budget, violations, findings, folded, config, userConfig }.
 */
export async function runCheck({ repoRoot, home, config, userConfig = false }) {
  if (!(await isDirectory(repoRoot))) throw new CheckUsageError(`repository not found: ${repoRoot}`);
  const vendors = config.vendors ?? (await inferVendors(repoRoot));
  const sessionStats = { vendorsWithSessions: vendors, sessionCount: 0, hookRuns: {}, mcpInvocations: {}, mcpToolsObserved: {}, skillInvocations: {}, agentRuns: {}, instructionFilesObserved: [] };
  const emptyHome = userConfig ? null : await mkdtemp(path.join(os.tmpdir(), "contextscope-check-home-"));
  let inventory;
  try {
    inventory = await buildSetupInventory({ repoRoot, home: emptyHome ?? home, sessionStats, capture: false });
  } finally {
    if (emptyHome) await rm(emptyHome, { recursive: true, force: true }).catch(() => {});
  }
  const thresholds = {
    ...defaultThresholds(),
    instructionFileTokens: config.budgets.instructionFileTokens,
    instructionChainTokens: Math.min(defaultThresholds().instructionChainTokens ?? Infinity, config.budgets.startupTokens),
    ...config.thresholds,
  };
  const rules = (await loadRules({ onWarning: false })).filter((rule) => rule.scope === "setup" && ruleEnabled(rule.id, config));
  const ignored = ignoredBy(config);
  const rawFindings = (await evaluateSetup(inventory, { thresholds, rules, sessionStats, onWarning: false })).filter((finding) => !ignored(findingFile(finding)));

  const violations = [];
  const budget = {};
  for (const [vendor, entry] of Object.entries(inventory.startupBudget ?? {})) {
    const value = entry.total?.value ?? 0;
    const limit = config.budgets.startupTokens;
    const root = rootInstructionFile(inventory.instructionFiles, vendor);
    // Each vendor's line is that vendor's calibrated figure (the budget's `basis`), never a neutral ratio.
    const basis = entry.total?.basis ?? entry.instructions?.basis ?? "neutral";
    budget[vendor] = { startup: value, limit, ok: value <= limit, provenance: entry.instructions?.provenance, basis, file: root?.path };
    if (value > limit) violations.push({ kind: "budget", vendor, file: root?.path, value, limit, basis, message: `${vendor} startup budget is ${formatCount(value)} tokens (${formatBasis(basis)}), over ${formatCount(limit)} by ${formatCount(value - limit)}` });
  }
  // Violations cover files that enter a prompt (the chain and path-scoped rules); nested files only
  // load when the model works under their directory, and ignored globs (fixtures, vendored trees) are skipped.
  // A file's single figure is its vendor's estimate, or the larger of two vendors' (conservative); `basis` says which.
  for (const file of inventory.instructionFiles) {
    if (ignored(file.path) || (file.scope === "nested" && file.loadState === "discoverable")) continue;
    if (file.estTokens > config.budgets.instructionFileTokens) {
      const basis = file.estBasis ?? "neutral";
      violations.push({ kind: "file", file: file.path, value: file.estTokens, limit: config.budgets.instructionFileTokens, basis, message: `${file.path} is ${formatCount(file.estTokens)} est. tokens (${formatBasis(basis)}), over ${formatCount(config.budgets.instructionFileTokens)}` });
    }
    if (config.brokenRefs) {
      for (const ref of file.brokenRefs ?? []) violations.push({ kind: "broken-ref", file: file.path, ref, message: `${file.path} references ${ref}, which does not exist` });
    }
  }
  const { findings, folded } = dedupeFindings(rawFindings, violations);
  const failing = findings.filter((finding) => severityOrder[finding.severity] <= severityOrder[config.failOn]);
  const ok = violations.length === 0 && failing.length === 0;
  const skipped = (inventory.excluded ?? []).filter((item) => item.reason === "nested-repo" || item.reason === "gitignored");
  return { ok, exitCode: ok ? EXIT.pass : EXIT.violations, repo: path.basename(repoRoot), vendors, budget, violations, findings, folded, failing: failing.length, config, userConfig, skipped };
}

function vendorTag(finding) {
  const vendors = Array.isArray(finding.vendors) && finding.vendors.length ? finding.vendors : finding.vendor ? [finding.vendor] : [];
  return vendors.length ? ` · ${vendors.join("+")}` : "";
}

export function renderCheck(result) {
  const lines = [`ContextScope check · ${result.repo}${result.userConfig ? " · with user config (~)" : " · repo files only (no ~ config; --user-config to include)"}`];
  const skipped = result.skipped ?? [];
  if (skipped.length) {
    const nestedRepos = skipped.filter((item) => item.reason === "nested-repo").length;
    const ignoredDirs = skipped.length - nestedRepos;
    const parts = [nestedRepos ? `${formatCount(nestedRepos)} nested repo${nestedRepos === 1 ? "" : "s"} / worktree${nestedRepos === 1 ? "" : "s"}` : "", ignoredDirs ? `${formatCount(ignoredDirs)} git-ignored dir${ignoredDirs === 1 ? "" : "s"}` : ""].filter(Boolean);
    lines.push(`  skipped: ${parts.join(", ")} (not part of this checkout's setup; --json lists them)`);
  }
  const vendorRows = Object.entries(result.budget);
  if (!vendorRows.length) lines.push("  no instruction files or agent configuration found for claude, codex or gemini");
  for (const [vendor, row] of vendorRows) {
    const over = row.ok ? "" : `over by ${formatCount(row.startup - row.limit)}`;
    lines.push(`  ${padRight(vendor, 7)} startup ${padLeft(formatCount(row.startup), 7)} / ${formatCount(row.limit)} tokens   ${padRight(over, 18)} ${row.ok ? "ok" : "FAIL"}   (${formatBasis(row.basis)}, from disk)`);
  }
  for (const violation of result.violations) {
    if (violation.kind === "file") lines.push(`  ${padRight(violation.file, 34)} ${formatCount(violation.value)} tokens > ${formatCount(violation.limit)}   FAIL   (${formatBasis(violation.basis)})`);
    if (violation.kind === "broken-ref") lines.push(`  ${padRight(`${violation.file} → ${violation.ref}`, 34)} missing reference   FAIL`);
  }
  const failOn = severityOrder[result.config.failOn];
  for (const finding of result.findings) {
    const primary = findingFile(finding) ?? "";
    const tag = `[${finding.severity.toUpperCase()}]`;
    lines.push(`  ${tag} ${finding.ruleId} ${finding.title}${primary ? ` · ${primary}` : ""}${vendorTag(finding)}${severityOrder[finding.severity] <= failOn ? "" : "  (below --fail-on)"}`);
  }
  const folded = result.folded ? ` (${formatCount(result.folded)} finding${result.folded === 1 ? "" : "s"} folded into the size violation${result.folded === 1 ? "" : "s"} above)` : "";
  const counts = `${formatCount(result.violations.length)} violation${result.violations.length === 1 ? "" : "s"}, ${formatCount(result.failing)} finding${result.failing === 1 ? "" : "s"} at or above ${result.config.failOn}${folded}`;
  lines.push(result.ok ? `${counts} → ok (exit ${EXIT.pass})` : `${counts} → exit ${EXIT.violations}`);
  return lines.join("\n");
}

/** GitHub workflow-command escaping: data escapes `%`, CR, LF; a property value also escapes `:` and `,`. */
function escapeData(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotation(level, file, message) {
  return file ? `::${level} file=${escapeProperty(file)},line=1::${escapeData(message)}` : `::${level}::${escapeData(message)}`;
}

/** GitHub Actions workflow commands: errors for everything that fails the check, warnings for findings below --fail-on. */
export function renderGithub(result) {
  const lines = [];
  for (const violation of result.violations) lines.push(annotation("error", violation.file, violation.message));
  const failOn = severityOrder[result.config.failOn];
  for (const finding of result.findings) {
    const file = findingFile(finding);
    const level = severityOrder[finding.severity] <= failOn ? "error" : "warning";
    lines.push(annotation(level, file, `${finding.ruleId} ${finding.title}: ${finding.fix?.summary ?? finding.whyItMatters}${vendorTag(finding)}`));
  }
  return lines.join("\n");
}

export async function run(args, { home, cwd, env = process.env }) {
  const started = Date.now();
  let result;
  try {
    const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));
    const configFlag = args.option("--config", undefined);
    const configFile = configFlag ? path.resolve(configFlag) : path.join(repoRoot, ".contextscope.json");
    const config = applyFlags(await readConfig(configFile, { required: Boolean(configFlag) }), args);
    // The developer's home config is opt-in, and never read on a CI runner (`CI=1`), so laptops and runners agree.
    const userConfig = args.has("--user-config") && !(env.CI && env.CI !== "0" && env.CI !== "false");
    result = await runCheck({ repoRoot, home, config, userConfig });
  } catch (error) {
    if (error instanceof CheckUsageError) {
      console.error(`ContextScope check: ${error.message}`);
      process.exitCode = EXIT.usage;
      return;
    }
    console.error(`ContextScope check: runtime error: ${error?.message ?? error}`);
    process.exitCode = EXIT.runtime;
    return;
  }
  if (args.has("--json")) {
    console.log(JSON.stringify({ ok: result.ok, exitCode: result.exitCode, repo: result.repo, vendors: result.vendors, userConfig: result.userConfig, budget: result.budget, violations: result.violations, findings: result.findings.map(withSources), folded: result.folded, config: result.config, ms: Date.now() - started }, null, 2));
  } else {
    console.log(renderCheck(result));
    if (args.has("--github")) {
      const annotations = renderGithub(result);
      if (annotations) console.log(annotations);
    }
  }
  process.exitCode = result.exitCode;
}
