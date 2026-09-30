/**
 * Findings rules engine (ADR-001 section 4, docs/cycle1-contracts.md).
 *
 * Rule modules live next to this file as `S-*.mjs` (setup) and `B-*.mjs`
 * (session / subagent). Each exports a default object
 * `{ id, scope, severity, title, whyItMatters, thresholdKeys, evaluate(input, thresholds) }`.
 * Thresholds merge, in order: thresholds.json <- thresholds.setup.json <- ~/.contextscope/thresholds.json.
 *
 * `rulesHash()` (ADR-003 section 9) is the sha1 over every rule module source
 * (`[SBH]-NN.mjs`, sorted, plus `util.mjs` and `habits.mjs`), `thresholds.json`,
 * `thresholds.setup.json` and the user thresholds file; the index stores it per
 * entry and re-evaluates stored runs whose hash differs without re-parsing.
 * `evaluateRun` stamps the hash on `run.coverage.rulesHash`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_AGGREGATED_EVIDENCE } from "./util.mjs";

const RULES_DIR = dirname(fileURLToPath(import.meta.url));
const RULE_FILE = /^[SB]-\d{2}\.mjs$/;
const HASHED_FILE = /^(?:[SBH]-\d{2}\.mjs|util\.mjs|habits\.mjs|thresholds\.json|thresholds\.setup\.json)$/;
const SEVERITIES = new Set(["high", "medium", "low"]);
const SCOPES = new Set(["setup", "session", "subagent"]);
const EVIDENCE_KINDS = new Set(["file", "request", "block", "scope", "metric", "run"]);
const PROVENANCES = new Set(["observed.vendor", "observed.artifact", "derived.exact", "estimated.local", "unknown"]);

export const severityOrder = { high: 0, medium: 1, low: 2 };

let rulesCache = null;

function warn(onWarning, message) {
  if (typeof onWarning === "function") onWarning(message);
  else if (onWarning !== false) console.warn(`[contextscope rules] ${message}`);
}

export function validateRuleModule(rule, file = "?") {
  if (!rule || typeof rule !== "object") throw new Error(`${file}: default export is not an object`);
  if (typeof rule.id !== "string" || !/^[SB]-\d{2}$/.test(rule.id)) throw new Error(`${file}: invalid rule id ${rule.id}`);
  if (!SCOPES.has(rule.scope)) throw new Error(`${file}: invalid scope ${rule.scope}`);
  if (!SEVERITIES.has(rule.severity)) throw new Error(`${file}: invalid severity ${rule.severity}`);
  if (typeof rule.title !== "string" || !rule.title) throw new Error(`${file}: missing title`);
  if (typeof rule.whyItMatters !== "string" || !rule.whyItMatters) throw new Error(`${file}: missing whyItMatters`);
  if (!Array.isArray(rule.thresholdKeys)) throw new Error(`${file}: thresholdKeys must be an array`);
  if (typeof rule.evaluate !== "function") throw new Error(`${file}: evaluate must be a function`);
  return rule;
}

/** readdir + dynamic import of every [SB]-NN.mjs; broken or missing modules are skipped with a warning. */
export async function loadRules({ dir = RULES_DIR, onWarning, force = false } = {}) {
  if (!force && dir === RULES_DIR && rulesCache) return rulesCache;
  let entries = [];
  try {
    entries = (await readdir(dir)).filter((name) => RULE_FILE.test(name)).sort();
  } catch (error) {
    warn(onWarning, `cannot read rules dir ${dir}: ${error.message}`);
  }
  const rules = [];
  const seen = new Set();
  for (const name of entries) {
    const file = join(dir, name);
    try {
      const mod = await import(pathToFileURL(file).href);
      const rule = validateRuleModule(mod.default, name);
      if (seen.has(rule.id)) { warn(onWarning, `${name}: duplicate rule id ${rule.id}, skipped`); continue; }
      seen.add(rule.id);
      rules.push(rule);
    } catch (error) {
      warn(onWarning, `${name}: skipped (${error.message})`);
    }
  }
  rules.sort((a, b) => a.id.localeCompare(b.id));
  if (dir === RULES_DIR) rulesCache = rules;
  return rules;
}

// --- rules hash ---

const hashCache = new Map(); // `${dir}|${userFile}` -> { key, hash }

