import { formatTokens, makeHabitFinding, median, metricEvidence, platformOf, sum, topRunEvidence } from "./habits.mjs";

const RETURN_RULE = "Return findings only: file:line references, decisions, and open questions. Under 600 words. Do not paste file contents or tool output.";

/** Built-in Claude Code agent types: no `.claude/agents/<type>.md` exists for them; the rule goes to CLAUDE.md. */
const BUILTIN_AGENTS = new Set(["Explore", "general-purpose", "Plan", "claude", "statusline-setup", "claude-code-guide", "output-style-setup", "Bash", "Task"]);

function agentFile(setup, type) {
  const agent = Array.isArray(setup?.agents) ? setup.agents.find((a) => a?.name === type && typeof a.path === "string") : null;
  return agent?.path;
}

function fixPathFor(setup, type, platform) {
  const defined = agentFile(setup, type);
  if (defined) return defined;
  if (platform === "codex") return "AGENTS.md";
  return BUILTIN_AGENTS.has(type) ? "CLAUDE.md" : `.claude/agents/${type}.md`;
}

export default {
  id: "H-03",
  scope: "habit",
  severity: "high",
  title: "Subagent type with fat handoffs",
  whyItMatters: "One agent type returns a fat handoff in session after session: the fix belongs in that agent's definition, not in each prompt.",
  thresholdKeys: ["habitMinSessions", "fatHandoffTokens"],
  needs: (thresholds) => thresholds.habitMinSessions ?? 3,
  evaluate({ habits, setup, thresholds }) {
    const minSessions = thresholds.habitMinSessions ?? 3;
    const fatTokens = thresholds.fatHandoffTokens ?? 4000;
    // A poorly compressed handoff only matters when it is big enough to notice: half the fat bar (review #13).
    const ratioFloor = fatTokens / 2;
    const byType = new Map();
    for (const record of habits ?? []) {
      for (const agent of record.habits?.agents ?? []) {
        if (!agent.type || !(agent.n > 0) || !(agent.handoffP50 > 0)) continue;
        const group = byType.get(agent.type) ?? { type: agent.type, records: [], perRun: new Map(), n: 0, handoffs: [], ratios: [] };
        group.records.push(record);
        group.perRun.set(record.runId, agent);
        group.n += agent.n;
        for (let i = 0; i < agent.n; i += 1) { group.handoffs.push(agent.handoffP50); if (agent.ratioP50 > 0) group.ratios.push(agent.ratioP50); }
        byType.set(agent.type, group);
      }
    }
    const findings = [];
    for (const group of byType.values()) {
      const sessions = new Set(group.records.map((record) => record.runId)).size;
      if (sessions < minSessions || group.n < 3) continue;
      const handoffP50 = median(group.handoffs);
      const ratioP50 = group.ratios.length ? median(group.ratios) : Infinity;
      if (!(handoffP50 >= fatTokens) && !(ratioP50 < 3 && handoffP50 >= ratioFloor)) continue;
      const platform = platformOf(group.records);
      const path = fixPathFor(setup, group.type, platform);
      const builtin = BUILTIN_AGENTS.has(group.type) && path === "CLAUDE.md";
      const why = handoffP50 >= fatTokens ? `median handoff ${formatTokens(handoffP50)}` : `median compression ${ratioP50.toFixed(1)}x`;
      findings.push(makeHabitFinding(this, {
        primaryRef: `habit:H-03:${group.type}`,
        records: group.records,
        title: `${this.title}: ${group.type}`,
        count: group.n,
        tokensAffected: sum(group.records.map((record) => { const a = group.perRun.get(record.runId); return (a?.handoffP50 ?? 0) * (a?.n ?? 0); })),
        evidence: [
          metricEvidence(this.id, group.type, `${group.type}: ${group.n} handoffs in ${sessions} sessions, ${why}${Number.isFinite(ratioP50) && handoffP50 >= fatTokens ? `, ${ratioP50.toFixed(1)}x compression` : ""}`, group.n),
          ...topRunEvidence(group.records, (record) => group.perRun.get(record.runId)?.handoffP50, (record, value) => { const a = group.perRun.get(record.runId); return `${a?.n ?? 1}x ${group.type}, median handoff ${formatTokens(value)}, max ${formatTokens(a?.handoffMax ?? value)}`; }),
        ],
        fix: platform === "codex"
          ? { platform, path, summary: `Instruct ${group.type} agents in ${path} to return a short summary, not their transcript.`, snippet: `When you finish as ${group.type}, reply with a summary only: paths, line references, decisions, open questions. Under 600 words. Never include raw tool output.` }
          : { platform: platform === "both" ? "both" : "claude", path, summary: `Require ${group.type} to return findings only; add this line to ${path}${builtin ? ` (${group.type} is a built-in agent type with no definition file, so the rule goes where its prompts are written)` : ""}.`, snippet: builtin ? `- When delegating to ${group.type}: "${RETURN_RULE}"` : RETURN_RULE },
      }));
    }
    return findings;
  },
};
