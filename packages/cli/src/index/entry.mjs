/**
 * Derives the compact manifest entry for one indexed run: summary, per-run
 * handoffs, session stats (skills, agents, hooks, MCP, instructions), finding
 * heads (one per rule), and the scope summaries the run shell carries. Also
 * the privacy scrub that runs before any run is written to disk.
 */

import { encodedDirIsReversible } from "../ir/project.mjs";
import { cwdKindOf } from "./reader.mjs";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
export const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
// 3 (ADR-005): entries carry `kind`, `targets`, `nestedHashes`, `instructionHash`; Bash reads join `fullReads`.
export const HABITS_VERSION = 3;
const HABIT_TOP = 8;
// ADR-005 section 2: bounded attribution evidence per entry (short, repo-relative strings only).
const MAX_TARGETS = 32;
const MAX_NESTED_HASHES = 8;
const HARNESS_MAX_REQUESTS = 2;
const HABIT_LABEL_MAX = 80;
const DEFAULT_FAT_TOKENS = 8000;
export const TOP_BLOCKS = 5;
const MAX_INSTRUCTION_FILES = 200;
const FIX_SUMMARY_MAX = 200;
// Keys that must never appear in a stored run. (`output` is a legitimate usage
// counter in the IR, so it is deliberately not listed.)
export const FORBIDDEN_KEYS = new Set(["content", "text", "stdout", "stderr", "prompt"]);
// Rules whose setup fix applies to every session of the repo (ADR-002 B): an
// oversized chain, a duplicated instruction file and a broken import are paid
// on every request, so their recurrence is the repo session count.
export const SETUP_RULES_EVERY_SESSION = new Set(["S-01", "S-02", "S-06"]);

/** Removes any forbidden key anywhere in the object. Returns how many were dropped. */
export function scrubForbiddenKeys(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 64) return 0;
  let dropped = 0;
  if (Array.isArray(value)) {
    for (const item of value) dropped += scrubForbiddenKeys(item, depth + 1);
    return dropped;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      delete value[key];
      dropped += 1;
      continue;
    }
    dropped += scrubForbiddenKeys(value[key], depth + 1);
  }
  return dropped;
}

