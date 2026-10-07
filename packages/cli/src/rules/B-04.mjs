import { MAX_AGGREGATED_EVIDENCE, countedTitle, findingScopeFor, formatTokens, isToolResult, makeFinding, metricEvidence, platformFix, scopeEvidence, scopeRef, sum, toolTarget, topBy } from "./util.mjs";

// Tools that re-sample state by design (browser screenshots, navigation, status checks): a repeat is a poll, not a cache miss.
const POLLING_TOOL = /screenshot|wait|sleep|poll|reload|navigate|status|monitor/i;
// A plain shell command keeps no command text in the IR (privacy), only a target when the parser found a path;
// this catches the few polls whose target or label still says so.
const POLLING_SHELL = /\b(?:sleep|wait|poll|watch|until)\b/i;

function isPolling(block) {
  if (POLLING_TOOL.test(block.tool.name)) return true;
  if (block.tool.kind !== "shell") return false;
  return [block.tool.target, block.label].some((text) => typeof text === "string" && POLLING_SHELL.test(text));
}

/**
 * One finding per scope; an occurrence is a group of calls with the same tool and argument hash
 * whose results were identical too (block `hash` is the sha1 of the result content). A command
 * repeated with results that differ is a legitimate re-check (polling, a build after edits); only
 * identical results are true cache misses. Calls without a logged result cannot be judged and are skipped.
 */
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
      const resultsByUse = new Map();
      for (const block of scope.blocks) {
        if (!block.toolUseId || !isToolResult(block)) continue;
        if (!resultsByUse.has(block.toolUseId)) resultsByUse.set(block.toolUseId, block);
      }
      const byKey = new Map();
      for (const block of scope.blocks) {
        if (block.category !== "tool_call" || !block.tool?.name || !block.tool.argsHash || !block.toolUseId) continue;
        if (isPolling(block)) continue;
        const result = resultsByUse.get(block.toolUseId);
        if (!result) continue;
        const key = `${block.tool.name} ${block.tool.argsHash} ${result.hash}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ call: block, result });
      }
      const groups = [];
      for (const hits of byKey.values()) {
        if (hits.length < minCount) continue;
        const tokens = sum(hits.map(({ result }) => result.estTokens)) || sum(hits.map(({ call }) => call.estTokens));
        groups.push({ calls: hits.map(({ call }) => call), tokens, first: hits[0].call });
      }
      if (!groups.length) continue;
      const slots = scope.kind === "subagent" ? MAX_AGGREGATED_EVIDENCE - 1 : MAX_AGGREGATED_EVIDENCE;
      const evidence = topBy(groups, (g) => g.tokens, slots).map(({ calls, tokens, first }) => {
        const name = first.tool.name;
        const target = toolTarget(first);
        const requests = calls.map((c) => `#${c.firstRequest}`).join(", ");
        return metricEvidence(run, `identicalCalls.${scope.id}.${first.tool.argsHash}`, calls.length, {
          label: `${name}${target ? ` ${target}` : ""} ×${calls.length} with identical arguments and identical results (requests ${requests}), ${formatTokens(tokens)} resent`,
          unit: "count",
        });
      });
      if (scope.kind === "subagent") evidence.push(scopeEvidence(run, scope));
      const worst = topBy(groups, (g) => g.tokens, 1)[0].first;
      const name = worst.tool.name;
      const target = toolTarget(worst);
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
          claude: { summary: `Add a rule to CLAUDE.md so the ${name} result is recorded once and reused.`, snippet: ruleLine },
          codex: { summary: `Add a rule to AGENTS.md so the ${name} result is recorded once and reused.`, snippet: ruleLine },
          subagent: {
            claude: { summary: `Add this line to the agent definition (.claude/agents/<type>.md, or the Agent prompt) so the ${name} result is recorded once and reused.`, snippet: ruleLine },
            codex: { summary: `Add this line to the spawn prompt so the ${name} result is recorded once and reused.`, snippet: ruleLine },
          },
        }, { scope }),
      }));
    }
    return findings;
  },
};
