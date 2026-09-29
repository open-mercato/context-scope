import { countedTitle, fileTargets, formatTokens, makeFinding, metricEvidence, platformFix, scopeById, scopeRef, shellCommands, subagentScopes, sum, topBy } from "./util.mjs";

function resultTokensFor(scope, call) {
  if (!call?.toolUseId) return 0;
  return sum(scope.blocks.filter((b) => b.toolUseId === call.toolUseId && b.category.startsWith("tool_result.")).map((b) => b.estTokens));
}

/** One finding per parent scope; each overlapping sibling pair is an occurrence, the top pairs by duplicated tokens are the evidence. */
export default {
  id: "B-15",
  scope: "subagent",
  severity: "low",
  title: "Parallel duplicate work",
  whyItMatters: "Parallel agents that duplicate work double cost without adding coverage.",
  thresholdKeys: ["parallelDuplicateFiles"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const minShared = thresholds.parallelDuplicateFiles;
    const byParent = new Map();
    for (const child of subagentScopes(run)) {
      const parent = child.parentScopeId ?? "main";
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(child);
    }
    const findings = [];
    for (const [parentId, siblings] of byParent) {
      const pairs = [];
      for (let i = 0; i < siblings.length; i += 1) {
        for (let j = i + 1; j < siblings.length; j += 1) {
          const a = siblings[i];
          const b = siblings[j];
          const filesA = fileTargets(a.blocks);
          const filesB = fileTargets(b.blocks);
          const sharedFiles = [...filesA.keys()].filter((t) => filesB.has(t));
          const cmdA = shellCommands(a.blocks);
          const cmdB = shellCommands(b.blocks);
          const sharedCmds = [...cmdA.keys()].filter((h) => cmdB.has(h));
          if (sharedFiles.length < minShared && sharedCmds.length < minShared) continue;
          const tokens = sum(sharedFiles.map((t) => resultTokensFor(b, filesB.get(t)))) + sum(sharedCmds.map((h) => resultTokensFor(b, cmdB.get(h))));
          pairs.push({ a, b, sharedFiles, sharedCmds, tokens });
        }
      }
      if (!pairs.length) continue;
      const top = topBy(pairs, (p) => p.tokens);
      const evidence = top.map(({ a, b, sharedFiles, sharedCmds, tokens }) => metricEvidence(run, `parallelDuplicate.${a.id}.${b.id}`, sharedFiles.length + sharedCmds.length, {
        label: `${a.agentType ?? "subagent"} ${a.id} and ${b.agentType ?? "subagent"} ${b.id} share ${sharedFiles.length} file reads and ${sharedCmds.length} identical commands (${formatTokens(tokens)} duplicated${sharedFiles.length ? `: ${sharedFiles.slice(0, 3).join(", ")}${sharedFiles.length > 3 ? ", …" : ""}` : ""})`,
        unit: "count",
        provenance: "observed.artifact",
      }));
      const worst = top[0];
      const fileA = worst.sharedFiles[0] ?? "<dir A>";
      const parent = scopeById(run, parentId) ?? { id: parentId };
      findings.push(makeFinding(this, run, {
        scope: "subagent",
        scopeId: parent.id,
        primaryRef: scopeRef(run, parent),
        count: pairs.length,
        title: countedTitle(this, pairs.length),
        evidence,
        tokensAffected: sum(pairs.map((p) => p.tokens)),
        fix: platformFix(run, {
          claude: { summary: "Give each Agent a disjoint scope in its prompt.", snippet: `Agent { description: "<part A>", prompt: "Only cover ${fileA} and its callers; do not read <dir B>. Return findings only." }\nAgent { description: "<part B>", prompt: "Only cover <dir B>; do not read ${fileA}. Return findings only." }` },
          codex: { summary: "Give each spawned agent a disjoint scope in its prompt.", snippet: `spawn_agent A: "Only cover ${fileA} and its callers; do not read <dir B>. Return a summary only."\nspawn_agent B: "Only cover <dir B>; do not read ${fileA}. Return a summary only."` },
        }),
      }));
    }
    return findings;
  },
};
