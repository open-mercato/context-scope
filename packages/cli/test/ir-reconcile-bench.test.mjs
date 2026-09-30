/**
 * ADR-002 D acceptance: the sweep-line visibility is equivalent to a
 * brute-force scan on random scopes, and reconcileScope handles the big
 * session's shape (1,573 requests x 4,599 blocks, 2 compactions) in < 50 ms.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORIES } from "../src/ir/categories.mjs";
import { applyCompactionPresence, reconcileScope, reconcileWithEstimates, sweep } from "../src/ir/reconcile.mjs";
import { finalizeRun } from "../src/ir/finalize.mjs";

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const VISIBLE_CATEGORIES = CATEGORIES.filter((c) => !["system", "instructions", "unlogged"].includes(c));

function randomScope(seed, { requests, blocks, compactions }) {
  const rand = rng(seed);
  const scope = { id: "main", kind: "main", requests: [], blocks: [], compactions: [] };
  let total = 20_000 + Math.floor(rand() * 30_000);
  for (let i = 0; i < requests; i += 1) {
    total = Math.max(1_000, total + Math.floor((rand() - 0.3) * 8_000));
    scope.requests.push({ index: i, at: new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString(), model: "m", turn: 1, usage: { input: 100, cacheCreation: 300, cacheRead: Math.max(0, total - 400), output: 50, total } });
  }
  const boundaries = [];
  for (let c = 0; c < compactions; c += 1) boundaries.push(1 + Math.floor(rand() * (requests - 1)));
  boundaries.sort((a, b) => a - b);
  boundaries.forEach((at, c) => scope.compactions.push({ id: `c${c}`, at: "", atRequest: at, trigger: "auto", preTokens: { value: 0, provenance: "unknown" }, postTokens: { value: 0, provenance: "unknown" }, droppedTokens: { value: 0, provenance: "unknown" } }));
  for (let b = 0; b < blocks; b += 1) {
    const first = Math.floor(rand() * (requests + 1));
    const category = rand() < 0.1 ? "assistant_thinking" : VISIBLE_CATEGORIES[Math.floor(rand() * VISIBLE_CATEGORIES.length)];
    const block = { id: `main:${b}`, seq: b, at: "", category, bytes: 0, estTokens: Math.floor(rand() * 3_000), firstRequest: first, hash: `${b}` };
    const roll = rand();
    if (roll < 0.15) block.lastRequest = first + Math.floor(rand() * 5);
    else if (roll < 0.2) block.lastRequest = first - 1; // empty window
    scope.blocks.push(block);
  }
  for (const compaction of scope.compactions) {
    const summary = { id: `main:s${compaction.id}`, seq: scope.blocks.length, at: "", category: "compaction_summary", bytes: 0, estTokens: 2_000, firstRequest: compaction.atRequest, hash: compaction.id };
    compaction.summaryBlockId = summary.id;
    scope.blocks.push(summary);
    if (rand() < 0.5) { const candidate = scope.blocks[Math.floor(rand() * (scope.blocks.length - 1))]; if (candidate.firstRequest < compaction.atRequest) candidate.preservedBy = compaction.id; }
  }
  return scope;
}

/** Straightforward O(R x B) reference for visibility. */
function bruteForce(scope) {
  const n = scope.requests.length;
  const est = new Float64Array(n);
  const estByCat = [];
  const addAt = Array.from({ length: n + 1 }, () => []);
  const removeAt = Array.from({ length: n + 1 }, () => []);
  const newAt = Array.from({ length: n + 1 }, () => []);
  for (let i = 0; i < n; i += 1) {
    const cat = new Float64Array(CATEGORIES.length);
    for (const block of scope.blocks) {
      if (block.firstRequest === i) newAt[i].push(block);
      if (block.category === "assistant_thinking") continue;
      const visible = block.firstRequest <= i && (block.lastRequest === undefined || block.lastRequest >= i);
      if (!visible) continue;
      cat[CATEGORIES.indexOf(block.category)] += block.estTokens;
      est[i] += block.estTokens;
      if (block.firstRequest === i) addAt[i].push(block);
      if (block.lastRequest === i) removeAt[i + 1].push(block);
    }
    estByCat.push(cat);
  }
  return { est, estByCat, addAt, removeAt, newAt };
}

