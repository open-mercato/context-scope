/**
 * Privacy-safe export (ADR-003 section 5, ADR-004 fix wave 2): the
 * `contextscope.export/1` document, its assembly from the index, and the
 * structural validation the importer (hosted demo, `#/open`) and the tests
 * share.
 *
 * An export is the run shell plus chosen scopes, exactly what the API already
 * serves, with an optional salted label hash. It runs through the same
 * forbidden-key scrub as the index and two leak gates over the WHOLE
 * serialised document (every string, the markdown included):
 *   - plain mode: no absolute path anywhere (`/Users/`, `/home/`, `C:\`, the
 *     encoded `-Users-` / `-home-`, or `/<dir>/<dir>` after a word boundary);
 *     `~/` is allowed only for the vendor config directories (`~/.claude/…`,
 *     `~/.codex/…`) and, by contract, in the display fields
 *     `project.cwdDisplay` and `source.file`;
 *   - redacted mode: additionally no path-like token at all
 *     (`redact.mjs` `findPathLikeTokens`).
 * The exporter also enforces the importer's 50 MB cap.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { scrubForbiddenKeys, summarizeScope } from "../index/entry.mjs";
import { attachRecurrence } from "../index/overview.mjs";
import { findPathLikeTokens, newSalt, redactExport } from "./redact.mjs";
import { renderMarkdown } from "./markdown.mjs";

export const EXPORT_SCHEMA = "contextscope.export/1";
export const GENERATOR_NAME = "contextscope";
/** Importers refuse anything larger (raw JSON bytes); the exporter refuses to produce it. */
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const LABEL_MODES = new Set(["plain", "sha1-10"]);
const PROJECT_MODES = new Set(["basename", "hashed"]);
const VENDORS = new Set(["claude", "codex", "gemini"]);
// Substring leak patterns (not line-anchored): a well-known home prefix, a drive letter, the encoded
// Claude project-directory form, or `/<dir>/<dir…>` right after a boundary (start, space, quote,
// bracket, `=`, `:`…). `~/` never precedes the slash here, so home-relative paths pass; slash
// commands (`/compact …`) have no second directory segment and pass; `.claude/agents/x.md` and
// URLs (`//host/`) are not preceded by a boundary character.
const ABSOLUTE_PATH = /\/Users\/|\/home\/|-Users-|-home-|[A-Za-z]:\\|(?:^|[\s"'`([{=:,;<>])\/(?:[A-Za-z0-9._@-]+\/)+/;
// `~/` outside a display field must point at a vendor or ContextScope config directory.
const HOME_RELATIVE = /~\/(?!\.claude\/|\.codex\/|\.gemini\/|\.contextscope\/|\.claude\.json\b)/;
const DISPLAY_FIELD = /(?:^|\.)(?:cwdDisplay|source\.file)$/;

let versionPromise = null;
export async function generatorVersion() {
  versionPromise ??= readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
    .then((text) => JSON.parse(text).version ?? "0.0.0")
    .catch(() => "0.0.0");
  return versionPromise;
}

/**
 * Parses `--scopes`: "main" (default), "all", or a comma-separated list of scope ids.
 * The main scope is always included.
 */
export function parseScopeSelection(value) {
  if (!value || value === "main") return { mode: "main", ids: [] };
  if (value === "all") return { mode: "all", ids: [] };
  return { mode: "list", ids: String(value).split(",").map((id) => id.trim()).filter(Boolean) };
}

/** Deep-clone via JSON so redaction and scrubbing never touch the cached payload. */
const clone = (value) => JSON.parse(JSON.stringify(value));

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Assembles an export for `runId` from an index (`readRunShell`, `readFindings`,
 * `readScope`). `run.scopes` holds every scope as a summary (`partial: true`);
 * `scopes` holds the selected scopes in full, the main scope always. Options:
 * `{ scopes, redact, thresholds, recurrence, now, version, salt, maxBytes }`;
 * `recurrence` is `{ byRule, sessionCount }` from `analysis.repoRecurrence()`
 * so findings carry the same `recurrence` the API serves. Throws
 * `{ status: 404 }` when the run is unknown, `{ status: 413 }` when the
 * document would exceed `maxBytes` (the importer's cap), and a plain error
 * when a leak gate fires.
 */

/**
 * `newBlockIds` is derivable from every block's `firstRequest`, so an export
 * drops it: on the largest local run that is ~8% of the document, and the UI
 * already falls back to the blocks (packages/ui/src/components/Ledger.tsx).
 */
function slimScope(scope) {
  for (const request of scope.requests ?? []) { delete request.newBlockIds; delete request.visibleBlockIds; }
  return scope;
}

export async function buildExport({ index, runId, scopes = "main", redact = false, thresholds = {}, recurrence, now = new Date(), version, salt, maxBytes = MAX_EXPORT_BYTES } = {}) {
  const shell = await index.readRunShell(runId);
  if (!shell) throw Object.assign(new Error(`Run not found: ${runId}`), { status: 404 });
  const run = clone(shell);
  run.findings = clone(await index.readFindings(runId));
  if (recurrence?.byRule) attachRecurrence(run.findings, recurrence.byRule, { sessionCount: recurrence.sessionCount ?? 0 });
  const selection = typeof scopes === "string" ? parseScopeSelection(scopes) : scopes;
  const mainId = run.scopes?.[0]?.id ?? "main";
  const wanted = new Set([mainId]);
  if (selection.mode === "all") for (const scope of run.scopes ?? []) wanted.add(scope.id);
  for (const id of selection.ids ?? []) wanted.add(id);

  const fullScopes = {};
  const extraScopes = [];
  for (const summary of run.scopes ?? []) {
    if (!wanted.has(summary.id)) {
      // Redaction learns labels from every scope of the run, exported or not (ADR-004 section 5).
      if (redact) { const full = await index.readScope(runId, summary.id); if (full) extraScopes.push(full); }
      continue;
    }
    const full = await index.readScope(runId, summary.id);
    if (full) fullScopes[summary.id] = slimScope(clone(full));
    else if (Array.isArray(summary.requests)) fullScopes[summary.id] = slimScope(clone(summary));
  }
  if (!fullScopes[mainId]) throw Object.assign(new Error(`Main scope of ${runId} is not in the index`), { status: 404 });
  // Shell scopes stay summaries (the full ones live in `scopes`); an unsplit shell is summarised here.
  run.scopes = (run.scopes ?? []).map((scope) => (Array.isArray(scope.requests) ? summarizeScope(scope) : scope));

  const doc = {
    schema: EXPORT_SCHEMA,
    exportedAt: now.toISOString(),
    generator: { name: GENERATOR_NAME, version: version ?? await generatorVersion() },
    redaction: { labels: "plain", project: "basename" },
    run,
    scopes: fullScopes,
    thresholds: thresholds ?? {},
    markdown: "",
  };
  if (redact) redactExport(doc, { salt: salt ?? newSalt(), extraScopes });
  scrubForbiddenKeys(doc);
  doc.markdown = renderMarkdown(doc);
  const leaks = findAbsolutePaths(doc);
  if (leaks.length) throw new Error(`Export refused: absolute path in ${leaks[0].path}`);
  if (redact) {
    const tokens = findPathLikeTokens(doc);
    if (tokens.length) throw new Error(`Export refused: path-like token survived redaction in ${tokens[0].path}`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  if (bytes > maxBytes) {
    const hint = Object.keys(fullScopes).length > 1 ? "; export fewer scopes (--scopes main)" : "";
    throw Object.assign(new Error(`Export refused: ${megabytes(bytes)} exceeds the ${megabytes(maxBytes)} importer cap${hint}`), { status: 413, bytes });
  }
  return doc;
}

/**
 * Every string value that carries an absolute path (anywhere in the string)
 * or a `~/` path outside the vendor config directories, as `{ path, value }`
 * (JSON-pointer-ish path). `~/…` of any shape is allowed in the display
 * fields `cwdDisplay` and `source.file` by contract.
 */
export function findAbsolutePaths(value, where = "", out = [], depth = 0) {
  if (depth > 64) return out;
  if (typeof value === "string") {
    if (ABSOLUTE_PATH.test(value) || (HOME_RELATIVE.test(value) && !DISPLAY_FIELD.test(where))) out.push({ path: where || "$", value });
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { value.forEach((item, i) => findAbsolutePaths(item, `${where}[${i}]`, out, depth + 1)); return out; }
  for (const [key, nested] of Object.entries(value)) findAbsolutePaths(nested, where ? `${where}.${key}` : key, out, depth + 1);
  return out;
}

/**
 * Structural validation of an export document. Returns `{ valid, errors }`;
 * the importer shows the first few errors. Checks: schema tag, envelope
 * fields, redaction enums (and a hex salt when labels are hashed), run
 * identity and scopes, `scopes` carries main, thresholds numeric, markdown a
 * string, no forbidden keys, no absolute paths, and, for a redacted document,
 * no path-like token anywhere.
 */
export function validateExport(doc) {
  const errors = [];
  const push = (message) => { if (errors.length < 20) errors.push(message); };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { valid: false, errors: ["not a JSON object"] };
  if (doc.schema !== EXPORT_SCHEMA) push(`schema must be "${EXPORT_SCHEMA}" (got ${JSON.stringify(doc.schema)})`);
  if (typeof doc.exportedAt !== "string" || !Number.isFinite(Date.parse(doc.exportedAt))) push("exportedAt must be an ISO date");
  if (!doc.generator || typeof doc.generator.name !== "string" || typeof doc.generator.version !== "string") push("generator.name and generator.version must be strings");
  if (!doc.redaction || !LABEL_MODES.has(doc.redaction.labels)) push('redaction.labels must be "plain" or "sha1-10"');
  if (!doc.redaction || !PROJECT_MODES.has(doc.redaction.project)) push('redaction.project must be "basename" or "hashed"');
  const redacted = doc.redaction?.labels === "sha1-10";
  if (redacted && !(typeof doc.redaction.salt === "string" && /^[0-9a-f]{16,64}$/.test(doc.redaction.salt))) push("redaction.salt must be a hex string when labels are hashed");
  const run = doc.run;
  if (!run || typeof run !== "object") push("run is missing");
  else {
    if (typeof run.id !== "string" || !run.id.includes(":")) push("run.id must be `${vendor}:${sessionId}`");
    if (!VENDORS.has(run.vendor)) push("run.vendor must be claude, codex or gemini");
    if (typeof run.id === "string" && run.vendor && !run.id.startsWith(`${run.vendor}:`)) push("run.id must start with run.vendor");
    if (!run.project || typeof run.project.key !== "string" || typeof run.project.displayName !== "string") push("run.project needs key and displayName");
    if (!Array.isArray(run.scopes) || !run.scopes.length) push("run.scopes must be a non-empty array");
    else {
      const main = run.scopes[0];
      if (main.kind !== "main") push("run.scopes[0] must be the main scope");
      run.scopes.forEach((scope, i) => { if (typeof scope.id !== "string") push(`run.scopes[${i}].id missing`); });
    }
    if (!run.summary || typeof run.summary.requests !== "number" || !run.summary.peak || typeof run.summary.peak.value !== "number") push("run.summary needs requests and peak");
    if (!run.window || typeof run.window.value !== "number") push("run.window missing");
    if (!Array.isArray(run.findings)) push("run.findings must be an array");
    else run.findings.forEach((finding, i) => { if (!finding || typeof finding.id !== "string" || typeof finding.ruleId !== "string") push(`run.findings[${i}] needs id and ruleId`); });
  }
  if (!doc.scopes || typeof doc.scopes !== "object" || Array.isArray(doc.scopes)) push("scopes must be an object keyed by scope id");
  else {
    const mainId = run?.scopes?.[0]?.id ?? "main";
    if (!doc.scopes[mainId]) push(`scopes must contain the main scope "${mainId}"`);
    for (const [id, scope] of Object.entries(doc.scopes)) {
      if (!scope || scope.id !== id) push(`scopes["${id}"].id must equal its key`);
      else if (!Array.isArray(scope.requests) || !Array.isArray(scope.blocks)) push(`scopes["${id}"] must carry requests and blocks`);
    }
  }
  if (!doc.thresholds || typeof doc.thresholds !== "object" || Array.isArray(doc.thresholds)) push("thresholds must be an object");
  else for (const [key, value] of Object.entries(doc.thresholds)) if (typeof value !== "number") { push(`thresholds.${key} must be a number`); break; }
  if (typeof doc.markdown !== "string") push("markdown must be a string");
  const forbidden = forbiddenKeysIn(doc);
  if (forbidden.length) push(`forbidden keys present: ${forbidden.join(", ")}`);
  const leaks = findAbsolutePaths(doc);
  if (leaks.length) push(`absolute path at ${leaks[0].path}`);
  if (redacted) {
    const tokens = findPathLikeTokens(doc);
    if (tokens.length) push(`path-like token at ${tokens[0].path} in a redacted document`);
  }
  return { valid: errors.length === 0, errors };
}

const FORBIDDEN = ["content", "text", "stdout", "stderr", "prompt"];
export function forbiddenKeysIn(value, found = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 64) return [...found];
  if (Array.isArray(value)) { for (const item of value) forbiddenKeysIn(item, found, depth + 1); return [...found]; }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN.includes(key)) found.add(key);
    forbiddenKeysIn(nested, found, depth + 1);
  }
  return [...found];
}
