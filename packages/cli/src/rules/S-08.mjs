import { makeFinding, metricEvidence } from "../setup/findings.mjs";
import { MCP_TOKENS_PER_TOOL } from "../setup/budget.mjs";

function fixFor(server) {
  if (server.vendor === "codex") {
    return {
      platform: "codex",
      summary: `Disable ${server.name} for this project in config.toml and re-enable it on demand.`,
      path: server.scope === "user" ? "~/.codex/config.toml" : ".codex/config.toml",
      snippet: `[mcp_servers.${server.name}]\nenabled = false\n`,
    };
  }
  return {
    platform: "claude",
    summary: `Disable ${server.name} for this project (or rely on deferred tool loading) so its tool schemas stop entering every request.`,
    path: server.scope === "project" ? ".mcp.json" : ".claude/settings.local.json",
    snippet: server.scope === "project"
      ? `claude mcp remove ${server.name}\n# or move it to user scope: claude mcp add --scope user ${server.name} ...`
      : `{\n  "disabledMcpjsonServers": ["${server.name}"]\n}\n`,
  };
}

const rule = {
  id: "S-08",
  scope: "setup",
  severity: "medium",
  title: "MCP schema bloat",
  whyItMatters: "Every tool schema is prompt text on every request; a 40-tool server can cost more than the entire CLAUDE.md.",
  thresholdKeys: ["mcpToolsPerServer", "mcpToolsTotal"],
  evaluate(input, thresholds) {
    const servers = input.setup?.mcpServers ?? [];
    const observed = input.sessionStats?.mcpToolsObserved ?? {};
    const findings = [];
    let total = 0;
    const counted = [];
    for (const server of servers) {
      const tools = server.toolsObserved?.length ? server.toolsObserved : (observed[server.name] ?? []);
      if (!tools.length) continue;
      total += tools.length;
      counted.push({ server, tools: tools.length });
      if (tools.length > thresholds.mcpToolsPerServer) {
        findings.push(makeFinding(rule, {
          primaryRef: `mcp:${server.name}`,
          vendor: server.vendor ?? "claude",
          tokensAffected: tools.length * MCP_TOKENS_PER_TOOL,
          evidence: [
            metricEvidence(`mcp:${server.name}`, `${server.name} exposes ${tools.length} tools observed in sessions (threshold ${thresholds.mcpToolsPerServer})`, tools.length, "count", "derived.exact"),
            metricEvidence(`mcp:${server.name}`, `~${tools.length * MCP_TOKENS_PER_TOOL} est. tokens of schema per request`, tools.length * MCP_TOKENS_PER_TOOL, "tokens", "estimated.local"),
          ],
          fix: fixFor(server),
        }));
      }
    }
    if (total > thresholds.mcpToolsTotal && counted.length) {
      const biggest = [...counted].sort((a, b) => b.tools - a.tools)[0].server;
      findings.push(makeFinding(rule, {
        primaryRef: "mcp:total",
        title: "MCP tool schemas exceed the startup budget",
        tokensAffected: total * MCP_TOKENS_PER_TOOL,
        evidence: [
          metricEvidence("mcp:total", `${total} MCP tool schemas across ${counted.length} server(s) (threshold ${thresholds.mcpToolsTotal})`, total, "count", "derived.exact"),
          ...counted.map(c => metricEvidence(`mcp:${c.server.name}`, `${c.server.name}: ${c.tools} tools`, c.tools, "count", "derived.exact")),
        ],
        fix: fixFor(biggest),
      }));
    }
    return findings;
  },
};

export default rule;
