import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFindingShape, defaultThresholds, evaluateRun, evaluateSetup, loadRules, loadThresholds, rankFindings, severityOrder, validateThresholds, validateRuleModule } from "../src/rules/index.mjs";
import { makeFinding, sha1 } from "../src/rules/util.mjs";
import { makeScenario } from "./fixtures/ir/make-runs.mjs";

const SESSION_RULE_IDS = Array.from({ length: 17 }, (_, i) => `B-${String(i + 1).padStart(2, "0")}`);

async function scratch() {
  return mkdtemp(join(tmpdir(), "contextscope-rules-"));
}

function ruleSource(id, { scope = "session", severity = "medium", body = "return [];" } = {}) {
  return `export default { id: "${id}", scope: "${scope}", severity: "${severity}", title: "${id}", whyItMatters: "why", thresholdKeys: [], evaluate(input, thresholds) { ${body} } };\n`;
}

test("loadRules imports every B-01..B-17 module from the rules dir", async () => {
  const rules = await loadRules({ force: true, onWarning: () => {} });
  const ids = rules.map((rule) => rule.id);
  for (const id of SESSION_RULE_IDS) assert.ok(ids.includes(id), `${id} loaded`);
  for (const rule of rules) validateRuleModule(rule);
  assert.deepEqual(ids, [...ids].sort());
});

test("loadRules tolerates missing and broken modules with a warning", async () => {
  const dir = await scratch();
  await writeFile(join(dir, "B-01.mjs"), ruleSource("B-01"));
  await writeFile(join(dir, "S-01.mjs"), "export default { id: 'S-01' };\n");
  await writeFile(join(dir, "S-02.mjs"), "this is not javascript {{{\n");
  await writeFile(join(dir, "S-03.mjs"), ruleSource("S-03", { scope: "setup" }));
  await writeFile(join(dir, "notes.mjs"), "export default 1;\n");
  const warnings = [];
  const rules = await loadRules({ dir, onWarning: (message) => warnings.push(message) });
  assert.deepEqual(rules.map((rule) => rule.id), ["B-01", "S-03"]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.startsWith("S-01.mjs")));
  assert.ok(warnings.some((w) => w.startsWith("S-02.mjs")));
  const missing = await loadRules({ dir: join(dir, "nope"), onWarning: (message) => warnings.push(message) });
  assert.deepEqual(missing, []);
});

test("assertFindingShape rejects a finding with empty evidence and the engine drops it", async () => {
  const run = makeScenario("quiet");
  const good = makeFinding({ id: "B-01", severity: "high", title: "t", whyItMatters: "w", thresholdKeys: [] }, run, {
    evidence: [{ kind: "metric", ref: `${run.id}#metric:x`, label: "x", value: 1, provenance: "derived.exact" }],
    fix: { platform: "claude", summary: "s" },
  });
  assertFindingShape(good);
  assert.throws(() => assertFindingShape({ ...good, evidence: [] }), /empty evidence/);
  assert.throws(() => assertFindingShape({ ...good, id: "B-01:nothex" }), /bad id/);
  // aggregated findings: count is an integer >= 1 and evidence is capped at 5
  const ev = (n) => Array.from({ length: n }, (_, i) => ({ kind: "metric", ref: `${run.id}#metric:${i}`, label: `m${i}`, value: i, provenance: "derived.exact" }));
  assertFindingShape({ ...good, count: 1 });
  assertFindingShape({ ...good, count: 14, evidence: ev(5), scopeId: "main" });
  assert.throws(() => assertFindingShape({ ...good, count: 0 }), /count must be an integer >= 1/);
  assert.throws(() => assertFindingShape({ ...good, count: 1.5 }), /count must be an integer >= 1/);
  assert.throws(() => assertFindingShape({ ...good, count: 3, evidence: ev(6) }), /max 5/);
  assertFindingShape({ ...good, evidence: ev(9) }); // scalar rules may carry more evidence
  assert.throws(() => assertFindingShape({ ...good, scopeId: "" }), /scopeId/);
  assert.throws(() => assertFindingShape({ ...good, sessions: "3" }), /sessions not finite/);
  assert.throws(() => makeFinding({ id: "B-01", severity: "high", title: "t", whyItMatters: "w", thresholdKeys: [] }, run, { evidence: [], fix: { platform: "claude", summary: "s" } }), /evidence/);

  const dir = await scratch();
  await writeFile(join(dir, "B-01.mjs"), ruleSource("B-01", { body: `return [{ id: "B-01:${sha1("x").slice(0, 10)}", ruleId: "B-01", severity: "high", scope: "session", title: "t", whyItMatters: "w", evidence: [], fix: { platform: "claude", summary: "s" }, thresholdKeys: [] }];` }));
  await writeFile(join(dir, "B-02.mjs"), ruleSource("B-02", { body: "throw new Error('boom');" }));
  const warnings = [];
  const rules = await loadRules({ dir, onWarning: () => {} });
  const findings = await evaluateRun(run, { rules, thresholds: {}, onWarning: (message) => warnings.push(message) });
  assert.deepEqual(findings, []);
  assert.ok(warnings.some((w) => /B-01: dropped finding/.test(w)));
  assert.ok(warnings.some((w) => /B-02: evaluate threw/.test(w)));
});

