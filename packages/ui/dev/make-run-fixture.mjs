/**
 * Generates the run fixtures in the ADR-002 C shape:
 *   dev/fixtures/run-sample.json         run response: main scope full, child scopes as summaries (partial: true)
 *   dev/fixtures/run-sample.scopes.json  every scope in full, by id (served by /runs/:vendor/:id/scopes/:scopeId)
 *   node dev/make-run-fixture.mjs --stress  -> run-stress.json / run-stress.scopes.json (160 subagents, 1,500 main
 *                                             requests, ~300 findings, resumed session), gitignored
 *
 * Synthetic Claude Code run with realistic usage series, reconciliation v2
 * composition (clamped k, `unlogged` band, base steps), a composition that sums
 * to usage.total on every request, compactions, nested subagents (one still
 * open, one with a fat handoff) and aggregated findings with `count`.
 * Deterministic PRNG; no transcript content anywhere.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STRESS = process.argv.includes("--stress");
const NAME = STRESS ? "run-stress" : "run-sample";
const outRun = path.join(here, "fixtures", `${NAME}.json`);
const outScopes = path.join(here, "fixtures", `${NAME}.scopes.json`);

let seed = STRESS ? 20260903 : 20260901;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[ri(0, 15)]).join("");
const M = (value, provenance) => ({ value, provenance });
const round4 = (v) => Number(v.toFixed(4));

const RUN_ID = STRESS ? "claude:stress" : "claude:sample";
const SESSION_ID = STRESS ? "stress" : "sample";
const WINDOW = STRESS ? 1_000_000 : 200_000;
const SIZE = STRESS ? 0.55 : 0.36; // block-size multiplier so the main scope compacts below the window
const START = Date.parse("2026-09-01T09:00:00Z");
const MODELS = STRESS ? ["claude-opus-4-1", "claude-sonnet-4-5", "claude-opus-5"] : ["claude-opus-4-1", "claude-sonnet-4-5"];
const K_MIN = 0.6, K_MAX = 1.5;
const SYSTEM_BASELINE = 25_000;

const FILES = ["src/index/manifest.mjs", "src/adapters/claude.mjs", "src/ir/finalize.mjs", "packages/ui/src/main.tsx", "docs/adr-001-product-architecture.md", "src/rules/B-01.mjs", "package.json", "test/adapters.test.mjs", "src/contextscope.mjs", "README.md"];
const SHELL = ["npm test", "git status", "node build.mjs", "ls -la", "npm run typecheck", "git diff --stat", "node --test test/*.test.mjs"];
const SEARCH = ["Grep estimateTokens", "Glob **/*.mjs", "Grep compactMetadata", "Grep parseClaudeSession"];
const AGENT_TYPES = ["Explore", "general-purpose", "code-reviewer", "Plan", "docs-writer"];

/**
 * Builds one scope. `compactAt` lists request indexes where a compaction
 * boundary sits before the request; `unlogged0` is the persistent unlogged base
 * from request 0 (resumed session); `steps` are persistent base changes
 * ({ at, delta }) detected by reconciliation v2.
 */
