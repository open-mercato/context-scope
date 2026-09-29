/**
 * ADR-003 section 9: a rule-source or thresholds change invalidates stored
 * findings through `rulesHash`; the index re-evaluates affected entries from
 * the stored run without re-parsing the transcript.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RULES_DIR, evaluateRun, rulesHash } from "../src/rules/index.mjs";
import { createIndex } from "../src/index/index.mjs";
import { indexRoot } from "../src/index/manifest.mjs";
import { CLAUDE_SESSIONS, fakeAdapters, fakeRules, fakeRun, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};

function copyRules(dir) {
  for (const name of fs.readdirSync(RULES_DIR)) {
    if (!/\.(mjs|json)$/.test(name)) continue;
    fs.copyFileSync(path.join(RULES_DIR, name), path.join(dir, name));
  }
}

test("rulesHash: stable across calls, sensitive to rule sources, built-in thresholds and the user thresholds file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "contextscope-rules-home-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contextscope-rules-"));
  try {
    copyRules(dir);
    const h1 = await rulesHash({ dir, home });
    assert.match(h1, /^[0-9a-f]{16}$/);
    assert.equal(await rulesHash({ dir, home }), h1, "stat cache returns the same hash while nothing changed");
    assert.equal(h1, await rulesHash({ dir: RULES_DIR, home }), "a faithful copy hashes like the built-in rules dir");

    fs.appendFileSync(path.join(dir, "B-01.mjs"), "\n// touched\n");
    const h2 = await rulesHash({ dir, home });
    assert.notEqual(h2, h1, "a rule source change changes the hash");

    const thresholds = JSON.parse(fs.readFileSync(path.join(dir, "thresholds.json"), "utf8"));
    const key = Object.keys(thresholds)[0];
    thresholds[key] = thresholds[key] + 1;
    fs.writeFileSync(path.join(dir, "thresholds.json"), JSON.stringify(thresholds));
    const h3 = await rulesHash({ dir, home });
    assert.notEqual(h3, h2, "a built-in thresholds change changes the hash");

    fs.mkdirSync(path.join(home, ".contextscope"), { recursive: true });
    fs.writeFileSync(path.join(home, ".contextscope", "thresholds.json"), JSON.stringify({ [key]: 1 }));
    const h4 = await rulesHash({ dir, home });
    assert.notEqual(h4, h3, "the user thresholds file is part of the hash");
    fs.writeFileSync(path.join(home, ".contextscope", "thresholds.json"), JSON.stringify({ [key]: 2 }));
    assert.notEqual(await rulesHash({ dir, home }), h4, "its content, not just its presence");

    // A non-rule file in the directory does not count.
    fs.writeFileSync(path.join(dir, "notes.md"), "irrelevant");
    const h5 = await rulesHash({ dir, home });
    fs.writeFileSync(path.join(dir, "notes.md"), "irrelevant 2");
    assert.equal(await rulesHash({ dir, home }), h5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("evaluateRun stamps Coverage.rulesHash on the run", async () => {
  const run = fakeRun("/tmp/claude-x/11111111-1111-4111-8111-111111111111.jsonl", "claude");
  await evaluateRun(run, { thresholds: {}, rulesHash: "abcdef0123456789", onWarning: quiet });
  assert.equal(run.coverage.rulesHash, "abcdef0123456789");
  const other = fakeRun("/tmp/claude-x/11111111-1111-4111-8111-111111111111.jsonl", "claude");
  await evaluateRun(other, { thresholds: {}, onWarning: quiet });
  assert.match(other.coverage.rulesHash, /^[0-9a-f]{16}$/, "computed from the built-in rules dir when not given");
});

test("a rule edit re-evaluates exactly the evaluated entries on the next pass, parsing nothing", async () => {
  const fixture = await makeFixtureHome();
  const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "contextscope-rules-"));
  try {
    copyRules(rulesDir);
    // Rules engine under test: the real hash over a temp copy of the rules, a fake evaluator whose output depends on `mode`.
    const base = fakeRules();
    let mode = "before";
    const rules = {
      ...base,
      rulesHash: () => rulesHash({ dir: rulesDir, home: fixture.home }),
      async evaluateRun(run, options) {
        const findings = await base.evaluateRun(run, options);
        if (mode === "after") findings.push({
          id: `B-02:${run.id}`, ruleId: "B-02", severity: "low", scope: "session", vendor: run.vendor, runId: run.id, title: "New rule", whyItMatters: "why",
          evidence: [{ kind: "run", ref: run.id, label: "run", provenance: "derived.exact" }], fix: { platform: "both", summary: "none" }, thresholdKeys: [], tokensAffected: 0,
        });
        return findings;
      },
    };
    const failing = CLAUDE_SESSIONS[2];
    const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters({ failOn: failing }), rules, warn: quiet });
    const root = indexRoot(fixture.home);
    const readManifest = () => JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

    const first = await index.ensure();
    assert.equal(first.parsed, 4);
    assert.equal(first.failed, 1);
    assert.equal(first.rulesChanged, 0);
    const h1 = await rulesHash({ dir: rulesDir, home: fixture.home });
    let manifest = readManifest();
    assert.equal(manifest.rulesHash, h1);
    const evaluated = Object.values(manifest.files).filter((entry) => !entry.error);
    assert.equal(evaluated.length, 4);
    assert.ok(evaluated.every((entry) => entry.rulesHash === h1), "every evaluated entry stores the rules hash");
    assert.equal(manifest.files[fixture.files[failing]].rulesHash, undefined, "an error entry stores no rules hash");
    const countsBefore = Object.fromEntries(evaluated.map((entry) => [entry.runId, entry.findingsCount]));

    const second = await index.ensure();
    assert.equal(second.parsed + second.reevaluated, 0);
    assert.equal(second.skipped, 5);

    // Edit a rule in the temp copy: the hash moves, the next pass re-evaluates without parsing.
    fs.appendFileSync(path.join(rulesDir, "B-01.mjs"), "\n// edited\n");
    mode = "after";
    const events = [];
    const third = await index.ensure({ onProgress: (event) => events.push(event) });
    assert.equal(third.parsed, 0, "no transcript is re-parsed");
    assert.equal(third.reevaluated, 4, "exactly the evaluated entries are re-evaluated");
    assert.equal(third.rulesChanged, 4);
    assert.equal(third.failed, 0);
    assert.equal(third.skipped, 1, "the error entry is left alone");
    assert.equal(events.find((event) => event.type === "start").rulesChanged, 4);
    const h2 = await rulesHash({ dir: rulesDir, home: fixture.home });
    assert.notEqual(h2, h1);
    manifest = readManifest();
    assert.equal(manifest.rulesHash, h2);
    assert.equal(manifest.lastPass.reevaluated, 4);
    assert.equal(manifest.lastPass.rulesChanged, 4);
    for (const entry of Object.values(manifest.files).filter((e) => !e.error)) {
      assert.equal(entry.rulesHash, h2);
      assert.equal(entry.findingsCount, countsBefore[entry.runId] + 1, "findings were rewritten from the stored run");
      assert.ok(entry.findingHeads.some((head) => head.ruleId === "B-02"));
    }
    const findings = await index.readFindings(`claude:${CLAUDE_SESSIONS[0]}`);
    assert.ok(findings.some((finding) => finding.ruleId === "B-02"), "findings.json carries the new rule's output");

    const fourth = await index.ensure();
    assert.equal(fourth.parsed + fourth.reevaluated, 0);
    assert.equal(fourth.skipped, 5);

    // A rules engine without rulesHash (older or injected) never re-evaluates on that basis.
    const plain = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters({ failOn: failing }), rules: base, warn: quiet });
    const fifth = await plain.ensure();
    assert.equal(fifth.reevaluated, 0);
    assert.equal(fifth.rulesChanged, 0);
  } finally {
    fs.rmSync(rulesDir, { recursive: true, force: true });
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("rulesHash covers rules/habits.mjs (the habit engine) next to the rule modules", async () => {
  const { cp, mkdtemp, rm, appendFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { rulesHash, RULES_DIR } = await import("../src/rules/index.mjs");
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-rules-"));
  try {
    const home = path.join(base, "home");
    const dir = path.join(base, "rules");
    await cp(RULES_DIR, dir, { recursive: true });
    const before = await rulesHash({ dir, home });
    await appendFile(path.join(dir, "habits.mjs"), "\n// touched\n");
    assert.notEqual(await rulesHash({ dir, home }), before, "editing habits.mjs changes the hash");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("printPassNotes reports rulesChanged / reevaluated only when non-zero", async () => {
  const { printPassNotes } = await import("../src/commands/shared.mjs");
  const lines = [];
  const write = (line) => lines.push(line);
  printPassNotes({ parsed: 3, reevaluated: 0, rulesChanged: 0 }, { write });
  printPassNotes(null, { write });
  assert.deepEqual(lines, []);
  printPassNotes({ parsed: 0, reevaluated: 12, rulesChanged: 12 }, { write });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /rules changed: 12 stored run\(s\) flagged, 12 re-evaluated without re-parsing/);
});
