import { makeFinding, metricEvidence, percent, platformFix, requestEvidence, sum } from "./util.mjs";

export default {
  id: "B-12",
  scope: "session",
  severity: "medium",
  title: "Tool results dominate",
  whyItMatters: "The window should hold the task and decisions, not raw output; results are the most compressible content.",
  thresholdKeys: ["toolResultsDominateShare"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const composition = run.summary?.compositionAtPeak;
    if (!composition) return [];
    const total = sum(Object.values(composition));
    if (!(total > 0)) return [];
    const resultEntries = Object.entries(composition).filter(([category]) => category.startsWith("tool_result."));
    const resultTokens = sum(resultEntries.map(([, value]) => value));
    const share = resultTokens / total;
    if (share <= thresholds.toolResultsDominateShare) return [];
    const main = run.scopes[0];
    const peakRequest = main.requests.reduce((best, r) => (!best || r.usage.total > best.usage.total ? r : best), null);
    const breakdown = resultEntries.sort((a, b) => b[1] - a[1]).map(([category, value]) => `${category.slice("tool_result.".length)} ${percent(value / total)}`).join(", ");
    const evidence = [
      metricEvidence(run, "toolResultShareAtPeak", Number(share.toFixed(4)), { label: `tool results are ${percent(share)} of the ${total.toLocaleString("en-US")} tok at the session peak (${breakdown})`, unit: "ratio", provenance: "estimated.local" }),
    ];
    if (peakRequest) evidence.push(requestEvidence(run, main, peakRequest, { label: `peak request #${peakRequest.index}: ${peakRequest.usage.total.toLocaleString("en-US")} tok` }));
    return [makeFinding(this, run, {
      evidence,
      tokensAffected: resultTokens,
      fix: platformFix(run, {
        claude: { summary: "Delegate exploration to subagents, search with limits, and compact when a phase ends.", snippet: "Agent { description: \"explore\", prompt: \"Find <what>; return paths and line refs only, under 400 words.\" }\nGrep { pattern: \"<pattern>\", output_mode: \"files_with_matches\", head_limit: 50 }" },
        codex: { summary: "Delegate exploration to a subagent, search with limits, and compact when a phase ends.", snippet: "rg -l '<pattern>' | head -50\n/compact   # after exploration, before implementation" },
      }, { scope: main }),
    })];
  },
};