const clone = (scope) => JSON.parse(JSON.stringify(scope));

test("sweep equals the brute-force reference on random scopes (visibility, composition, errors)", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const requests = 5 + (seed % 37);
    const shape = { requests, blocks: 10 + (seed * 7) % 120, compactions: seed % 4 };
    const a = randomScope(seed, shape);
    const b = clone(a);
    applyCompactionPresence(a);
    applyCompactionPresence(b);
    const fast = sweep(a);
    const slow = bruteForce(b);
    assert.deepEqual([...fast.est], [...slow.est], `seed ${seed}: est`);
    fast.estByCat.forEach((cat, i) => assert.deepEqual([...cat], [...slow.estByCat[i]], `seed ${seed}: estByCat ${i}`));
    fast.addAt.forEach((list, i) => assert.deepEqual(list.map((x) => x.id).sort(), slow.addAt[i].map((x) => x.id).sort(), `seed ${seed}: addAt ${i}`));
    const options = { instructionTokensEstimate: 2_000, systemBaseline: 12_000, window: 200_000, thresholds: { reconcileStepMinTokens: 2_000, reconcileStepWindowShare: 0 } };
    const ra = reconcileWithEstimates(a, fast, options);
    const rb = reconcileWithEstimates(b, slow, options);
    assert.deepEqual(a.requests.map((r) => r.composition), b.requests.map((r) => r.composition), `seed ${seed}: composition`);
    assert.deepEqual(a.requests.map((r) => [r.scale, r.scaleRaw, r.hiddenBase.value, r.baseChange, r.reconciled, r.deltaCheck]), b.requests.map((r) => [r.scale, r.scaleRaw, r.hiddenBase.value, r.baseChange, r.reconciled, r.deltaCheck]), `seed ${seed}: per-request`);
    assert.deepEqual(ra, rb, `seed ${seed}: result`);
    for (const r of a.requests) {
      assert.equal(Object.values(r.composition).reduce((x, y) => x + y, 0), r.usage.total, `seed ${seed}: sums`);
      for (const value of Object.values(r.composition)) assert.ok(value >= 0, `seed ${seed}: non-negative`);
    }
  }
});

test("reconcileScope on 1,573 requests x 4,599 blocks x 2 compactions completes in under 150 ms (best of 3)", () => {
  const scope = randomScope(99, { requests: 1_573, blocks: 4_599, compactions: 2 });
  reconcileScope(clone(scope), { window: 1_000_000 }); // warm-up (JIT)
  const fresh = clone(scope);
  const t0 = process.hrtime.bigint();
  reconcileScope(fresh, { window: 1_000_000, systemBaseline: 25_000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 150, `reconcileScope took ${ms.toFixed(1)} ms`);
  for (const r of fresh.requests) assert.equal(Object.values(r.composition).reduce((x, y) => x + y, 0), r.usage.total);
});

test("a 168-scope synthetic run finalises in under 150 ms (best of 3)", () => {
  const scopes = [randomScope(7, { requests: 400, blocks: 1_500, compactions: 1 })];
  for (let i = 1; i < 168; i += 1) {
    const scope = randomScope(100 + i, { requests: 5 + (i % 40), blocks: 20 + (i % 100), compactions: 0 });
    scope.id = `a${i}`;
    scope.kind = "subagent";
    scope.blocks.forEach((b) => { b.id = `${scope.id}:${b.seq}`; });
    scopes.push(scope);
  }
  const run = { id: "claude:big", vendor: "claude", sessionId: "big", project: { key: "p", displayName: "p", cwdHash: "h" }, startedAt: "", endedAt: "", window: { value: 1_000_000, provenance: "estimated.local" }, coverage: { records: 0, unparsedRecords: 0, unparsedTypes: {}, syntheticRecordsSkipped: 0, adapterVersion: "t" }, source: { file: "x", bytes: 0, mtimeMs: 0, subagentFiles: 167 }, scopes };
  finalizeRun(clone(run)); // warm-up
  const t0 = process.hrtime.bigint();
  const done = finalizeRun(clone(run));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 150, `finalizeRun took ${ms.toFixed(1)} ms`);
  assert.equal(done.summary.subagents, 167);
});
