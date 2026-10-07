import assert from "node:assert/strict";
import test from "node:test";
import { assertFindingShape, evaluateRun, loadRules, defaultThresholds } from "../src/rules/index.mjs";
import { sha1 } from "../src/rules/util.mjs";
import { blk, callAndResult, makeRun, makeScenario, req, scenarioNames, scope, toolCall, toolResult } from "./fixtures/ir/make-runs.mjs";

const thresholds = defaultThresholds();
const rulesPromise = loadRules({ force: true, onWarning: () => {} });

async function findingsFor(name, vendor = "claude") {
  const rules = await rulesPromise;
  const run = makeScenario(name, { vendor });
  const findings = await evaluateRun(run, { rules, thresholds });
  for (const finding of findings) assertFindingShape(finding);
  return { run, findings };
}

function only(findings, ruleId) {
  return findings.filter((f) => f.ruleId === ruleId);
}

const CASES = [
  { id: "B-01", fires: ["B-01-fires", "B-01-many", "B-01-subagent-many", "B-01-high"], quiet: ["B-01-quiet", "quiet"] },
  { id: "B-02", fires: ["B-02-fires"], quiet: ["B-02-quiet", "quiet"] },
  { id: "B-03", fires: ["B-03-fires", "B-03-many", "B-03-1m-window"], quiet: ["B-03-quiet", "quiet"] },
  { id: "B-04", fires: ["B-04-fires", "B-04-subagent-fires", "B-04-many"], quiet: ["B-04-quiet", "quiet"] },
  { id: "B-05", fires: ["B-05-fires", "B-05-share-fires", "B-05-many"], quiet: ["B-05-quiet", "quiet"] },
  { id: "B-06", fires: ["B-06-fires"], quiet: ["B-06-quiet", "quiet"] },
  { id: "B-07", fires: ["B-07-fires", "B-07-rate-fires"], quiet: ["B-07-quiet", "quiet"] },
  { id: "B-08", fires: ["B-08-fires", "B-08-many"], quiet: ["B-08-quiet", "quiet"] },
  { id: "B-09", fires: ["B-09-fires"], quiet: ["B-09-quiet", "quiet"], claudeOnly: true },
  { id: "B-10", fires: ["B-10-fires"], quiet: ["B-10-quiet", "quiet"] },
  { id: "B-11", fires: ["B-11-fires"], quiet: ["B-11-quiet", "quiet"] },
  { id: "B-12", fires: ["B-12-fires"], quiet: ["B-12-quiet", "quiet"] },
  { id: "B-13", fires: ["B-13-fires", "B-13-hours-fires"], quiet: ["B-13-quiet", "quiet"] },
  { id: "B-14", fires: ["B-14-fires", "B-14-many"], quiet: ["B-14-quiet", "quiet"] },
  { id: "B-15", fires: ["B-15-fires", "B-15-many"], quiet: ["B-15-quiet", "quiet"] },
  { id: "B-16", fires: ["B-16-share-fires", "B-16-steps-fires", "B-16-subagent-fires"], quiet: ["B-16-quiet", "B-16-legacy-quiet", "quiet"] },
  { id: "B-17", fires: ["B-17-fires"], quiet: ["B-17-quiet", "B-12-fires", "quiet"] },
];

const AGGREGATED = ["B-01", "B-03", "B-04", "B-05", "B-08", "B-14", "B-15"];

for (const { id, fires, quiet, claudeOnly } of CASES) {
  for (const name of fires) {
    test(`${id} fires on ${name} (claude) with evidence and a claude fix`, async () => {
      const rules = await rulesPromise;
      const { run, findings } = await findingsFor(name, "claude");
      const hits = only(findings, id);
      assert.ok(hits.length >= 1, `${id} should fire; got ${findings.map((f) => f.ruleId).join(",") || "nothing"}`);
      for (const finding of hits) {
        assert.equal(finding.runId, run.id);
        assert.equal(finding.vendor, "claude");
        assert.equal(finding.fix.platform, "claude");
        assert.ok(finding.fix.snippet, "fix has a snippet");
        assert.ok(finding.evidence.length >= 1);
        assert.ok(finding.evidence.every((e) => e.ref.startsWith(run.id) || e.kind === "file"));
        assert.ok(finding.tokensAffected === undefined || finding.tokensAffected >= 0);
        assert.match(finding.id, new RegExp(`^${id}:[0-9a-f]{10}$`));
        if (AGGREGATED.includes(id)) {
          assert.ok(Number.isInteger(finding.count) && finding.count >= 1, `${id} carries count`);
          assert.ok(finding.evidence.length <= 5, `${id} evidence capped at 5`);
          assert.equal(typeof finding.scopeId, "string");
          assert.ok(finding.count === 1 ? finding.title === rules.find((r) => r.id === id).title : finding.title.endsWith(`×${finding.count}`), `${id} title carries the count`);
        }
      }
    });
    if (!claudeOnly) {
      test(`${id} fires on ${name} (codex) with a codex fix`, async () => {
        const { findings } = await findingsFor(name, "codex");
        const hits = only(findings, id);
        assert.ok(hits.length >= 1, `${id} should fire for codex`);
        for (const finding of hits) assert.equal(finding.fix.platform, "codex");
      });
    }
  }
  for (const name of quiet) {
    test(`${id} stays quiet on ${name}`, async () => {
      const { findings } = await findingsFor(name, "claude");
      assert.deepEqual(only(findings, id), [], `${id} should not fire on ${name}`);
    });
  }
}

