import { makeFinding, metricEvidence, percent, platformFix, requestEvidence, sum } from "./util.mjs";

// A request "churns" when cache_creation is a large share of the total while the
// new blocks explain less than half of it (deltaCheck = input + cacheCreation - est(new blocks)).
const UNEXPLAINED_SHARE = 0.5;

export default {
  id: "B-09",
  scope: "session",
  severity: "medium",
  title: "Cache churn",
  whyItMatters: "Cache misses cost more per token and signal that something upstream is invalidating the prefix every turn.",
  thresholdKeys: ["cacheChurnShare", "cacheChurnRequestShare", "cacheChurnMinRequest"],
  evaluate({ run }, thresholds) {
    if (!run || run.vendor !== "claude") return [];
    const findings = [];
    for (const scope of run.scopes) {
      const eligible = scope.requests.filter((r) => r.index >= thresholds.cacheChurnMinRequest && r.usage?.cacheCreation !== undefined && r.deltaCheck !== undefined && r.usage.total > 0);
      if (!eligible.length) continue;
      const churning = eligible.filter((r) => {
        const creation = r.usage.cacheCreation;
        if (creation / r.usage.total <= thresholds.cacheChurnShare) return false;
        const newContent = r.usage.input + creation - r.deltaCheck;
        return newContent < creation * UNEXPLAINED_SHARE;
      });
      const share = churning.length / eligible.length;
      if (share < thresholds.cacheChurnRequestShare) continue;
      const churnTokens = sum(churning.map((r) => r.usage.cacheCreation));
      const evidence = [
        metricEvidence(run, `cacheChurn.${scope.id}`, Number(share.toFixed(4)), { label: `${churning.length} of ${eligible.length} requests after #${thresholds.cacheChurnMinRequest} rewrite the cache with little new content (${percent(share)})`, unit: "ratio" }),
        metricEvidence(run, `cacheChurnTokens.${scope.id}`, churnTokens, { label: `${churnTokens.toLocaleString("en-US")} tok written to cache in those requests`, provenance: "observed.vendor" }),
        ...churning.slice(0, 6).map((r) => requestEvidence(run, scope, r, { label: `request #${r.index}: cache_creation ${r.usage.cacheCreation.toLocaleString("en-US")} of ${r.usage.total.toLocaleString("en-US")} tok, new content est. ${Math.max(0, r.usage.input + r.usage.cacheCreation - r.deltaCheck).toLocaleString("en-US")} tok`, value: r.usage.cacheCreation })),
      ];
      findings.push(makeFinding(this, run, {
        scope: scope.kind === "subagent" ? "subagent" : "session",
        evidence,
        tokensAffected: churnTokens,
        fix: platformFix(run, {
          claude: { summary: "Keep the prompt prefix stable: no timestamps or changing hook stdout early in the prompt, no MCP servers that mutate schemas.", snippet: "grep -n -A3 'SessionStart\\|UserPromptSubmit' .claude/settings.json ~/.claude/settings.json   # hooks whose stdout changes every turn (dates, git status)\nclaude mcp list   # servers whose tool schemas change mid-session" },
          codex: { summary: "Check for per-turn user_instructions changes (nested AGENTS.md swaps, changing environment context).", snippet: "find . -name AGENTS.md -newer ~/.codex/config.toml   # instruction files rewritten mid-session\n# and in AGENTS.md: \"- Never edit AGENTS.md files during a task; propose changes at the end.\"" },
        }),
      }));
    }
    return findings;
  },
};