function buildScope({ id, kind, depth, parentScopeId, agentType, description, count, startMs, gapMs, compactAt = [], baseSystem, baseInstructions, model, launch, seedBlocks = [], unlogged0 = 0, steps = [], errorTail = 0.08 }) {
  const requests = [];
  const blocks = [];
  const compactions = [];
  const baseSteps = [];
  let seq = 0;
  let t = startMs;
  let visible = [];
  let turn = 0;
  let prevTotal = 0;
  let U = unlogged0;
  let pending = [];
  let lastHadTool = false;
  let peak = 0;
  let processed = 0, outputSum = 0, toolCalls = 0;
  let unloggedSum = 0;
  const models = new Set();
  const errors = [];
  let clamped = 0;

  function addBlock(category, opts, firstRequest) {
    const bytes = Math.round((opts.bytes ?? ri(200, 4000)) * (category === "compaction_summary" || category === "user" ? 1 : SIZE));
    const kindOf = opts.kind ?? (category.startsWith("tool_result") || category === "tool_call" ? "code" : "prose");
    const b = { id: `${id}:${seq}`, seq, at: new Date(t).toISOString(), category, bytes, estTokens: Math.ceil(bytes / (kindOf === "code" ? 3.2 : 3.6)), kind: kindOf, firstRequest, hash: hex(40) };
    if (opts.tool) b.tool = opts.tool;
    if (opts.label) b.label = opts.label;
    if (opts.attachmentType) b.attachmentType = opts.attachmentType;
    if (opts.agentId) b.agentId = opts.agentId;
    seq++;
    blocks.push(b);
    return b;
  }

  for (const s of seedBlocks) pending.push(addBlock(s.category, s, 0));

  for (let i = 0; i < count; i++) {
    const compaction = compactAt.includes(i);
    if (compaction) {
      const pre = prevTotal;
      const cid = `${id}:c${compactions.length + 1}`;
      for (const b of visible) { b.lastRequest = i - 1; b.droppedBy = cid; }
      visible = [];
      const summary = addBlock("compaction_summary", { bytes: ri(9000, 14000), kind: "prose", label: "compaction summary" }, i);
      visible.push(summary);
      const postEstimate = baseSystem + baseInstructions + U + summary.estTokens + pending.reduce((s, b) => s + b.estTokens, 0);
      compactions.push({ id: cid, at: new Date(t).toISOString(), atRequest: i, trigger: compactions.length === 0 ? "auto" : "manual", preTokens: M(pre, "observed.vendor"), postTokens: M(postEstimate, "observed.vendor"), droppedTokens: M(pre - postEstimate, "derived.exact"), summaryBlockId: summary.id, durationMs: ri(4000, 12000), preservedMessages: ri(4, 12) });
    }
    const step = steps.find((s) => s.at === i);
    if (step) { U = Math.max(0, U + step.delta); baseSteps.push({ atRequest: i, delta: step.delta }); }
    if (i === 0 || (!lastHadTool && rnd() < 0.7)) {
      turn++;
      pending.push(addBlock("user", { bytes: ri(80, 1200), kind: "prose", label: `prompt ${turn}` }, i));
      if (rnd() < 0.4) pending.push(addBlock("attachments", { bytes: ri(120, 900), kind: "prose", attachmentType: "system-reminder", label: "system-reminder" }, i));
    }
    for (const b of pending) visible.push(b);
    const newIds = pending.map((b) => b.id);
    const newEst = pending.reduce((s, b) => s + b.estTokens, 0);
    pending = [];

    const sumEst = visible.reduce((s, b) => s + b.estTokens, 0);
    // Truth: the vendor total uses kRaw (the estimator's real error, with a tail); reconciliation clamps it.
    const err = rnd() < errorTail ? (rnd() - 0.5) * 1.2 : (rnd() - 0.5) * 0.08;
    const kRaw = Math.max(0.3, 1 + err);
    const k = Math.min(K_MAX, Math.max(K_MIN, kRaw));
    if (kRaw >= K_MIN && kRaw <= K_MAX) errors.push(Math.abs(1 - kRaw)); else clamped++;
    const total = Math.max(baseSystem + baseInstructions + U + Math.round(kRaw * sumEst), 1000);
    // Reconciled composition: k × est per category, base = system + instructions + unlogged; residual goes to unlogged (or shrinks system).
    const comp = {};
    for (const b of visible) comp[b.category] = (comp[b.category] ?? 0) + b.estTokens * k;
    for (const c of Object.keys(comp)) comp[c] = Math.round(comp[c]);
    let system = baseSystem;
    const visibleSum = Object.values(comp).reduce((s, v) => s + v, 0);
    let rest = total - system - baseInstructions - visibleSum;
    let unlogged = 0;
    if (rest >= 0) unlogged = rest;
    else { system = Math.max(0, system + rest); rest = total - system - baseInstructions - visibleSum; if (rest < 0) { const largest = Object.keys(comp).sort((a, b) => comp[b] - comp[a])[0]; comp[largest] += rest; } }
    comp.system = system;
    comp.instructions = baseInstructions;
    if (unlogged > 0) comp.unlogged = unlogged;
    unloggedSum += unlogged;

    let cacheRead, cacheCreation, input;
    const cold = i === 0 || compaction || rnd() < 0.05;
    if (cold) { cacheRead = compaction ? 0 : Math.round(prevTotal * (i === 0 ? 0 : rnd() * 0.5)); cacheCreation = Math.max(0, total - cacheRead - ri(50, 400)); }
    else { cacheRead = Math.min(total, prevTotal + ri(-200, 0)); cacheCreation = Math.max(0, total - cacheRead - ri(0, 120)); }
    if (cacheRead < 0) cacheRead = 0;
    input = Math.max(0, total - cacheRead - cacheCreation);
    const thinking = rnd() < 0.35 ? ri(200, 2500) : 0;
    const output = ri(60, 1200) + thinking;
    const m = model ?? (i > count * 0.6 && rnd() < 0.25 ? MODELS[1] : STRESS && i > count * 0.85 ? MODELS[2] : MODELS[0]);
    models.add(m);

    const req = { index: i, id: `req_${hex(8)}`, at: new Date(t).toISOString(), model: m, turn, usage: { input, cacheCreation, cacheRead, output, total, ...(thinking ? { thinking } : {}) }, hiddenBase: M(system + baseInstructions + unlogged, "estimated.local"), scale: round4(k), scaleRaw: round4(kRaw), composition: comp, deltaCheck: Math.round((input + cacheCreation) - newEst), newBlockIds: newIds };
    if (compaction) req.compactionBefore = compactions[compactions.length - 1].id;
    if (step) req.baseChange = { tokens: step.delta, provenance: "derived.exact" };
    requests.push(req);
    processed += total; outputSum += output; peak = Math.max(peak, total); prevTotal = total;

    t += gapMs();
    pending.push(addBlock("assistant_text", { bytes: ri(60, 1800), kind: "prose" }, i + 1));
    if (thinking) addBlock("assistant_thinking", { bytes: thinking * 3, kind: "prose" }, i + 1);
    const roll = rnd();
    lastHadTool = false;
    const wantsSub = launch && launch.some((l) => l.at === i);
    if (wantsSub) {
      lastHadTool = true;
      for (const l of launch.filter((l) => l.at === i)) {
        toolCalls++;
        pending.push(addBlock("tool_call", { bytes: ri(300, 900), tool: { name: "Agent", kind: "agent", argsHash: hex(12) }, label: `Agent(${l.agentType})`, agentId: l.id }, i + 1));
      }
    } else if (roll < 0.8) {
      toolCalls++; lastHadTool = true;
      const tk = rnd();
      let tool, cat, label, bytes;
      if (tk < 0.35) { tool = { name: "Read", kind: "file", argsHash: hex(12), target: pick(FILES) }; cat = "tool_result.file"; label = tool.target; bytes = rnd() < 0.08 ? ri(30000, 60000) : ri(1500, 14000); }
      else if (tk < 0.6) { tool = { name: "Bash", kind: "shell", argsHash: hex(12) }; cat = "tool_result.shell"; label = pick(SHELL); bytes = rnd() < 0.06 ? ri(25000, 45000) : ri(200, 6000); }
      else if (tk < 0.8) { tool = { name: rnd() < 0.5 ? "Grep" : "Glob", kind: "search", argsHash: hex(12) }; cat = "tool_result.search"; label = pick(SEARCH); bytes = ri(300, 9000); }
      else if (tk < 0.88) { tool = { name: "WebFetch", kind: "web", argsHash: hex(12) }; cat = "tool_result.web"; label = "docs.anthropic.com"; bytes = ri(4000, 18000); }
      else if (tk < 0.94) { tool = { name: "Edit", kind: "edit", argsHash: hex(12), target: pick(FILES) }; cat = "tool_result.other"; label = tool.target; bytes = ri(100, 400); }
      else { tool = { name: "Skill", kind: "skill", argsHash: hex(12) }; cat = "skills"; label = "dataviz"; bytes = ri(6000, 12000); }
      pending.push(addBlock("tool_call", { bytes: ri(80, 600), tool, label: tool.target ?? label }, i + 1));
      const result = addBlock(cat, { bytes, tool: { ...tool, isError: rnd() < 0.04 }, label }, i + 1);
      pending.push(result);
      if (rnd() < 0.15) pending.push(addBlock("attachments", { bytes: ri(100, 700), kind: "prose", attachmentType: rnd() < 0.5 ? "hook_stdout" : "task_notification", label: "hook stdout" }, i + 1));
    }
    if (i === 5 && depth === 0) pending.push(addBlock("memory", { bytes: 2400, kind: "prose", label: "memory/MEMORY.md", tool: { name: "Read", kind: "file", argsHash: hex(12), target: "memory/MEMORY.md" } }, i + 1));
  }
  for (const b of pending) b.lastRequest = count - 1;
  const sorted = [...errors].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  return {
    id, kind, agentType, description, parentScopeId, depth, status: "completed", models: [...models], requests, blocks, compactions,
    peak: M(peak, "observed.vendor"), processedInputTokens: processed, outputTokens: outputSum, toolCalls,
    unloggedShare: round4(processed ? unloggedSum / processed : 0), estimatorErrorMedian: round4(q(0.5)), estimatorErrorP95: round4(q(0.95)), baseSteps,
    endMs: t, clamped,
  };
}

