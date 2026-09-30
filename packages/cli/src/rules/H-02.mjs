import { formatTokens, instructionFileFor, makeHabitFinding, metricEvidence, platformOf, topRunEvidence } from "./habits.mjs";

const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|.*\.min\.(js|css)|.*\.snap)$|(^|\/)(dist|build)\//i;

export default {
  id: "H-02",
  scope: "habit",
  severity: "medium",
  title: "File read whole repeatedly",
  whyItMatters: "A file read in full across sessions is a standing cost the instructions can name: a range, a summary, or 'do not read'.",
  thresholdKeys: ["habitMinSessions", "habitFullReadTokens"],
  needs: (thresholds) => thresholds.habitMinSessions ?? 3,
  evaluate({ habits, thresholds }) {
    const minSessions = thresholds.habitMinSessions ?? 3;
    const perRead = thresholds.habitFullReadTokens ?? 2000;
    const groups = new Map();
    for (const record of habits ?? []) {
      for (const read of record.habits?.fullReads ?? []) {
        if (!read.label) continue;
        const group = groups.get(read.label) ?? { label: read.label, records: [], perRun: new Map(), tokens: 0, n: 0 };
        group.records.push(record);
        group.perRun.set(record.runId, read);
        group.tokens += read.tokens ?? 0;
        group.n += read.n ?? 0;
        groups.set(read.label, group);
      }
    }
    const findings = [];
    for (const group of groups.values()) {
      const sessions = new Set(group.records.map((record) => record.runId)).size;
      if (sessions < minSessions || group.n < 1 || group.tokens < perRead * group.n) continue;
      const platform = platformOf(group.records);
      const path = instructionFileFor(platform);
      const perReadTokens = Math.round(group.tokens / group.n);
      const generated = GENERATED.test(group.label);
      const line = generated
        ? `- Never read \`${group.label}\` (generated, ~${formatTokens(perReadTokens)}); grep for the specific entry you need.`
        : `- \`${group.label}\` is ~${formatTokens(perReadTokens)}: read it with \`offset\`/\`limit\` or grep for the symbol; never whole.`;
      findings.push(makeHabitFinding(this, {
        primaryRef: `habit:H-02:${group.label}`,
        records: group.records,
        title: `${this.title}: ${group.label}`,
        count: group.n,
        tokensAffected: group.tokens,
        evidence: [
          metricEvidence(this.id, group.label, `${group.label} read whole ${group.n}x in ${sessions} sessions, ${formatTokens(group.tokens)} together (~${formatTokens(perReadTokens)} per read)`, group.n),
          ...topRunEvidence(group.records, (record) => group.perRun.get(record.runId)?.tokens, (record, value) => `${group.perRun.get(record.runId)?.n ?? 1}x ${group.label}, ${formatTokens(value)}`),
        ],
        fix: { platform, path, summary: `Tell the agent in ${path} how to read ${group.label}: a range, a grep, or not at all.`, snippet: line },
      }));
    }
    return findings;
  },
};
