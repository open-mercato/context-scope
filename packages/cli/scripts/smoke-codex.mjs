#!/usr/bin/env node
/**
 * Smoke-test the Codex adapter on real rollouts. Prints numbers only: no
 * message text, tool output, prompt text, or absolute paths.
 *
 *   node scripts/smoke-codex.mjs <rollout.jsonl> [more.jsonl ...]
 *   node scripts/smoke-codex.mjs --largest 3     # 3 largest files under ~/.codex/sessions
 *   node scripts/smoke-codex.mjs --all           # every file under ~/.codex/sessions (summary table)
 */
import os from "node:os";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { parseCodexRollout } from "../src/adapters/codex.mjs";
import { percentile } from "../src/ir/reconcile.mjs";

const args = process.argv.slice(2);
const home = os.homedir();

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let info;
    try { info = statSync(full); } catch { continue; }
    if (info.isDirectory()) walk(full, out);
    else if (entry.endsWith(".jsonl")) out.push({ path: full, size: info.size });
  }
  return out;
}

function pickFiles() {
  const sessions = path.join(home, ".codex", "sessions");
  if (args.includes("--largest")) {
    const n = Number(args[args.indexOf("--largest") + 1]) || 3;
    return walk(sessions).sort((a, b) => b.size - a.size).slice(0, n).map((f) => f.path);
  }
  if (args.includes("--all")) return walk(sessions).sort((a, b) => b.size - a.size).map((f) => f.path);
  return args.filter((arg) => !arg.startsWith("--"));
}

function mb(bytes) { return (bytes / 1_048_576).toFixed(1); }
function pct(value) { return `${(value * 100).toFixed(1)}%`; }

async function smoke(filePath, { verbose }) {
  const startedAt = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  const run = await parseCodexRollout(filePath, { home });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const rssAfter = process.memoryUsage().rss;
  const scope = run.scopes[0];
  const byCategory = {};
  for (const block of scope.blocks) {
    const entry = (byCategory[block.category] ??= { count: 0, estTokens: 0 });
    entry.count += 1;
    entry.estTokens += block.estTokens;
  }
  const line = {
    file: run.source.file.replace(/rollout-[^/]*$/, (name) => name.slice(0, 26) + "…"),
    mb: mb(run.source.bytes),
    records: run.coverage.records,
    requests: run.summary.requests,
    peak: scope.peak.value,
    window: `${run.window.value} (${run.window.provenance})`,
    peakShare: pct(run.summary.peakShareOfWindow),
    compactions: run.summary.compactions,
    truncated: run.coverage.truncatedOutputs,
    errMedian: pct(run.coverage.estimatorErrorMedian),
    errP95: pct(run.coverage.estimatorErrorP95),
    ms: elapsedMs.toFixed(0),
    rssMb: mb(rssAfter),
  };
  if (!verbose) return line;
  console.log(`\n== ${line.file}  ${line.mb} MB, ${line.records} records, cli ${run.cliVersion ?? "?"}, entry ${run.entrypoint}, kind ${run.kind}`);
  console.log(`   requests ${line.requests}  turns ${run.summary.turns}  peak ${line.peak} / ${line.window} = ${line.peakShare}  processed ${run.summary.processedInputTokens}  cacheReadShare ${pct(run.summary.cacheReadShare)}`);
  console.log(`   compactions ${line.compactions}: ${scope.compactions.map((c) => `${c.id}@r${c.atRequest} pre ${c.preTokens.value} post ${c.postTokens.value} dropped ${c.droppedTokens.value} (${c.trigger})`).join("; ") || "-"}`);
  console.log(`   coverage: unparsed ${run.coverage.unparsedRecords} ${JSON.stringify(run.coverage.unparsedTypes)}  synthetic skipped ${run.coverage.syntheticRecordsSkipped}  unresolved handoffs ${run.coverage.unresolvedHandoffs}  truncated outputs ${line.truncated}`);
  console.log(`   estimator error median ${line.errMedian} p95 ${line.errP95}  parse ${line.ms} ms  rss ${mb(rssBefore)} -> ${line.rssMb} MB`);
  const instructionBlocks = scope.blocks.filter((b) => b.category === "instructions" || b.category === "system" || b.category === "skills");
  console.log(`   hidden/instruction blocks: ${instructionBlocks.map((b) => `${b.label ?? b.category}=${b.estTokens}@r${b.firstRequest}`).join(", ") || "-"}`);
  console.log(`   baseInstructionsTokens ${run.baseInstructionsTokens}  instructionsObserved ${run.instructionsObserved?.chars ?? "-"} chars  spawned ${run.spawnedThreadIds.length}  parent ${run.parentThreadId ? "yes" : "no"}`);
  console.log("   blocks by category (count / est tokens):");
  for (const [category, entry] of Object.entries(byCategory).sort((a, b) => b[1].estTokens - a[1].estTokens)) {
    console.log(`     ${category.padEnd(22)} ${String(entry.count).padStart(6)} ${String(entry.estTokens).padStart(10)}`);
  }
  console.log("   top blocks: " + run.summary.topBlocks.slice(0, 6).map((b) => `${b.category}${b.tool ? `/${b.tool}` : ""}=${b.estTokens}@r${b.firstRequest}`).join(", "));
  const toolKinds = {};
  for (const block of scope.blocks) if (block.category === "tool_call") toolKinds[block.tool.kind] = (toolKinds[block.tool.kind] ?? 0) + 1;
  console.log(`   tool call kinds: ${JSON.stringify(toolKinds)}  targets resolved ${scope.blocks.filter((b) => b.category === "tool_call" && b.tool.target).length}`);
  const first = scope.requests[0];
  const peakRequest = scope.requests.find((r) => r.usage.total === scope.peak.value);
  if (first) console.log(`   request 0: total ${first.usage.total} H ${first.hiddenBase.value} scale ${first.scale}`);
  if (peakRequest) console.log(`   peak request ${peakRequest.index}: H ${peakRequest.hiddenBase.value} scale ${peakRequest.scale} composition ${JSON.stringify(peakRequest.composition)}`);
  const scales = scope.requests.map((r) => r.scaleRaw ?? r.scale);
  console.log(`   scaleRaw k: min ${Math.min(...scales).toFixed(3)} p50 ${percentile(scales, 50).toFixed(3)} max ${Math.max(...scales).toFixed(3)}  clamped ${scope.clampedRequests}  unloggedShare ${pct(scope.unloggedShare ?? 0)}  baseSteps ${JSON.stringify(scope.baseSteps ?? [])}  transcriptIncomplete ${scope.transcriptIncomplete}`);
  if (run.handoffsByThread) console.log(`   handoffsByThread: ${Object.entries(run.handoffsByThread).map(([id, h]) => `${id.slice(0, 8)}… ${h.tokens.value} tok @r${h.deliveredAtRequest}${h.launchedAtRequest !== undefined ? ` launched@r${h.launchedAtRequest}` : ""}`).join("; ")}`);
  return line;
}

const files = pickFiles();
if (!files.length) { console.error("usage: smoke-codex.mjs <file.jsonl> ... | --largest N | --all"); process.exit(1); }
const verbose = !args.includes("--all");
const rows = [];
for (const file of files) {
  try { rows.push(await smoke(file, { verbose })); }
  catch (error) { rows.push({ file: path.basename(file).slice(0, 26), error: error.message.slice(0, 120) }); if (verbose) console.error(`!! ${path.basename(file)}: ${error.stack}`); }
}
if (!verbose) console.table(rows);