const gap = () => ri(6_000, 40_000);

// ---------- scopes ----------
const mainCount = STRESS ? 1500 : 400;
const launches = STRESS
  ? Array.from({ length: 150 }, (_, k) => ({ id: `agent-${hex(4)}`, at: 3 + Math.floor((k / 150) * (mainCount - 40)) + ri(0, 5), agentType: k % 7 === 0 ? "Plan" : k % 3 === 0 ? "general-purpose" : "Explore" }))
  : [{ id: "agent-a1", at: 60, agentType: "Explore" }, { id: "agent-a2", at: 200, agentType: "general-purpose" }, { id: "agent-a4", at: 372, agentType: "code-reviewer" }];

const main = buildScope({
  id: "main", kind: "main", depth: 0, count: mainCount, startMs: START, gapMs: gap,
  compactAt: STRESS ? [520, 1010, 1380] : [152, 311], baseSystem: STRESS ? 25_000 : 18_400, baseInstructions: 4_600, launch: launches,
  unlogged0: STRESS ? 180_000 : 0, // stress: a resumed session whose earlier history is not in the transcript
  steps: STRESS ? [{ at: 300, delta: 33_000 }, { at: 1100, delta: -41_000 }] : [{ at: 100, delta: 18_000 }],
});
{ // a 45-minute idle gap in the middle (active time excludes it)
  const at = Math.floor(mainCount * 0.575); const shift = 45 * 60_000;
  for (const r of main.requests) if (r.index >= at) r.at = new Date(Date.parse(r.at) + shift).toISOString();
  for (const b of main.blocks) if (b.firstRequest >= at) b.at = new Date(Date.parse(b.at) + shift).toISOString();
  main.endMs += shift;
}

