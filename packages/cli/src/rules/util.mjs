/**
 * Shared helpers for rule modules: finding ids, evidence refs, block iteration,
 * platform-specific fixes. Rules stay pure functions over the IR; nothing here
 * touches the filesystem.
 */
import { createHash } from "node:crypto";

export function sha1(text) {
  return createHash("sha1").update(String(text)).digest("hex");
}

export function findingId(ruleId, primaryRef) {
  return `${ruleId}:${sha1(primaryRef).slice(0, 10)}`;
}

// --- evidence refs (contract: docs/cycle1-contracts.md, Rules engine) ---

export function requestRef(run, scope, index) {
  return `${run.id}#${scope.id}#${index}`;
}

export function blockRef(run, block) {
  return `${run.id}#${typeof block === "string" ? block : block.id}`;
}

export function scopeRef(run, scope) {
  return `${run.id}#${typeof scope === "string" ? scope : scope.id}`;
}

export function metricRef(run, name) {
  return `${run.id}#metric:${name}`;
}

// --- evidence builders ---

export function requestEvidence(run, scope, request, { label, value, unit = "tokens", provenance = "observed.vendor" } = {}) {
  return {
    kind: "request",
    ref: requestRef(run, scope, request.index),
    label: label ?? `${scopeLabel(scope)} request #${request.index}`,
    value: value ?? request.usage?.total,
    unit,
    provenance,
  };
}

export function blockEvidence(run, block, { label, value, unit = "tokens", provenance = "estimated.local" } = {}) {
  return {
    kind: "block",
    ref: blockRef(run, block),
    label: label ?? describeBlock(block),
    value: value ?? block.estTokens,
    unit,
    provenance,
  };
}

export function scopeEvidence(run, scope, { label, value, unit = "tokens", provenance = "observed.vendor" } = {}) {
  return {
    kind: "scope",
    ref: scopeRef(run, scope),
    label: label ?? `${scopeLabel(scope)} (peak ${formatTokens(scope.peak?.value ?? 0)})`,
    value: value ?? scope.peak?.value,
    unit,
    provenance,
  };
}

export function metricEvidence(run, name, value, { label, unit = "tokens", provenance = "derived.exact" } = {}) {
  return { kind: "metric", ref: metricRef(run, name), label: label ?? name, value, unit, provenance };
}

export function windowEvidence(run) {
  const source = run.window.provenance === "observed.vendor" ? "vendor-reported" : run.window.provenance === "derived.exact" ? "raised by observed peak" : run.window.provenance === "estimated.local" ? "model table" : "unknown source";
  return metricEvidence(run, "window", run.window.value, { label: `context window ${formatTokens(run.window.value)} (${source})`, provenance: run.window.provenance });
}

// --- labels ---

export function scopeLabel(scope) {
  if (scope.kind === "main") return "main";
  const type = scope.agentType ? ` ${scope.agentType}` : "";
  return `subagent${type} ${scope.id}`;
}

export function toolName(block) {
  return block.tool?.name ?? block.label ?? block.category;
}

export function toolTarget(block) {
  return block.tool?.target ?? (block.label && block.label !== block.tool?.name ? block.label : undefined);
}

export function describeBlock(block) {
  const name = toolName(block);
  const target = toolTarget(block);
  const where = target && target !== name ? ` ${target}` : "";
  return `${name}${where} result, ${formatTokens(block.estTokens)} (request #${block.firstRequest})`;
}

export function formatTokens(n) {
  return `${Math.round(n).toLocaleString("en-US")} tok`;
}

export function percent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

// --- iteration helpers ---

export function isToolResult(block) {
  return typeof block.category === "string" && block.category.startsWith("tool_result.");
}

export function resultKind(block) {
  return block.tool?.kind ?? block.category.slice("tool_result.".length);
}

export function* iterBlocks(run, predicate = () => true) {
  for (const scope of run.scopes ?? []) {
    for (const block of scope.blocks ?? []) {
      if (predicate(block, scope)) yield { scope, block };
    }
  }
}

export function subagentScopes(run) {
  return (run.scopes ?? []).filter((scope) => scope.kind === "subagent");
}

export function scopeById(run, id) {
  return (run.scopes ?? []).find((scope) => scope.id === id);
}

export function requestByIndex(scope, index) {
  return scope.requests.find((request) => request.index === index);
}

export function isFileCall(block) {
  return block.category === "tool_call" && block.tool?.kind === "file" && typeof block.tool.target === "string" && block.tool.target.length > 0;
}

/** A Bash call is a shell call whatever kind the command parser gave it (ADR-005 section 4), so B-15 never loses one. */
export function isShellCall(block) {
  return block.category === "tool_call" && (block.tool?.kind === "shell" || block.tool?.name === "Bash") && typeof block.tool.argsHash === "string";
}

