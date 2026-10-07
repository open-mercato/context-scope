import { makeFinding, metricEvidence, platformFix, requestEvidence, requestByIndex, scopeEvidence, sum } from "./util.mjs";

export default {
  id: "B-07",
  scope: "session",
  severity: "high",
  title: "Frequent compaction",
  whyItMatters: "Each compaction discards state that later turns may need; theory and practice agree there is no lossless summary.",
  thresholdKeys: ["compactionsPerHour", "compactionsPerSession"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const compactions = run.scopes.flatMap((scope) => (scope.compactions ?? []).map((compaction) => ({ scope, compaction })));
    if (!compactions.length) return [];
    const count = compactions.length;
    const hours = (run.activeMs ?? 0) / 3_600_000;
    const perHour = hours > 0 ? count / hours : 0;
    const tooMany = count >= thresholds.compactionsPerSession;
    // The rate branch needs at least two compactions so a single early compaction in a short session does not fire.
    const tooFrequent = count >= 2 && hours > 0 && perHour > thresholds.compactionsPerHour;
    if (!tooMany && !tooFrequent) return [];
    const times = compactions.map(({ compaction }) => Date.parse(compaction.at)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const minGapMs = gaps.length ? Math.min(...gaps) : undefined;
    const dropped = sum(compactions.map(({ compaction }) => compaction.droppedTokens?.value ?? 0));
    const evidence = [
      metricEvidence(run, "compactions", count, { label: `${count} compactions in ${hours.toFixed(1)} active hours (${perHour.toFixed(1)}/h)`, unit: "count" }),
      metricEvidence(run, "droppedTokens", dropped, { label: `${dropped.toLocaleString("en-US")} tok discarded by compaction`, provenance: compactions[0].compaction.droppedTokens?.provenance ?? "unknown" }),
    ];
    if (minGapMs !== undefined) evidence.push(metricEvidence(run, "minCompactionGap", minGapMs, { label: `shortest gap between compactions ${(minGapMs / 60_000).toFixed(0)} min`, unit: "ms" }));
    for (const { scope, compaction } of compactions.slice(0, 6)) {
      const request = requestByIndex(scope, compaction.atRequest);
      evidence.push(request
        ? requestEvidence(run, scope, request, { label: `${compaction.trigger} compaction ${compaction.id} at ${compaction.at} (pre ${compaction.preTokens?.value?.toLocaleString("en-US") ?? "?"} tok)`, value: compaction.preTokens?.value, provenance: compaction.preTokens?.provenance ?? "observed.vendor" })
        : scopeEvidence(run, scope, { label: `${compaction.trigger} compaction ${compaction.id} at ${compaction.at}` }));
    }
    return [makeFinding(this, run, {
      primaryRef: evidence[0].ref,
      evidence,
      tokensAffected: dropped,
      fix: platformFix(run, {
        claude: { summary: "Start a fresh session per task, delegate exploration to subagents, and fix fat results (B-01/B-03) first.", snippet: "/clear   # new task, fresh window\nAgent { description: \"explore\", prompt: \"Investigate <question>; return findings only, under 600 words.\" }" },
        codex: { summary: "Start a fresh session per task, delegate exploration to a subagent, and reduce startup mass (S-01).", snippet: "/new   # fresh thread per task\n# and in AGENTS.md: keep tool output short (head/tail); delegate broad exploration to a subagent that returns a summary" },
      }, { scope: run.scopes[0] }),
    })];
  },
};