function childScope({ id, parent, agentType, description, count, launchAt, deliverAt, depth, status, handoffBytes, model, steps, errorTail }) {
  const parentReq = parent.requests[launchAt];
  const startMs = Date.parse(parentReq.at) + 2_000;
  const scope = buildScope({ id, kind: "subagent", depth, parentScopeId: parent.id, agentType, description, count, startMs, gapMs: () => ri(4_000, 15_000), baseSystem: 11_200, baseInstructions: 0, model, seedBlocks: [{ category: "user", bytes: ri(600, 1800), kind: "prose", label: "agent prompt" }], steps, errorTail });
  scope.launchedAtRequest = launchAt;
  scope.launchedAt = parentReq.at;
  scope.status = status;
  scope.source = { file: `~/.claude/projects/-Users-me-contextscope/${SESSION_ID}/subagents/${id}.jsonl`, bytes: ri(80_000, 400_000) };
  if (deliverAt !== undefined) {
    scope.deliveredAtRequest = deliverAt;
    scope.deliveredAt = parent.requests[deliverAt].at;
    const b = { id: `${parent.id}:${parent.blocks.length}`, seq: parent.blocks.length, at: parent.requests[deliverAt].at, category: "subagent_handoff", bytes: handoffBytes, estTokens: Math.ceil(handoffBytes / 3.6), kind: "prose", agentId: id, label: `handoff from ${agentType}`, tool: { name: "Agent", kind: "agent", argsHash: hex(12) }, firstRequest: deliverAt, hash: hex(40) };
    const c = parent.compactions.find((c) => c.atRequest > deliverAt);
    if (c) { b.lastRequest = c.atRequest - 1; b.droppedBy = c.id; }
    parent.blocks.push(b);
    parent.requests[deliverAt].newBlockIds.push(b.id);
    // fold the handoff into the parent composition without breaking the sum: take it from the largest visible category
    const last = b.lastRequest ?? parent.requests.length - 1;
    for (let i = deliverAt; i <= last; i++) {
      const r = parent.requests[i];
      const donor = Object.keys(r.composition).filter((k) => !["system", "instructions", "unlogged", "subagent_handoff"].includes(k)).sort((x, y) => r.composition[y] - r.composition[x])[0];
      const take = Math.min(b.estTokens, r.composition[donor] - 100);
      if (take > 0) { r.composition[donor] -= take; r.composition.subagent_handoff = (r.composition.subagent_handoff ?? 0) + take; }
    }
    scope.handoff = { blockId: b.id, tokens: M(b.estTokens, "observed.artifact"), compressionRatio: M(Number((scope.peak.value / b.estTokens).toFixed(2)), "derived.exact") };
  }
  return scope;
}

