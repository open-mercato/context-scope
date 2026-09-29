#!/usr/bin/env node
/**
 * Re-derives the estimator constants from an existing index (ADR-002 F, ADR-003 section 9).
 * Reads ~/.contextscope/index/v1/manifest.json and the run files it lists
 * (<runDir>/shell.json + <runDir>/scopes/*.json); needs no transcript content:
 * blocks carry `bytes`, requests carry `input + cacheCreation` (Claude) or the
 * reconcile `scaleRaw` (Codex). Prints numbers only.
 *
 *   node packages/cli/scripts/calibrate.mjs [--home <dir>] [--json] [--min-bytes 400] [--ref id,id,id]
 *
 * Claude, per-category slopes: per request (not a segment start, cacheCreation
 * present) the vendor charges input + cacheCreation for the blocks that became
 * visible at that request. Requests whose new blocks are >= 90% one category
 * give that category's slope: bytes / (charged - envelope * blocks).
 *
 * Claude, envelope fit (ADR-003): over MAIN scopes only, a trimmed least-squares
 * fit of   charged ≈ bytes_code / bpt_code + bytes_prose / bpt_prose + b × blocks + c
 * where `blocks` counts new blocks in envelope categories; `b` is the per-block
 * envelope the estimator applies (calibration.json `envelopeTokens`), `c` the
 * per-request mass no block explains (which the estimator cannot express; it
 * is reported, not applied). Candidates are then replayed on the reference
 * sessions (`--ref`, default: the three ADR-003 sessions) by recomputing every
 * block's estTokens and running reconcileScope on a clone of the main scope,
 * reporting k p50 (scaleRaw) and the estimator error median / p95 before and
 * after. Constants change only when the fitted per-block envelope differs from
 * the current one by > 30% AND moves the reference k p50 toward 1.00.
 *
 * Codex: scaleRaw p50 per dominant new-block category (rollouts flagged
 * transcriptIncomplete or with requestsWithoutNewBlocks > 20% are excluded,
 * as are subagent runs with a fork bootstrap).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CALIBRATION, systemBaselineFor } from "../src/ir/estimate.mjs";
import { percentile, reconcileScope } from "../src/ir/reconcile.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const home = flag("--home", os.homedir());
const wantJson = args.includes("--json");
const MIN_BYTES = Number(flag("--min-bytes", 400));
const REF_IDS = String(flag("--ref", "cc87cfe5,5ca0d315,9f2e3d73")).split(",").map((id) => id.trim()).filter(Boolean);
const root = path.join(home, ".contextscope", "index", "v1");

let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")); }
catch { console.error("no index at ~/.contextscope/index/v1 (run `contextscope index` first)"); process.exit(2); }

const CLAUDE = CALIBRATION.vendors.claude;
const ENVELOPE = CLAUDE.envelopeTokens;
const ENVELOPE_SET = new Set(CLAUDE.envelopeCategories ?? []);
const claude = { sessions: 0, requests: 0, observations: 0, byCategory: {}, envelope: [], kRaw: [], kRawMain: [], fit: [] };
const codex = { rollouts: 0, excluded: 0, requests: 0, byCategory: {}, kRaw: [] };
const refRuns = [];

for (const [absPath, entry] of Object.entries(manifest.files ?? {})) {
  if (entry.error || !entry.vendor) continue;
  const run = readRun(path.join(root, "runs", entry.vendor, sha1(absPath)));
  if (!run) continue;
  if (run.vendor === "claude") {
    calibrateClaude(run);
    if (REF_IDS.some((id) => String(entry.sessionId ?? "").startsWith(id))) refRuns.push({ id: String(entry.sessionId).slice(0, 8), run });
  } else if (run.vendor === "codex") {
    calibrateCodex(run);
  }
}

function sha1(value) { return createHash("sha1").update(String(value)).digest("hex"); }

/** shell.json + every scopes/*.json, in shell order; null when the layout is missing. */
function readRun(runDir) {
  let shell;
  try { shell = JSON.parse(fs.readFileSync(path.join(runDir, "shell.json"), "utf8")); } catch { return null; }
  const scopesDir = path.join(runDir, "scopes");
  const scopes = [];
  try {
    for (const name of fs.readdirSync(scopesDir)) if (name.endsWith(".json")) scopes.push(JSON.parse(fs.readFileSync(path.join(scopesDir, name), "utf8")));
  } catch { return null; }
  const order = new Map((shell.scopes ?? []).map((scope, index) => [scope.id, index]));
  scopes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  if (!scopes.length) return null;
  return { ...shell, scopes };
}

