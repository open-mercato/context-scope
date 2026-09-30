/**
 * Export documents (`contextscope.export/1`): the structural + privacy
 * validator, the parser, the in-memory backend an opened export becomes, and
 * the browser-side assembly the demo uses. Loaded on demand by the Open screen
 * and by the static backend's Export button, so the core bundle does not carry
 * it (review cycle 2, #30).
 */
import type { AgentScope, Export, Finding, Overview, OverviewRun, Thresholds } from "@ir/types.ts";
import { ApiError, EXPORT_SCHEMA, MAX_EXPORT_BYTES, localEvents, localThresholds, filterFindings, type Backend, type ExportOptions, type RunResponse } from "./api.ts";

const FORBIDDEN_KEYS = ["content", "text", "stdout", "stderr", "prompt"];
/** `/tmp`, `/Users/me`, `C:\` — one string at a time, no multi-line flag (mirrors packages/cli/src/export/schema.mjs). */
const ABSOLUTE_PATH = /^(?:\/[A-Za-z0-9._@-]+(?:\/|$)|[A-Za-z]:\\)/;
const VENDORS = new Set(["claude", "codex", "gemini"]);
const MAX_ERRORS = 12;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/**
 * Structural check of a `contextscope.export/1` document; mirrors
 * `packages/cli/src/export/schema.mjs`. Privacy checks run first and are
 * always kept in the list (#22); the structural list is capped.
 */
export function validateExportDocument(doc: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { valid: false, errors: ["The file is not a JSON object."] };
  const forbidden = forbiddenKeysIn(doc);
  if (forbidden.length) errors.push(`The file carries content keys (${forbidden.join(", ")}); ContextScope exports never do.`);
  const absolute = firstAbsolutePath(doc);
  if (absolute) errors.push(`The file carries an absolute path (at ${absolute}); ContextScope exports never do.`);
  const push = (message: string) => { if (errors.length < MAX_ERRORS) errors.push(message); };
  const d = doc as Partial<Export> & Record<string, unknown>;
  if (d.schema !== EXPORT_SCHEMA) push(`Expected schema "${EXPORT_SCHEMA}", found ${JSON.stringify(d.schema ?? null)}.`);
  if (!isIso(d.exportedAt)) push("exportedAt is not an ISO date.");
  if (!d.generator || typeof d.generator.name !== "string" || typeof d.generator.version !== "string") push("generator.name / generator.version are missing.");
  if (!d.redaction || !["plain", "sha1-10"].includes(d.redaction.labels)) push('redaction.labels must be "plain" or "sha1-10".');
  if (!d.redaction || !["basename", "hashed"].includes(d.redaction.project)) push('redaction.project must be "basename" or "hashed".');
  const run = d.run as Partial<RunResponse> | undefined;
  let mainId = "main";
  if (!run || typeof run !== "object") push("run is missing.");
  else {
    if (typeof run.id !== "string" || !run.id.includes(":")) push("run.id must be vendor:sessionId.");
    if (!VENDORS.has(run.vendor as string)) push("run.vendor must be claude, codex or gemini.");
    if (typeof run.id === "string" && run.vendor && !run.id.startsWith(`${run.vendor}:`)) push("run.id must start with run.vendor.");
    if (!run.project || typeof run.project.key !== "string" || typeof run.project.displayName !== "string") push("run.project needs key and displayName.");
    if (!isIso(run.startedAt) || !isIso(run.endedAt)) push("run.startedAt / run.endedAt must be ISO dates.");
    if (!isNum(run.activeMs)) push("run.activeMs is missing.");
    if (!run.source || typeof run.source.file !== "string") push("run.source.file is missing.");
    if (!run.coverage || !isNum(run.coverage.estimatorErrorMedian) || !isNum(run.coverage.estimatorErrorP95)) push("run.coverage needs estimatorErrorMedian and estimatorErrorP95.");
    if (!Array.isArray(run.scopes) || !run.scopes.length) push("run.scopes must be a non-empty array.");
    else {
      if (run.scopes[0].kind !== "main") push("run.scopes[0] must be the main scope.");
      mainId = run.scopes[0].id ?? "main";
      run.scopes.forEach((s, i) => {
        if (!s || typeof s.id !== "string") { push(`run.scopes[${i}] needs an id.`); return; }
        if (!isNum(s.peak?.value)) push(`run.scopes[${i}] (${s.id}) needs peak.value.`);
        if (!Array.isArray(s.models)) push(`run.scopes[${i}] (${s.id}) needs models[].`);
        if (!isNum(s.processedInputTokens)) push(`run.scopes[${i}] (${s.id}) needs processedInputTokens.`);
      });
    }
    const summary = run.summary;
    if (!summary || !isNum(summary.requests) || !isNum(summary.peak?.value)) push("run.summary needs requests and peak.");
    else {
      if (!Array.isArray(summary.models)) push("run.summary.models must be an array.");
      if (!summary.compositionAtPeak || typeof summary.compositionAtPeak !== "object") push("run.summary.compositionAtPeak is missing.");
      if (!isNum(summary.processedInputTokens) || !isNum(summary.compactions) || !isNum(summary.subagents)) push("run.summary needs processedInputTokens, compactions and subagents.");
    }
    if (!run.window || !isNum(run.window.value)) push("run.window is missing.");
    if (!Array.isArray(run.findings)) push("run.findings must be an array.");
  }
  const scopes = d.scopes as Record<string, AgentScope> | undefined;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) push("scopes must be an object keyed by scope id.");
  else {
    const main = scopes[mainId];
    if (!main) push(`scopes must contain the main scope "${mainId}".`);
    for (const [id, scope] of Object.entries(scopes)) {
      if (!scope || scope.id !== id) { push(`scopes["${id}"].id must equal its key.`); continue; }
      if (!Array.isArray(scope.requests) || !Array.isArray(scope.blocks)) push(`scopes["${id}"] must carry requests and blocks.`);
      if (!Array.isArray(scope.compactions)) push(`scopes["${id}"] must carry compactions[].`);
      if (!Array.isArray(scope.models)) push(`scopes["${id}"] must carry models[].`);
      if (!isNum(scope.peak?.value)) push(`scopes["${id}"] needs peak.value.`);
      if (!isNum(scope.processedInputTokens)) push(`scopes["${id}"] needs processedInputTokens.`);
    }
    if (main && Array.isArray(main.requests) && main.requests.length === 0) push(`The main scope "${mainId}" carries no requests; there is nothing to show.`);
  }
  if (!d.thresholds || typeof d.thresholds !== "object" || Array.isArray(d.thresholds)) push("thresholds must be an object.");
  if (typeof d.markdown !== "string") push("markdown must be a string.");
  return { valid: errors.length === 0, errors };
}

