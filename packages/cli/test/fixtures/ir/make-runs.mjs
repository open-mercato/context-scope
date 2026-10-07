/**
 * Synthetic finished Runs for the rules tests. Every scenario is built from
 * small builders and pushed through finalizeRun, so the fixtures follow the
 * same reconciliation the adapters use. Nothing here is copied from a real
 * transcript; labels are invented repo-relative paths.
 *
 *   import { scenarios, makeScenario } from "./fixtures/ir/make-runs.mjs";
 *   const run = makeScenario("B-01-fires");
 */
import { finalizeRun } from "../../../src/ir/finalize.mjs";
import { sha1 } from "../../../src/rules/util.mjs";

const T0 = Date.parse("2026-09-01T10:00:00Z");

export function at(minutes) {
  return new Date(T0 + minutes * 60_000).toISOString();
}

export function req(index, total, { minute = index, cacheCreation = 200, input = 100, output = 50, turn = 1, model = "m" } = {}) {
  const cacheRead = Math.max(0, total - input - cacheCreation);
  return { index, at: at(minute), model, turn, usage: { input, cacheCreation, cacheRead, output, total } };
}

export function blk(scopeId, seq, category, estTokens, firstRequest, extra = {}) {
  const id = `${scopeId}:${seq}`;
  return { id, seq, at: at(firstRequest), category, bytes: estTokens * 4, estTokens, firstRequest, hash: sha1(id), ...extra };
}

export function toolCall(scopeId, seq, firstRequest, { name, kind, args, target, toolUseId, estTokens = 60 }) {
  const label = target ?? name;
  return blk(scopeId, seq, "tool_call", estTokens, firstRequest, { tool: { name, kind, argsHash: sha1(`${name}:${args ?? target ?? ""}`), target }, toolUseId, label });
}

export function toolResult(scopeId, seq, firstRequest, { name, kind, target, toolUseId, estTokens, category }) {
  const cat = category ?? `tool_result.${["file", "shell", "search", "web"].includes(kind) ? kind : "other"}`;
  // Result hash stands for the result content: the same tool on the same target with the same size is the same result (B-04 compares it).
  return blk(scopeId, seq, cat, estTokens, firstRequest, { tool: { name, kind, argsHash: sha1(`${name}:${target ?? ""}`), target }, toolUseId, label: target ?? name, hash: sha1(`${cat}:${name}:${target ?? ""}:${estTokens}`) });
}

/** A tool call at request r followed by its result (input to request r+1). */
export function callAndResult(scopeId, seq, request, { name, kind, args, target, resultTokens, resultCategory }) {
  const toolUseId = `tu_${scopeId}_${seq}`;
  return [
    toolCall(scopeId, seq, request, { name, kind, args, target, toolUseId }),
    toolResult(scopeId, seq + 1, request, { name, kind, target, toolUseId, estTokens: resultTokens, category: resultCategory }),
  ];
}

export function scope(id, { kind = id === "main" ? "main" : "subagent", requests = [], blocks = [], compactions = [], ...extra } = {}) {
  return { id, kind, requests, blocks, compactions, models: [], ...(kind === "subagent" ? { parentScopeId: "main", depth: 1, status: "completed" } : {}), ...extra };
}

export function makeRun({ id = "s1", vendor = "claude", window = 200_000, windowProvenance = vendor === "codex" ? "observed.vendor" : "estimated.local", scopes, instructionTokensEstimate = 0 }) {
  const run = {
    id: `${vendor}:${id}`,
    vendor,
    sessionId: id,
    project: { key: "proj", displayName: "proj", cwdHash: "h" },
    startedAt: "",
    endedAt: "",
    activeMs: 0,
    window: { value: window, provenance: windowProvenance },
    scopes,
    coverage: { records: 0, unparsedRecords: 0, unparsedTypes: {}, syntheticRecordsSkipped: 0, adapterVersion: "fixture" },
    source: { file: "~/fixture.jsonl", bytes: 1, mtimeMs: 1, subagentFiles: scopes.length - 1 },
  };
  return finalizeRun(run, { instructionTokensEstimate });
}