/** Unclamped k: `scaleRaw` (chars-v2 runs) or `scale` (chars-v1 runs never clamped). */
function rawScale(request) { return typeof request.scaleRaw === "number" ? request.scaleRaw : (typeof request.scale === "number" ? request.scale : undefined); }

function segmentStarts(scope) {
  return new Set([0, ...(scope.compactions ?? []).map((c) => c.atRequest)]);
}

function dominant(blocks) {
  const bytesByCat = {};
  let total = 0;
  for (const block of blocks) { bytesByCat[block.category] = (bytesByCat[block.category] ?? 0) + block.bytes; total += block.bytes; }
  const [category, bytes] = Object.entries(bytesByCat).sort((a, b) => b[1] - a[1])[0] ?? [];
  return category && bytes >= 0.9 * total ? { category, bytes: total } : null;
}

function newVisibleBlocks(scope) {
  const byFirst = new Map();
  for (const block of scope.blocks) {
    if (block.category === "assistant_thinking") continue;
    if (block.lastRequest !== undefined && block.lastRequest < block.firstRequest) continue;
    if (!byFirst.has(block.firstRequest)) byFirst.set(block.firstRequest, []);
    byFirst.get(block.firstRequest).push(block);
  }
  return byFirst;
}

function calibrateClaude(run) {
  claude.sessions += 1;
  for (const scope of run.scopes) {
    if (scope.transcriptIncomplete) continue;
    const starts = segmentStarts(scope);
    const byFirst = newVisibleBlocks(scope);
    for (const request of scope.requests) {
      claude.requests += 1;
      if (starts.has(request.index) || request.usage.cacheCreation === undefined) continue;
      const k = rawScale(request);
      if (k !== undefined) { claude.kRaw.push(k); if (scope.kind === "main") claude.kRawMain.push(k); }
      const charged = request.usage.input + request.usage.cacheCreation;
      const blocks = byFirst.get(request.index) ?? [];
      const bytes = blocks.reduce((sum, block) => sum + block.bytes, 0);
      if (bytes < 300 && charged > 0 && charged < 5_000) claude.envelope.push(charged);
      if (scope.kind === "main" && charged > 0) {
        let code = 0;
        let prose = 0;
        let enveloped = 0;
        for (const block of blocks) {
          if (block.kind === "code") code += block.bytes; else prose += block.bytes;
          if (ENVELOPE_SET.has(block.category)) enveloped += 1;
        }
        claude.fit.push({ y: charged, code, prose, blocks: enveloped });
      }
      if (bytes < MIN_BYTES) continue;
      const dom = dominant(blocks);
      if (!dom) continue;
      const tokens = charged - ENVELOPE * blocks.length;
      if (tokens <= 0) continue;
      const key = dom.category + (blocks[0].tool?.name && blocks.every((b) => b.tool?.name === blocks[0].tool.name) ? `(${blocks[0].tool.name})` : "");
      (claude.byCategory[key] ??= []).push(bytes / tokens);
      (claude.byCategory[dom.category] ??= []).push(bytes / tokens);
      claude.observations += 1;
    }
  }
}

function calibrateCodex(run) {
  codex.rollouts += 1;
  const scope = run.scopes[0];
  const n = scope.requests.length;
  const noNew = run.coverage?.requestsWithoutNewBlocks ?? 0;
  if (scope.transcriptIncomplete || (n > 0 && noNew / n > 0.2) || run.forkBootstrap) { codex.excluded += 1; return; }
  const starts = segmentStarts(scope);
  const byFirst = newVisibleBlocks(scope);
  for (const request of scope.requests) {
    codex.requests += 1;
    const k = rawScale(request);
    if (starts.has(request.index) || k === undefined) continue;
    codex.kRaw.push(k);
    const blocks = byFirst.get(request.index) ?? [];
    const dom = dominant(blocks);
    if (!dom || dom.bytes < MIN_BYTES) continue;
    (codex.byCategory[dom.category] ??= []).push(k);
  }
}