test("B-01 evidence names the block and the size; a single 9.5k block on a 200k window is medium", async () => {
  const { run, findings } = await findingsFor("B-01-fires");
  const [f] = only(findings, "B-01");
  assert.equal(f.evidence[0].kind, "block");
  assert.equal(f.evidence[0].ref, `${run.id}#main:51`);
  assert.equal(f.evidence[0].value, 9_500);
  assert.equal(f.tokensAffected, 9_500);
  assert.equal(f.scope, "session");
  assert.equal(f.scopeId, "main");
  assert.equal(f.count, 1);
  assert.equal(f.severity, "medium");
  assert.equal(f.title, "Fat tool result");
  assert.match(f.fix.snippet, /head -c 8000/);
});

test("B-01 aggregates 14 fat results into one finding with count, top-5 evidence by tokens and summed tokens", async () => {
  const { run, findings } = await findingsFor("B-01-many");
  const hits = only(findings, "B-01");
  assert.equal(hits.length, 1);
  const [f] = hits;
  assert.equal(f.count, 14);
  assert.equal(f.title, "Fat tool result ×14");
  assert.equal(f.evidence.length, 5);
  assert.deepEqual(f.evidence.map((e) => e.value), [22_000, 21_000, 20_000, 19_000, 18_000]);
  assert.ok(f.evidence.every((e) => e.kind === "block"));
  // 22k + 21k + ... + 9k
  assert.equal(f.tokensAffected, 14 * 22_000 - 1_000 * (13 * 14 / 2));
  assert.equal(f.scopeId, "main");
  assert.equal(f.id, `B-01:${sha1(`${run.id}#main`).slice(0, 10)}`);
  // id is stable per (rule, run, scope) whatever the number of occurrences
  const single = await findingsFor("B-01-fires");
  assert.equal(only(single.findings, "B-01")[0].id, f.id);
  // the fix targets the fattest block
  assert.match(f.fix.snippet, /head -c 8000/);
});

test("B-01 in a subagent keeps one slot for the scope: top-4 blocks + scope evidence", async () => {
  const { run, findings } = await findingsFor("B-01-subagent-many");
  const [f] = only(findings, "B-01");
  assert.equal(f.scope, "subagent");
  assert.equal(f.scopeId, "a1");
  assert.equal(f.count, 6);
  assert.equal(f.evidence.length, 5);
  assert.equal(f.evidence.filter((e) => e.kind === "block").length, 4);
  assert.equal(f.evidence.at(-1).kind, "scope");
  assert.equal(f.evidence.at(-1).ref, `${run.id}#a1`);
  assert.equal(f.tokensAffected, 6 * 9_900 - 100 * 15);
});

test("B-01/B-03 severity is window-relative: high only when one block reaches max(threshold, 5% of the window)", async () => {
  const high = await findingsFor("B-01-high");
  assert.equal(only(high.findings, "B-01")[0].severity, "high");
  const many = await findingsFor("B-01-many");
  assert.equal(only(many.findings, "B-01")[0].severity, "high");
  const small = await findingsFor("B-03-fires"); // 25k on 200k: 25k >= max(20k, 10k)
  assert.equal(only(small.findings, "B-03")[0].severity, "high");
  const wide = await findingsFor("B-03-1m-window"); // 25k on 1M: below 50k
  assert.equal(only(wide.findings, "B-03")[0].severity, "medium");
  assert.equal(only(wide.findings, "B-01")[0].severity, "medium");
  // the share is a threshold: raising it to 20% makes the 200k case medium too
  const rules = await rulesPromise;
  const strict = await evaluateRun(makeScenario("B-03-fires"), { rules, thresholds: { ...thresholds, fatBlockWindowShare: 0.2 } });
  assert.equal(only(strict, "B-03")[0].severity, "medium");
  // B-02 stays the high habit rule
  assert.equal(only(many.findings, "B-02")[0].severity, "high");
});

test("B-03 aggregates huge reads per scope, names the paths and keeps a Read offset/limit snippet", async () => {
  const single = await findingsFor("B-03-fires");
  const [f] = only(single.findings, "B-03");
  assert.equal(f.count, 1);
  assert.match(f.evidence[0].label, /package-lock\.json/);
  assert.match(f.fix.snippet, /offset/);
  assert.match(f.fix.snippet, /package-lock\.json/);
  const codex = await findingsFor("B-03-fires", "codex");
  assert.match(only(codex.findings, "B-03")[0].fix.snippet, /sed -n/);
  const { findings } = await findingsFor("B-03-many");
  const hits = only(findings, "B-03");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 3);
  assert.equal(hits[0].tokensAffected, 25_000 + 30_000 + 35_000);
  assert.deepEqual(hits[0].evidence.map((e) => e.value), [35_000, 30_000, 25_000]);
  assert.match(hits[0].fix.snippet, /fixtures\/big\.json/); // the fattest read
  assert.match(hits[0].fix.summary, /3 files/);
});