/** A modest, clean main scope: 6 requests, small reads, nothing that fires. */
function quietMain({ vendor = "claude", requests = 6, base = vendor === "codex" ? 10_000 : 20_000 } = {}) {
  const reqs = [];
  const blocks = [blk("main", 0, "user", 400, 0)];
  let seq = 1;
  for (let i = 0; i < requests; i += 1) {
    reqs.push(req(i, base + i * 1_500, { turn: 1 + Math.floor(i / 3) }));
    if (i < requests - 1) {
      blocks.push(...callAndResult("main", seq, i, { name: vendor === "claude" ? "Read" : "exec_command", kind: "file", target: `src/file${i}.ts`, resultTokens: 1_200 }));
      seq += 2;
    }
  }
  return { requests: reqs, blocks };
}

function withSubagent({ vendor = "claude", handoffTokens = 800, childPeak = 40_000, childBlocks = [], parentExtraBlocks = [], childExtra = {} } = {}) {
  const main = quietMain({ vendor });
  main.blocks.push(toolCall("main", 90, 2, { name: vendor === "claude" ? "Agent" : "spawn_agent", kind: "agent", args: "explore", toolUseId: "tu_agent" }));
  main.blocks.push(blk("main", 91, "subagent_handoff", handoffTokens, 3, { agentId: "a1", label: "explore" }));
  main.blocks.push(...parentExtraBlocks);
  const child = scope("a1", {
    agentType: "explore",
    launchedAtRequest: 2,
    deliveredAtRequest: 3,
    requests: [req(0, Math.min(15_000, childPeak)), req(1, childPeak)],
    blocks: [blk("a1", 0, "user", 300, 0), ...childBlocks],
    handoff: { blockId: "main:91", tokens: { value: handoffTokens, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } },
    ...childExtra,
  });
  return [scope("main", main), child];
}

function compaction(id, atRequest, minute, pre = 180_000, post = 20_000) {
  return { id, at: at(minute), atRequest, trigger: "auto", preTokens: { value: pre, provenance: "observed.vendor" }, postTokens: { value: post, provenance: "observed.vendor" }, droppedTokens: { value: pre - post, provenance: "derived.exact" } };
}

function fileReads(scopeId, startSeq, request, targets, tokens = 1_500) {
  const blocks = [];
  let seq = startSeq;
  for (const target of targets) {
    blocks.push(...callAndResult(scopeId, seq, request, { name: "Read", kind: "file", target, resultTokens: tokens }));
    seq += 2;
  }
  return blocks;
}


/** N sibling subagents under main, each with its own handoff block; `child(i)` returns extra per-child fields. */
function withChildren({ vendor = "claude", count, handoffTokens = 800, childPeak = 40_000, child = () => ({}) } = {}) {
  const main = quietMain({ vendor });
  const scopes = [];
  for (let i = 0; i < count; i += 1) {
    const id = `a${i + 1}`;
    const extra = child(i);
    const tokens = extra.handoffTokens ?? handoffTokens;
    const callSeq = 90 + i * 2;
    main.blocks.push(toolCall("main", callSeq, 2, { name: vendor === "claude" ? "Agent" : "spawn_agent", kind: "agent", args: `explore-${i}`, toolUseId: `tu_agent_${id}` }));
    main.blocks.push(blk("main", callSeq + 1, "subagent_handoff", tokens, 3, { agentId: id, label: `explore-${i}` }));
    scopes.push(scope(id, {
      agentType: extra.agentType ?? "explore",
      launchedAtRequest: 2,
      deliveredAtRequest: 3,
      requests: [req(0, Math.min(15_000, childPeak)), req(1, extra.childPeak ?? childPeak)],
      blocks: [blk(id, 0, "user", 300, 0), ...(extra.blocks ?? [])],
      handoff: { blockId: `main:${callSeq + 1}`, tokens: { value: tokens, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } },
    }));
  }
  return [scope("main", main), ...scopes];
}