// ---- envelope fit (main scopes) ------------------------------------------

/** Solves the normal equations of an ordinary least-squares fit; rows are [x..., y]. */
function leastSquares(rows, dims) {
  const A = Array.from({ length: dims }, () => new Array(dims).fill(0));
  const B = new Array(dims).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dims; i += 1) {
      B[i] += row[i] * row[dims];
      for (let j = 0; j < dims; j += 1) A[i][j] += row[i] * row[j];
    }
  }
  // Gaussian elimination with partial pivoting.
  const M = A.map((line, i) => [...line, B[i]]);
  for (let col = 0; col < dims; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < dims; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;
    for (let r = 0; r < dims; r += 1) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= dims; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((line, i) => line[dims] / line[i]);
}

/**
 * Trimmed least squares: fit, drop rows whose residual exceeds 3 × MAD, refit
 * (two rounds), so cache-miss requests (charged = the whole context) do not
 * drive the constants. Returns { bytesPerToken, envelopeTokens, perRequest, rows, used }.
 */
function fitEnvelope(points) {
  let rows = points.filter((p) => p.y > 0 && p.y < 200_000).map((p) => [p.code, p.prose, p.blocks, 1, p.y]);
  const total = rows.length;
  let solution = null;
  for (let round = 0; round < 3 && rows.length >= 50; round += 1) {
    solution = leastSquares(rows, 4);
    if (!solution) break;
    const residuals = rows.map((row) => row[4] - (solution[0] * row[0] + solution[1] * row[1] + solution[2] * row[2] + solution[3]));
    const med = percentile(residuals, 50);
    const mad = percentile(residuals.map((r) => Math.abs(r - med)), 50) || 1;
    const kept = rows.filter((_, i) => Math.abs(residuals[i] - med) <= 3 * 1.4826 * mad);
    if (kept.length === rows.length) break;
    rows = kept;
  }
  if (!solution) return null;
  const [aCode, aProse, perBlock, perRequest] = solution;
  return {
    bytesPerToken: { code: aCode > 0 ? 1 / aCode : null, prose: aProse > 0 ? 1 / aProse : null },
    envelopeTokens: perBlock,
    perRequest,
    rows: total,
    used: rows.length,
  };
}

// ---- replay on the reference sessions ------------------------------------

function estimateWith(block, constants) {
  if (!block.bytes) return 0;
  const bpt = block.kind === "code" ? constants.bytesPerToken.code : constants.bytesPerToken.prose;
  let tokens = Math.ceil(block.bytes / bpt);
  if (ENVELOPE_SET.has(block.category)) tokens += constants.envelopeTokens;
  return tokens;
}

/** Main-scope k p50 and estimator error under a candidate set of constants (the stored run is never modified). */
function replay(run, constants) {
  const main = structuredClone(run.scopes[0]);
  const current = { bytesPerToken: CLAUDE.bytesPerToken, envelopeTokens: ENVELOPE };
  for (const block of main.blocks) {
    // Whatever the stored estimate carried beyond the text estimate (image tokens) is kept.
    const extra = Math.max(0, block.estTokens - estimateWith(block, current));
    block.estTokens = estimateWith(block, constants) + extra;
  }
  reconcileScope(main, { vendor: "claude", window: run.window?.value, systemBaseline: systemBaselineFor("claude") });
  const starts = segmentStarts(main);
  const k = main.requests.filter((r) => !starts.has(r.index) && typeof r.scaleRaw === "number").map((r) => r.scaleRaw);
  return { kP50: round(percentile(k, 50)), errorMedian: round(main.estimatorErrorMedian ?? 0), errorP95: round(main.estimatorErrorP95 ?? 0), requests: main.requests.length };
}

const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const stats = (values) => ({ n: values.length, p10: round(percentile(values, 10)), p50: round(percentile(values, 50)), p90: round(percentile(values, 90)) });
const errs = (values) => values.map((k) => Math.abs(1 - k)).filter((e) => e <= 0.5);

