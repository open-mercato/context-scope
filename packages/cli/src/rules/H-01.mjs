import { formatTokens, instructionFileFor, makeHabitFinding, metricEvidence, platformOf, topRunEvidence } from "./habits.mjs";

/**
 * Standing rule per fix family. The family is the tool *kind* (file, shell,
 * search, web, edit, mcp …), not the tool name: Codex `exec` running
 * `tools.web__run` is a web fetch, a Claude `Bash` running `cat path` is a file
 * read with a target. `call` groups are fat tool-call payloads (Write/Edit/
 * apply_patch arguments), where the fix is on the writing side.
 */
function ruleLine({ tool, kind, label, call }) {
  const target = label ? `\`${label}\`` : null;
  if (call) {
    if (kind === "edit") return `Write ${target ?? "large files"} in chunks (create the skeleton, then append sections with Edit); never send a whole file in one call, and never echo a file back to rewrite a few lines.`;
    return `Keep ${tool} arguments small: pass paths and short snippets, not whole files or logs${target ? ` (recurring: ${target})` : ""}.`;
  }
  switch (kind) {
    case "file": return `Read ${target ?? "large files"} in ranges (\`offset\`/\`limit\`, \`sed -n\`, \`head\`); never whole.`;
    case "shell": return `Keep shell output short: pipe long commands through \`| head -c 8000\` (or \`| tail\`, \`| grep\`); never dump whole logs${target ? ` (recurring: ${target})` : ""}.`;
    case "search": return `Search with \`head_limit\` / \`rg -l\` (file names first) and read only the lines you need${target ? ` (recurring: ${target})` : ""}.`;
    case "web": return `When fetching ${target ?? "web pages"}, extract only the facts you need; never paste whole pages.`;
    case "mcp": return `Ask ${tool} for a filtered or paginated result; never a full listing${target ? ` (recurring: ${target})` : ""}.`;
    case "agent": return `Subagents return findings only (paths, line references, decisions); never their transcript${target ? ` (recurring: ${target})` : ""}.`;
    default: return `Keep ${tool} results small: ask for summaries, not dumps${target ? ` (recurring: ${target})` : ""}.`;
  }
}

/** The tool name most records used for the group (Codex `exec` and Claude `Bash` may share a kind). */
function dominantTool(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "tool";
}

export default {
  id: "H-01",
  scope: "habit",
  severity: "high",
  title: "Recurring fat result",
  whyItMatters: "The same kind of tool returns the same oversized result session after session; one instruction line prevents it every time.",
  thresholdKeys: ["habitMinSessions", "habitFatTotalTokens", "fatToolResultTokens"],
  needs: (thresholds) => thresholds.habitMinSessions ?? 3,
  evaluate({ habits, thresholds }) {
    const minSessions = thresholds.habitMinSessions ?? 3;
    // Every fat entry is already >= fatToolResultTokens, so a per-result bar is vacuous across 3 sessions; the habit
    // must have cost at least habitFatTotalTokens together (three results at the 8k floor are 24k: not a habit yet).
    const minTokens = thresholds.habitFatTotalTokens ?? 30_000;
    const groups = new Map();
    for (const record of habits ?? []) {
      for (const fat of record.habits?.fat ?? []) {
        const kind = fat.kind ?? "other";
        const key = `${fat.call ? "call" : "result"} ${kind} ${fat.label ?? ""}`;
        const group = groups.get(key) ?? { kind, label: fat.label, call: Boolean(fat.call), names: [], records: [], perRun: new Map(), tokens: 0, n: 0 };
        if (group.perRun.has(record.runId)) {
          const merged = group.perRun.get(record.runId);
          merged.tokens += fat.tokens ?? 0;
          merged.n += fat.n ?? 0;
        } else {
          group.records.push(record);
          group.perRun.set(record.runId, { tokens: fat.tokens ?? 0, n: fat.n ?? 0 });
        }
        group.names.push(fat.tool ?? "tool");
        group.tokens += fat.tokens ?? 0;
        group.n += fat.n ?? 0;
        groups.set(key, group);
      }
    }
    const findings = [];
    for (const group of groups.values()) {
      const sessions = new Set(group.records.map((record) => record.runId)).size;
      if (sessions < minSessions || group.tokens < minTokens) continue;
      const tool = dominantTool(group.names);
      const what = group.call
        ? `${tool} arguments${group.label ? ` for ${group.label}` : ""}`
        : group.label ? `${tool} ${group.label}` : `${tool} (${group.kind})`;
      const platform = platformOf(group.records);
      const path = instructionFileFor(platform);
      const line = ruleLine({ tool, kind: group.kind, label: group.label, call: group.call });
      findings.push(makeHabitFinding(this, {
        primaryRef: `habit:H-01:${group.call ? "call:" : ""}${group.kind}:${group.label ?? ""}`,
        records: group.records,
        title: `${group.call ? "Recurring fat tool call" : this.title}: ${what}`,
        count: group.n,
        tokensAffected: group.tokens,
        evidence: [
          metricEvidence(this.id, `${group.kind}:${group.label ?? tool}`, `${what}: ${group.n} ${group.call ? "calls" : "results"} over the fat threshold in ${sessions} sessions, ${formatTokens(group.tokens)} together`, group.n),
          ...topRunEvidence(group.records, (record) => group.perRun.get(record.runId)?.tokens, (record, value) => `${group.perRun.get(record.runId)?.n ?? 1}x ${what}, ${formatTokens(value)}`),
        ],
        fix: { platform, path, summary: `Add a standing rule to ${path} so ${what} ${group.call ? "payloads" : "results"} stay small.`, snippet: `- ${line}` },
      }));
    }
    return findings;
  },
};
