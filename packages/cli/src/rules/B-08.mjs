import { countedTitle, findingScopeFor, makeFinding, metricEvidence, percent, platformFix, requestEvidence, scopeEvidence, scopeRef, sum, topBy, windowEvidence } from "./util.mjs";

/** One finding per hot scope; each streak is an occurrence (up to three as evidence), tokensAffected sums every hot request. */
export default {
  id: "B-08",
  scope: "session",
  severity: "high",
  title: "Running hot",
  whyItMatters: "Quality degrades with length before the hard limit; the last 20% of the window is the most expensive and least reliable.",
  thresholdKeys: ["runningHotShare", "runningHotRequests"],
  evaluate({ run }, thresholds) {
    if (!run || !(run.window?.value > 0)) return [];
    const window = run.window.value;
    const limit = window * thresholds.runningHotShare;
    const minRun = thresholds.runningHotRequests;
    const findings = [];
    for (const scope of run.scopes) {
      const requests = [...scope.requests].sort((a, b) => a.index - b.index);
      let streak = [];
      const streaks = [];
      for (const request of requests) {
        if (request.usage.total > limit) streak.push(request);
        else { if (streak.length >= minRun) streaks.push(streak); streak = []; }
      }
      if (streak.length >= minRun) streaks.push(streak);
      if (!streaks.length) continue;
      const hotRequests = sum(streaks.map((s) => s.length));
      const peak = Math.max(...streaks.flat().map((r) => r.usage.total));
      // metric + window (+ scope for subagents) leave three (two) slots for streaks.
      const slots = scope.kind === "subagent" ? 2 : 3;
      const evidence = topBy(streaks, (s) => sum(s.map((r) => r.usage.total)), slots).map((hot) => {
        const first = hot[0];
        const last = hot[hot.length - 1];
        return requestEvidence(run, scope, first, { label: `hot streak: requests #${first.index}–#${last.index} (${hot.length} requests, ${percent(first.usage.total / window)} → ${percent(last.usage.total / window)} of window)` });
      });
      evidence.push(metricEvidence(run, `hotRequests.${scope.id}`, hotRequests, { label: `${hotRequests} requests in ${streaks.length} streak${streaks.length === 1 ? "" : "s"} above ${percent(thresholds.runningHotShare)} of the window (peak ${percent(peak / window)})`, unit: "count" }));
      evidence.push(windowEvidence(run));
      if (scope.kind === "subagent") evidence.push(scopeEvidence(run, scope));
      findings.push(makeFinding(this, run, {
        scope: findingScopeFor(scope),
        scopeId: scope.id,
        primaryRef: scopeRef(run, scope),
        count: streaks.length,
        title: countedTitle(this, streaks.length),
        evidence,
        tokensAffected: sum(streaks.flat().map((r) => r.usage.total)),
        fix: platformFix(run, {
          claude: { summary: "Compact deliberately with a focus before the auto trigger, or split the task.", snippet: "/compact Keep: current task, decisions made, files changed, next steps. Drop: tool output and exploration." },
          codex: { summary: "Compact deliberately before the auto trigger, or split the task into a new thread.", snippet: "/compact\n# or start a new thread with a short handoff note of decisions and next steps" },
          // A child cannot open a thread; its task is sized by whoever spawned it.
          subagent: {
            claude: { summary: "Give the agent a narrower task and keep tool output out of its context; set it in the agent definition or the Agent prompt.", snippet: "- Read files in ranges (Read offset/limit); cap search and shell output.\n- Keep tool output out of the handoff; return paths and decisions only." },
            codex: { summary: "Give the child thread a narrower task and keep tool output out of its context; set it in the spawn prompt.", snippet: "spawn_agent prompt: \"<task, one deliverable>. Read files in ranges (sed -n 'A,Bp'); pipe shell output through head -c 8000. Return paths and decisions only.\"" },
          },
        }, { scope }),
      }));
    }
    return findings;
  },
};
