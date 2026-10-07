import { instructionFileFor, makeHabitFinding, metricEvidence, platformOf, sum, topRunEvidence } from "./habits.mjs";

const WINDOW = 10;

function ratePerK(records) {
  const requests = sum(records.map((record) => record.requests ?? 0));
  const compactions = sum(records.map((record) => record.compactions ?? 0));
  return { requests, compactions, rate: requests > 0 ? (compactions / requests) * 1000 : 0 };
}

export default {
  id: "H-04",
  scope: "habit",
  severity: "medium",
  title: "Compaction frequency rising",
  whyItMatters: "More compactions per request means sessions fill the window sooner than they used to: something in the setup or the habits grew.",
  thresholdKeys: ["habitMinSessions", "habitCompactionRatio", "habitCompactionMinRecent"],
  needs: (thresholds) => 2 * (thresholds.habitMinSessions ?? 3),
  evaluate({ habits, thresholds }) {
    const minSessions = thresholds.habitMinSessions ?? 3;
    const minRatio = thresholds.habitCompactionRatio ?? 1.5;
    const minRecent = thresholds.habitCompactionMinRecent ?? 3;
    const ordered = [...(habits ?? [])];
    if (ordered.length < 2 * minSessions) return [];
    const recent = ordered.slice(-WINDOW);
    const previous = ordered.slice(Math.max(0, ordered.length - 2 * WINDOW), ordered.length - WINDOW);
    if (recent.length < minSessions || previous.length < minSessions) return [];
    const now = ratePerK(recent);
    const before = ratePerK(previous);
    if (now.compactions < minRecent) return [];
    const ratio = before.rate > 0 ? now.rate / before.rate : Infinity;
    if (!(ratio >= minRatio)) return [];
    const platform = platformOf(recent);
    const path = instructionFileFor(platform);
    const ratioLabel = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "from zero";
    const runs = topRunEvidence(recent.filter((record) => (record.compactions ?? 0) > 0), (record) => record.compactions, (record, value) => `${value} compaction${value === 1 ? "" : "s"} in ${record.requests ?? 0} requests`)
      .map((item) => ({ ...item, unit: "count", provenance: "observed.vendor" }));
    return [makeHabitFinding(this, {
      primaryRef: `habit:H-04:${recent[0].runId}:${recent[recent.length - 1].runId}`,
      records: recent,
      title: `${this.title} (${ratioLabel})`,
      count: now.compactions,
      evidence: [
        metricEvidence(this.id, "ratio", `${now.rate.toFixed(1)} compactions per 1k requests over the last ${recent.length} sessions vs ${before.rate.toFixed(1)} over the previous ${previous.length} (${ratioLabel})`, Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : now.rate, { unit: "ratio" }),
        ...runs,
      ],
      fix: { platform, path, summary: `Compare the recent sessions' largest blocks with the older ones; add the rule that keeps them small to ${path}.`, snippet: "- Keep tool results small (ranges, head, grep) and delegate long explorations to a subagent that returns a summary." },
    })];
  },
};
