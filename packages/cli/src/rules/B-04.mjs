import { MAX_AGGREGATED_EVIDENCE, countedTitle, findingScopeFor, formatTokens, makeFinding, metricEvidence, platformFix, scopeEvidence, scopeRef, sum, topBy } from "./util.mjs";

/** One finding per scope; each identical-argument group is one occurrence, the top groups by resent tokens are the evidence. */
export default {
  id: "B-04",
  scope: "session",
  severity: "medium",
  title: "Repeated identical tool call",
  whyItMatters: "Identical calls resend identical results; each is a fresh block in the window.",
  thresholdKeys: ["repeatedIdenticalCalls"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const minCount = thresholds.repeatedIdenticalCalls;
    const findings = [];
    for (const scope of run.scopes) {
      const byKey = new Map();
      for (const block of scope.blocks) {
        if (block.category !== "tool_call" || !block.tool?.name || !block.tool.argsHash) continue;
        const key = `${block.tool.name} ${block.tool.argsHash}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(block);
      }
      const groups = [];
      for (const calls of byKey.values()) {
        if (calls.length < minCount) continue;
        const ids = new Set(calls.map((c) => c.toolUseId).filter(Boolean));
        const results = scope.blocks.filter((b) => b.toolUseId && ids.has(b.toolUseId) && b.category.startsWith("tool_result."));
        const tokens = sum(results.map((b) => b.estTokens)) || sum(calls.map((c) => c.estTokens));
        groups.push({ calls, tokens, first: calls[0] });
      }
      if (!groups.length) continue;
      const slots = scope.kind === "subagent" ? MAX_AGGREGATED_EVIDENCE - 1 : MAX_AGGREGATED_EVIDENCE;
      const evidence = topBy(groups, (g) => g.tokens, slots).map(({ calls, tokens, first }) => {
        const name = first.tool.name;
        const target = first.tool.target;
        const requests = calls.map((c) => `#${c.firstRequest}`).join(", ");
        return metricEvidence(run, `identicalCalls.${scope.id}.${first.tool.argsHash}`, calls.length, {
          label: `${name}${target ? ` ${target}` : ""} ×${calls.length} with identical arguments (requests ${requests}), ${formatTokens(tokens)} resent`,
          unit: "count",
        });
      });
      if (scope.kind === "subagent") evidence.push(scopeEvidence(run, scope));
      const worst = topBy(groups, (g) => g.tokens, 1)[0].first;
      const name = worst.tool.name;
      const target = worst.tool.target;
      const isShell = worst.tool.kind === "shell";
      const ruleLine = `- Do not re-run ${name}${target ? ` on ${target}` : ""} with the same arguments; note the result in the plan and reuse it.`;
      findings.push(makeFinding(this, run, {
        scope: findingScopeFor(scope),
        scopeId: scope.id,
        primaryRef: scopeRef(run, scope),
        count: groups.length,
        title: countedTitle(this, groups.length),
        evidence,
        tokensAffected: sum(groups.map((g) => g.tokens)),
        fix: platformFix(run, {
          claude: isShell
            ? { summary: "Wait on the condition instead of polling with Bash; note the outcome once.", snippet: `Monitor { command: "${target ?? "<the same command>"}", until: "<condition>" }` }
            : { summary: `Add a rule to CLAUDE.md so the ${name} result is recorded once and reused.`, snippet: ruleLine },
          codex: isShell
            ? { summary: "Wait inside one command instead of polling; note the outcome once.", snippet: "until <condition>; do sleep 5; done" }
            : { summary: `Add a rule to AGENTS.md so the ${name} result is recorded once and reused.`, snippet: ruleLine },
        }),
      }));
    }
    return findings;
  },
};