const slopeRows = Object.entries(claude.byCategory).filter(([, v]) => v.length >= 20).map(([k, v]) => [k, stats(v)]).sort((a, b) => b[1].n - a[1].n);
const codeCats = ["tool_call", "tool_result.file", "tool_result.shell", "tool_result.search", "tool_result.other"];
const pooled = (keys) => keys.flatMap((k) => claude.byCategory[k] ?? []);
const codeSlope = percentile(pooled(codeCats), 50);
const proseSlope = percentile(pooled(["user", "assistant_text", "attachments", "skills", "subagent_handoff", "tool_result.web"]), 50);

const fit = fitEnvelope(claude.fit);
const currentConstants = { bytesPerToken: CLAUDE.bytesPerToken, envelopeTokens: ENVELOPE };
const candidates = { current: currentConstants };
if (fit && Number.isFinite(fit.envelopeTokens)) {
  candidates.fittedEnvelope = { bytesPerToken: CLAUDE.bytesPerToken, envelopeTokens: Math.max(0, Math.round(fit.envelopeTokens)) };
  if (fit.bytesPerToken.code && fit.bytesPerToken.prose) {
    candidates.fittedJoint = { bytesPerToken: { code: round(fit.bytesPerToken.code, 2), prose: round(fit.bytesPerToken.prose, 2) }, envelopeTokens: candidates.fittedEnvelope.envelopeTokens };
  }
}
const replays = {};
for (const [name, constants] of Object.entries(candidates)) {
  replays[name] = { constants, sessions: {} };
  for (const { id, run } of refRuns) replays[name].sessions[id] = replay(run, constants);
  const ks = Object.values(replays[name].sessions).map((s) => s.kP50);
  replays[name].meanAbsKError = ks.length ? round(ks.reduce((sum, k) => sum + Math.abs(1 - k), 0) / ks.length) : null;
}
const envelopeDelta = fit && ENVELOPE > 0 ? round(Math.abs(fit.envelopeTokens - ENVELOPE) / ENVELOPE) : null;
const improves = replays.fittedEnvelope && replays.current.meanAbsKError !== null && replays.fittedEnvelope.meanAbsKError < replays.current.meanAbsKError;
const recommendation = !fit ? "no fit (too few main-scope requests)"
  : envelopeDelta !== null && envelopeDelta > 0.3 && improves ? `update envelopeTokens ${ENVELOPE} -> ${candidates.fittedEnvelope.envelopeTokens} (bump calibrationVersion)`
    : envelopeDelta !== null && envelopeDelta > 0.3 ? `fitted envelope differs by ${Math.round(envelopeDelta * 100)}% but does not move the reference k p50 toward 1.00: keep ${ENVELOPE}`
      : `fitted envelope within 30% of ${ENVELOPE}: keep`;

const claudeMeasured = {
  at: new Date().toISOString().slice(0, 10),
  method: "deltaCheck slope: (input + cacheCreation) vs bytes of new visible blocks, per dominant category, segment starts excluded; envelope: trimmed least squares over main scopes, replayed on the reference sessions",
  sessions: claude.sessions,
  requests: claude.requests,
  observations: claude.observations,
  envelopeTokensPerRequest: round(percentile(claude.envelope, 50), 0),
  bytesPerTokenByCategory: Object.fromEntries(slopeRows.map(([k, s]) => [k, s.p50])),
  slopeBytesPerToken: { code: round(codeSlope, 2), prose: round(proseSlope, 2) },
  currentBytesPerToken: CLAUDE.bytesPerToken,
  currentEnvelopeTokens: ENVELOPE,
  scaleRawWithCurrentConstants: stats(claude.kRaw),
  scaleRawMainScopes: stats(claude.kRawMain),
  proposedBytesPerToken: { code: round(CLAUDE.bytesPerToken.code / (percentile(claude.kRawMain, 50) || 1), 2), prose: round(CLAUDE.bytesPerToken.prose / (percentile(claude.kRawMain, 50) || 1), 2) },
  resultingError: { median: round(percentile(errs(claude.kRaw), 50)), p95: round(percentile(errs(claude.kRaw), 95)) },
  envelopeFit: fit ? { rows: fit.rows, used: fit.used, envelopeTokensPerBlock: round(fit.envelopeTokens, 1), perRequestTokens: round(fit.perRequest, 1), bytesPerToken: { code: round(fit.bytesPerToken.code, 2), prose: round(fit.bytesPerToken.prose, 2) }, deltaVsCurrent: envelopeDelta } : null,
  referenceSessions: replays,
  recommendation,
};
const codexMeasured = {
  at: claudeMeasured.at,
  method: "reconcile scaleRaw p50 per dominant new-block category over non-legacy rollouts",
  rollouts: codex.rollouts - codex.excluded,
  excludedRollouts: codex.excluded,
  requests: codex.requests,
  kP50: { current: round(percentile(codex.kRaw, 50)) },
  kP50ByCategory: Object.fromEntries(Object.entries(codex.byCategory).filter(([, v]) => v.length >= 10).map(([k, v]) => [k, round(percentile(v, 50))])),
  currentCategoryScale: CALIBRATION.vendors.codex.categoryScale,
  resultingError: { median: round(percentile(errs(codex.kRaw), 50)), p95: round(percentile(errs(codex.kRaw), 95)) },
};

