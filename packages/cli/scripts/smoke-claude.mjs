#!/usr/bin/env node
/**
 * Smoke test for the Claude adapter on a real session. Prints numbers only:
 *   node packages/cli/scripts/smoke-claude.mjs <main .jsonl> [--json] [--delta]
 * --delta prints the per-category deltaCheck summary used to tune the estimator.
 */
import { parseClaudeSession } from "../src/adapters/claude.mjs";
import { percentile } from "../src/ir/reconcile.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: smoke-claude.mjs <main .jsonl> [--json] [--delta]"); process.exit(2); }
const wantJson = args.includes("--json");
const wantDelta = args.includes("--delta");

const t0 = process.hrtime.bigint();
const run = await parseClaudeSession(file);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const rss = process.memoryUsage().rss / (1024 * 1024);
const main = run.scopes[0];

if (wantJson) { console.log(JSON.stringify(run)); process.exit(0); }

const n = (x) => (typeof x === "number" ? x.toLocaleString("en-US") : String(x));
console.log(`session ${run.sessionId}  project ${run.project.key}  version ${run.cliVersion ?? "?"}  model(s) ${run.summary.models.join(",")}`);
console.log(`window ${n(run.window.value)} (${run.window.provenance})  records ${n(run.coverage.records)}  unparsed ${run.coverage.unparsedRecords}  synthetic ${run.coverage.syntheticRecordsSkipped}  transcriptOnly ${run.coverage.transcriptOnlyRecordsSkipped ?? 0}`);
console.log(`requests ${n(main.requests.length)} (all scopes ${n(run.coverage.requests)})  turns ${run.summary.turns}  blocks ${n(main.blocks.length)}  toolCalls ${n(run.summary.toolCalls)}`);
console.log(`peak ${n(main.peak.value)} (${(run.summary.peakShareOfWindow * 100).toFixed(1)}% of window)  processed ${n(run.summary.processedInputTokens)}  output ${n(run.summary.outputTokens)}  cacheReadShare ${(run.summary.cacheReadShare * 100).toFixed(1)}%  activeMs ${n(run.activeMs)}`);
console.log(`compactions ${main.compactions.length}`);
for (const c of main.compactions) {
  console.log(`  ${c.id} ${c.trigger} atRequest ${c.atRequest} pre ${n(c.preTokens.value)} post ${n(c.postTokens.value)} dropped ${n(c.droppedTokens.value)} summaryBlock ${c.summaryBlockId ?? "-"} preserved ${c.preservedMessages ?? "-"}`);
}
console.log(`subagents ${run.scopes.length - 1} (files ${run.source.subagentFiles})`);
for (const s of run.scopes.slice(1)) {
  const h = s.handoff;
  console.log(`  ${s.id} ${s.agentType ?? "?"} depth ${s.depth} parent ${s.parentScopeId} launched@${s.launchedAtRequest ?? "-"} delivered@${s.deliveredAtRequest ?? "-"} status ${s.status} requests ${s.requests.length} peak ${n(s.peak.value)} handoff ${h ? n(h.tokens.value) : "-"} ratio ${h ? h.compressionRatio.value : "-"}`);
}
console.log(`main estimator error median ${(main.estimatorErrorMedian * 100).toFixed(1)}%  p95 ${(main.estimatorErrorP95 * 100).toFixed(1)}%  clamped ${main.clampedRequests}/${main.requests.length}  unloggedShare ${(main.unloggedShare * 100).toFixed(1)}%  resumed ${main.resumed}  baseSteps ${JSON.stringify(main.baseSteps)}`);
const r0 = main.requests[0];
if (r0) console.log(`request 0: total ${n(r0.usage.total)} system ${n(r0.composition.system ?? 0)} instructions ${n(r0.composition.instructions ?? 0)} unlogged ${n(r0.composition.unlogged ?? 0)}`);
{
  const k = main.requests.map((r) => r.scaleRaw).filter((x) => typeof x === "number");
  console.log(`main scaleRaw p5 ${percentile(k, 5).toFixed(2)} p50 ${percentile(k, 50).toFixed(2)} p95 ${percentile(k, 95).toFixed(2)} max ${Math.max(...k).toFixed(2)}  rebased ${main.requests.filter((r) => r.reconciled === "rebased").length}`);
  for (const c of main.compactions) { const r = main.requests[c.atRequest]; if (r) console.log(`  segment @${c.atRequest}: H ${n(r.hiddenBase.value)} (system ${n(r.composition.system ?? 0)} unlogged ${n(r.composition.unlogged ?? 0)})`); }
  const subs = run.scopes.slice(1);
  const stepped = subs.filter((s) => s.baseSteps?.length);
  const subK = subs.flatMap((s) => s.requests.map((r) => r.scaleRaw)).filter((x) => typeof x === "number");
  const subErr = subs.map((s) => s.estimatorErrorP95).filter((x) => typeof x === "number");
  if (subs.length) console.log(`subagents: ${stepped.length}/${subs.length} with baseSteps (${stepped.filter((s) => s.baseSteps[0].atRequest === 1).length} at request 1)  scaleRaw p95 ${percentile(subK, 95).toFixed(2)}  per-scope error p95 median ${(percentile(subErr, 50) * 100).toFixed(1)}%  clamped ${subs.reduce((a, s) => a + (s.clampedRequests ?? 0), 0)}/${subK.length}`);
  const steppedK = stepped.flatMap((s) => s.requests.map((r) => r.scaleRaw)).filter((x) => typeof x === "number");
  if (stepped.length) console.log(`  stepped subagents scaleRaw p95 ${percentile(steppedK, 95).toFixed(2)}  steps ${stepped.map((s) => s.baseSteps.map((b) => b.delta).join("/")).join(", ")}`);
}
console.log("top blocks:");
for (const b of run.summary.topBlocks.slice(0, 5)) console.log(`  ${b.id} ${b.category} ${b.tool ?? ""} ${n(b.estTokens)} tokens @${b.firstRequest}`);
console.log(`unparsed types ${JSON.stringify(run.coverage.unparsedTypes)}  ignored ${JSON.stringify(run.coverage.ignoredTypes ?? {})}`);
console.log(`mcp tools observed ${run.mcpToolsObserved?.length ?? 0}  tokenBudget ${run.tokenBudget ? `${n(run.tokenBudget.max)} -> ${n(run.tokenBudget.last)}` : "-"}`);
console.log(`time ${ms.toFixed(0)} ms  peak RSS ${rss.toFixed(0)} MB`);

