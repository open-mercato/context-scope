/**
 * Checks the dev fixtures against the shapes in packages/cli/src/ir/types.ts
 * and the ADR-002 C contract: required keys, primitive types, enum values,
 * cross-references, and for the run fixtures: composition sums, block ids,
 * partial child scopes and the scope files. Exit code 1 on any failure.
 * Run: `node dev/validate-fixtures.mjs`.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// `--demo` validates dev/demo (the hosted-demo dataset: runs/<vendor>--<id>.json + <name>.scopes/<scope>.json).
const DEMO = process.argv.includes("--demo");
const fixtures = path.join(here, DEMO ? "demo" : "fixtures");
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

const PROVENANCE = ["observed.vendor", "observed.artifact", "derived.exact", "estimated.local", "unknown"];
const VENDORS = ["claude", "codex", "gemini"];
const SEVERITIES = ["high", "medium", "low"];
const SCOPES = ["setup", "session", "subagent", "habit"];
const EVIDENCE_KINDS = ["file", "request", "block", "scope", "metric", "run"];
const CATEGORIES = ["system", "instructions", "skills", "user", "assistant_text", "assistant_thinking", "tool_call", "tool_result.file", "tool_result.shell", "tool_result.search", "tool_result.web", "tool_result.other", "subagent_handoff", "compaction_summary", "attachments", "memory", "unlogged", "other"];

function expect(obj, where, shape) {
  if (!obj || typeof obj !== "object") return fail(where, "not an object");
  for (const [key, type] of Object.entries(shape)) {
    const optional = key.endsWith("?");
    const name = optional ? key.slice(0, -1) : key;
    const value = obj[name];
    if (value === undefined) { if (!optional) fail(where, `missing "${name}"`); continue; }
    if (Array.isArray(type)) { if (!type.includes(value)) fail(where, `"${name}" = ${JSON.stringify(value)} not in ${type.join("|")}`); continue; }
    if (type === "array") { if (!Array.isArray(value)) fail(where, `"${name}" should be an array`); continue; }
    if (type === "measured") { expect(value, `${where}.${name}`, { value: "number", provenance: PROVENANCE }); continue; }
    if (typeof value !== type) fail(where, `"${name}" should be ${type}, got ${typeof value}`);
  }
}

function checkFinding(f, where) {
  expect(f, where, { id: "string", ruleId: "string", severity: SEVERITIES, scope: SCOPES, "vendor?": VENDORS, "runId?": "string", "sessions?": "number", title: "string", whyItMatters: "string", evidence: "array", fix: "object", thresholdKeys: "array", "tokensAffected?": "number", "recurrence?": "number", "count?": "number", "scopeId?": "string" });
  if (f.scope === "habit" && typeof f.sessions !== "number") fail(where, "habit findings must carry `sessions` (distinct top-level runs)");
  if (f.scope === "habit" && !/^H-0[1-6]$/.test(f.ruleId ?? "")) fail(where, `habit finding with a non-habit rule id ${f.ruleId}`);
  if (!f.evidence?.length) fail(where, "finding has no evidence (a finding with empty evidence is a test failure)");
  if (f.evidence?.length > 5 && f.count > 1) fail(where, "aggregated findings carry at most 5 evidence rows");
  f.evidence?.forEach((e, i) => expect(e, `${where}.evidence[${i}]`, { kind: EVIDENCE_KINDS, ref: "string", label: "string", "value?": "number", "unit?": ["tokens", "chars", "count", "ratio", "percent", "ms"], provenance: PROVENANCE }));
  if (f.fix) expect(f.fix, `${where}.fix`, { platform: [...VENDORS, "both"], summary: "string", "snippet?": "string", "path?": "string" });
}

function checkRunSummary(s, where) {
  expect(s, where, { requests: "number", turns: "number", processedInputTokens: "number", outputTokens: "number", cacheReadShare: "number", peak: "measured", peakShareOfWindow: "number", compactions: "number", subagents: "number", toolCalls: "number", models: "array", "topBlocks?": "array", "findingIds?": "array", compositionAtPeak: "object" });
  for (const key of Object.keys(s?.compositionAtPeak ?? {})) if (!CATEGORIES.includes(key)) fail(`${where}.compositionAtPeak`, `unknown category "${key}"`);
  for (const key of Object.keys(s?.compositionAtEnd ?? {})) if (!CATEGORIES.includes(key)) fail(`${where}.compositionAtEnd`, `unknown category "${key}"`);
}

function checkOverviewRun(r, where) {
  expect(r, where, { id: "string", vendor: VENDORS, project: "object", startedAt: "string", endedAt: "string", activeMs: "number", summary: "object", window: "measured", findingsCount: "number", findingsHigh: "number", "live?": "object", "parentRunId?": "string", "gitBranch?": "string", "agentType?": "string" });
  if (r.live && (typeof r.live.at !== "string" || !Number.isFinite(Date.parse(r.live.at)))) fail(where, "live.at must be an ISO date");
  if (r.project) expect(r.project, `${where}.project`, { key: "string", displayName: "string", cwdHash: "string", "cwdDisplay?": "string" });
  if (r.id && r.vendor && !r.id.startsWith(`${r.vendor}:`)) fail(where, `id "${r.id}" must start with "${r.vendor}:"`);
  if (r.summary) { checkRunSummary(r.summary, `${where}.summary`); if (r.summary.topBlocks) fail(where, "overview rows must not carry summary.topBlocks (ADR-002 C)"); }
  if (typeof r.project?.cwdDisplay === "string" && /^\/(?!~)/.test(r.project.cwdDisplay)) fail(where, "cwdDisplay must not be an absolute path outside ~");
  if (r.children) { if (!Array.isArray(r.children)) fail(where, "children must be an array"); else r.children.forEach((c, i) => checkOverviewRun(c, `${where}.children[${i}]`)); }
}

function checkBlock(b, where) {
  expect(b, where, { id: "string", seq: "number", at: "string", category: CATEGORIES, bytes: "number", estTokens: "number", "kind?": ["prose", "code"], "tool?": "object", "label?": "string", firstRequest: "number", "lastRequest?": "number", "droppedBy?": "string", hash: "string" });
  if (b.tool) expect(b.tool, `${where}.tool`, { name: "string", kind: ["file", "shell", "search", "web", "edit", "agent", "skill", "mcp", "other"], argsHash: "string", "target?": "string", "isError?": "boolean", "partial?": "boolean", "truncated?": "boolean" });
}

function checkRequest(r, where, scopeId) {
  expect(r, where, { index: "number", at: "string", model: "string", turn: "number", usage: "object", hiddenBase: "measured", scale: "number", "scaleRaw?": "number", composition: "object", "newBlockIds?": "array", "compactionBefore?": "string" });
  if (r.usage) expect(r.usage, `${where}.usage`, { input: "number", cacheCreation: "number", cacheRead: "number", output: "number", total: "number", "thinking?": "number" });
  let sum = 0;
  for (const [key, value] of Object.entries(r.composition ?? {})) { if (!CATEGORIES.includes(key)) fail(`${where}.composition`, `unknown category "${key}"`); if (value < 0) fail(`${where}.composition`, `${key} is negative`); sum += value; }
  if (r.usage && sum !== r.usage.total) fail(where, `composition sums to ${sum}, usage.total is ${r.usage.total}`);
  if (r.usage && r.usage.total !== r.usage.input + r.usage.cacheCreation + r.usage.cacheRead) fail(where, "usage.total != input + cacheCreation + cacheRead");
  if (r.scale < 0.6 || r.scale > 1.5) fail(where, `scale ${r.scale} outside the clamp band 0.6..1.5`);
  const base = (r.composition?.system ?? 0) + (r.composition?.instructions ?? 0) + (r.composition?.unlogged ?? 0);
  if (r.hiddenBase && Math.abs(r.hiddenBase.value - base) > 1) fail(where, `hiddenBase ${r.hiddenBase.value} != system + instructions + unlogged ${base}`);
  if (scopeId && r.newBlockIds) for (const id of r.newBlockIds) if (!id.startsWith(`${scopeId}:`)) fail(where, `newBlockId ${id} is not in scope ${scopeId}`);
}

function checkForecast(f, where) {
  expect(f, where, { threshold: "measured", perRequest: "number", perMinute: "number", requestsLeft: "number", minutesLeft: "number", basis: "object", provenance: ["derived.exact"], "status?": ["ok", "flat"] });
  if (f.basis) expect(f.basis, `${where}.basis`, { requests: "number", from: "number", to: "number" });
  if (f.threshold?.basis) expect(f.threshold.basis, `${where}.threshold.basis`, { "events?": "number", "min?": "number", "max?": "number", "source?": "string" });
}

function checkFullScope(s, where) {
  expect(s, where, { id: "string", kind: ["main", "subagent"], depth: "number", status: ["completed", "open", "unknown"], models: "array", requests: "array", blocks: "array", compactions: "array", peak: "measured", processedInputTokens: "number", outputTokens: "number", toolCalls: "number", "unloggedShare?": "number", "estimatorErrorMedian?": "number", "estimatorErrorP95?": "number", "baseSteps?": "array", "forecast?": "object" });
  if (s.forecast) checkForecast(s.forecast, `${where}.forecast`);
  if (s.partial) fail(where, "a full scope must not be marked partial");
  const ids = new Set((s.blocks ?? []).map((b) => b.id));
  s.blocks?.forEach((b, i) => { checkBlock(b, `${where}.blocks[${i}]`); if (!b.id.startsWith(`${s.id}:`)) fail(`${where}.blocks[${i}]`, `block id ${b.id} lacks the scope prefix`); if (b.firstRequest > (s.requests?.length ?? 0)) fail(`${where}.blocks[${i}]`, `firstRequest ${b.firstRequest} beyond the scope`); });
  s.requests?.forEach((r, i) => {
    checkRequest(r, `${where}.requests[${i}]`, s.id);
    if (r.index !== i) fail(`${where}.requests[${i}]`, `index ${r.index} is not dense`);
    for (const id of r.newBlockIds ?? []) if (!ids.has(id)) fail(`${where}.requests[${i}]`, `newBlockId ${id} does not resolve`);
  });
  const peak = (s.requests ?? []).reduce((m, r) => Math.max(m, r.usage.total), 0);
  if (s.peak && s.peak.value !== peak) fail(where, `peak ${s.peak.value} != max usage.total ${peak}`);
  s.compactions?.forEach((c, i) => { expect(c, `${where}.compactions[${i}]`, { id: "string", at: "string", atRequest: "number", trigger: ["auto", "manual", "unknown"], preTokens: "measured", postTokens: "measured", droppedTokens: "measured" }); if (c.atRequest >= (s.requests?.length ?? 0)) fail(`${where}.compactions[${i}]`, "atRequest beyond the scope"); });
  s.baseSteps?.forEach((b, i) => { expect(b, `${where}.baseSteps[${i}]`, { atRequest: "number", delta: "number" }); if (b.atRequest >= (s.requests?.length ?? 0)) fail(`${where}.baseSteps[${i}]`, "atRequest beyond the scope"); });
  if (typeof s.unloggedShare === "number") {
    const u = (s.requests ?? []).reduce((a, r) => a + (r.composition.unlogged ?? 0), 0);
    const t = (s.requests ?? []).reduce((a, r) => a + r.usage.total, 0);
    if (t && Math.abs(u / t - s.unloggedShare) > 0.005) fail(where, `unloggedShare ${s.unloggedShare} != Σ unlogged / Σ total ${(u / t).toFixed(3)}`);
  }
}

function checkSummaryScope(s, where, parentCount) {
  expect(s, where, { id: "string", kind: ["subagent"], depth: "number", status: ["completed", "open", "unknown"], models: "array", peak: "measured", processedInputTokens: "number", outputTokens: "number", toolCalls: "number", partial: "boolean", requestCount: "number", "topBlocks?": "array", "launchedAtRequest?": "number", "deliveredAtRequest?": "number", "handoff?": "object", "agentType?": "string", parentScopeId: "string" });
  if (s.partial !== true) fail(where, "child scopes in the run response must be partial");
  if (s.requests || s.blocks) fail(where, "partial scopes must not carry requests / blocks");
  if (s.launchedAtRequest !== undefined && parentCount !== undefined && s.launchedAtRequest >= parentCount) fail(where, `launchedAtRequest ${s.launchedAtRequest} >= parent request count ${parentCount}`);
  if (s.handoff) expect(s.handoff, `${where}.handoff`, { blockId: "string", tokens: "measured", compressionRatio: "measured" });
  s.topBlocks?.forEach((b, i) => expect(b, `${where}.topBlocks[${i}]`, { id: "string", category: CATEGORIES, estTokens: "number", firstRequest: "number", "tool?": "string", "label?": "string" }));
}

async function load(name, { optional = false } = {}) {
  try { return JSON.parse(await readFile(path.join(fixtures, name), "utf8")); }
  catch (error) { if (!optional) fail(name, `cannot read: ${error.message}`); return null; }
}

function checkIndex(index, where) {
  expect(index, where, { files: "number", indexed: "number", failed: "number", runsInRange: "number", state: ["idle", "indexing"], lastPass: "object", "total?": "number", "done?": "number", "lastRunAt?": "string" });
  if (index.lastPass) expect(index.lastPass, `${where}.lastPass`, { parsed: "number", skipped: "number", failed: "number", ms: "number", "at?": "string" });
}

function checkOverview(overview, where, { mode } = {}) {
  expect(overview, where, { runs: "array", totals: "object", trends: "object", topOffenders: "object", "firstFinding?": "object", index: "object", "scope?": "object", ...(overview?.since === null ? {} : { "since?": "string" }), "range?": "string" });
  if (overview.scope) {
    expect(overview.scope, `${where}.scope`, { mode: ["repo", "all"], repo: "object", sessions: "number", machineSessions: "number", unattributed: "number" });
    if (mode && overview.scope.mode !== mode) fail(`${where}.scope`, `mode should be ${mode}`);
    if (overview.scope.sessions > overview.scope.machineSessions) fail(`${where}.scope`, "sessions exceeds machineSessions");
  }
  if (overview.since !== undefined && overview.since !== null && !Number.isFinite(Date.parse(overview.since))) fail(where, "since must be an ISO date or null");
  overview.runs?.forEach((r, i) => checkOverviewRun(r, `${where}.runs[${i}]`));
  const topLevel = overview.runs?.length ?? 0;
  if (overview.scope?.mode === "repo" && overview.scope.sessions !== topLevel && !(overview.index?.runsInRange > topLevel)) fail(`${where}.scope`, `sessions ${overview.scope.sessions} != ${topLevel} top-level rows (a session is a top-level run; Codex children are subagents)`);
  if (overview.totals) expect(overview.totals, `${where}.totals`, { runs: "number", subagents: "number", requests: "number", processedInputTokens: "number", outputTokens: "number", cacheReadShare: "number", compactions: "number", vendors: "array" });
  if (overview.trends) {
    expect(overview.trends, `${where}.trends`, { days: "array", processedInputTokens: "array", requests: "array", compactions: "array", subagents: "array", "sessions?": "array", "peakShareMedian?": "array", "startupH0Median?": "array", "instructionEdits?": "array" });
    const n = overview.trends.days?.length ?? 0;
    for (const key of ["processedInputTokens", "requests", "compactions", "subagents", "sessions", "peakShareMedian", "startupH0Median"]) if (overview.trends[key] && overview.trends[key].length !== n) fail(`${where}.trends`, `${key} has ${overview.trends[key]?.length} points, days has ${n}`);
    if (n !== 30) fail(`${where}.trends`, `expected 30 days, got ${n}`);
    overview.trends.instructionEdits?.forEach((e, i) => expect(e, `${where}.trends.instructionEdits[${i}]`, { path: "string", at: "string" }));
    if (overview.scope?.mode === "repo" && !overview.trends.sessions) fail(`${where}.trends`, "repo overview must carry trends.sessions (cycle 2)");
  }
  if (overview.topOffenders) {
    expect(overview.topOffenders, `${where}.topOffenders`, { largestBlocks: "array", fattestHandoffs: "array", mostCompacted: "array" });
    const ids = new Set();
    const collect = (runs) => runs?.forEach((r) => { ids.add(r.id); collect(r.children); });
    collect(overview.runs);
    overview.topOffenders.largestBlocks?.forEach((b, i) => { expect(b, `largestBlocks[${i}]`, { runId: "string", scopeId: "string", blockId: "string", category: CATEGORIES, estTokens: "number", firstRequest: "number", "tool?": "string", "label?": "string" }); if (!ids.has(b.runId)) fail(`largestBlocks[${i}]`, `runId ${b.runId} not in runs`); });
    overview.topOffenders.fattestHandoffs?.forEach((h, i) => { expect(h, `fattestHandoffs[${i}]`, { runId: "string", scopeId: "string", "agentType?": "string", handoffTokens: "number", childPeak: "number", ratio: "number" }); if (!ids.has(h.runId)) fail(`fattestHandoffs[${i}]`, `runId ${h.runId} not in runs`); });
    overview.topOffenders.mostCompacted?.forEach((c, i) => { expect(c, `mostCompacted[${i}]`, { runId: "string", compactions: "number", processedInputTokens: "number" }); if (!ids.has(c.runId)) fail(`mostCompacted[${i}]`, `runId ${c.runId} not in runs`); });
  }
  if (overview.firstFinding) checkFinding(overview.firstFinding, `${where}.firstFinding`);
  if (overview.index) {
    checkIndex(overview.index, `${where}.index`);
    if (overview.index.runsInRange < topLevel) fail(`${where}.index`, "runsInRange is smaller than the top-level rows served");
  }
}

const overview = await load("overview.json");
if (overview) checkOverview(overview, "overview", { mode: "repo" });
const overviewAll = await load("overview-all.json", { optional: true });
if (overviewAll) {
  checkOverview(overviewAll, "overview-all", { mode: "all" });
  if (overview && overviewAll.runs.length <= overview.runs.length) fail("overview-all", "All projects must list more sessions than the repo overview (a second project)");
  if (overview && JSON.stringify(overviewAll.runs.map((r) => r.id).sort()) === JSON.stringify(overview.runs.map((r) => r.id).sort())) fail("overview-all", "same rows as the repo overview");
}
if (DEMO && !overviewAll) fail("overview-all.json", "the demo must ship an All-projects overview (review cycle 2, #7)");
if (overview && !overview.runs.some((r) => r.live)) fail("overview", "expected one live row (cycle-2 coverage)");

const setup = await load("setup.json");
if (setup) {
  expect(setup, "setup", { repo: "object", vendorsDetected: "array", instructionFiles: "array", skills: "array", agents: "array", hooks: "array", mcpServers: "array", commands: "array", memory: "object", settings: "array", startupBudget: "object", findings: "array", "excluded?": "array" });
  setup.excluded?.forEach((e, i) => { expect(e, `setup.excluded[${i}]`, { path: "string", reason: ["fixture"] }); if (e.path?.startsWith("/")) fail(`setup.excluded[${i}]`, "absolute path leaked"); });
  if (!setup.excluded?.length) fail("setup", "expected an `excluded` list (cycle-2 coverage)");
  if (setup.repo) expect(setup.repo, "setup.repo", { name: "string", root: ["cwd"], git: "boolean" });
  setup.instructionFiles?.forEach((f, i) => {
    expect(f, `setup.instructionFiles[${i}]`, { path: "string", scope: ["user", "project", "local", "nested", "rules", "override"], vendors: "array", bytes: "number", estTokens: "number", precedence: "number", mtime: "string", loadState: ["discoverable", "expected.load", "observed.loaded"], brokenRefs: "array" });
    if (f.path?.startsWith("/")) fail(`setup.instructionFiles[${i}]`, "absolute path leaked into the inventory");
  });
  setup.skills?.forEach((s, i) => expect(s, `setup.skills[${i}]`, { name: "string", path: "string", scope: ["user", "project", "plugin"], hasDescription: "boolean", descriptionChars: "number", bodyEstTokens: "number", frontmatterValid: "boolean", invocations30d: "number" }));
  setup.agents?.forEach((a, i) => expect(a, `setup.agents[${i}]`, { name: "string", path: "string", scope: ["user", "project"], "model?": "string", "tools?": "array", descriptionChars: "number", runs30d: "number" }));
  setup.hooks?.forEach((h, i) => expect(h, `setup.hooks[${i}]`, { event: "string", "matcher?": "string", command: "string", scope: ["user", "project", "local"], runs30d: "number", stdoutP50: "number", stdoutP95: "number" }));
  setup.mcpServers?.forEach((m, i) => expect(m, `setup.mcpServers[${i}]`, { name: "string", scope: ["user", "project", "local"], "transport?": "string", toolsObserved: "array", invocations30d: "number" }));
  setup.commands?.forEach((c, i) => expect(c, `setup.commands[${i}]`, { name: "string", path: "string" }));
  if (setup.memory) expect(setup.memory, "setup.memory", { present: "boolean", bytes: "number", files: "number", indexBytes: "number" });
  setup.settings?.forEach((s, i) => expect(s, `setup.settings[${i}]`, { path: "string", scope: ["user", "project", "local"], keys: "array" }));
  for (const [vendor, budget] of Object.entries(setup.startupBudget ?? {})) {
    if (!VENDORS.includes(vendor)) fail("setup.startupBudget", `unknown vendor "${vendor}"`);
    expect(budget, `setup.startupBudget.${vendor}`, { instructions: "measured", skills: "measured", agents: "measured", mcpTools: "measured", total: "measured" });
    const sum = ["instructions", "skills", "agents", "mcpTools"].reduce((s, k) => s + (budget?.[k]?.value ?? 0), 0);
    if (budget?.total && sum !== budget.total.value) fail(`setup.startupBudget.${vendor}`, `total ${budget.total.value} != sum of parts ${sum}`);
  }
  setup.findings?.forEach((f, i) => { checkFinding(f, `setup.findings[${i}]`); if (f.scope !== "setup") fail(`setup.findings[${i}]`, "setup response must only carry setup-scope findings"); });
}

const findingsDoc = await load("findings.json");
if (findingsDoc) {
  expect(findingsDoc, "findings", { findings: "array", "firstChange?": "object" });
  const seen = new Set();
  findingsDoc.findings?.forEach((f, i) => {
    checkFinding(f, `findings[${i}]`);
    if (seen.has(f.id)) fail(`findings[${i}]`, `duplicate id ${f.id}`);
    seen.add(f.id);
  });
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < (findingsDoc.findings?.length ?? 0); i++) {
    if (order[findingsDoc.findings[i].severity] < order[findingsDoc.findings[i - 1].severity]) fail(`findings[${i}]`, "not sorted by severity");
  }
  if ((findingsDoc.findings?.length ?? 0) < 8) fail("findings", "expected at least 8 findings");
  if (!findingsDoc.findings?.some((f) => f.scope === "habit")) fail("findings", "expected habit findings (H-0x with `sessions`)");
  findingsDoc.groups?.forEach((g, i) => expect(g, `findings.groups[${i}]`, { ruleId: "string", title: "string", severity: SEVERITIES, scope: SCOPES, sessions: "number", occurrences: "number", tokensAffected: "number", findings: "array" }));
  const perRuleRunScope = new Map();
  for (const f of findingsDoc.findings ?? []) {
    if (!f.runId) continue;
    const key = `${f.ruleId}|${f.runId}|${f.scopeId ?? "main"}`;
    if (["B-01", "B-03", "B-04", "B-08", "B-14", "B-15"].includes(f.ruleId) && perRuleRunScope.has(key)) fail("findings", `${f.ruleId} emitted twice for ${f.runId}/${f.scopeId ?? "main"} (must aggregate with count)`);
    perRuleRunScope.set(key, true);
  }
  if (findingsDoc.firstChange) { checkFinding(findingsDoc.firstChange, "findings.firstChange"); if (findingsDoc.firstChange.removes) expect(findingsDoc.firstChange.removes, "findings.firstChange.removes", { findings: "number", sessions: "number" }); }
}

const thresholds = await load("thresholds.json");
if (thresholds) {
  if (typeof thresholds !== "object" || Array.isArray(thresholds)) fail("thresholds", "must be an object map");
  for (const [key, value] of Object.entries(thresholds)) if (typeof value !== "number" || !Number.isFinite(value)) fail("thresholds", `${key} must be a finite number`);
  const referenced = new Set([...(findingsDoc?.findings ?? []), ...(setup?.findings ?? [])].flatMap((f) => f.thresholdKeys ?? []));
  for (const key of referenced) if (!(key in thresholds)) fail("thresholds", `finding references unknown threshold key "${key}"`);
}

// Run fixtures: run-*.json (run response with partial children) + run-*.scopes.json (full scopes by id).
let forecasts = 0;
const runFiles = DEMO
  ? (await readdir(path.join(fixtures, "runs"))).filter((n) => n.endsWith(".json")).map((n) => `runs/${n}`)
  : (await readdir(fixtures)).filter((n) => /^run-.*\.json$/.test(n) && !n.endsWith(".scopes.json"));
if (!DEMO && !runFiles.includes("run-sample.json")) fail("run-sample.json", "missing");
if (DEMO && runFiles.length < 10) fail("runs", `expected at least 10 demo runs, found ${runFiles.length}`);
async function loadScopesFor(name, run) {
  if (!DEMO) return load(name.replace(/\.json$/, ".scopes.json"));
  const dir = path.join(fixtures, name.replace(/\.json$/, ".scopes"));
  const doc = { [run.scopes[0].id]: run.scopes[0] };
  for (const file of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".json"))) doc[file.replace(/\.json$/, "")] = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  return doc;
}
for (const name of runFiles) {
  const run = await load(name);
  if (!run) continue;
  const where = name;
  expect(run, where, { id: "string", vendor: VENDORS, sessionId: "string", project: "object", startedAt: "string", endedAt: "string", activeMs: "number", window: "measured", scopes: "array", summary: "object", coverage: "object", source: "object", findings: "array" });
  if (run.coverage) expect(run.coverage, `${where}.coverage`, { records: "number", unparsedRecords: "number", unparsedTypes: "object", requests: "number", syntheticRecordsSkipped: "number", estimatorErrorMedian: "number", estimatorErrorP95: "number", adapterVersion: "string" });
  if (run.summary) checkRunSummary(run.summary, `${where}.summary`);
  if (run.source?.file?.startsWith("/")) fail(where, "source.file must be ~-relative");
  const main = run.scopes?.[0];
  if (!main || main.kind !== "main") fail(where, "scopes[0] must be the main scope");
  else { checkFullScope(main, `${where}.scopes[0]`); if (main.forecast) forecasts++; }
  const byId = new Map((run.scopes ?? []).map((s) => [s.id, s]));
  run.scopes?.slice(1).forEach((s, i) => {
    const parent = byId.get(s.parentScopeId);
    const parentCount = parent ? (parent.requests?.length ?? parent.requestCount) : undefined;
    checkSummaryScope(s, `${where}.scopes[${i + 1}]`, parentCount);
    if (!parent) fail(`${where}.scopes[${i + 1}]`, `parentScopeId ${s.parentScopeId} not in run`);
  });
  if (main && run.coverage && (run.coverage.estimatorErrorP95 !== main.estimatorErrorP95 || run.coverage.estimatorErrorMedian !== main.estimatorErrorMedian)) fail(`${where}.coverage`, "estimatorError* must equal the main scope's numbers (ADR-002 A)");
  const findingIds = new Set();
  run.findings?.forEach((f, i) => { checkFinding(f, `${where}.findings[${i}]`); if (f.runId !== run.id) fail(`${where}.findings[${i}]`, "runId mismatch"); if (f.scopeId && !byId.has(f.scopeId)) fail(`${where}.findings[${i}]`, `scopeId ${f.scopeId} not in run`); if (findingIds.has(f.id)) fail(`${where}.findings[${i}]`, `duplicate id ${f.id}`); findingIds.add(f.id); });
  const bytes = Buffer.byteLength(JSON.stringify(run));
  if (run.scopes?.length > 20 && bytes > 8 * 1024 * 1024) fail(where, `run response is ${Math.round(bytes / 1024)} KB; child scopes must be summaries`);

  const scopesDoc = await loadScopesFor(name, run);
  if (scopesDoc) {
    for (const s of run.scopes ?? []) {
      const full = scopesDoc[s.id];
      if (!full) { fail(`${name}.scopes`, `no full scope for ${s.id}`); continue; }
      checkFullScope(full, `${name}.scopes.${s.id}`);
      if (s.partial && full.requests.length !== s.requestCount) fail(`${name}.scopes.${s.id}`, `requestCount ${s.requestCount} != ${full.requests.length} requests`);
      if (full.peak.value !== s.peak.value) fail(`${name}.scopes.${s.id}`, "peak differs between summary and full scope");
    }
    for (const id of Object.keys(scopesDoc)) if (!byId.has(id)) fail(`${name}.scopes`, `scope ${id} is not in the run`);
  }
}

if (DEMO && forecasts === 0) fail("runs", "expected at least one run with a forecast on its main scope (the live one)");

// Privacy sweep: no absolute paths outside ~ anywhere in the fixtures.
for (const [name, doc] of [["overview.json", overview], ["overview-all.json", overviewAll], ["setup.json", setup], ["findings.json", findingsDoc]]) {
  const text = JSON.stringify(doc ?? {});
  const leak = text.match(/"\/(Users|home|private|var|tmp|etc)\/[^"]*"/);
  if (leak) fail(name, `absolute path leaked: ${leak[0]}`);
}

if (errors.length) {
  console.error(`fixture validation failed (${errors.length}):`);
  for (const e of errors.slice(0, 60)) console.error(`  - ${e}`);
  if (errors.length > 60) console.error(`  … ${errors.length - 60} more`);
  process.exit(1);
}
console.log(`fixtures valid: overview.json, setup.json, findings.json, thresholds.json, ${runFiles.join(", ")} (+ scopes)`);
