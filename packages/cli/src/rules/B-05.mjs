import { countedTitle, formatTokens, makeFinding, percent, platformFix, scopeEvidence, subagentScopes, sum, topBy } from "./util.mjs";

const RETURN_RULE = "Return findings only: file:line references, decisions, and open questions. Under 600 words. Do not paste file contents or tool output.";

/** The agent file from the setup inventory, when one exists; built-in agent types have no file. */
function agentFile(setup, agentType) {
  if (!agentType || !Array.isArray(setup?.agents)) return undefined;
  const agent = setup.agents.find((a) => a?.name === agentType && typeof a.path === "string");
  return agent?.path;
}

/** One finding per (run, agentType); the children over threshold are the occurrences, the fattest handoffs the evidence. */
export default {
  id: "B-05",
  scope: "subagent",
  severity: "high",
  title: "Fat subagent handoff",
  whyItMatters: "A subagent exists to isolate context; a fat handoff moves the child's context into the parent and defeats the purpose.",
  thresholdKeys: ["fatHandoffTokens", "fatHandoffShare"],
  evaluate({ run, setup }, thresholds) {
    if (!run) return [];
    const byType = new Map();
    for (const scope of subagentScopes(run)) {
      const handoff = scope.handoff;
      if (!handoff || !handoff.tokens) continue;
      const tokens = handoff.tokens.value;
      const peak = scope.peak?.value ?? 0;
      const share = peak > 0 ? tokens / peak : 0;
      if (!(tokens > thresholds.fatHandoffTokens) && !(peak > 0 && share > thresholds.fatHandoffShare)) continue;
      const key = scope.agentType ?? "";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push({ scope, tokens, peak, share, handoff });
    }
    const findings = [];
    for (const [agentType, hits] of byType) {
      const top = topBy(hits, (h) => h.tokens);
      const evidence = top.map(({ scope, tokens, peak, share, handoff }) => scopeEvidence(run, scope, {
        label: `${agentType || "subagent"} ${scope.id}: handoff ${formatTokens(tokens)}, ${percent(share)} of the child's peak ${formatTokens(peak)}${handoff.compressionRatio?.value ? ` (${handoff.compressionRatio.value}x compression)` : ""}`,
        value: tokens,
        provenance: handoff.tokens.provenance,
      }));
      const agentName = agentType || "the subagent";
      const path = agentFile(setup, agentType);
      findings.push(makeFinding(this, run, {
        scope: "subagent",
        scopeId: top[0].scope.id,
        primaryRef: `${run.id}#agentType:${agentType}`,
        count: hits.length,
        title: countedTitle(this, hits.length),
        evidence,
        tokensAffected: sum(hits.map((h) => h.tokens)),
        fix: platformFix(run, {
          claude: path
            ? { summary: `Require ${agentName} to return findings only, not transcripts; add this line to ${path}.`, path, snippet: RETURN_RULE }
            : { summary: `Require ${agentName} to return findings only, not transcripts; put it in the Agent prompt.`, snippet: `Agent { ${agentType ? `subagent_type: "${agentType}", ` : ""}description: "<task>", prompt: "<task>. ${RETURN_RULE}" }` },
          codex: { summary: `Instruct ${agentName} to return a short summary, not its transcript.`, snippet: `spawn_agent prompt: "<task>. When you finish, reply with a summary only: paths, line references, decisions, open questions. Under 600 words. Never include raw tool output."` },
        }),
      }));
    }
    return findings;
  },
};