test("B-04 reports subagent scope with scope evidence when the repeats happen in a child", async () => {
  const { run, findings } = await findingsFor("B-04-subagent-fires");
  const [f] = only(findings, "B-04");
  assert.equal(f.scope, "subagent");
  assert.equal(f.scopeId, "a1");
  assert.ok(f.evidence.some((e) => e.kind === "scope" && e.ref === `${run.id}#a1`));
  assert.equal(f.evidence[0].value, 3);
  assert.match(f.evidence[0].label, /×3/);
  assert.match(f.evidence[0].label, /requests #0, #0, #0/);
  assert.match(f.evidence[0].label, /identical results/);
  assert.match(f.fix.summary, /agent definition|spawn prompt/);
  assert.doesNotMatch(f.fix.summary, /CLAUDE\.md|AGENTS\.md/);
  const main = await findingsFor("B-04-fires");
  assert.equal(only(main.findings, "B-04")[0].scope, "session");
  assert.match(only(main.findings, "B-04")[0].fix.snippet, /same arguments; note the result/);
  assert.match(only(main.findings, "B-04")[0].fix.summary, /CLAUDE\.md/);
});

test("B-04 ignores repeats whose results differ (polling, re-checks) and tools that re-sample state by name", async () => {
  const rules = await rulesPromise;
  const differing = makeScenario("B-04-fires");
  // Same command three times, three different outputs: a re-check, not a cache miss.
  differing.scopes[0].blocks.filter((b) => b.category === "tool_result.shell").forEach((b, i) => { b.hash = sha1(`output-${i}`); });
  assert.deepEqual(only(await evaluateRun(differing, { rules, thresholds }), "B-04"), []);

  const polling = makeScenario("B-04-fires");
  for (const b of polling.scopes[0].blocks) if (b.tool) b.tool.name = "mcp__chrome__screenshot";
  assert.deepEqual(only(await evaluateRun(polling, { rules, thresholds }), "B-04"), []);

  // Two identical results out of four do not reach the bar; three do, and only the identical ones count.
  const mixed = makeScenario("B-04-fires");
  mixed.scopes[0].blocks.push(...callAndResult("main", 70, 4, { name: "Bash", kind: "shell", args: "git status", resultTokens: 300 }));
  const results = mixed.scopes[0].blocks.filter((b) => b.category === "tool_result.shell");
  assert.equal(results.length, 4);
  results[3].hash = sha1("changed");
  const [f] = only(await evaluateRun(mixed, { rules, thresholds }), "B-04");
  assert.equal(f.evidence[0].value, 3);
  assert.equal(f.tokensAffected, 900);

  // A call without a logged result cannot be judged.
  const orphan = makeScenario("B-04-fires");
  orphan.scopes[0].blocks = orphan.scopes[0].blocks.filter((b) => !b.category.startsWith("tool_result."));
  assert.deepEqual(only(await evaluateRun(orphan, { rules, thresholds }), "B-04"), []);
});

test("B-04 aggregates identical-call groups per scope: count = groups, evidence = top 5 by resent tokens", async () => {
  const { findings } = await findingsFor("B-04-many");
  const hits = only(findings, "B-04");
  assert.equal(hits.length, 1);
  const [f] = hits;
  assert.equal(f.count, 7);
  assert.equal(f.evidence.length, 5);
  assert.ok(f.evidence.every((e) => e.kind === "metric" && e.value === 3));
  // groups resend 300, 600, ..., 2100 tok; the top five are 2100..900
  assert.match(f.evidence[0].label, /2,100 tok resent/);
  assert.match(f.evidence[4].label, /900 tok resent/);
  assert.equal(f.tokensAffected, 3 * 100 * (1 + 2 + 3 + 4 + 5 + 6 + 7));
});

test("B-05 aggregates per agent type: evidence is the fattest child handoffs, fix path only with an inventory file", async () => {
  const { run, findings } = await findingsFor("B-05-fires");
  const [f] = only(findings, "B-05");
  assert.equal(f.scope, "subagent");
  assert.equal(f.count, 1);
  assert.equal(f.evidence[0].kind, "scope");
  assert.equal(f.evidence[0].ref, `${run.id}#a1`);
  assert.equal(f.evidence[0].value, 6_000);
  assert.match(f.evidence[0].label, /15% of the child's peak 40,000 tok/);
  assert.equal(f.tokensAffected, 6_000);
  assert.equal(f.scopeId, "a1");
  // built-in / unknown agent types have no file: the fix goes into the Agent prompt and carries no path
  assert.equal(f.fix.path, undefined);
  assert.match(f.fix.snippet, /subagent_type: "explore"/);
  assert.match(f.fix.snippet, /Return findings only/);
  const share = await findingsFor("B-05-share-fires");
  assert.match(only(share.findings, "B-05")[0].evidence[0].label, /50% of the child's peak/);

  const rules = await rulesPromise;
  const withFile = await evaluateRun(makeScenario("B-05-fires"), { rules, thresholds, setup: { agents: [{ name: "explore", path: ".claude/agents/explore.md", scope: "project" }] } });
  assert.equal(only(withFile, "B-05")[0].fix.path, ".claude/agents/explore.md");
  const otherFile = await evaluateRun(makeScenario("B-05-fires"), { rules, thresholds, setup: { agents: [{ name: "planner", path: ".claude/agents/planner.md", scope: "project" }] } });
  assert.equal(only(otherFile, "B-05")[0].fix.path, undefined);

  const many = await findingsFor("B-05-many");
  const grouped = only(many.findings, "B-05");
  assert.equal(grouped.length, 2);
  const explore = grouped.find((g) => g.count === 3);
  const planner = grouped.find((g) => g.count === 1);
  assert.ok(explore && planner);
  assert.equal(explore.title, "Fat subagent handoff ×3");
  assert.deepEqual(explore.evidence.map((e) => e.value), [8_000, 7_000, 6_000]);
  assert.equal(explore.tokensAffected, 21_000);
  assert.equal(explore.scopeId, "a3");
  assert.match(planner.evidence[0].label, /^planner a4/);
  assert.notEqual(explore.id, planner.id);
});
test("B-02 groups by tool kind and sums the offending blocks", async () => {
  const { findings } = await findingsFor("B-02-fires");
  const [f] = only(findings, "B-02");
  assert.equal(f.tokensAffected, 5 * 3_500);
  assert.equal(f.evidence[0].kind, "metric");
  assert.equal(f.evidence[0].value, 5);
  assert.equal(f.fix.path, "CLAUDE.md");
  const codex = await findingsFor("B-02-fires", "codex");
  assert.equal(only(codex.findings, "B-02")[0].fix.path, "AGENTS.md");
});

test("B-06 lists the shared files and only counts parent reads before launch", async () => {
  const { findings } = await findingsFor("B-06-fires");
  const [f] = only(findings, "B-06");
  const files = f.evidence.filter((e) => e.kind === "file").map((e) => e.ref).sort();
  assert.deepEqual(files, ["src/file0.ts", "src/file1.ts", "src/file2.ts"]);
  assert.equal(f.scope, "subagent");
  assert.equal(f.tokensAffected, 3 * 1_500);
});

test("B-07 evidence carries compaction count, rate, dropped tokens, and request refs", async () => {
  const { findings } = await findingsFor("B-07-fires");
  const [f] = only(findings, "B-07");
  assert.equal(f.evidence[0].value, 3);
  assert.ok(f.evidence.some((e) => e.kind === "request"));
  assert.equal(f.tokensAffected, 3 * 160_000);
  assert.match(f.fix.snippet, /\/clear/);
});

test("B-08 evidence mentions the window provenance and streak length", async () => {
  const { findings } = await findingsFor("B-08-fires");
  const [f] = only(findings, "B-08");
  const windowEv = f.evidence.find((e) => e.ref.endsWith("#metric:window"));
  assert.equal(windowEv.provenance, "estimated.local");
  assert.match(windowEv.label, /model table/);
  assert.equal(f.evidence.find((e) => e.unit === "count").value, 11);
  assert.equal(f.count, 1);
  assert.equal(f.title, "Running hot");
  assert.match(f.fix.snippet, /\/compact/);
  const codex = await findingsFor("B-08-fires", "codex");
  assert.match(only(codex.findings, "B-08")[0].evidence.find((e) => e.ref.endsWith("#metric:window")).label, /vendor-reported/);
});

test("B-08 reports one finding per hot scope: streaks are the occurrences, tokens sum every hot request", async () => {
  const { run, findings } = await findingsFor("B-08-many");
  const hits = only(findings, "B-08");
  assert.equal(hits.length, 1);
  const [f] = hits;
  assert.equal(f.count, 3);
  assert.equal(f.title, "Running hot ×3");
  assert.equal(f.evidence.length, 5);
  assert.equal(f.evidence.filter((e) => e.kind === "request").length, 3);
  assert.equal(f.evidence.find((e) => e.unit === "count").value, 33);
  assert.match(f.evidence.find((e) => e.unit === "count").label, /3 streaks/);
  const hot = run.scopes[0].requests.filter((r) => r.usage.total > 160_000);
  assert.equal(hot.length, 33);
  assert.equal(f.tokensAffected, hot.reduce((sum, r) => sum + r.usage.total, 0));
  assert.equal(f.scopeId, "main");
});

test("B-09 is skipped when cacheCreation is undefined or the vendor is not claude", async () => {
  const rules = await rulesPromise;
  const run = makeScenario("B-09-fires");
  for (const request of run.scopes[0].requests) { delete request.usage.cacheCreation; delete request.deltaCheck; }
  assert.deepEqual(only(await evaluateRun(run, { rules, thresholds }), "B-09"), []);
  const codex = makeScenario("B-09-fires", { vendor: "codex" });
  assert.deepEqual(only(await evaluateRun(codex, { rules, thresholds }), "B-09"), []);
  const { findings } = await findingsFor("B-09-fires");
  const [f] = only(findings, "B-09");
  assert.equal(f.evidence[0].value, 0.5);
  assert.equal(f.tokensAffected, 5 * 40_000);
});

test("B-10 uses system + instructions of the first request against the window, never unlogged", async () => {
  const { run, findings } = await findingsFor("B-10-fires");
  const [f] = only(findings, "B-10");
  assert.equal(f.evidence[0].ref, `${run.id}#main#0`);
  // H = 80,000 - visible 1,660 = 78,340; system capped at the 25k baseline, instructions 45k, the rest (8,340) is unlogged
  assert.equal(run.scopes[0].requests[0].composition.unlogged, 8_340);
  assert.equal(f.evidence[0].value, 70_000);
  assert.equal(f.tokensAffected, 70_000);
  assert.ok(f.evidence.some((e) => e.ref.endsWith("#metric:instructionTokens") && e.value === 45_000));
  assert.match(f.fix.snippet, /claude mcp/);
  const codex = await findingsFor("B-10-fires", "codex");
  assert.equal(only(codex.findings, "B-10")[0].evidence[0].value, 53_000);
});

test("B-11 counts tiny follow-ups and sums what they resend", async () => {
  const { findings } = await findingsFor("B-11-fires");
  const [f] = only(findings, "B-11");
  assert.equal(f.evidence[0].value, 11);
  assert.equal(f.tokensAffected, 11 * 120_000);
  assert.equal(f.severity, "low");
  assert.match(f.evidence[2].label, /turn 2/);
});

/** A main scope with `turns` human prompts of `userTokens` each, every prompt followed by `loopSteps` tool-loop requests. */
function agentLoopRun({ vendor = "claude", turns = 12, loopSteps = 4, userTokens = 20, toolResultTokens = 400 } = {}) {
  const requests = [];
  const blocks = [];
  let index = 0;
  let seq = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    requests.push(req(index, 120_000, { turn }));
    blocks.push(blk("main", seq++, "user", userTokens, index));
    index += 1;
    for (let step = 0; step < loopSteps; step += 1) {
      const toolUseId = `tu_${index}`;
      blocks.push(toolCall("main", seq++, index - 1, { name: "Bash", kind: "shell", args: `cmd ${index}`, toolUseId }));
      blocks.push(toolResult("main", seq++, index, { name: "Bash", kind: "shell", toolUseId, estTokens: toolResultTokens }));
      requests.push(req(index, 120_000, { turn }));
      index += 1;
    }
  }
  return makeRun({ vendor, scopes: [scope("main", { requests, blocks })] });
}

test("B-11 counts only requests that start a human turn: tool-loop steps and deliveries without a user block never count", async () => {
  const rules = await rulesPromise;
  // 12 turns x (1 prompt + 4 loop steps) = 60 requests; 11 tiny turns (the first prompt is the task) is still a finding, 48 loop steps are not.
  const loop = agentLoopRun();
  const [f] = only(await evaluateRun(loop, { rules, thresholds }), "B-11");
  assert.equal(f.evidence[0].value, 12);
  assert.equal(f.tokensAffected, 12 * 120_000);
  assert.ok(f.evidence.slice(2).every((e) => /turn \d+/.test(e.label)));

  // Nine real prompts and 50 loop steps: below the bar once the loop steps are out.
  const few = agentLoopRun({ turns: 9, loopSteps: 6 });
  assert.deepEqual(only(await evaluateRun(few, { rules, thresholds }), "B-11"), []);

  // A turn boundary whose new blocks are an attachment / tool result only (handoff delivery) is not a human message.
  const delivered = makeScenario("B-11-fires");
  for (const block of delivered.scopes[0].blocks) if (block.firstRequest > 0) block.category = "attachments";
  assert.deepEqual(only(await evaluateRun(delivered, { rules, thresholds }), "B-11"), []);
});

test("B-12 uses the composition at peak", async () => {
  const { run, findings } = await findingsFor("B-12-fires");
  const [f] = only(findings, "B-12");
  assert.ok(f.evidence[0].value > 0.6);
  assert.ok(f.evidence.some((e) => e.ref === `${run.id}#main#3`));
});

test("B-17 fires when tool-call arguments are >= 35% of the peak; names the fattest payloads; fix is on the writing side", async () => {
  const { run, findings } = await findingsFor("B-17-fires");
  const [f] = only(findings, "B-17");
  assert.ok(f.evidence[0].value >= 0.35, `share ${f.evidence[0].value}`);
  assert.match(f.evidence[0].label, /tool arguments are \d+% of the/);
  assert.ok(f.evidence.some((e) => e.ref === `${run.id}#main#3`), "peak request evidence");
  const blocks = f.evidence.filter((e) => e.kind === "block");
  assert.equal(blocks.length, 3);
  assert.match(blocks[0].label, /Write src\/generated\/[abc]\.ts arguments, 12,000 tok/);
  assert.equal(f.tokensAffected, run.summary.compositionAtPeak.tool_call);
  assert.match(f.fix.snippet, /Edit/);
  const codex = await findingsFor("B-17-fires", "codex");
  assert.match(only(codex.findings, "B-17")[0].fix.snippet, /apply_patch/);
  assert.equal(only((await findingsFor("B-12-fires")).findings, "B-17").length, 0, "fat results are B-12's case, not B-17's");
});

test("B-13 fires on tokens or on hours+compactions with matching primary evidence", async () => {
  const tokens = await findingsFor("B-13-fires");
  const [a] = only(tokens.findings, "B-13");
  assert.equal(a.evidence[0].value, 20 * 160_000);
  const hours = await findingsFor("B-13-hours-fires");
  const [b] = only(hours.findings, "B-13");
  assert.notEqual(a.id.split(":")[1], b.id.split(":")[1]);
  assert.ok(hours.run.activeMs > 4 * 3_600_000);
});

test("B-13 is about length: the token branch needs an hour of active time, the hours branch needs two compactions", async () => {
  const rules = await rulesPromise;
  // 3.2M processed tokens in 38 active minutes: a busy short session, not a long one.
  const requests = [];
  for (let i = 0; i < 20; i += 1) requests.push(req(i, 160_000, { minute: i * 2 }));
  const short = makeRun({ scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
  assert.ok(short.summary.processedInputTokens > thresholds.sessionTooLongTokens);
  assert.ok(short.activeMs < 3_600_000);
  assert.deepEqual(only(await evaluateRun(short, { rules, thresholds }), "B-13"), []);

  // Five active hours with one compaction: long, but the rule asks for two.
  const long = makeScenario("B-13-hours-fires");
  long.scopes[0].compactions = long.scopes[0].compactions.slice(0, 1);
  long.summary.compactions = 1;
  assert.deepEqual(only(await evaluateRun(long, { rules, thresholds }), "B-13"), []);
});

test("B-14 suggests files_with_matches on claude and rg -l on codex", async () => {
  const claude = await findingsFor("B-14-fires");
  assert.match(only(claude.findings, "B-14")[0].fix.snippet, /files_with_matches/);
  const codex = await findingsFor("B-14-fires", "codex");
  assert.match(only(codex.findings, "B-14")[0].fix.snippet, /rg -l/);
});

test("B-15 reports one finding per parent: pairs are the occurrences and name both siblings and the shared files", async () => {
  const { run, findings } = await findingsFor("B-15-fires");
  const [f] = only(findings, "B-15");
  assert.equal(f.scope, "subagent");
  assert.equal(f.scopeId, "main");
  assert.equal(f.count, 1);
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].ref, `${run.id}#metric:parallelDuplicate.a1.a2`);
  assert.equal(f.evidence[0].value, 3);
  assert.match(f.evidence[0].label, /explore a1 and explore a2 share 3 file reads/);
  assert.match(f.evidence[0].label, /src\/a\.ts, src\/b\.ts, src\/c\.ts/);
  assert.equal(f.tokensAffected, 3 * 1_500);
  assert.match(f.fix.snippet, /src\/a\.ts/);
  const many = await findingsFor("B-15-many");
  const hits = only(many.findings, "B-15");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 6);
  assert.equal(hits[0].evidence.length, 5);
  assert.equal(hits[0].tokensAffected, 6 * 3 * 1_500);
  assert.equal(hits[0].title, "Parallel duplicate work ×6");
});

test("B-16 fires on unlogged share or base steps, explains resumed sessions vs hidden injections, skips incomplete transcripts", async () => {
  const share = await findingsFor("B-16-share-fires");
  const [f] = only(share.findings, "B-16");
  assert.equal(f.scope, "session");
  assert.equal(f.scopeId, "main");
  assert.equal(f.severity, "medium");
  assert.equal(f.evidence[0].unit, "ratio");
  assert.equal(f.evidence[0].value, 0.3);
  assert.match(f.evidence[0].label, /30% of the peak/);
  assert.equal(f.tokensAffected, Math.round(0.3 * share.run.scopes[0].peak.value));
  assert.match(f.fix.snippet, /\/clear/);
  assert.match(f.fix.summary, /resum/);
  const codex = await findingsFor("B-16-share-fires", "codex");
  assert.match(only(codex.findings, "B-16")[0].fix.snippet, /\/new/);

  const steps = await findingsFor("B-16-steps-fires");
  const [g] = only(steps.findings, "B-16");
  // The −12,000 step at #4 is hidden mass leaving the window, never an injection: not evidence, not tokens.
  assert.equal(g.evidence.length, 2);
  assert.equal(g.evidence[1].kind, "request");
  assert.equal(g.evidence[1].ref, `${steps.run.id}#main#1`);
  assert.equal(g.evidence[1].value, 33_000);
  assert.match(g.evidence[1].label, /\+33,000 tok unlogged at request #1/);
  assert.ok(g.evidence.every((e) => !/−/.test(e.label)));
  assert.equal(g.tokensAffected, 33_000);
  assert.match(g.fix.summary, /grew at request #1/);
  assert.match(g.fix.summary, /nested instruction file or memory/);
  assert.match(g.fix.snippet, /contextscope hooks install --scope user/);
  assert.doesNotMatch(g.fix.snippet, /mcp list/);
  const codexSteps = await findingsFor("B-16-steps-fires", "codex");
  assert.match(only(codexSteps.findings, "B-16")[0].fix.summary, /nested AGENTS\.md/);

  const child = await findingsFor("B-16-subagent-fires");
  const [h] = only(child.findings, "B-16");
  assert.equal(h.scope, "subagent");
  assert.equal(h.scopeId, "a1");
  assert.match(h.evidence[1].label, /present from the first request/);
  assert.ok(h.evidence.some((e) => e.kind === "scope" && e.ref === `${child.run.id}#a1`));
  // A subagent cannot /clear or resume: its fix goes to the agent definition.
  assert.doesNotMatch(h.fix.snippet, /\/clear/);
  assert.match(h.fix.summary, /\.claude\/agents/);
  assert.match(h.fix.summary, /return paths and decisions only/);

  // B-10 ignores unlogged mass: only system + instructions count toward the system share
  const rules = await rulesPromise;
  const run = makeScenario("B-10-fires");
  const first = run.scopes[0].requests[0];
  first.composition = { ...first.composition, system: 20_000, instructions: 12_000, unlogged: first.hiddenBase.value - 32_000 };
  assert.deepEqual(only(await evaluateRun(run, { rules, thresholds }), "B-10"), []);
  first.composition.system = 60_000;
  assert.equal(only(await evaluateRun(run, { rules, thresholds }), "B-10")[0].evidence[0].value, 72_000);
});

test("B-16 raises the bar: a drop-only step list or a small positive step below the share threshold stays quiet", async () => {
  const rules = await rulesPromise;
  const drops = makeScenario("B-16-steps-fires");
  drops.scopes[0].baseSteps = [{ atRequest: 2, delta: -30_000 }, { atRequest: 4, delta: -12_000 }];
  assert.deepEqual(only(await evaluateRun(drops, { rules, thresholds }), "B-16"), []);
  const small = makeScenario("B-16-steps-fires");
  small.scopes[0].baseSteps = [{ atRequest: 2, delta: 4_000 }];
  assert.deepEqual(only(await evaluateRun(small, { rules, thresholds }), "B-16"), []);
  small.scopes[0].baseSteps = [{ atRequest: 2, delta: 5_000 }];
  const [f] = only(await evaluateRun(small, { rules, thresholds }), "B-16");
  assert.equal(f.tokensAffected, 5_000);
  assert.match(f.fix.summary, /grew at request #2/);
});

test("scope-aware fixes: a Codex child thread or a Claude subagent is never told to /clear, /new, start a session or delegate", async () => {
  const rules = await rulesPromise;
  const forbidden = /\/clear|\/new|fresh (session|thread|window)|new thread|delegate/i;
  // Codex child thread: its own run with kind "subagent-run"; session-level rules must address the spawn prompt.
  for (const name of ["B-13-fires", "B-11-fires", "B-07-fires", "B-12-fires"]) {
    const run = makeScenario(name, { vendor: "codex" });
    run.kind = "subagent-run";
    run.parentThreadId = "parent-1";
    run.scopes[0].agentType = "reviewer";
    const id = name.slice(0, 4);
    const [f] = only(await evaluateRun(run, { rules, thresholds }), id);
    assert.ok(f, `${id} fires on the child run`);
    assert.equal(f.fix.platform, "codex");
    assert.doesNotMatch(`${f.fix.summary}\n${f.fix.snippet}`, forbidden, `${id} child fix: ${f.fix.summary}`);
    assert.match(f.fix.summary, /reviewer|spawn prompt/);
    assert.match(f.fix.snippet, /spawn_agent prompt/);
  }
  // The same scenarios as main runs keep the session fix.
  const main = only(await evaluateRun(makeScenario("B-13-fires", { vendor: "codex" }), { rules, thresholds }), "B-13")[0];
  assert.match(main.fix.snippet, /\/new/);

  // Claude subagent scope with a fat "other" result: the delegate fallback becomes an agent-definition fix; file reads keep the ranged read.
  const child = makeScenario("B-01-subagent-many");
  const [fileFix] = only(await evaluateRun(child, { rules, thresholds }), "B-01");
  assert.equal(fileFix.scope, "subagent");
  assert.doesNotMatch(fileFix.fix.summary, forbidden);
  for (const block of child.scopes[1].blocks) if (block.category.startsWith("tool_result.")) { block.category = "tool_result.other"; block.tool.kind = "other"; block.tool.name = "mcp__db__query"; }
  const [otherFix] = only(await evaluateRun(child, { rules, thresholds }), "B-01");
  assert.doesNotMatch(`${otherFix.fix.summary}\n${otherFix.fix.snippet}`, forbidden);
  assert.match(otherFix.fix.summary, /\.claude\/agents/);
  assert.match(otherFix.fix.snippet, /Keep tool output out of the handoff/);
  const mainOther = makeScenario("B-01-fires");
  for (const block of mainOther.scopes[0].blocks) if (block.category.startsWith("tool_result.")) { block.category = "tool_result.other"; block.tool.kind = "other"; block.tool.name = "mcp__db__query"; }
  assert.match(only(await evaluateRun(mainOther, { rules, thresholds }), "B-01")[0].fix.summary, /Delegate/);
});

test("every scenario builds a finished run whose findings all pass the shape check and are sorted", async () => {
  const rules = await rulesPromise;
  for (const name of scenarioNames()) {
    for (const vendor of ["claude", "codex"]) {
      const run = makeScenario(name, { vendor });
      assert.ok(run.summary && run.scopes[0].peak.value > 0, `${name} finalized`);
      const findings = await evaluateRun(run, { rules, thresholds });
      for (const finding of findings) assertFindingShape(finding);
      const ids = findings.map((f) => f.id);
      assert.equal(new Set(ids).size, ids.length, `${name} ids unique`);
      const order = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < findings.length; i += 1) assert.ok(order[findings[i - 1].severity] <= order[findings[i].severity], `${name} sorted`);
    }
  }
});