const scopes = [main];
if (STRESS) {
  for (const [k, l] of launches.entries()) {
    const count = ri(8, 40);
    const deliver = k % 9 === 8 ? undefined : Math.min(mainCount - 1, l.at + ri(6, 60));
    const child = childScope({ id: l.id, parent: main, agentType: l.agentType, description: `task ${k + 1}`, count, launchAt: l.at, deliverAt: deliver, depth: 1, status: deliver === undefined ? "open" : "completed", handoffBytes: k % 5 === 0 ? ri(30_000, 60_000) : ri(2_000, 12_000), model: l.agentType === "Explore" ? "claude-sonnet-4-5" : "claude-opus-4-1", steps: k % 8 === 1 ? [{ at: 1, delta: 33_000 }] : [], errorTail: k % 4 === 0 ? 0.3 : 0.08 });
    scopes.push(child);
    if (k % 15 === 2 && count > 12) scopes.push(childScope({ id: `agent-${hex(4)}`, parent: child, agentType: "Explore", description: "nested lookup", count: ri(6, 14), launchAt: 3, deliverAt: Math.min(count - 1, 9), depth: 2, status: "completed", handoffBytes: ri(3_000, 8_000), model: "claude-sonnet-4-5", steps: [] }));
  }
} else {
  const a1 = childScope({ id: "agent-a1", parent: main, agentType: "Explore", description: "Find where estimator errors are computed", count: 38, launchAt: 60, deliverAt: 96, depth: 1, status: "completed", handoffBytes: 9_800, model: "claude-sonnet-4-5", steps: [] });
  const a2 = childScope({ id: "agent-a2", parent: main, agentType: "general-purpose", description: "Refactor the index manifest and write tests", count: 74, launchAt: 200, deliverAt: 262, depth: 1, status: "completed", handoffBytes: 52_000, model: "claude-opus-4-1", steps: [{ at: 1, delta: 33_000 }] });
  const a3 = childScope({ id: "agent-a3", parent: a2, agentType: "Explore", description: "List every manifest reader", count: 22, launchAt: 12, deliverAt: 31, depth: 2, status: "completed", handoffBytes: 7_200, model: "claude-sonnet-4-5", steps: [] });
  const a4 = childScope({ id: "agent-a4", parent: main, agentType: "code-reviewer", description: "Review the session view diff", count: 19, launchAt: 372, deliverAt: undefined, depth: 1, status: "open", handoffBytes: 0, model: "claude-sonnet-4-5", steps: [], errorTail: 0.4 });
  scopes.push(a1, a2, a3, a4);
}

// ---------- run-level numbers ----------
const peakReq = main.requests.reduce((best, r) => (r.usage.total > best.usage.total ? r : best), main.requests[0]);
const topBlocksOf = (s, n) => s.blocks.filter((b) => b.category !== "assistant_thinking").slice().sort((a, b) => b.estTokens - a.estTokens).slice(0, n).map((b) => ({ id: b.id, category: b.category, estTokens: b.estTokens, firstRequest: b.firstRequest, tool: b.tool?.name, label: b.label }));
const topBlocks = scopes.flatMap((s) => topBlocksOf(s, 5).map((b) => ({ ...b, scopeId: s.id }))).sort((a, b) => b.estTokens - a.estTokens).slice(0, 5);
const totalRequests = scopes.reduce((s, sc) => s + sc.requests.length, 0);
const sumTotal = scopes.reduce((s, sc) => s + sc.processedInputTokens, 0);
const sumCacheRead = scopes.reduce((s, sc) => s + sc.requests.reduce((x, r) => x + r.usage.cacheRead, 0), 0);
const startedAt = new Date(START).toISOString();
const endedAt = new Date(scopes.reduce((m, s) => Math.max(m, s.endMs), 0)).toISOString();
let activeMs = 0;
for (let i = 1; i < main.requests.length; i++) { const d = Date.parse(main.requests[i].at) - Date.parse(main.requests[i - 1].at); if (d <= 30 * 60_000) activeMs += d; }

