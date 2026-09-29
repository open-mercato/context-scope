import { makeHabitFinding, metricEvidence, recordTime, runEvidence } from "./habits.mjs";

/**
 * `disabledMcpjsonServers` only applies to `.mcp.json` (project-scope) servers;
 * user- and local-scope servers live in `~/.claude.json` and are removed with
 * `claude mcp remove -s <scope>` (review #8).
 */
function fixFor(server) {
  if (server.vendor === "codex") {
    return { platform: "codex", path: server.scope === "user" ? "~/.codex/config.toml" : ".codex/config.toml", summary: `Disable ${server.name} for this project and re-enable it on demand.`, snippet: `[mcp_servers.${server.name}]\nenabled = false\n` };
  }
  if (server.scope === "project") {
    return {
      platform: "claude",
      path: ".claude/settings.local.json",
      summary: `Disable the project server ${server.name} (from .mcp.json) for yourself without editing the shared file, or remove it from .mcp.json for everyone.`,
      snippet: `{\n  "disabledMcpjsonServers": ["${server.name}"]\n}\n`,
    };
  }
  const scope = server.scope === "local" ? "local" : "user";
  return {
    platform: "claude",
    path: "~/.claude.json",
    summary: `Remove the ${scope}-scope server ${server.name} so its tool schemas stop entering every request; add it back when a task needs it.`,
    snippet: `claude mcp remove -s ${scope} ${server.name}`,
  };
}

export default {
  id: "H-06",
  scope: "habit",
  severity: "low",
  title: "MCP server never invoked",
  whyItMatters: "A configured server pays its schema cost on every request of every session; across many sessions with no call, that is pure overhead (S-09 shows the per-request estimate).",
  thresholdKeys: ["habitMcpUnusedSessions"],
  needs: (thresholds) => thresholds.habitMcpUnusedSessions ?? 5,
  evaluate({ habits, setup, thresholds }) {
    const minSessions = thresholds.habitMcpUnusedSessions ?? 5;
    const servers = Array.isArray(setup?.mcpServers) ? setup.mcpServers : [];
    if (!servers.length) return [];
    const findings = [];
    for (const server of servers) {
      if (!server?.name) continue;
      const vendor = server.vendor ?? "claude";
      const records = (habits ?? []).filter((record) => record.vendor === vendor);
      if (records.length < minSessions) continue;
      if (records.some((record) => (record.habits?.mcp?.invoked ?? []).includes(server.name))) continue;
      const recent = [...records].sort((a, b) => recordTime(b) - recordTime(a)).slice(0, 5);
      findings.push(makeHabitFinding(this, {
        primaryRef: `habit:H-06:${vendor}:${server.scope ?? ""}:${server.name}`,
        records,
        title: `${this.title}: ${server.name}`,
        evidence: [
          metricEvidence(this.id, server.name, `${server.name} (${server.scope ?? "?"} scope) invoked 0x across ${records.length} ${vendor} sessions`, 0),
          ...recent.map((record) => runEvidence(record, `no ${server.name} call`, { value: 0, unit: "count", provenance: "observed.artifact" })),
        ],
        fix: fixFor({ ...server, vendor }),
      }));
    }
    return findings;
  },
};