export function rankFindings(findings) {
  return [...findings].sort((a, b) => {
    const severity = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (severity !== 0) return severity;
    const tokens = (b.tokensAffected ?? 0) - (a.tokensAffected ?? 0);
    if (tokens !== 0) return tokens;
    const recurrence = (b.recurrence ?? 0) - (a.recurrence ?? 0);
    if (recurrence !== 0) return recurrence;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * "One change to make first" (ADR-002 section B): leverage = severity weight ×
 * min(recurrence, 10); ties prefer a finding with a fix path, then tokensAffected.
 * `recurrence` must already be attached (see overview.mjs `attachRecurrence`).
 */
export function leverageOf(finding) {
  return (SEVERITY_WEIGHT[finding.severity] ?? 1) * Math.min(Math.max(1, finding.recurrence ?? 1), 10);
}

/** Majority vendor among the findings' sessions (distinct root runs, so a Codex parent with six children counts once); undefined when none or tied. */
export function majorityVendor(findings) {
  const sessions = new Map();
  for (const finding of findings) if (finding?.vendor) (sessions.get(finding.vendor) ?? sessions.set(finding.vendor, new Set()).get(finding.vendor)).add(finding.rootRunId ?? finding.runId ?? finding.id);
  const ranked = [...sessions.entries()].map(([vendor, set]) => [vendor, set.size]).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return undefined;
  return ranked[0][0];
}

/**
 * Grouping key for the first-change ranking: session findings of one rule are
 * one group whatever their vendor's fix file (the fix platform is chosen from
 * the majority vendor afterwards); setup and habit findings keep their fix path
 * in the key, since S-01 on two files are two different changes.
 */
function firstChangeKey(finding) {
  if (finding.scope === "session" || finding.scope === "subagent") return finding.ruleId;
  return `${finding.ruleId}|${finding.fix?.path ?? ""}`;
}

export function rankFirstChange(findings) {
  const byKey = new Map();
  for (const finding of findings) {
    if (!finding) continue;
    const key = firstChangeKey(finding);
    const group = byKey.get(key) ?? { key, findings: [], tokens: 0, severity: "low" };
    group.findings.push(finding);
    group.tokens += finding.tokensAffected ?? 0;
    if ((SEVERITY_RANK[finding.severity] ?? 3) < (SEVERITY_RANK[group.severity] ?? 3)) group.severity = finding.severity;
    byKey.set(key, group);
  }
  let best = null;
  for (const group of byKey.values()) {
    const recurrence = Math.max(...group.findings.map((finding) => finding.recurrence ?? 1));
    const leverage = (SEVERITY_WEIGHT[group.severity] ?? 1) * Math.min(recurrence, 10);
    const hasPath = group.findings.some((finding) => finding.fix?.path) ? 1 : 0;
    const candidate = { group, leverage, hasPath, tokens: group.tokens, recurrence };
    if (!best
      || candidate.leverage > best.leverage
      || (candidate.leverage === best.leverage && candidate.hasPath > best.hasPath)
      || (candidate.leverage === best.leverage && candidate.hasPath === best.hasPath && candidate.tokens > best.tokens)) {
      best = candidate;
    }
  }
  if (!best) return undefined;
  // The fix platform follows the majority vendor of the recurrence (ADR-004 fix 5), not the top-ranked head's vendor.
  const ranked = rankFindings(best.group.findings);
  const vendor = majorityVendor(best.group.findings);
  const representative = (vendor && ranked.find((finding) => finding.vendor === vendor)) ?? ranked[0];
  return {
    ...representative,
    recurrence: best.recurrence,
    leverage: best.leverage,
    removes: {
      findings: best.group.findings.reduce((sum, finding) => sum + (finding.count ?? 1), 0),
      sessions: best.recurrence,
    },
  };
}

export function handoffsOf(run) {
  const handoffs = [];
  for (const scope of run.scopes ?? []) {
    if (scope.kind !== "subagent" || !scope.handoff) continue;
    handoffs.push({
      scopeId: scope.id,
      agentType: scope.agentType,
      handoffTokens: scope.handoff.tokens?.value ?? 0,
      childPeak: scope.peak?.value ?? 0,
      ratio: scope.handoff.compressionRatio?.value ?? 0,
    });
  }
  return handoffs;
}

/**
 * Codex parents carry `run.handoffsByThread` ({ [childThreadId]: handoff }) so
 * the overview can join a child rollout to the parent's handoff block. Values
 * are normalised to `{ blockId, tokens, firstRequest }`.
 */
export function handoffsByThreadOf(run) {
  const source = run?.handoffsByThread;
  if (!source || typeof source !== "object") return undefined;
  const out = {};
  const entries = source instanceof Map ? [...source.entries()] : Object.entries(source);
  for (const [threadId, value] of entries) {
    if (!threadId) continue;
    if (typeof value === "number") { out[threadId] = { tokens: value }; continue; }
    if (!value || typeof value !== "object") continue;
    const tokens = typeof value.tokens === "number" ? value.tokens : typeof value.tokens?.value === "number" ? value.tokens.value : typeof value.estTokens === "number" ? value.estTokens : 0;
    out[threadId] = { blockId: value.blockId ?? undefined, tokens, firstRequest: value.firstRequest ?? undefined };
  }
  return Object.keys(out).length ? out : undefined;
}

function bump(record, key, by = 1) {
  if (!key) return;
  record[key] = (record[key] ?? 0) + by;
}

/** `hook_success:SessionStart:compact` → { event: "SessionStart", matcher: "compact" }. */
export function parseHookLabel(block) {
  const raw = String(block.label ?? block.attachmentType ?? "");
  const withoutType = raw.replace(/^hook_(?:success|system_message|cancelled|error|failure):/, "");
  if (!withoutType || /^hook_/.test(withoutType)) return null;
  const [event, ...rest] = withoutType.split(":");
  if (!event) return null;
  return { event, matcher: rest.length ? rest.join(":") : undefined };
}

function looksLikeInstructionFile(label) {
  return typeof label === "string" && label.length > 0 && label.length < 200 && /\.md$/i.test(label) && !/^(skill|skills_instructions|user_instructions|role_prompt|agents_md)$/.test(label);
}

/**
 * Best-effort SessionStats for one run, derived only from IR fields (tool
 * kinds, scope agent types, attachment types, safe labels). Hook stdout sizes
 * are tokens (`unit: "tokens"`), keyed by hook event with a per-matcher split.
 */
export function statsOf(run) {
  const stats = {
    skillInvocations: {},
    agentRuns: {},
    hookRuns: {},
    mcpInvocations: {},
    mcpToolsObserved: {},
    vendorsWithSessions: [run.vendor],
    sessionCount: 1,
    codexInstructionChars: 0,
    instructionFilesObserved: [],
  };
  const instructionFiles = new Set();
  let instructionBytes = 0;
  const instructionHashes = new Set();
  for (const scope of run.scopes ?? []) {
    if (scope.kind === "subagent") bump(stats.agentRuns, scope.agentType ?? "unknown");
    for (const block of scope.blocks ?? []) {
      const tool = block.tool;
      if (block.category === "skills") bump(stats.skillInvocations, block.label || tool?.target || "unknown");
      if (tool?.kind === "mcp") {
        const server = tool.server ?? (tool.name?.startsWith("mcp__") ? tool.name.split("__")[1] : tool.name) ?? "unknown";
        bump(stats.mcpInvocations, server);
        const tools = (stats.mcpToolsObserved[server] ??= []);
        if (tool.name && !tools.includes(tool.name)) tools.push(tool.name);
      }
      if (block.category === "attachments" && /^hook_/.test(block.attachmentType ?? "")) {
        const parsed = parseHookLabel(block);
        if (parsed) {
          const hook = (stats.hookRuns[parsed.event] ??= { runs: 0, stdoutSizes: [], unit: "tokens", byMatcher: {} });
          hook.runs += 1;
          hook.stdoutSizes.push(block.estTokens ?? 0);
          if (parsed.matcher) {
            const sub = (hook.byMatcher[parsed.matcher] ??= { runs: 0, stdoutSizes: [] });
            sub.runs += 1;
            sub.stdoutSizes.push(block.estTokens ?? 0);
          }
        }
      }
      if (block.category === "attachments" && block.attachmentType === "nested_memory" && looksLikeInstructionFile(block.label)) instructionFiles.add(block.label);
      if (block.category === "instructions") {
        if (looksLikeInstructionFile(block.label)) instructionFiles.add(block.label);
        if (scope.kind === "main" && block.hash && !instructionHashes.has(block.hash)) {
          instructionHashes.add(block.hash);
          instructionBytes += block.bytes ?? 0;
        }
      }
    }
  }
  const observed = run.instructionsObserved;
  stats.codexInstructionChars = run.vendor === "codex"
    ? (Number.isFinite(observed?.chars) && observed.chars > 0 ? observed.chars : instructionBytes)
    : 0;
  // Runtime evidence: files the InstructionsLoaded hook reported for this run (capture/join.mjs).
  for (const file of Array.isArray(run.instructionFilesObserved) ? run.instructionFilesObserved : []) if (typeof file === "string" && file) instructionFiles.add(file);
  stats.instructionFilesObserved = [...instructionFiles].slice(0, MAX_INSTRUCTION_FILES);
  return stats;
}

function topBlocksOf(scope, limit = TOP_BLOCKS) {
  return (scope.blocks ?? [])
    .filter((block) => block.category !== "assistant_thinking")
    .map((block) => ({ id: block.id, category: block.category, estTokens: block.estTokens, firstRequest: block.firstRequest, tool: block.tool?.name, label: block.label }))
    .sort((a, b) => b.estTokens - a.estTokens)
    .slice(0, limit);
}

/**
 * ScopeSummary (ADR-002 section C): every field the lanes, the scope selector
 * and the subagent rail read, without `requests` and `blocks`.
 */
export function summarizeScope(scope) {
  const { requests, blocks, ...rest } = scope;
  return {
    ...rest,
    compactions: scope.compactions ?? [],
    partial: true,
    requestCount: requests?.length ?? 0,
    blockCount: blocks?.length ?? 0,
    compactionCount: scope.compactions?.length ?? 0,
    topBlocks: topBlocksOf(scope),
  };
}

const HASH_HEX = 16;

/**
 * Storage slimming (review #7): requests never carry `visibleBlockIds`
 * (derivable from block presence windows) and drop zero-valued composition
 * entries (the type is Partial; the sum still equals `usage.total`); block
 * hashes and `tool.argsHash` are truncated to 16 hex (equality within a run is
 * all the rules use them for). Runs before the scope is written, after rules ran.
 */
export function slimScopeForStorage(scope) {
  for (const request of scope.requests ?? []) {
    delete request.visibleBlockIds;
    if (request.composition && typeof request.composition === "object") {
      for (const [key, value] of Object.entries(request.composition)) if (value === 0) delete request.composition[key];
    }
  }
  for (const block of scope.blocks ?? []) {
    if (typeof block.hash === "string" && block.hash.length > HASH_HEX) block.hash = block.hash.slice(0, HASH_HEX);
    if (typeof block.tool?.argsHash === "string" && block.tool.argsHash.length > HASH_HEX) block.tool.argsHash = block.tool.argsHash.slice(0, HASH_HEX);
  }
  return scope;
}

function trimFix(fix) {
  if (!fix || typeof fix !== "object") return { platform: "both", summary: "" };
  const out = { platform: fix.platform, summary: String(fix.summary ?? "").slice(0, FIX_SUMMARY_MAX) };
  if (fix.path) out.path = fix.path;
  return out;
}

/**
 * One head per rule that fired in the run: the top-ranked finding of that
 * rule, trimmed to what the overview, recurrence and "first change" need.
 */
export function findingHeadsOf(findings) {
  const byRule = new Map();
  for (const finding of rankFindings(findings)) {
    const head = byRule.get(finding.ruleId);
    if (head) { head.occurrences += 1; head.count += finding.count ?? 1; head.tokensAffected += finding.tokensAffected ?? 0; continue; }
    // `runId`, `vendor`, `evidence`, `thresholdKeys` and `whyItMatters` are added back when a head is served (overview.mjs `repoHeads`, analysis.mjs `hydrate`).
    byRule.set(finding.ruleId, {
      id: finding.id,
      ruleId: finding.ruleId,
      severity: finding.severity,
      scope: finding.scope,
      scopeId: finding.scopeId,
      title: baseTitle(finding.title),
      fix: trimFix(finding.fix),
      tokensAffected: finding.tokensAffected ?? 0,
      count: finding.count ?? 1,
      occurrences: 1,
    });
  }
  return [...byRule.values()];
}

/** Aggregated rules suffix their title with " ×N"; the head keeps the rule's base title. */
export function baseTitle(title) {
  return String(title ?? "").replace(/\s*[×x]\s*\d+\s*$/u, "");
}

function slimSummary(summary) {
  if (!summary) return summary;
  const compositionAtPeak = {};
  for (const [key, value] of Object.entries(summary.compositionAtPeak ?? {})) if (value) compositionAtPeak[key] = value;
  const compositionAtEnd = {};
  for (const [key, value] of Object.entries(summary.compositionAtEnd ?? {})) if (value) compositionAtEnd[key] = value;
  return { ...summary, topBlocks: (summary.topBlocks ?? []).slice(0, TOP_BLOCKS), compositionAtPeak, compositionAtEnd };
}

// --- per-run habits record (ADR-003 section 2) ---

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function shortLabel(label) {
  const text = String(label ?? "");
  return text.length > HABIT_LABEL_MAX ? `…${text.slice(-(HABIT_LABEL_MAX - 1))}` : text;
}

function topTotals(map, limit = HABIT_TOP) {
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.n - a.n).slice(0, limit);
}

/**
 * Compact cross-session facts for one run, computed once at index time so the
 * habit rules never open a run file: fat results by (tool kind, target) — the
 * kind, not the tool name, decides the fix family, so Codex `exec` calling
 * `tools.web__run` groups with web fetches and Claude `Bash` results group by
 * the command's target (`cat path`) when the adapter found one; fat tool-call
 * payloads (Write/Edit/apply_patch arguments) by the same key with `call: true`;
 * files read whole (`tool.partial !== true`, a real target); handoff stats per
 * agent type; compaction count; startup base of request 0; MCP servers invoked.
 * Bounded: top 8 per list, labels 80 chars, so an entry stays under ~1.5 KB.
 * `v` is HABITS_VERSION; a record with another version is re-derived on the
 * next index pass (writer) and flagged stale by the habit engine until then.
 */
export function habitsOf(run, thresholds = {}) {
  const fatMin = Number(thresholds.fatToolResultTokens) > 0 ? Number(thresholds.fatToolResultTokens) : DEFAULT_FAT_TOKENS;
  const fat = new Map();
  const fullReads = new Map();
  const agents = new Map();
  const mcp = new Set();
  let compactions = 0;
  let auto = 0;
  let firstAt;
  let requests = 0;
  const main = (run.scopes ?? []).find((scope) => scope.kind === "main") ?? run.scopes?.[0];
  for (const scope of run.scopes ?? []) {
    requests += scope.requests?.length ?? 0;
    for (const compaction of scope.compactions ?? []) {
      compactions += 1;
      if (compaction.trigger === "auto") auto += 1;
      if (scope === main && Number.isFinite(compaction.atRequest) && (firstAt === undefined || compaction.atRequest < firstAt)) firstAt = compaction.atRequest;
    }
    if (scope.kind === "subagent") {
      const type = scope.agentType ?? "unknown";
      const slot = agents.get(type) ?? { type, n: 0, handoffs: [], ratios: [], peaks: [] };
      slot.n += 1;
      if (scope.handoff?.tokens?.value > 0) {
        slot.handoffs.push(scope.handoff.tokens.value);
        if (scope.handoff.compressionRatio?.value > 0) slot.ratios.push(scope.handoff.compressionRatio.value);
      }
      if (scope.peak?.value > 0) slot.peaks.push(scope.peak.value);
      agents.set(type, slot);
    }
    for (const block of scope.blocks ?? []) {
      const tool = block.tool;
      if (!tool) continue;
      if (tool.kind === "mcp") mcp.add(tool.server ?? (tool.name?.startsWith("mcp__") ? tool.name.split("__")[1] : tool.name) ?? "unknown");
      const isResult = typeof block.category === "string" && block.category.startsWith("tool_result.");
      const isCall = block.category === "tool_call";
      if (!isResult && !isCall) continue;
      const tokens = block.estTokens ?? 0;
      if (tokens >= fatMin) {
        const kind = tool.kind ?? (isResult ? block.category.slice("tool_result.".length) : "other");
        const label = shortLabel(tool.target ?? (block.label && block.label !== tool.name ? block.label : ""));
        const key = `${isCall ? "call" : "result"}\u0000${kind}\u0000${label}`;
        const slot = fat.get(key) ?? { tool: tool.name ?? "tool", kind, label: label || undefined, tokens: 0, n: 0, ...(isCall ? { call: true } : {}) };
        slot.tokens += tokens;
        slot.n += 1;
        fat.set(key, slot);
      }
      if (isResult && tool.kind === "file" && tool.partial !== true && typeof tool.target === "string" && tool.target) {
        const label = shortLabel(tool.target);
        const slot = fullReads.get(label) ?? { label, tokens: 0, n: 0 };
        slot.tokens += tokens;
        slot.n += 1;
        fullReads.set(label, slot);
      }
    }
  }
  const first = main?.requests?.[0];
  const startup = { h0: Math.round(first?.hiddenBase?.value ?? 0) };
  if (run.cliVersion) startup.cliVersion = String(run.cliVersion).slice(0, 32);
  if (first?.model) startup.model = String(first.model).slice(0, 64);
  return {
    v: HABITS_VERSION,
    fat: topTotals(fat).map((slot) => ({ ...slot, tokens: Math.round(slot.tokens) })),
    fullReads: topTotals(fullReads).map((slot) => ({ ...slot, tokens: Math.round(slot.tokens) })),
    agents: [...agents.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, HABIT_TOP)
      .map((slot) => ({ type: shortLabel(slot.type), n: slot.n, handoffP50: median(slot.handoffs), handoffMax: slot.handoffs.length ? Math.max(...slot.handoffs) : 0, ratioP50: Number(median(slot.ratios).toFixed(2)), peakP50: median(slot.peaks) })),
    compaction: { n: compactions, auto, firstAt, requests },
    startup,
    mcp: { invoked: [...mcp].sort().slice(0, 16) },
    peakShare: Number((run.summary?.peakShareOfWindow ?? 0).toFixed(3)),
    window: run.window?.value ?? 0,
  };
}

/**
 * Attribution fields stored next to `cwd` so the population rule never opens
 * a run file. `cwd` stays the only absolute path in the entry (manifest
 * contract); the reader resolves its realpath lazily and caches it.
 */
export function cwdFieldsOf(candidate) {
  const cwd = candidate?.cwd ?? null;
  const reversible = cwd ? encodedDirIsReversible(cwd) : (candidate?.vendor === "codex" ? false : Boolean(candidate?.cwdReversible));
  return { cwd, cwdKind: cwdKindOf(cwd), cwdReversible: reversible };
}

// --- session kind and attribution evidence (ADR-005 section 2) ---

/**
 * "harness" for an SDK-driven run (`entrypoint === "sdk-cli"`) or a temp-cwd
 * run that never called a tool and made at most two requests; "interactive"
 * otherwise. A temp-cwd session with tool calls is never a harness run.
 */
export function sessionKindOf({ entrypoint, cwdKind, summary } = {}) {
  if (entrypoint === "sdk-cli") return "harness";
  if (cwdKind === "temp" && (summary?.toolCalls ?? 0) === 0 && (summary?.requests ?? 0) <= HARNESS_MAX_REQUESTS) return "harness";
  return "interactive";
}

/** A repo-relative path: not absolute, not `~`-relative, not a drive path, not `.`/`..`, no `..` segment. */
export function isRepoRelativeTarget(value) {
  if (typeof value !== "string" || !value) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value === "." || value === ".." || /(^|\/)\.\.(\/|$)/.test(value)) return false;
  return true;
}

/** Distinct repo-relative `tool.target` values over every scope (main + subagents), first MAX_TARGETS in order of appearance. */
export function targetsOf(run) {
  const out = [];
  const seen = new Set();
  for (const scope of run?.scopes ?? []) {
    for (const block of scope.blocks ?? []) {
      const target = block.tool?.target;
      if (!isRepoRelativeTarget(target) || seen.has(target)) continue;
      seen.add(target);
      out.push(target);
      if (out.length >= MAX_TARGETS) return out;
    }
  }
  return out;
}

/** Content hashes (first HASH_HEX chars) of `nested_memory` blocks whose label looks like an instruction file. */
export function nestedHashesOf(run) {
  const out = [];
  for (const scope of run?.scopes ?? []) {
    for (const block of scope.blocks ?? []) {
      if (block.category !== "attachments" || block.attachmentType !== "nested_memory" || !looksLikeInstructionFile(block.label)) continue;
      const hash = shortHash(block.hash);
      if (!hash || out.includes(hash)) continue;
      out.push(hash);
      if (out.length >= MAX_NESTED_HASHES) return out;
    }
  }
  return out;
}

/** Codex: hash of the first `instructions` block the main scope saw at request 0 (what the runtime loaded as AGENTS.md). */
export function instructionHashOf(run) {
  if (run?.vendor !== "codex") return undefined;
  const main = (run.scopes ?? []).find((scope) => scope.kind === "main") ?? run.scopes?.[0];
  for (const block of main?.blocks ?? []) {
    if (block.category !== "instructions") continue;
    if ((block.firstRequest ?? 0) > 0) return undefined;
    return shortHash(block.hash);
  }
  return undefined;
}

/** The first HASH_HEX hex chars of a hash, so a full sha1 (inventory) and a slimmed block hash (storage) compare equal. */
export function shortHash(hash) {
  return typeof hash === "string" && hash ? hash.slice(0, HASH_HEX) : undefined;
}

export function buildEntry({ run, findings, candidate, adapterVersion, estimatorVersion, calibrationVersion, thresholdsHash, file, thresholds }) {
  const cwdFields = cwdFieldsOf(candidate);
  const summary = slimSummary(run.summary);
  const entrypoint = typeof run.entrypoint === "string" && run.entrypoint ? run.entrypoint.slice(0, 32) : undefined;
  const instructionHash = instructionHashOf(run);
  return {
    vendor: run.vendor,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    adapterVersion,
    estimatorVersion: estimatorVersion ?? null,
    calibrationVersion: calibrationVersion ?? null,
    thresholdsHash,
    runId: run.id,
    sessionId: run.sessionId,
    file,
    projectKey: run.project?.key ?? candidate.projectKey,
    discoveryKey: candidate.projectKey,
    projectDisplay: run.project?.displayName ?? candidate.projectDisplay,
    project: run.project ?? { key: candidate.projectKey, displayName: candidate.projectDisplay, cwdHash: candidate.projectKey },
    ...cwdFields,
    entrypoint,
    kind: sessionKindOf({ entrypoint, cwdKind: cwdFields.cwdKind, summary }),
    targets: targetsOf(run),
    nestedHashes: nestedHashesOf(run),
    ...(instructionHash ? { instructionHash } : {}),
    cliVersion: run.cliVersion ?? undefined,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    activeMs: run.activeMs ?? 0,
    window: run.window,
    summary,
    findingsCount: findings.length,
    findingsHigh: findings.filter((finding) => finding.severity === "high").length,
    findingHeads: findingHeadsOf(findings),
    handoffs: handoffsOf(run),
    handoffsByThread: handoffsByThreadOf(run),
    stats: statsOf(run),
    habits: habitsOf(run, thresholds),
    parentThreadId: candidate.parentThreadId ?? undefined,
    subagentFiles: run.source?.subagentFiles ?? candidate.subagentFiles ?? 0,
    indexedAt: new Date().toISOString(),
  };
}

/** The highest-ranked finding head of an entry (what the old `topFinding` field held). */
export function topFindingOf(entry) {
  return rankFindings(entry?.findingHeads ?? [])[0] ?? null;
}

export function errorEntry({ candidate, adapterVersion, estimatorVersion, calibrationVersion, thresholdsHash, file, error }) {
  return {
    vendor: candidate.vendor,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    adapterVersion,
    estimatorVersion: estimatorVersion ?? null,
    calibrationVersion: calibrationVersion ?? null,
    thresholdsHash,
    runId: `${candidate.vendor}:${candidate.sessionId}`,
    sessionId: candidate.sessionId,
    file,
    projectKey: candidate.projectKey,
    discoveryKey: candidate.projectKey,
    projectDisplay: candidate.projectDisplay,
    ...cwdFieldsOf(candidate),
    parentThreadId: candidate.parentThreadId ?? undefined,
    error,
    indexedAt: new Date().toISOString(),
  };
}