/** A whole-file read result with a real target: a Read without a range, or a Bash/exec `cat path` (kind `file`, not partial). */
export function isWholeFileRead(block) {
  return isToolResult(block) && block.tool?.kind === "file" && block.tool.partial !== true && typeof block.tool.target === "string" && block.tool.target.length > 0;
}

export function fileTargets(blocks) {
  const map = new Map();
  for (const block of blocks) if (isFileCall(block) && !map.has(block.tool.target)) map.set(block.tool.target, block);
  return map;
}

export function shellCommands(blocks) {
  const map = new Map();
  for (const block of blocks) if (isShellCall(block) && !map.has(block.tool.argsHash)) map.set(block.tool.argsHash, block);
  return map;
}

export function findingScopeFor(scope) {
  return scope.kind === "subagent" ? "subagent" : "session";
}

// --- fixes ---

/** Picks the fix variant for the run's vendor; the finding carries exactly one platform. */
export function platformFix(run, variants) {
  const vendor = run.vendor;
  const chosen = variants[vendor] ?? variants.both;
  if (chosen) return { platform: variants[vendor] ? vendor : "both", ...chosen };
  const fallback = variants.claude ?? variants.codex ?? {};
  return { platform: "both", ...fallback };
}

// --- finding factory ---

export function makeFinding(rule, run, { scope = "session", primaryRef, evidence, fix, tokensAffected, severity, title, count, scopeId }) {
  if (!evidence?.length) throw new Error(`${rule.id}: a finding needs at least one evidence entry`);
  const ref = primaryRef ?? evidence[0].ref;
  const finding = {
    id: findingId(rule.id, ref),
    ruleId: rule.id,
    severity: severity ?? rule.severity,
    scope,
    vendor: run.vendor,
    runId: run.id,
    title: title ?? rule.title,
    whyItMatters: rule.whyItMatters,
    evidence,
    fix,
    thresholdKeys: [...rule.thresholdKeys],
    tokensAffected: tokensAffected === undefined ? undefined : Math.round(tokensAffected),
  };
  if (count !== undefined) finding.count = count;
  if (scopeId !== undefined) finding.scopeId = scopeId;
  return finding;
}

// --- aggregation (ADR-002 B): one finding per (rule, run, scope) ---

/** Evidence cap for aggregated findings; assertFindingShape enforces it whenever `count` is present. */
export const MAX_AGGREGATED_EVIDENCE = 5;

/** Title with the occurrence count, e.g. "Fat tool result ×14"; unchanged for a single occurrence. */
export function countedTitle(rule, count) {
  return count > 1 ? `${rule.title} ×${count}` : rule.title;
}

/** Items sorted by `pick(item)` descending, first `limit`. Stable for ties (keeps input order). */
export function topBy(items, pick, limit = MAX_AGGREGATED_EVIDENCE) {
  return items
    .map((item, index) => ({ item, index, value: pick(item) ?? 0 }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

/** Groups the results of iterBlocks by scope, preserving scope order. */
export function groupByScope(run, predicate) {
  const groups = new Map();
  for (const { scope, block } of iterBlocks(run, predicate)) {
    if (!groups.has(scope.id)) groups.set(scope.id, { scope, blocks: [] });
    groups.get(scope.id).blocks.push(block);
  }
  return [...groups.values()];
}

/**
 * Window-relative severity for block-size rules: `high` only when a single block reaches
 * max(thresholdTokens, fatBlockWindowShare × window); otherwise the rule's base severity.
 */
export function blockSeverity(rule, run, blocks, thresholdTokens, thresholds) {
  const share = thresholds.fatBlockWindowShare ?? 0.05;
  const window = run.window?.value > 0 ? run.window.value : 0;
  const bar = Math.max(thresholdTokens ?? 0, share * window);
  return blocks.some((block) => block.estTokens >= bar) ? "high" : rule.severity;
}

/**
 * Evidence for an aggregated per-scope finding: the top blocks by tokens, with one slot
 * reserved for the scope itself when the scope is a subagent (cap MAX_AGGREGATED_EVIDENCE).
 */
export function aggregatedBlockEvidence(run, scope, blocks, toEvidence) {
  const slots = scope.kind === "subagent" ? MAX_AGGREGATED_EVIDENCE - 1 : MAX_AGGREGATED_EVIDENCE;
  const evidence = topBy(blocks, (block) => block.estTokens, slots).map((block) => toEvidence(block));
  if (scope.kind === "subagent") evidence.push(scopeEvidence(run, scope));
  return evidence;
}

export function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