async function statKey(file) {
  try {
    const info = await stat(file);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * sha1 (16 hex) over the sorted sources of every `[SBH]-NN.mjs` rule module and
 * `util.mjs`, the built-in thresholds files and the user thresholds file (missing
 * files hash as absent). Stat-cached: a call costs one readdir + N stats unless
 * something changed, so it can run on every index pass.
 */
export async function rulesHash({ dir = RULES_DIR, home = homedir() } = {}) {
  const userFile = userThresholdsPath(home);
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => HASHED_FILE.test(name)).sort();
  } catch { /* no rules dir: only the user file contributes */ }
  const files = [...names.map((name) => join(dir, name)), userFile];
  const key = (await Promise.all(files.map(statKey))).join("|");
  const cacheKey = `${dir}|${userFile}`;
  const cached = hashCache.get(cacheKey);
  if (cached && cached.key === key) return cached.hash;
  const hash = createHash("sha1");
  for (const file of files) {
    let body = null;
    try { body = await readFile(file); } catch { /* absent */ }
    hash.update(`${file.slice(file.lastIndexOf("/") + 1)}\0${body ? body.length : -1}\0`);
    if (body) hash.update(body);
  }
  const digest = hash.digest("hex").slice(0, 16);
  hashCache.set(cacheKey, { key, hash: digest });
  return digest;
}

// --- thresholds ---

function readJsonSync(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

async function readJson(file, onWarning) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") warn(onWarning, `ignoring ${file}: ${error.message}`);
    return null;
  }
}

function numericEntries(object) {
  const out = {};
  if (!object || typeof object !== "object") return out;
  for (const [key, value] of Object.entries(object)) if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  return out;
}

/** Built-in defaults: session keys merged with setup keys (if the setup file exists). Synchronous so validateThresholds can use it. */
export function defaultThresholds({ dir = RULES_DIR } = {}) {
  return { ...numericEntries(readJsonSync(join(dir, "thresholds.json"))), ...numericEntries(readJsonSync(join(dir, "thresholds.setup.json"))) };
}

export function userThresholdsPath(home = homedir()) {
  return join(home, ".contextscope", "thresholds.json");
}

export async function loadThresholds({ home = homedir(), dir = RULES_DIR, onWarning } = {}) {
  const session = numericEntries(await readJson(join(dir, "thresholds.json"), onWarning));
  const setup = numericEntries(await readJson(join(dir, "thresholds.setup.json"), onWarning));
  const user = await readJson(userThresholdsPath(home), onWarning);
  const merged = { ...session, ...setup };
  if (user) {
    const { valid, errors, values } = validateThresholds(user, { known: merged });
    if (!valid) warn(onWarning, `~/.contextscope/thresholds.json: ${errors.join("; ")}`);
    Object.assign(merged, values);
  }
  return merged;
}

/**
 * Validates a thresholds object for the PUT route: every key must be known
 * (present in the built-in defaults or `known`), every value a finite number.
 * Returns { valid, errors, values } where `values` holds only the accepted entries.
 */
export function validateThresholds(object, { known = defaultThresholds() } = {}) {
  const errors = [];
  const values = {};
  if (!object || typeof object !== "object" || Array.isArray(object)) return { valid: false, errors: ["thresholds must be an object"], values };
  for (const [key, value] of Object.entries(object)) {
    if (!(key in known)) { errors.push(`unknown key "${key}"`); continue; }
    if (typeof value !== "number" || !Number.isFinite(value)) { errors.push(`"${key}" must be a finite number`); continue; }
    if (value < 0) { errors.push(`"${key}" must not be negative`); continue; }
    values[key] = value;
  }
  return { valid: errors.length === 0, errors, values };
}

// --- findings ---

