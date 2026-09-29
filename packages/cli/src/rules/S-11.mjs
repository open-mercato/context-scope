import { makeFinding, metricEvidence } from "../setup/findings.mjs";
import { hookRunStats } from "../setup/config.mjs";

const rule = {
  id: "S-11",
  scope: "setup",
  severity: "medium",
  title: "Hook with large stdout",
  whyItMatters: "Hook stdout is injected into context every time it fires.",
  thresholdKeys: ["hookStdoutTokens", "hookStdoutShare"],
  evaluate(input, thresholds) {
    const hookRuns = input.sessionStats?.hookRuns;
    if (!hookRuns) return [];
    const findings = [];
    const seen = new Set();
    for (const hook of input.setup?.hooks ?? []) {
      const stats = hookRunStats(hook, hookRuns);
      if (!stats.stdoutTokens.length) continue;
      const over = stats.stdoutTokens.filter(t => t > thresholds.hookStdoutTokens).length;
      const share = over / stats.stdoutTokens.length;
      if (!(share > thresholds.hookStdoutShare)) continue;
      const ref = `hook:${hook.scope}:${hook.event}:${hook.matcher ?? ""}:${hook.command}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const sorted = [...stats.stdoutTokens].sort((a, b) => a - b);
      const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
      findings.push(makeFinding(rule, {
        primaryRef: ref,
        vendor: "claude",
        tokensAffected: p95,
        evidence: [
          metricEvidence(ref, `${hook.event}${hook.matcher ? ` (${hook.matcher})` : ""} hook "${hook.command}" exceeded ${thresholds.hookStdoutTokens} est. tokens in ${over} of ${stats.stdoutTokens.length} run(s) (${Math.round(share * 100)}%)`, Math.round(share * 100), "percent", "derived.exact"),
          metricEvidence(ref, `stdout p95: ${p95} est. tokens`, p95, "tokens", "estimated.local"),
        ],
        fix: {
          platform: "claude",
          summary: "Make the hook print only on failure or cap its output.",
          path: hook.scope === "user" ? "~/.claude/settings.json" : hook.scope === "local" ? ".claude/settings.local.json" : ".claude/settings.json",
          snippet: `{\n  "hooks": {\n    "${hook.event}": [{\n      ${hook.matcher ? `"matcher": "${hook.matcher}",\n      ` : ""}"hooks": [{ "type": "command", "command": "${hook.command.replace(/"/g, '\\"')} 2>&1 | tail -20" }]\n    }]\n  }\n}\n`,
        },
      }));
    }
    return findings;
  },
};

export default rule;
