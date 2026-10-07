import { makeFinding, metricEvidence, platformFix, requestEvidence, sum } from "./util.mjs";

/**
 * Counts only requests that start a human turn (the request's `turn` differs from the
 * previous one and it carries a `user` block). Tool-loop steps (tool_use → tool_result →
 * next request) also carry little new user content, but they are the agent's work, not
 * the user's habit; counting them read whole agent loops as "tiny follow-ups".
 */
export default {
  id: "B-11",
  scope: "session",
  severity: "low",
  title: "Turn overhead",
  whyItMatters: "Each tiny follow-up resends the entire window; that is where most \"idle\" cost comes from.",
  thresholdKeys: ["turnOverheadUserTokens", "turnOverheadTotal", "turnOverheadRequests"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const main = run.scopes[0];
    if (!main) return [];
    const blocks = new Map(main.blocks.map((block) => [block.id, block]));
    const tiny = [];
    let previousTurn;
    for (const request of main.requests) {
      const startsTurn = previousTurn === undefined || request.turn !== previousTurn;
      previousTurn = request.turn;
      if (!startsTurn) continue;
      // A turn boundary without a user block is a delivery (handoff, attachment, tool result), not a human message.
      const userBlocks = (request.newBlockIds ?? []).map((id) => blocks.get(id)).filter((b) => b && b.category === "user");
      if (!userBlocks.length) continue;
      if (request.usage.total <= thresholds.turnOverheadTotal) continue;
      const userTokens = sum(userBlocks.map((b) => b.estTokens));
      if (userTokens < thresholds.turnOverheadUserTokens) tiny.push({ request, userTokens });
    }
    if (tiny.length < thresholds.turnOverheadRequests) return [];
    const resent = sum(tiny.map(({ request }) => request.usage.total));
    const evidence = [
      metricEvidence(run, "tinyRequests", tiny.length, { label: `${tiny.length} user turns opened with under ${thresholds.turnOverheadUserTokens} tok of new user content while resending over ${thresholds.turnOverheadTotal.toLocaleString("en-US")} tok`, unit: "count" }),
      metricEvidence(run, "tinyRequestTokens", resent, { label: `${resent.toLocaleString("en-US")} tok processed by those requests`, provenance: "observed.vendor" }),
      ...tiny.slice(0, 8).map(({ request, userTokens }) => requestEvidence(run, main, request, { label: `request #${request.index} (turn ${request.turn}): ${userTokens} tok new user content, ${request.usage.total.toLocaleString("en-US")} tok total` })),
    ];
    return [makeFinding(this, run, {
      evidence,
      tokensAffected: resent,
      fix: platformFix(run, {
        claude: { summary: "Batch small follow-ups, compact between task phases, and open a fresh session for unrelated questions.", snippet: "/compact Keep decisions, changed files, and next steps.   # between phases\n/clear   # for an unrelated question" },
        codex: { summary: "Batch small follow-ups and start a new thread for unrelated questions.", snippet: "/new   # unrelated question: fresh thread\n# batch follow-ups: \"Do A, then B, then C; report once at the end.\"" },
      }, { scope: main }),
    })];
  },
};