export function assertFindingShape(finding) {
  const fail = (message) => { throw new Error(`invalid finding ${finding?.id ?? "?"}: ${message}`); };
  if (!finding || typeof finding !== "object") fail("not an object");
  if (typeof finding.id !== "string" || !/^[SB]-\d{2}:[0-9a-f]{10}$/.test(finding.id)) fail(`bad id ${finding.id}`);
  if (typeof finding.ruleId !== "string" || !finding.id.startsWith(`${finding.ruleId}:`)) fail("id does not start with ruleId");
  if (!SEVERITIES.has(finding.severity)) fail(`bad severity ${finding.severity}`);
  if (!SCOPES.has(finding.scope)) fail(`bad scope ${finding.scope}`);
  if (typeof finding.title !== "string" || !finding.title) fail("missing title");
  if (typeof finding.whyItMatters !== "string" || !finding.whyItMatters) fail("missing whyItMatters");
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) fail("empty evidence");
  for (const item of finding.evidence) {
    if (!EVIDENCE_KINDS.has(item?.kind)) fail(`bad evidence kind ${item?.kind}`);
    if (typeof item.ref !== "string" || !item.ref) fail("evidence without ref");
    if (typeof item.label !== "string" || !item.label) fail("evidence without label");
    if (!PROVENANCES.has(item.provenance)) fail(`bad evidence provenance ${item.provenance}`);
    if (item.value !== undefined && (typeof item.value !== "number" || !Number.isFinite(item.value))) fail("evidence value not finite");
  }
  if (!finding.fix || typeof finding.fix !== "object") fail("missing fix");
  if (!["claude", "codex", "gemini", "both"].includes(finding.fix.platform)) fail(`bad fix platform ${finding.fix.platform}`);
  if (typeof finding.fix.summary !== "string" || !finding.fix.summary) fail("fix without summary");
  if (!Array.isArray(finding.thresholdKeys)) fail("thresholdKeys must be an array");
  if (finding.tokensAffected !== undefined && (typeof finding.tokensAffected !== "number" || !Number.isFinite(finding.tokensAffected))) fail("tokensAffected not finite");
  for (const key of ["recurrence", "sessions"]) {
    if (finding[key] !== undefined && (typeof finding[key] !== "number" || !Number.isFinite(finding[key]))) fail(`${key} not finite`);
  }
  if (finding.count !== undefined) {
    if (!Number.isInteger(finding.count) || finding.count < 1) fail(`count must be an integer >= 1, got ${finding.count}`);
    if (finding.evidence.length > MAX_AGGREGATED_EVIDENCE) fail(`aggregated finding carries ${finding.evidence.length} evidence items (max ${MAX_AGGREGATED_EVIDENCE})`);
  }
  if (finding.scopeId !== undefined && (typeof finding.scopeId !== "string" || !finding.scopeId)) fail("scopeId must be a non-empty string");
  return finding;
}

/**
 * Severity, then tokensAffected desc, then cross-session count desc (`sessions`, filled by the
 * API layer at read time; `recurrence` is the legacy name), then id.
 */
export function rankFindings(findings) {
  return [...findings].sort((a, b) =>
    (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
    || (b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)
    || (b.sessions ?? b.recurrence ?? 0) - (a.sessions ?? a.recurrence ?? 0)
    || a.id.localeCompare(b.id));
}

function dedupe(findings) {
  const byId = new Map();
  for (const finding of findings) if (!byId.has(finding.id)) byId.set(finding.id, finding);
  return [...byId.values()];
}

function runRule(rule, input, thresholds, onWarning) {
  let out;
  try {
    out = rule.evaluate(input, thresholds) ?? [];
  } catch (error) {
    warn(onWarning, `${rule.id}: evaluate threw (${error.message})`);
    return [];
  }
  if (!Array.isArray(out)) { warn(onWarning, `${rule.id}: evaluate did not return an array`); return []; }
  const valid = [];
  for (const finding of out) {
    try {
      valid.push(assertFindingShape(finding));
    } catch (error) {
      warn(onWarning, `${rule.id}: dropped finding (${error.message})`);
    }
  }
  return valid;
}

/**
 * Session and subagent findings for one finished run. Recurrence across sessions is not
 * computed here (the API layer fills `sessions` at read time from the manifest); `setup`
 * is the optional setup inventory, used by rules whose fix targets a file (B-05 agent files).
 */
export async function evaluateRun(run, { thresholds, rules, setup, onWarning, rulesHash: hash, home } = {}) {
  if (!run || !Array.isArray(run.scopes)) return [];
  const allRules = rules ?? (await loadRules({ onWarning }));
  const sessionRules = allRules.filter((rule) => rule.scope === "session" || rule.scope === "subagent");
  const merged = thresholds ?? (await loadThresholds({ onWarning, ...(home ? { home } : {}) }));
  const findings = [];
  for (const rule of sessionRules) findings.push(...runRule(rule, { run, setup }, merged, onWarning));
  // Which rule version produced these findings (Coverage.rulesHash, ADR-003 section 9); built-in rules only.
  const stamp = hash ?? (rules ? undefined : await rulesHash(home ? { home } : {}));
  if (stamp) run.coverage = { ...run.coverage, rulesHash: stamp };
  return rankFindings(dedupe(findings));
}

export async function evaluateSetup(setup, { thresholds, runs, sessionStats, rules, onWarning } = {}) {
  if (!setup || typeof setup !== "object") return [];
  const allRules = rules ?? (await loadRules({ onWarning }));
  const setupRules = allRules.filter((rule) => rule.scope === "setup");
  const merged = thresholds ?? (await loadThresholds({ onWarning }));
  const findings = [];
  for (const rule of setupRules) findings.push(...runRule(rule, { setup, runs, sessionStats }, merged, onWarning));
  return rankFindings(dedupe(findings));
}

export { RULES_DIR };