test("finding ids are ruleId + sha1(primary ref) and are stable", () => {
  const run = makeScenario("B-01-fires");
  const rule = { id: "B-01", severity: "high", title: "t", whyItMatters: "w", thresholdKeys: [] };
  const evidence = [{ kind: "block", ref: `${run.id}#main:51`, label: "b", value: 1, provenance: "estimated.local" }];
  const a = makeFinding(rule, run, { evidence, fix: { platform: "claude", summary: "s" } });
  const b = makeFinding(rule, run, { evidence, fix: { platform: "claude", summary: "s" } });
  assert.equal(a.id, `B-01:${sha1(`${run.id}#main:51`).slice(0, 10)}`);
  assert.equal(a.id, b.id);
});

test("loadThresholds merges session <- setup <- user, ignoring unknown and non-numeric user keys", async () => {
  const dir = await scratch();
  const home = join(dir, "home");
  await mkdir(join(home, ".contextscope"), { recursive: true });
  await writeFile(join(dir, "thresholds.json"), JSON.stringify({ fatToolResultTokens: 8000, shared: 1, onlySession: 5 }));
  await writeFile(join(dir, "thresholds.setup.json"), JSON.stringify({ instructionFileTokens: 3000, shared: 2 }));
  await writeFile(join(home, ".contextscope", "thresholds.json"), JSON.stringify({ shared: 3, fatToolResultTokens: 5000, unknownKey: 1, instructionFileTokens: "nope" }));
  const warnings = [];
  const thresholds = await loadThresholds({ home, dir, onWarning: (message) => warnings.push(message) });
  assert.equal(thresholds.shared, 3);
  assert.equal(thresholds.fatToolResultTokens, 5000);
  assert.equal(thresholds.onlySession, 5);
  assert.equal(thresholds.instructionFileTokens, 3000);
  assert.equal(thresholds.unknownKey, undefined);
  assert.equal(warnings.length, 1);

  const noSetup = await scratch();
  await writeFile(join(noSetup, "thresholds.json"), JSON.stringify({ a: 1 }));
  assert.deepEqual(await loadThresholds({ home: join(noSetup, "nohome"), dir: noSetup, onWarning: () => {} }), { a: 1 });

  const real = await loadThresholds({ home: join(dir, "empty-home"), onWarning: () => {} });
  assert.equal(real.fatToolResultTokens, 8000);
  assert.equal(real.parallelDuplicateFiles, 3);
});

test("every session rule's thresholdKeys exist in the defaults", async () => {
  const defaults = defaultThresholds();
  const rules = await loadRules({ force: true, onWarning: () => {} });
  for (const rule of rules.filter((r) => r.id.startsWith("B-"))) {
    assert.ok(rule.thresholdKeys.length > 0, `${rule.id} declares thresholdKeys`);
    for (const key of rule.thresholdKeys) assert.equal(typeof defaults[key], "number", `${rule.id} key ${key}`);
  }
});

test("validateThresholds rejects unknown keys, NaN, and non-objects", () => {
  const known = { fatToolResultTokens: 8000, fatHandoffShare: 0.4 };
  assert.deepEqual(validateThresholds({ fatToolResultTokens: 6000 }, { known }), { valid: true, errors: [], values: { fatToolResultTokens: 6000 } });
  const bad = validateThresholds({ fatToolResultTokens: Number.NaN, nope: 1, fatHandoffShare: "0.5" }, { known });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 3);
  assert.deepEqual(bad.values, {});
  assert.equal(validateThresholds(null).valid, false);
  assert.equal(validateThresholds([1]).valid, false);
  assert.equal(validateThresholds({ fatToolResultTokens: Number.POSITIVE_INFINITY }).valid, false);
  assert.equal(validateThresholds({ fatToolResultTokens: 1 }).valid, true);
  assert.equal(validateThresholds({ definitelyUnknown: 1 }).valid, false);
});