// ---------- findings (aggregated per rule × scope, ADR-002 B) ----------
const findings = [];
const fatBlocks = (s, cat, threshold) => s.blocks.filter((b) => b.category === cat && b.estTokens >= threshold).sort((a, b) => b.estTokens - a.estTokens);
const blockEvidence = (b) => ({ kind: "block", ref: `${RUN_ID}#${b.id}`, label: `${b.tool?.name ?? b.category} ${b.label ?? ""}`.trim(), value: b.estTokens, unit: "tokens", provenance: "estimated.local" });
const fatThreshold = STRESS ? 6_000 : 2_500;
for (const s of scopes) {
  const fat = fatBlocks(s, "tool_result.file", fatThreshold).concat(fatBlocks(s, "tool_result.shell", fatThreshold)).sort((a, b) => b.estTokens - a.estTokens);
  if (!fat.length) continue;
  const sum = fat.reduce((x, b) => x + b.estTokens, 0);
  findings.push({
    id: `B-01:${hex(10)}`, ruleId: "B-01", severity: fat[0].estTokens >= Math.max(8_000, 0.05 * WINDOW) ? "high" : "medium", scope: s.kind === "main" ? "session" : "subagent", vendor: "claude", runId: RUN_ID, scopeId: s.id,
    title: "Fat tool result", count: fat.length,
    whyItMatters: `${fat.length} tool result${fat.length === 1 ? "" : "s"} over ${fatThreshold.toLocaleString()} tokens entered ${s.kind === "main" ? "the main scope" : `${s.agentType} (${s.id})`} and were resent on every request until dropped; the largest is ${fat[0].estTokens.toLocaleString()} tokens.`,
    evidence: fat.slice(0, 5).map(blockEvidence),
    fix: { platform: "claude", summary: "Read with offset/limit or grep for the symbol instead of loading whole files; pipe shell output through head.", snippet: "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000.", path: "CLAUDE.md" },
    thresholdKeys: ["fatToolResultTokens"], tokensAffected: sum,
  });
}
for (const s of scopes.slice(1)) {
  if (!s.handoff || s.handoff.tokens.value < 4_000) continue;
  findings.push({
    id: `B-05:${hex(10)}`, ruleId: "B-05", severity: s.handoff.tokens.value > 0.3 * s.peak.value ? "high" : "medium", scope: "subagent", vendor: "claude", runId: RUN_ID, scopeId: s.id,
    title: "Fat subagent handoff", count: 1,
    whyItMatters: `A subagent exists to isolate context; ${s.agentType} returned ${s.handoff.tokens.value.toLocaleString()} tokens (${Math.round((s.handoff.tokens.value / s.peak.value) * 100)}% of its own peak) into the parent window.`,
    evidence: [
      { kind: "block", ref: `${RUN_ID}#${s.handoff.blockId}`, label: `handoff block #${s.handoff.blockId}`, value: s.handoff.tokens.value, unit: "tokens", provenance: "observed.artifact" },
      { kind: "scope", ref: `${RUN_ID}#${s.id}`, label: "child peak", value: s.peak.value, unit: "tokens", provenance: "observed.vendor" },
      { kind: "request", ref: `${RUN_ID}#main#${s.deliveredAtRequest}`, label: `delivered at request ${s.deliveredAtRequest}`, provenance: "derived.exact" },
      { kind: "metric", ref: "ratio", label: "compression ratio", value: s.handoff.compressionRatio.value, unit: "ratio", provenance: "derived.exact" },
    ],
    fix: { platform: "claude", summary: "Constrain the subagent's return format in its agent definition.", snippet: "Return findings only: file:line references, decisions, and open questions. Under 600 words.", path: `.claude/agents/${s.agentType}.md` },
    thresholdKeys: ["fatHandoffTokens", "fatHandoffShare"], tokensAffected: s.handoff.tokens.value,
  });
}
{
  const hot = main.requests.filter((r) => r.usage.total > 0.8 * WINDOW);
  if (hot.length >= 10) findings.push({
    id: `B-08:${hex(10)}`, ruleId: "B-08", severity: "high", scope: "session", vendor: "claude", runId: RUN_ID, scopeId: "main",
    title: "Running hot", count: 1,
    whyItMatters: `${hot.length} requests ran above 80% of the ${WINDOW.toLocaleString()}-token window; every request there resends nearly the whole window and compaction is one tool result away.`,
    evidence: [{ kind: "request", ref: `${RUN_ID}#main#${hot[0].index}`, label: `first hot request ${hot[0].index}`, value: hot[0].usage.total, unit: "tokens", provenance: "observed.vendor" }, { kind: "metric", ref: "count", label: "requests above 80% of window", value: hot.length, unit: "count", provenance: "derived.exact" }],
    fix: { platform: "claude", summary: "Compact or start a fresh session at phase boundaries; fix the fat results first.", snippet: "/compact focus on the remaining steps", path: undefined },
    thresholdKeys: ["runningHotShare", "runningHotRequests"], tokensAffected: hot.reduce((x, r) => x + r.usage.total, 0),
  });
  const fatShell = main.blocks.filter((b) => b.category === "tool_result.shell").sort((a, b) => b.estTokens - a.estTokens)[0];
  const c0 = main.compactions[0];
  if (fatShell && c0) findings.push({
    id: `B-13:${hex(10)}`, ruleId: "B-13", severity: "low", scope: "session", vendor: "claude", runId: RUN_ID, scopeId: "main",
    title: "Compaction landed while a large shell output was still hot", count: 1,
    whyItMatters: `The first compaction dropped ${c0.droppedTokens.value.toLocaleString()} tokens; ${fatShell.estTokens.toLocaleString()} of them were one shell output (${fatShell.label}) that could have been truncated at the source.`,
    evidence: [
      { kind: "request", ref: `${RUN_ID}#main#${c0.atRequest}`, label: `compaction before request ${c0.atRequest}`, value: c0.preTokens.value, unit: "tokens", provenance: "observed.vendor" },
      { kind: "block", ref: `${RUN_ID}#${fatShell.id}`, label: `Bash ${fatShell.label}`, value: fatShell.estTokens, unit: "tokens", provenance: "estimated.local" },
    ],
    fix: { platform: "both", summary: "Pipe long-running commands through `tail -n 200` or write output to a file and read the summary.", snippet: "npm test 2>&1 | tail -n 200" },
    thresholdKeys: ["compactionHotBlockTokens"], tokensAffected: fatShell.estTokens,
  });
  if (main.compactions.length >= 3) findings.push({
    id: `B-07:${hex(10)}`, ruleId: "B-07", severity: "high", scope: "session", vendor: "claude", runId: RUN_ID, scopeId: "main", title: "Frequent compaction", count: 1,
    whyItMatters: `${main.compactions.length} compaction boundaries in one session; the model rebuilt its working set ${main.compactions.length} times.`,
    evidence: main.compactions.slice(0, 3).map((c) => ({ kind: "request", ref: `${RUN_ID}#main#${c.atRequest}`, label: `${c.trigger} compaction before request ${c.atRequest}`, value: c.preTokens.value, unit: "tokens", provenance: "observed.vendor" })),
    fix: { platform: "claude", summary: "Split the task and fix the fat results first.", snippet: "Start a fresh session per task (/clear), delegate exploration to subagents." },
    thresholdKeys: ["compactionsPerSession", "compactionsPerHour"], tokensAffected: main.compactions.reduce((x, c) => x + c.droppedTokens.value, 0),
  });
}
if (STRESS) {
  const kids = scopes.filter((s) => s.depth === 1);
  for (let i = 0; i + 1 < kids.length && findings.filter((f) => f.ruleId === "B-15").length < 80; i += 2) {
    findings.push({
      id: `B-15:${hex(10)}`, ruleId: "B-15", severity: "low", scope: "subagent", vendor: "claude", runId: RUN_ID, scopeId: kids[i].id, title: "Parallel subagents duplicated work", count: ri(2, 6),
      whyItMatters: `${kids[i].agentType} (${kids[i].id}) and ${kids[i + 1].agentType} (${kids[i + 1].id}) read the same files.`,
      evidence: [{ kind: "scope", ref: `${RUN_ID}#${kids[i].id}`, label: `${kids[i].id} (${kids[i].agentType})`, value: 4, unit: "count", provenance: "observed.artifact" }, { kind: "scope", ref: `${RUN_ID}#${kids[i + 1].id}`, label: `${kids[i + 1].id} (${kids[i + 1].agentType})`, value: 4, unit: "count", provenance: "observed.artifact" }],
      fix: { platform: "claude", summary: "Give each subagent a disjoint scope in the delegation prompt.", snippet: "Agent A: only packages/cli/**. Agent B: only packages/ui/**." },
      thresholdKeys: ["parallelDuplicateFiles"], tokensAffected: ri(3_000, 12_000),
    });
  }
  for (const s of scopes.filter((s) => s.blocks.some((b) => b.category === "tool_result.file" && b.estTokens >= 15_000)).slice(0, 42)) {
    const b = s.blocks.filter((b) => b.category === "tool_result.file").sort((x, y) => y.estTokens - x.estTokens)[0];
    findings.push({ id: `B-03:${hex(10)}`, ruleId: "B-03", severity: b.estTokens >= 50_000 ? "high" : "medium", scope: s.kind === "main" ? "session" : "subagent", vendor: "claude", runId: RUN_ID, scopeId: s.id, title: "Huge file read", count: 1, whyItMatters: `A single Read of ${b.label} added ${b.estTokens.toLocaleString()} tokens.`, evidence: [blockEvidence(b)], fix: { platform: "claude", summary: "Read only the sections you need.", snippet: "Read with offset/limit, or sed -n 1,120p <file>." }, thresholdKeys: ["hugeFileReadTokens"], tokensAffected: b.estTokens });
  }
  findings.push({ id: `B-02:${hex(10)}`, ruleId: "B-02", severity: "high", scope: "session", vendor: "claude", runId: RUN_ID, scopeId: "main", title: "Repeated fat results", count: findings.filter((f) => f.ruleId === "B-01").reduce((x, f) => x + f.count, 0), whyItMatters: "The same tools keep returning fat results across scopes; this is a habit, not a one-off.", evidence: [{ kind: "metric", ref: "count", label: "fat results across scopes", value: findings.filter((f) => f.ruleId === "B-01").length, unit: "count", provenance: "derived.exact" }], fix: { platform: "claude", summary: "Prefer targeted reads.", snippet: "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000.", path: "CLAUDE.md" }, thresholdKeys: ["repeatedFatResultTokens", "repeatedFatResultCount"], tokensAffected: findings.filter((f) => f.ruleId === "B-01").reduce((x, f) => x + f.tokensAffected, 0) });
}
const SEV = { high: 3, medium: 2, low: 1 };
findings.sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || ((b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)) || a.id.localeCompare(b.id));
for (const f of findings) if (f.fix.path === undefined) delete f.fix.path;

