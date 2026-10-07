import { findingScopeFor, formatTokens, makeFinding, metricEvidence, percent, platformFix, requestByIndex, requestEvidence, scopeEvidence, scopeRef, sum } from "./util.mjs";

const MAX_STEPS = 4;
// A positive base step at least this large is an injection worth a finding on its own (below the share bar).
const INJECTION_STEP_TOKENS = 5_000;

/**
 * Scopes whose transcript is missing almost everything (Codex legacy history_mode children):
 * the stack is hidden upstream and the numbers say nothing about the user's habits.
 */
function transcriptIncomplete(scope) {
  if (typeof scope.transcriptIncomplete === "boolean") return scope.transcriptIncomplete;
  const requests = scope.requests ?? [];
  if (!requests.length || !(scope.unloggedShare > 0.8)) return false;
  const withBlocks = requests.filter((r) => (r.newBlockIds?.length ?? 0) > 0).length;
  return withBlocks / requests.length < 0.2;
}

/**
 * Reconciliation v2 evidence: input the model saw that the transcript does not contain (resumed
 * history, hidden injections, schema growth). Only positive base steps count: a negative step is
 * hidden mass leaving the window (a compaction, a swapped instruction file), never an injection.
 */
export default {
  id: "B-16",
  scope: "session",
  severity: "medium",
  title: "Unlogged context",
  whyItMatters: "Context that is not in the transcript still costs the window on every request; a resumed session or a hidden injection is paid for without being visible or fixable from the log.",
  thresholdKeys: ["unloggedShareHigh"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const minShare = thresholds.unloggedShareHigh;
    const findings = [];
    for (const scope of run.scopes) {
      const share = typeof scope.unloggedShare === "number" && Number.isFinite(scope.unloggedShare) ? scope.unloggedShare : 0;
      const steps = Array.isArray(scope.baseSteps) ? scope.baseSteps.filter((s) => Number.isFinite(s?.delta) && s.delta > 0) : [];
      const bigStep = steps.some((s) => s.delta >= INJECTION_STEP_TOKENS);
      if (share < minShare && !bigStep) continue;
      if (transcriptIncomplete(scope)) continue;
      const peak = scope.peak?.value ?? 0;
      const unloggedAtPeak = Math.round(share * peak);
      const evidence = [];
      if (share > 0) evidence.push(metricEvidence(run, `unloggedShare.${scope.id}`, Number(share.toFixed(4)), { label: `${percent(share)} of the peak (${formatTokens(unloggedAtPeak)} of ${formatTokens(peak)}) is input not present in the transcript`, unit: "ratio", provenance: "estimated.local" }));
      for (const step of steps.slice(0, MAX_STEPS)) {
        const label = `+${formatTokens(step.delta)} unlogged at request #${step.atRequest}${step.atRequest === 0 ? " (present from the first request: resumed or injected before the transcript starts)" : ""}`;
        const request = requestByIndex(scope, step.atRequest);
        evidence.push(request
          ? requestEvidence(run, scope, request, { label, value: step.delta, provenance: "derived.exact" })
          : metricEvidence(run, `baseStep.${scope.id}.${step.atRequest}`, step.delta, { label, provenance: "derived.exact" }));
      }
      if (scope.kind === "subagent" && evidence.length < 5) evidence.push(scopeEvidence(run, scope));
      // The IR flags a resumed scope (mass present from request 0); without the flag, a step at #0 or a flat share means the same.
      const resumed = typeof scope.resumed === "boolean" ? scope.resumed : steps.some((s) => s.atRequest === 0) || (share >= minShare && !steps.length);
      const largest = steps.filter((s) => s.atRequest > 0).reduce((best, s) => (!best || s.delta > best.delta ? s : best), null);
      const grewAt = largest ? `grew at request #${largest.atRequest}` : "grew mid-session";
      const injected = {
        claude: {
          summary: `Input the transcript does not show ${grewAt}; the usual causes are a nested instruction file or memory loaded when the agent entered a directory, a skill body loaded on invocation, or a hook that prints into context.`,
          snippet: "contextscope hooks install --scope user   # records what the runtime loads (InstructionsLoaded) so the next session names the source",
        },
        codex: {
          summary: `Input the transcript does not show ${grewAt}; the usual causes are a nested AGENTS.md swapped in when the agent entered a directory, a skill body loaded on invocation, or a tool list that grew.`,
          snippet: "find . -name AGENTS.md -not -path '*/node_modules/*'   # nested instruction files the runtime swaps in per directory",
        },
      };
      findings.push(makeFinding(this, run, {
        scope: findingScopeFor(scope),
        scopeId: scope.id,
        primaryRef: scopeRef(run, scope),
        evidence,
        tokensAffected: Math.max(unloggedAtPeak, sum(steps.map((s) => s.delta))),
        fix: platformFix(run, {
          claude: resumed
            ? { summary: "Start a fresh session per task instead of resuming; earlier history is resent on every request but never shown in this transcript.", snippet: "/clear   # new task, fresh window (instead of `claude --resume` / `--continue`)" }
            : injected.claude,
          codex: resumed
            ? { summary: "Start a fresh thread per task instead of resuming; earlier history is resent on every request but never shown in this rollout.", snippet: "/new   # new task, fresh thread (instead of `codex resume`)" }
            : injected.codex,
          // A child cannot resume or /clear; a mid-run injection in a child has the same causes as in a session.
          ...(resumed ? {} : { subagent: injected }),
        }, { scope }),
      }));
    }
    return findings;
  },
};