function forbiddenKeysIn(value: unknown, found = new Set<string>(), depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 64) return [...found];
  if (Array.isArray(value)) { for (const item of value) forbiddenKeysIn(item, found, depth + 1); return [...found]; }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key)) found.add(key);
    forbiddenKeysIn(nested, found, depth + 1);
  }
  return [...found];
}

function firstAbsolutePath(value: unknown, where = "$", depth = 0): string | null {
  if (depth > 64) return null;
  if (typeof value === "string") return ABSOLUTE_PATH.test(value) ? where : null;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) { for (const [i, item] of value.entries()) { const hit = firstAbsolutePath(item, `${where}[${i}]`, depth + 1); if (hit) return hit; } return null; }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) { const hit = firstAbsolutePath(nested, `${where}.${key}`, depth + 1); if (hit) return hit; }
  return null;
}

/** Parses and validates export text (a file's contents). Throws with a readable message. */
export function parseExportText(text: string, bytes = text.length): Export {
  if (bytes > MAX_EXPORT_BYTES) throw new Error(`The file is ${(bytes / 1024 / 1024).toFixed(0)} MB; exports over ${MAX_EXPORT_BYTES / 1024 / 1024} MB are refused.`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`Not valid JSON (${(error as Error).message}).`); }
  const { valid, errors } = validateExportDocument(parsed);
  if (!valid) throw new Error(errors.join(" "));
  return parsed as Export;
}

const SEVERITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

function overviewRunOf(run: RunResponse): OverviewRun {
  const { topBlocks: _top, findingIds: _ids, ...summary } = run.summary;
  return {
    id: run.id, vendor: run.vendor, project: run.project, startedAt: run.startedAt, endedAt: run.endedAt, activeMs: run.activeMs,
    summary: { ...summary, topBlocks: [], findingIds: [] }, window: run.window,
    findingsCount: run.findings.length, findingsHigh: run.findings.filter((f) => f.severity === "high").length,
    ...(run.gitBranch ? { gitBranch: run.gitBranch } : {}),
  } as OverviewRun;
}

function rankFirst(findings: Finding[]): Finding | undefined {
  return [...findings].sort((a, b) => {
    const leverage = (f: Finding) => (SEVERITY_WEIGHT[f.severity] ?? 1) * Math.min(Math.max(1, f.recurrence ?? 1), 10) + (f.fix?.path ? 0.5 : 0);
    return leverage(b) - leverage(a) || (b.tokensAffected ?? 0) - (a.tokensAffected ?? 0) || a.id.localeCompare(b.id);
  })[0];
}