// ---------- output shapes ----------
const strip = ({ endMs, clamped, ...s }) => s;
const summaryOf = (s) => {
  const { requests, blocks, ...rest } = strip(s);
  return { ...rest, partial: true, requestCount: requests.length, blockCount: blocks.length, topBlocks: topBlocksOf(s, 5) };
};

const run = {
  id: RUN_ID, vendor: "claude", sessionId: SESSION_ID,
  project: { key: "-Users-me-contextscope", displayName: "contextscope", cwdHash: hex(16), cwdDisplay: "~/projects/contextscope" },
  startedAt, endedAt, activeMs, cliVersion: "2.1.258", gitBranch: "main", entrypoint: "cli",
  window: M(WINDOW, "estimated.local"),
  scopes: [strip(main), ...scopes.slice(1).map(summaryOf)],
  summary: {
    requests: totalRequests, turns: main.requests[main.requests.length - 1].turn, processedInputTokens: sumTotal, outputTokens: scopes.reduce((s, sc) => s + sc.outputTokens, 0),
    cacheReadShare: Number((sumCacheRead / sumTotal).toFixed(3)), peak: main.peak, peakShareOfWindow: Number((main.peak.value / WINDOW).toFixed(3)),
    compactions: main.compactions.length, subagents: scopes.length - 1, toolCalls: scopes.reduce((s, sc) => s + sc.toolCalls, 0), models: [...new Set(scopes.flatMap((s) => s.models))],
    topBlocks, findingIds: findings.map((f) => f.id), compositionAtPeak: peakReq.composition,
  },
  coverage: { records: totalRequests * 3 + 12, unparsedRecords: 3, unparsedTypes: { "custom-title": 2, "file-history-snapshot": 1 }, requests: totalRequests, syntheticRecordsSkipped: 41, estimatorErrorMedian: main.estimatorErrorMedian, estimatorErrorP95: main.estimatorErrorP95, adapterVersion: "claude-v1", estimatorVersion: "chars-v2" },
  source: { file: `~/.claude/projects/-Users-me-contextscope/${SESSION_ID}.jsonl`, bytes: 3_912_884, mtimeMs: Date.parse(endedAt), subagentFiles: scopes.length - 1 },
  findings,
};
const scopesById = Object.fromEntries(scopes.map((s) => [s.id, strip(s)]));

await mkdir(path.dirname(outRun), { recursive: true });
await writeFile(outRun, JSON.stringify(run));
await writeFile(outScopes, JSON.stringify(scopesById));
const kb = (o) => Math.round(Buffer.byteLength(JSON.stringify(o)) / 1024);
console.log(`wrote ${outRun} (${kb(run)} KB) + scopes (${kb(scopesById)} KB): ${main.requests.length} main requests, ${scopes.length - 1} subagents, ${main.compactions.length} compactions, peak ${main.peak.value}, main p95 error ${main.estimatorErrorP95}, unlogged ${Math.round(main.unloggedShare * 100)}%, ${findings.length} findings`);