if (wantJson) { console.log(JSON.stringify({ claude: claudeMeasured, codex: codexMeasured }, null, 2)); process.exit(0); }
console.log(`index ${root.replace(home, "~")}: ${Object.keys(manifest.files ?? {}).length} files`);
console.log(`claude: ${claude.sessions} sessions, ${claude.requests} requests, ${claude.observations} slope observations, tiny-request envelope p50 ${claudeMeasured.envelopeTokensPerRequest} tokens/request`);
for (const [key, s] of slopeRows) console.log(`  ${key.padEnd(36)} n=${String(s.n).padStart(5)}  bytes/token p10 ${s.p10.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p90 ${s.p90.toFixed(2)}`);
console.log(`  per-block slope bytesPerToken code ${claudeMeasured.slopeBytesPerToken.code} prose ${claudeMeasured.slopeBytesPerToken.prose} (current ${JSON.stringify(claudeMeasured.currentBytesPerToken)}, envelope ${ENVELOPE}/block)`);
console.log(`  scaleRaw with current constants: all scopes ${JSON.stringify(claudeMeasured.scaleRawWithCurrentConstants)}  main scopes ${JSON.stringify(claudeMeasured.scaleRawMainScopes)}`);
console.log(`  proposed bytesPerToken (centre main-scope k on 1): code ${claudeMeasured.proposedBytesPerToken.code} prose ${claudeMeasured.proposedBytesPerToken.prose}  error median ${claudeMeasured.resultingError.median} p95 ${claudeMeasured.resultingError.p95}`);
if (fit) {
  console.log(`  envelope fit (main scopes, ${fit.used}/${fit.rows} requests after trimming): per-block ${round(fit.envelopeTokens, 1)} tok (current ${ENVELOPE}, delta ${Math.round((envelopeDelta ?? 0) * 100)}%), per-request ${round(fit.perRequest, 1)} tok, bytesPerToken code ${round(fit.bytesPerToken.code, 2)} prose ${round(fit.bytesPerToken.prose, 2)}`);
  for (const [name, entry] of Object.entries(replays)) {
    const cells = Object.entries(entry.sessions).map(([id, s]) => `${id}: k p50 ${s.kP50} err ${s.errorMedian}/${s.errorP95} (${s.requests} req)`);
    console.log(`  ${name.padEnd(16)} bpt ${entry.constants.bytesPerToken.code}/${entry.constants.bytesPerToken.prose} env ${entry.constants.envelopeTokens}  ${cells.join("  ")}  mean|1-k| ${entry.meanAbsKError}`);
  }
  console.log(`  recommendation: ${recommendation}`);
}
console.log(`codex: ${codexMeasured.rollouts} rollouts (${codex.excluded} excluded), ${codex.requests} requests, k p50 ${codexMeasured.kP50.current}`);
for (const [key, value] of Object.entries(codexMeasured.kP50ByCategory)) console.log(`  ${key.padEnd(36)} k p50 ${value}`);
console.log(`  error median ${codexMeasured.resultingError.median} p95 ${codexMeasured.resultingError.p95}`);