test("rankFindings sorts by severity, then tokensAffected desc, then sessions (or legacy recurrence) desc", () => {
  assert.deepEqual(severityOrder, { high: 0, medium: 1, low: 2 });
  const f = (id, severity, tokensAffected, extra = {}) => ({ id, severity, tokensAffected, ...extra });
  const ranked = rankFindings([
    f("low-a", "low", 999, { sessions: 9 }),
    f("med-small", "medium", 10),
    f("high-small", "high", 100),
    f("high-big", "high", 5000),
    f("med-big-s1", "medium", 500, { sessions: 1 }),
    f("med-big-s3", "medium", 500, { sessions: 3 }),
    f("med-big-r2", "medium", 500, { recurrence: 2 }),
  ]);
  assert.deepEqual(ranked.map((x) => x.id), ["high-big", "high-small", "med-big-s3", "med-big-r2", "med-big-s1", "med-small", "low-a"]);
});

test("evaluateRun dedupes identical ids, sorts, ignores `runs`, and leaves recurrence to the API layer", async () => {
  const dir = await scratch();
  await writeFile(join(dir, "B-01.mjs"), ruleSource("B-01", { severity: "high", body: `
    const ev = [{ kind: "metric", ref: input.run.id + "#metric:x", label: "x", value: 1, provenance: "derived.exact" }];
    const f = { id: "B-01:" + "a".repeat(10), ruleId: "B-01", severity: "high", scope: "session", title: "t", whyItMatters: "w", evidence: ev, fix: { platform: "claude", summary: "s" }, thresholdKeys: [], tokensAffected: 10, count: 2 };
    return [f, { ...f }];` }));
  await writeFile(join(dir, "B-02.mjs"), ruleSource("B-02", { severity: "low", body: `
    return [{ id: "B-02:" + "b".repeat(10), ruleId: "B-02", severity: "low", scope: "session", title: "t", whyItMatters: "w", evidence: [{ kind: "run", ref: input.run.id, label: "r", provenance: "unknown" }], fix: { platform: "codex", summary: "s" }, thresholdKeys: [], tokensAffected: 99999, setupSeen: input.setup !== undefined }];` }));
  await writeFile(join(dir, "S-01.mjs"), ruleSource("S-01", { scope: "setup", body: `return [{ id: "S-01:" + "c".repeat(10), ruleId: "S-01", severity: "medium", scope: "setup", title: "t", whyItMatters: "w", evidence: [{ kind: "file", ref: "CLAUDE.md", label: "f", provenance: "observed.artifact" }], fix: { platform: "both", summary: "s" }, thresholdKeys: [] }];` }));
  const rules = await loadRules({ dir, onWarning: () => {} });
  const runs = ["s1", "s2", "s3"].map((id) => makeScenario("quiet", { id }));
  const findings = await evaluateRun(runs[0], { rules, runs, thresholds: {} });
  assert.deepEqual(findings.map((f) => f.ruleId), ["B-01", "B-02"]);
  assert.equal(findings[0].count, 2);
  assert.equal(findings[0].recurrence, undefined);
  assert.equal(findings[1].recurrence, undefined);
  assert.equal(findings[1].sessions, undefined);
  assert.equal(findings[1].setupSeen, false);

  // the setup inventory is handed to rules that want it
  const withSetup = await evaluateRun(runs[0], { rules, thresholds: {}, setup: { agents: [] } });
  assert.equal(withSetup.find((f) => f.ruleId === "B-02").setupSeen, true);

  const setupFindings = await evaluateSetup({ repo: { name: "x", root: "cwd", git: true } }, { rules, thresholds: {} });
  assert.deepEqual(setupFindings.map((f) => f.ruleId), ["S-01"]);
  assert.equal(setupFindings[0].recurrence, undefined);
  assert.deepEqual(await evaluateSetup(null, { rules, thresholds: {} }), []);
  assert.deepEqual(await evaluateRun(null, { rules, thresholds: {} }), []);
});

test("evaluateRun with the real rules on the quiet fixture reports nothing for either vendor", async () => {
  for (const vendor of ["claude", "codex"]) {
    const findings = await evaluateRun(makeScenario("quiet", { vendor }), { onWarning: () => {} });
    assert.deepEqual(findings, [], `${vendor} quiet`);
  }
});