/** `count` fat shell results in one scope, sizes descending from `top` in steps of `step`, spread over requests 1..4. */
function fatShellResults(scopeId, count, { top = 22_000, step = 1_000, startSeq = 50, name = "Bash" } = {}) {
  const blocks = [];
  for (let i = 0; i < count; i += 1) {
    blocks.push(...callAndResult(scopeId, startSeq + i * 2, 1 + (i % 4), { name, kind: "shell", args: `cmd ${i}`, resultTokens: top - i * step }));
  }
  return blocks;
}

export const scenarios = {
  // --- baseline ---
  "quiet": ({ vendor }) => makeRun({ vendor, scopes: [scope("main", quietMain({ vendor }))] }),

  // --- B-01 fat tool result ---
  "B-01-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: vendor === "claude" ? "Bash" : "exec_command", kind: "shell", args: "npm test", resultTokens: 9_500 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-01-quiet": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: "Bash", kind: "shell", args: "npm test", resultTokens: 7_900 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },

  // --- B-02 repeated fat results (five shell results over 3k, each under the B-01 limit) ---
  "B-02-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    for (let i = 0; i < 5; i += 1) main.blocks.push(...callAndResult("main", 50 + i * 2, 1 + (i % 4), { name: "Bash", kind: "shell", args: `cmd ${i}`, resultTokens: 3_500 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-02-quiet": ({ vendor }) => {
    const main = quietMain({ vendor });
    for (let i = 0; i < 4; i += 1) main.blocks.push(...callAndResult("main", 50 + i * 2, 1 + (i % 4), { name: "Bash", kind: "shell", args: `cmd ${i}`, resultTokens: 3_500 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },

  // --- B-03 huge file read ---
  "B-03-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: "Read", kind: "file", target: "package-lock.json", resultTokens: 25_000 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-03-quiet": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: "Bash", kind: "shell", args: "cat big.log", resultTokens: 25_000 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },

  // --- B-04 repeated identical tool call ---
  "B-04-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    for (let i = 0; i < 3; i += 1) main.blocks.push(...callAndResult("main", 50 + i * 2, 1 + i, { name: "Bash", kind: "shell", args: "git status", resultTokens: 300 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-04-quiet": ({ vendor }) => {
    const main = quietMain({ vendor });
    for (let i = 0; i < 2; i += 1) main.blocks.push(...callAndResult("main", 50 + i * 2, 1 + i, { name: "Bash", kind: "shell", args: "git status", resultTokens: 300 }));
    main.blocks.push(...callAndResult("main", 60, 3, { name: "Bash", kind: "shell", args: "git status --short", resultTokens: 300 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-04-subagent-fires": ({ vendor }) => {
    const child = [];
    for (let i = 0; i < 3; i += 1) child.push(...callAndResult("a1", 10 + i * 2, 0, { name: "Bash", kind: "shell", args: "ls", resultTokens: 200 }));
    return makeRun({ vendor, scopes: withSubagent({ vendor, childBlocks: child }) });
  },

  // --- B-05 fat subagent handoff ---
  "B-05-fires": ({ vendor }) => makeRun({ vendor, scopes: withSubagent({ vendor, handoffTokens: 6_000, childPeak: 40_000 }) }),
  "B-05-share-fires": ({ vendor }) => makeRun({ vendor, scopes: withSubagent({ vendor, handoffTokens: 3_000, childPeak: 6_000 }) }),
  "B-05-quiet": ({ vendor }) => makeRun({ vendor, scopes: withSubagent({ vendor, handoffTokens: 1_000, childPeak: 40_000 }) }),

  // --- B-06 subagent re-reads parent files (parent read src/file0..4 before launching at request 2) ---
  "B-06-fires": ({ vendor }) => makeRun({ vendor, scopes: withSubagent({ vendor, childBlocks: fileReads("a1", 10, 0, ["src/file0.ts", "src/file1.ts", "src/other.ts"]).concat(fileReads("a1", 20, 1, ["src/file2.ts"])) }) }),
  "B-06-quiet": ({ vendor }) => makeRun({ vendor, scopes: withSubagent({ vendor, childBlocks: fileReads("a1", 10, 0, ["src/file0.ts", "src/file1.ts", "src/new.ts", "src/file4.ts"]) }) }),

  // --- B-07 frequent compaction ---
  "B-07-fires": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 12; i += 1) requests.push(req(i, i % 4 === 3 ? 30_000 : 150_000 + i * 2_000, { minute: i * 5 }));
    const blocks = [blk("main", 0, "user", 300, 0)];
    const compactions = [compaction("c1", 3, 14), compaction("c2", 7, 34), compaction("c3", 11, 54)];
    compactions.forEach((c, i) => { blocks.push(blk("main", 1 + i, "compaction_summary", 5_000, c.atRequest)); c.summaryBlockId = `main:${1 + i}`; });
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks, compactions })] });
  },
  "B-07-rate-fires": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 8; i += 1) requests.push(req(i, i % 4 === 3 ? 30_000 : 150_000, { minute: i * 5 }));
    const blocks = [blk("main", 0, "user", 300, 0), blk("main", 1, "compaction_summary", 5_000, 3), blk("main", 2, "compaction_summary", 5_000, 7)];
    const compactions = [{ ...compaction("c1", 3, 14), summaryBlockId: "main:1" }, { ...compaction("c2", 7, 34), summaryBlockId: "main:2" }];
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks, compactions })] });
  },
  "B-07-quiet": ({ vendor }) => {
    // One compaction in a 5-hour session: neither branch fires.
    const requests = [];
    for (let i = 0; i < 12; i += 1) requests.push(req(i, i === 6 ? 30_000 : 100_000, { minute: i * 27 }));
    const blocks = [blk("main", 0, "user", 300, 0), blk("main", 1, "compaction_summary", 5_000, 6)];
    const compactions = [{ ...compaction("c1", 6, 160), summaryBlockId: "main:1" }];
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks, compactions })] });
  },

  // --- B-08 running hot ---
  "B-08-fires": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 13; i += 1) requests.push(req(i, i < 2 ? 100_000 : 165_000 + i * 500));
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
  },
  "B-08-quiet": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 13; i += 1) requests.push(req(i, i % 5 === 0 ? 100_000 : 170_000));
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
  },

  // --- B-09 cache churn (claude only): after request 5, half the requests rewrite 40% of the prefix with no new blocks ---
  "B-09-fires": ({ vendor }) => {
    const requests = [];
    const blocks = [blk("main", 0, "user", 300, 0)];
    for (let i = 0; i < 15; i += 1) {
      const churn = i >= 5 && i % 2 === 1;
      requests.push(req(i, 100_000, { cacheCreation: churn ? 40_000 : 200, input: 100 }));
      if (!churn && i > 0) blocks.push(blk("main", i, "user", 150, i));
    }
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks })] });
  },
  "B-09-quiet": ({ vendor }) => {
    // Large cache writes are explained by large new blocks.
    const requests = [];
    const blocks = [blk("main", 0, "user", 300, 0)];
    for (let i = 0; i < 15; i += 1) {
      const big = i >= 5 && i % 2 === 1;
      requests.push(req(i, 100_000, { cacheCreation: big ? 40_000 : 200, input: 100 }));
      if (i > 0) blocks.push(...callAndResult("main", 10 + i * 2, i, { name: "Read", kind: "file", target: `src/f${i}.ts`, resultTokens: big ? 39_000 : 100 }));
    }
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks })] });
  },

  // --- B-10 system share high ---
  // Reconciliation v2 caps `system` at the vendor baseline (25k claude / 8k codex); the rest of H is
  // instructions (from the estimate) and then `unlogged`. 45k of instructions puts system + instructions
  // over 25% of the 200k window for both vendors.
  "B-10-fires": ({ vendor }) => {
    const main = quietMain({ vendor, base: 80_000 });
    return makeRun({ vendor, scopes: [scope("main", main)], instructionTokensEstimate: 45_000 });
  },
  "B-10-quiet": ({ vendor }) => makeRun({ vendor, scopes: [scope("main", quietMain({ vendor, base: 20_000 }))] }),

  // --- B-11 turn overhead ---
  "B-11-fires": ({ vendor }) => {
    const requests = [];
    const blocks = [blk("main", 0, "user", 300, 0)];
    for (let i = 0; i < 12; i += 1) {
      requests.push(req(i, 120_000, { turn: i + 1 }));
      if (i > 0) blocks.push(blk("main", i, "user", 20, i));
    }
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks })] });
  },
  "B-11-quiet": ({ vendor }) => {
    const requests = [];
    const blocks = [blk("main", 0, "user", 300, 0)];
    for (let i = 0; i < 12; i += 1) {
      requests.push(req(i, 120_000, { turn: i + 1 }));
      if (i > 0) blocks.push(blk("main", i, "user", 200, i));
    }
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks })] });
  },

  // --- B-12 tool results dominate at peak ---
  // Totals match H + visible so nothing is attributed to `unlogged`: at request 3 the visible stack is
  // 400 + 3 × 1,260 + 3 × 12,060 = 40,360 on top of H = 18,340, and tool results are 39,600 of 58,700 (67%).
  "B-12-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 1, { name: "Bash", kind: "shell", args: "npm test", resultTokens: 12_000 }));
    main.blocks.push(...callAndResult("main", 52, 2, { name: "Read", kind: "file", target: "src/big.ts", resultTokens: 12_000 }));
    main.blocks.push(...callAndResult("main", 54, 3, { name: "Bash", kind: "shell", args: "npm run lint", resultTokens: 12_000 }));
    main.requests[3] = req(3, 58_700);
    main.requests[4] = req(4, 58_700);
    main.requests[5] = req(5, 58_700);
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-12-quiet": ({ vendor }) => makeRun({ vendor, scopes: [scope("main", quietMain({ vendor }))] }),

  // --- B-13 session too long ---
  "B-13-fires": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 20; i += 1) requests.push(req(i, 160_000, { minute: i * 4 })); // 76 active minutes: past the one-hour floor of the token branch
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
  },
  "B-13-hours-fires": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 12; i += 1) requests.push(req(i, i % 6 === 5 ? 30_000 : 120_000, { minute: i * 25 }));
    const blocks = [blk("main", 0, "user", 300, 0), blk("main", 1, "compaction_summary", 5_000, 5), blk("main", 2, "compaction_summary", 5_000, 11)];
    const compactions = [{ ...compaction("c1", 5, 120), summaryBlockId: "main:1" }, { ...compaction("c2", 11, 270), summaryBlockId: "main:2" }];
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks, compactions })] });
  },
  "B-13-quiet": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 12; i += 1) requests.push(req(i, 120_000, { minute: i * 25 }));
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
  },

  // --- B-14 search flood ---
  "B-14-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: vendor === "claude" ? "Grep" : "exec_command", kind: "search", args: "rg TODO", resultTokens: 5_000 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-14-quiet": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: "Grep", kind: "search", args: "rg TODO", resultTokens: 3_000 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },

  // --- B-15 parallel duplicate work ---
  "B-15-fires": ({ vendor }) => {
    const scopes = withSubagent({ vendor, childBlocks: fileReads("a1", 10, 0, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) });
    scopes[0].blocks.push(toolCall("main", 92, 2, { name: "Agent", kind: "agent", args: "explore-2", toolUseId: "tu_agent2" }));
    scopes[0].blocks.push(blk("main", 93, "subagent_handoff", 700, 3, { agentId: "a2", label: "explore-2" }));
    scopes.push(scope("a2", {
      agentType: "explore",
      launchedAtRequest: 2,
      deliveredAtRequest: 3,
      requests: [req(0, 15_000), req(1, 30_000)],
      blocks: [blk("a2", 0, "user", 300, 0), ...fileReads("a2", 10, 0, ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"])],
      handoff: { blockId: "main:93", tokens: { value: 700, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } },
    }));
    return makeRun({ vendor, scopes });
  },
  "B-15-quiet": ({ vendor }) => {
    const scopes = withSubagent({ vendor, childBlocks: fileReads("a1", 10, 0, ["src/a.ts", "src/b.ts", "src/x.ts"]) });
    scopes[0].blocks.push(toolCall("main", 92, 2, { name: "Agent", kind: "agent", args: "explore-2", toolUseId: "tu_agent2" }));
    scopes[0].blocks.push(blk("main", 93, "subagent_handoff", 700, 3, { agentId: "a2", label: "explore-2" }));
    scopes.push(scope("a2", {
      agentType: "explore",
      launchedAtRequest: 2,
      deliveredAtRequest: 3,
      requests: [req(0, 15_000), req(1, 30_000)],
      blocks: [blk("a2", 0, "user", 300, 0), ...fileReads("a2", 10, 0, ["src/a.ts", "src/y.ts", "src/z.ts"])],
      handoff: { blockId: "main:93", tokens: { value: 700, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } },
    }));
    return makeRun({ vendor, scopes });
  },

  // --- aggregation (ADR-002 B): many occurrences collapse into one finding per (rule, run, scope) ---
  "B-01-many": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...fatShellResults("main", 14, { name: vendor === "claude" ? "Bash" : "exec_command" }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-01-subagent-many": ({ vendor }) => makeRun({ vendor, scopes: withSubagent({ vendor, childBlocks: fatShellResults("a1", 6, { top: 9_900, step: 100, startSeq: 10 }) }) }),
  // Single 12k block on a 200k window: 12k >= max(8k, 5% × 200k = 10k) → high. B-01-fires (9.5k) stays medium.
  "B-01-high": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: "Bash", kind: "shell", args: "npm test", resultTokens: 12_000 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-03-many": ({ vendor }) => {
    const main = quietMain({ vendor });
    ["package-lock.json", "dist/bundle.js", "fixtures/big.json"].forEach((target, i) => main.blocks.push(...callAndResult("main", 50 + i * 2, 1 + i, { name: "Read", kind: "file", target, resultTokens: 25_000 + i * 5_000 })));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  // 25k read on a 1M window: below 5% of the window → medium.
  "B-03-1m-window": ({ vendor }) => {
    const main = quietMain({ vendor });
    main.blocks.push(...callAndResult("main", 50, 2, { name: "Read", kind: "file", target: "package-lock.json", resultTokens: 25_000 }));
    return makeRun({ vendor, window: 1_000_000, scopes: [scope("main", main)] });
  },
  "B-04-many": ({ vendor }) => {
    const main = quietMain({ vendor });
    let seq = 50;
    for (let g = 0; g < 7; g += 1) {
      for (let i = 0; i < 3; i += 1) { main.blocks.push(...callAndResult("main", seq, 1 + i, { name: "Bash", kind: "shell", args: `cmd-${g}`, resultTokens: 100 * (g + 1) })); seq += 2; }
    }
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  // Three explore children with fat handoffs and one planner: one finding per agent type.
  "B-05-many": ({ vendor }) => makeRun({ vendor, scopes: withChildren({ vendor, count: 4, child: (i) => (i === 3 ? { agentType: "planner", handoffTokens: 5_000 } : { handoffTokens: 6_000 + i * 1_000 }) }) }),
  "B-08-many": ({ vendor }) => {
    // Three hot streaks (11, 12, 10 requests) separated by single cool requests.
    const requests = [];
    const plan = [11, 1, 12, 1, 10];
    let index = 0;
    plan.forEach((n, k) => { for (let i = 0; i < n; i += 1) { requests.push(req(index, k % 2 === 0 ? 165_000 + i * 500 : 100_000)); index += 1; } });
    return makeRun({ vendor, scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
  },
  "B-14-many": ({ vendor }) => {
    const main = quietMain({ vendor });
    for (let i = 0; i < 6; i += 1) main.blocks.push(...callAndResult("main", 50 + i * 2, 1 + (i % 4), { name: vendor === "claude" ? "Grep" : "exec_command", kind: "search", args: `rg pattern-${i}`, resultTokens: 5_000 + i * 500 }));
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  // Four siblings all reading the same three files: six overlapping pairs under one parent.
  "B-15-many": ({ vendor }) => makeRun({ vendor, scopes: withChildren({ vendor, count: 4, child: (i) => ({ blocks: fileReads(`a${i + 1}`, 10, 0, ["src/a.ts", "src/b.ts", "src/c.ts", `src/only-${i}.ts`]) }) }) }),

  // --- B-16 unlogged context (reconciliation v2 fields are set on the finalized run; the IR stream computes them) ---
  "B-16-share-fires": ({ vendor }) => {
    const run = makeRun({ vendor, scopes: [scope("main", quietMain({ vendor, base: 60_000 }))] });
    run.scopes[0].unloggedShare = 0.3;
    run.scopes[0].baseSteps = [];
    run.scopes[0].resumed = true;
    return run;
  },
  "B-16-steps-fires": ({ vendor }) => {
    const run = makeRun({ vendor, scopes: [scope("main", quietMain({ vendor }))] });
    run.scopes[0].unloggedShare = 0.05;
    run.scopes[0].baseSteps = [{ atRequest: 1, delta: 33_000 }, { atRequest: 4, delta: -12_000 }];
    run.scopes[0].resumed = false;
    return run;
  },
  "B-16-subagent-fires": ({ vendor }) => {
    const run = makeRun({ vendor, scopes: withSubagent({ vendor }) });
    run.scopes[1].unloggedShare = 0.4;
    run.scopes[1].baseSteps = [{ atRequest: 0, delta: 16_000 }];
    run.scopes[1].resumed = true;
    return run;
  },
  "B-16-quiet": ({ vendor }) => {
    const run = makeRun({ vendor, scopes: [scope("main", quietMain({ vendor }))] });
    run.scopes[0].unloggedShare = 0.1;
    run.scopes[0].baseSteps = [];
    run.scopes[0].resumed = false;
    return run;
  },
  // --- B-17 tool arguments dominate at peak: three 12k Write payloads (tool_call) on a quiet main scope ---
  "B-17-fires": ({ vendor }) => {
    const main = quietMain({ vendor });
    const name = vendor === "claude" ? "Write" : "apply_patch";
    main.blocks.push(toolCall("main", 50, 1, { name, kind: "edit", target: "src/generated/a.ts", estTokens: 12_000 }));
    main.blocks.push(toolCall("main", 51, 2, { name, kind: "edit", target: "src/generated/b.ts", estTokens: 12_000 }));
    main.blocks.push(toolCall("main", 52, 3, { name, kind: "edit", target: "src/generated/c.ts", estTokens: 12_000 }));
    main.requests[3] = req(3, 60_000);
    main.requests[4] = req(4, 60_000);
    main.requests[5] = req(5, 60_000);
    return makeRun({ vendor, scopes: [scope("main", main)] });
  },
  "B-17-quiet": ({ vendor }) => makeRun({ vendor, scopes: [scope("main", quietMain({ vendor }))] }),

  // Codex legacy history_mode child: almost everything unlogged and no blocks → transcript incomplete, not a habit.
  "B-16-legacy-quiet": ({ vendor }) => {
    const requests = [];
    for (let i = 0; i < 10; i += 1) requests.push(req(i, 50_000));
    const run = makeRun({ vendor, scopes: [scope("main", { requests, blocks: [blk("main", 0, "user", 300, 0)] })] });
    run.scopes[0].unloggedShare = 0.95;
    run.scopes[0].transcriptIncomplete = true;
    for (const request of run.scopes[0].requests) request.newBlockIds = [];
    return run;
  },
};

export function makeScenario(name, { vendor = "claude", id } = {}) {
  const build = scenarios[name];
  if (!build) throw new Error(`unknown scenario ${name}`);
  const run = build({ vendor });
  if (id) { run.sessionId = id; run.id = `${vendor}:${id}`; }
  return run;
}

export function scenarioNames() {
  return Object.keys(scenarios);
}