if (wantDelta) {
  // Per-request residual (input + cacheCreation) - est(new blocks), bucketed by the dominant new-block category.
  for (const scope of run.scopes) {
    const byCat = {};
    const blocks = new Map(scope.blocks.map((b) => [b.id, b]));
    for (const r of scope.requests) {
      if (r.deltaCheck === undefined) continue;
      const added = r.newBlockIds.map((id) => blocks.get(id)).filter((b) => b && b.category !== "assistant_thinking");
      if (!added.length) continue;
      const est = added.reduce((s, b) => s + b.estTokens, 0);
      if (est < 200) continue;
      const dominant = added.reduce((a, b) => (b.estTokens > a.estTokens ? b : a));
      const key = dominant.category + (dominant.tool ? `(${dominant.tool.name})` : dominant.attachmentType ? `(${dominant.attachmentType})` : "");
      const actual = r.usage.input + r.usage.cacheCreation;
      (byCat[key] ??= []).push(actual / est);
    }
    const rows = Object.entries(byCat).filter(([, v]) => v.length >= 3).map(([k, v]) => [k, v.length, percentile(v, 50), percentile(v, 10), percentile(v, 90)]).sort((a, b) => b[1] - a[1]);
    if (rows.length) console.log(`delta ratios (actual/est) for scope ${scope.id}:`);
    for (const [k, count, p50, p10, p90] of rows) console.log(`  ${k.padEnd(40)} n=${String(count).padStart(4)}  p50 ${p50.toFixed(2)}  p10 ${p10.toFixed(2)}  p90 ${p90.toFixed(2)}`);
  }
}
