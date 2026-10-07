import { makeFinding, metricEvidence } from "../setup/findings.mjs";
import { MCP_TOKENS_PER_TOOL, mcpToolCount } from "../setup/budget.mjs";

const rule = {
  id: "S-09",
  scope: "setup",
  severity: "medium",
  title: "MCP server unused",
  whyItMatters: "Pure schema cost with no observed benefit.",
  thresholdKeys: [],
  evaluate(input) {
    const stats = input.sessionStats;
    // Without indexed sessions there is no evidence of non-use.
    if (!stats || !(stats.sessionCount > 0)) return [];
    const invocations = stats.mcpInvocations ?? {};
    const findings = [];
    for (const server of input.setup?.mcpServers ?? []) {
      const count = Number(server.invocations30d ?? invocations[server.name] ?? 0) || 0;
      if (count > 0) continue;
      const codex = server.vendor === "codex";
      findings.push(makeFinding(rule, {
        primaryRef: `mcp:${server.vendor ?? "claude"}:${server.scope}:${server.name}`,
        vendor: server.vendor ?? "claude",
        tokensAffected: mcpToolCount(server) * MCP_TOKENS_PER_TOOL,
        evidence: [
          metricEvidence(`mcp:${server.name}`, `${server.name} (${server.scope} scope${server.transport ? `, ${server.transport}` : ""}) had 0 invocations across ${stats.sessionCount} indexed session(s)`, 0, "count", "derived.exact"),
          metricEvidence(`mcp:${server.name}`, `~${mcpToolCount(server) * MCP_TOKENS_PER_TOOL} est. schema tokens per request`, mcpToolCount(server) * MCP_TOKENS_PER_TOOL, "tokens", "estimated.local"),
        ],
        fix: codex ? {
          platform: "codex",
          summary: `Disable ${server.name} in config.toml; re-enable it when a task needs it.`,
          path: server.scope === "user" ? "~/.codex/config.toml" : ".codex/config.toml",
          snippet: `[mcp_servers.${server.name}]\nenabled = false\n`,
        } : {
          platform: "claude",
          summary: `Disable ${server.name} for this project; re-enable it on demand.`,
          path: ".claude/settings.local.json",
          snippet: `{\n  "disabledMcpjsonServers": ["${server.name}"]\n}\n`,
        },
      }));
    }
    return findings;
  },
};

export default rule;
