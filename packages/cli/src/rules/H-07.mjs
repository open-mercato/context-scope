import { formatTokens, instructionFileFor, makeHabitFinding, metricEvidence, platformOf, topRunEvidence } from "./habits.mjs";

const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|.*\.min\.(js|css)|.*\.snap)$|(^|\/)(dist|build)\//i;

/**
 * H-07 same-file-reread: the same repo-relative file is read in full in
 * session after session. H-02 covers the files that are too big to read whole
 * (the fix is a range); this rule covers the ones the agent keeps re-learning
 * (a design doc, a schema, a conventions file), where the fix is to carry the
 * knowledge over: a summary in CLAUDE.md/AGENTS.md or auto-memory, or a
 * pointer to the section that matters.
 */
export default {
  id: "H-07",
  scope: "habit",
  severity: "low",
  title: "Same file re-read every session",
  whyItMatters: "A file the agent reads whole at the start of every session is knowledge it re-acquires each time; a few lines in the instructions or in memory replace the read.",
  thresholdKeys: ["habitRereadSessions", "habitRereadMinTokens", "habitFullReadTokens"],
  needs: (thresholds) => thresholds.habitRereadSessions ?? 3,
  evaluate({ habits, thresholds }) {
    const minSessions = thresholds.habitRereadSessions ?? 3;
    const minPerRead = thresholds.habitRereadMinTokens ?? 300;
    const h02PerRead = thresholds.habitFullReadTokens ?? 2000;
    const groups = new Map();
    for (const record of habits ?? []) {
      for (const read of record.habits?.fullReads ?? []) {
        if (!read.label || GENERATED.test(read.label)) continue;
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
      if (sessions < minSessions || group.n < 1) continue;
      const perRead = group.tokens / group.n;
      // Tiny files are cheap to re-read; big ones belong to H-02 (read it in ranges), not here.
      if (perRead < minPerRead || perRead >= h02PerRead) continue;
      const platform = platformOf(group.records);
      const path = instructionFileFor(platform);
      const isDoc = /\.(md|mdx|rst|txt|adoc)$/i.test(group.label);
      findings.push(makeHabitFinding(this, {
        primaryRef: `habit:H-07:${group.label}`,
        records: group.records,
        title: `${this.title}: ${group.label}`,
        count: group.n,
        tokensAffected: group.tokens,
        evidence: [
          metricEvidence(this.id, group.label, `${group.label} read whole in ${sessions} of the sessions (${group.n}x, ~${formatTokens(Math.round(perRead))} per read, ${formatTokens(group.tokens)} together)`, sessions, { unit: "count" }),
          ...topRunEvidence(group.records, (record) => group.perRun.get(record.runId)?.tokens, (record, value) => `${group.perRun.get(record.runId)?.n ?? 1}x ${group.label}, ${formatTokens(value)}`),
        ],
        fix: {
          platform,
          path,
          summary: isDoc
            ? `Summarise what the agent needs from ${group.label} in ${path} (or auto-memory) and point to the section for the rest, so it stops re-reading the file every session.`
            : `Put the facts the agent keeps looking up in ${group.label} (its shape, the entry points) into ${path} or auto-memory; read the file only when changing it.`,
          snippet: `- \`${group.label}\`: <two lines: what it holds and when to open it>. Read only the section you need${isDoc ? " (headings: <list them>)" : ""}.`,
        },
      }));
    }
    return findings;
  },
};
