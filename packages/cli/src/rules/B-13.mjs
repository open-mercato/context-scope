import { makeFinding, metricEvidence, platformFix } from "./util.mjs";

// Processed input grows with every request, so a busy 20-minute session can cross the token
// bar; the rule is about length, so the token branch also needs at least this much active time.
const MIN_ACTIVE_HOURS_FOR_TOKENS = 1;

export default {
  id: "B-13",
  scope: "session",
  severity: "medium",
  title: "Session too long",
  whyItMatters: "Long sessions accumulate stale context and compaction loss; a fresh session with a good note is cheaper and more accurate.",
  thresholdKeys: ["sessionTooLongTokens", "sessionTooLongHours"],
  evaluate({ run }, thresholds) {
    if (!run?.summary) return [];
    const processed = run.summary.processedInputTokens ?? 0;
    const hours = (run.activeMs ?? 0) / 3_600_000;
    const compactions = run.summary.compactions ?? 0;
    const tooManyTokens = processed > thresholds.sessionTooLongTokens && hours >= MIN_ACTIVE_HOURS_FOR_TOKENS;
    const tooLong = compactions >= 2 && hours > thresholds.sessionTooLongHours;
    if (!tooManyTokens && !tooLong) return [];
    const evidence = [
      metricEvidence(run, "processedInputTokens", processed, { label: `${processed.toLocaleString("en-US")} tok processed across ${run.summary.requests} requests`, provenance: "observed.vendor" }),
      metricEvidence(run, "activeHours", Number(hours.toFixed(2)), { label: `${hours.toFixed(1)} active hours`, unit: "ratio" }),
      metricEvidence(run, "compactions", compactions, { label: `${compactions} compactions`, unit: "count" }),
    ];
    return [makeFinding(this, run, {
      primaryRef: tooManyTokens ? evidence[0].ref : evidence[1].ref,
      evidence,
      tokensAffected: processed,
      fix: platformFix(run, {
        claude: { summary: "Split work into one session per task; save a handoff note to memory before ending.", snippet: "Save to memory: decisions made, files changed, and next steps for <task>.\n/clear   # then start the next task in a fresh window" },
        codex: { summary: "Split work into one thread per task; write a handoff note before ending.", snippet: "Append to NOTES.md: decisions made, files changed, and next steps for <task>.\n/new   # then start the next task in a fresh thread" },
      }, { scope: run.scopes?.[0] }),
    })];
  },
};
