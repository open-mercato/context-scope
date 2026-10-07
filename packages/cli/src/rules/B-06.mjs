import { blockEvidence, fileTargets, makeFinding, metricEvidence, platformFix, scopeById, scopeEvidence, subagentScopes, sum } from "./util.mjs";

function resultTokensFor(scope, call) {
  if (!call.toolUseId) return 0;
  return sum(scope.blocks.filter((b) => b.toolUseId === call.toolUseId && b.category.startsWith("tool_result.")).map((b) => b.estTokens));
}

export default {
  id: "B-06",
  scope: "subagent",
  severity: "medium",
  title: "Subagent re-reads parent files",
  whyItMatters: "Duplicate reads cost the child's window and time without adding information the parent lacked.",
  thresholdKeys: ["subagentRereadFiles"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const minFiles = thresholds.subagentRereadFiles;
    const findings = [];
    for (const child of subagentScopes(run)) {
      const parent = scopeById(run, child.parentScopeId ?? "main");
      if (!parent) continue;
      const launched = child.launchedAtRequest;
      const parentReads = fileTargets(parent.blocks.filter((b) => launched === undefined || b.firstRequest <= launched));
      const childReads = fileTargets(child.blocks);
      const shared = [...childReads.keys()].filter((target) => parentReads.has(target));
      if (shared.length < minFiles) continue;
      const childCalls = shared.map((target) => childReads.get(target));
      const tokens = sum(childCalls.map((call) => resultTokensFor(child, call)));
      const evidence = [
        scopeEvidence(run, child, { label: `${child.agentType ?? "subagent"} ${child.id} re-read ${shared.length} files the parent had already read`, value: shared.length, unit: "count", provenance: "observed.artifact" }),
        ...shared.slice(0, 10).map((target) => ({ kind: "file", ref: target, label: target, provenance: "observed.artifact" })),
        ...childCalls.slice(0, 5).map((call) => blockEvidence(run, call, { label: `child read ${call.tool.target} (request #${call.firstRequest})`, value: resultTokensFor(child, call) })),
        ...shared.slice(0, 5).map((target) => blockEvidence(run, parentReads.get(target), { label: `parent read ${target} (request #${parentReads.get(target).firstRequest})`, value: resultTokensFor(parent, parentReads.get(target)) })),
        metricEvidence(run, `rereadTokens.${child.id}`, tokens, { label: `re-read results in child: ${tokens.toLocaleString("en-US")} tok`, provenance: "estimated.local" }),
      ];
      const list = shared.slice(0, 3).join(", ");
      findings.push(makeFinding(this, run, {
        scope: "subagent",
        evidence,
        tokensAffected: tokens,
        fix: platformFix(run, {
          claude: { summary: "Pass excerpts or exact file:line targets in the Agent prompt; keep the child's task narrow.", snippet: `Agent { prompt: "Context you already have: ${list} (summarised here: <key facts>). Do not re-read them. Task: <narrow task>. Return findings only." }` },
          codex: { summary: "Pass excerpts or exact file:line targets when spawning; keep the child's task narrow.", snippet: `spawn_agent prompt: "Context you already have: ${list} (summarised: <key facts>). Do not re-read them. Task: <narrow task>. Return a summary only."` },
        }),
      }));
    }
    return findings;
  },
};