/** The overview a single exported run can support: one row, its own trends day, its offenders. */
export function overviewFromExport(doc: Export): Overview {
  const run = doc.run as RunResponse;
  const row = overviewRunOf(run);
  const end = Date.parse(run.endedAt || run.startedAt || doc.exportedAt) || Date.now();
  const days = Array.from({ length: 30 }, (_, i) => new Date(end - (29 - i) * 86_400_000).toISOString().slice(0, 10));
  const runDay = new Date(end).toISOString().slice(0, 10);
  const on = (value: number) => days.map((day) => (day === runDay ? value : 0));
  const scopes = Object.values(doc.scopes);
  const handoffs = run.scopes.slice(1).map((summary) => doc.scopes[summary.id] ?? summary).filter((s) => s.handoff?.tokens?.value).map((s) => ({
    runId: run.id, scopeId: s.id, agentType: s.agentType, handoffTokens: s.handoff?.tokens.value ?? 0, childPeak: s.peak?.value ?? 0, ratio: s.handoff?.compressionRatio?.value ?? 0,
  })).sort((a, b) => b.handoffTokens - a.handoffTokens).slice(0, 5);
  const largestBlocks = (run.summary.topBlocks ?? []).map((b) => ({ runId: run.id, scopeId: b.scopeId, blockId: b.id, category: b.category, estTokens: b.estTokens, firstRequest: b.firstRequest, tool: b.tool, label: b.label }));
  const index = { total: scopes.length, done: scopes.length, failed: 0, state: "idle", lastRunAt: doc.exportedAt, files: 1 } satisfies Overview["index"] & { files: number };
  return {
    scope: { mode: "repo", repo: { name: run.project.displayName, key: run.project.key }, sessions: 1, machineSessions: 1, unattributed: 0 },
    runs: [row],
    totals: {
      runs: 1, subagents: run.summary.subagents, requests: run.summary.requests, processedInputTokens: run.summary.processedInputTokens,
      outputTokens: run.summary.outputTokens, cacheReadShare: run.summary.cacheReadShare, compactions: run.summary.compactions, vendors: [run.vendor],
    },
    trends: { days, processedInputTokens: on(run.summary.processedInputTokens), requests: on(run.summary.requests), compactions: on(run.summary.compactions), subagents: on(run.summary.subagents), sessions: on(1) },
    topOffenders: { largestBlocks, fattestHandoffs: handoffs, mostCompacted: run.summary.compactions ? [{ runId: run.id, compactions: run.summary.compactions, processedInputTokens: run.summary.processedInputTokens }] : [] },
    firstFinding: rankFirst(run.findings),
    range: "all",
    index,
  };
}

export function createMemoryBackend(doc: Export): Backend {
  const run = doc.run as RunResponse;
  const mainId = run.scopes[0]?.id ?? "main";
  const merged: RunResponse = {
    ...run,
    scopes: run.scopes.map((summary, i) => {
      const full = doc.scopes[summary.id];
      return full ? { ...summary, ...full, partial: false } : i === 0 ? summary : { ...summary, partial: true };
    }),
  };
  const events = localEvents(Object.keys(doc.scopes).length);
  const thresholds = localThresholds(async () => doc.thresholds ?? {});
  const notFound = (what: string) => new ApiError(404, `404 Not Found: ${what} is not in this export`);
  const same = (vendor: string, id: string) => `${vendor}:${id}` === run.id;
  return {
    overview: async () => overviewFromExport(doc),
    run: async (vendor, id) => { if (!same(vendor, id)) throw notFound(`${vendor}:${id}`); return merged; },
    scope: async (vendor, id, scopeId) => {
      if (!same(vendor, id)) throw notFound(`${vendor}:${id}`);
      const scope = doc.scopes[scopeId] ?? (scopeId === mainId ? merged.scopes[0] : undefined);
      if (!scope || !Array.isArray(scope.requests)) throw notFound(`scope ${scopeId}`);
      return scope;
    },
    tail: async () => { throw new ApiError(404, "404 Not Found: live tail is not available for an opened export"); },
    setup: async () => ({
      repo: { name: run.project.displayName, root: "cwd", git: false }, vendorsDetected: [run.vendor], instructionFiles: [], skills: [], agents: [], hooks: [],
      mcpServers: [], commands: [], memory: { present: false, bytes: 0, files: 0, indexBytes: 0 }, settings: [], startupBudget: {},
      findings: run.findings.filter((f) => f.scope === "setup"),
    }),
    findings: async (params = {}) => { const findings = filterFindings(run.findings, params); return { findings, firstChange: rankFirst(findings) }; },
    thresholds: () => thresholds.get(),
    saveThresholds: (patch) => thresholds.save(patch),
    refreshIndex: () => events.refresh(),
    indexEvents: (handlers) => events.subscribe(handlers),
    exportRun: async (vendor, id) => { if (!same(vendor, id)) throw notFound(`${vendor}:${id}`); return doc; },
  };
}

/** A browser-side export (no markdown renderer here; the CLI's `markdown` is empty when assembled in the UI). */
export function buildClientExport(run: RunResponse, scopes: Record<string, AgentScope>, thresholds: Thresholds, options: ExportOptions): Export {
  // Summaries drop requests/blocks (the type keeps them required for full scopes; the API contract marks summaries `partial`).
  const shell: RunResponse = { ...run, scopes: run.scopes.map((scope) => { const { requests: _r, blocks: _b, ...rest } = scope; return { ...rest, partial: true, requestCount: scope.requestCount ?? scope.requests?.length ?? 0 } as unknown as AgentScope; }) };
  return {
    schema: EXPORT_SCHEMA, exportedAt: new Date().toISOString(), generator: { name: "@contextscope/ui", version: "browser" },
    redaction: { labels: options.redact ? "sha1-10" : "plain", project: options.redact ? "hashed" : "basename" },
    run: shell, scopes, thresholds, markdown: "",
  };
}
