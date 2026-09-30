import { blockEvidence, makeFinding, metricEvidence, percent, platformFix, requestEvidence, sum, topBy } from "./util.mjs";

/**
 * B-17 tool-args-dominate: tool-call arguments (Write/Edit/apply_patch payloads,
 * commands with inlined content) are the largest band at the session peak.
 * Unlike tool results, arguments are content the agent itself produced and can
 * shrink: write files in chunks, patch with Edit, never echo a whole file back.
 */
export default {
  id: "B-17",
  scope: "session",
  severity: "medium",
  title: "Tool arguments dominate",
  whyItMatters: "Write and Edit payloads stay in the window for the rest of the session; a file written in one call, or rewritten to change a few lines, is paid on every following request.",
  thresholdKeys: ["toolArgsDominateShare"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const composition = run.summary?.compositionAtPeak;
    if (!composition) return [];
    const total = sum(Object.values(composition));
    if (!(total > 0)) return [];
    const args = composition.tool_call ?? 0;
    const share = args / total;
    if (!(share >= (thresholds.toolArgsDominateShare ?? 0.35))) return [];
    const main = run.scopes.find((scope) => scope.kind === "main") ?? run.scopes[0];
    const peakRequest = main.requests.reduce((best, r) => (!best || r.usage.total > best.usage.total ? r : best), null);
    const calls = (main.blocks ?? []).filter((block) => block.category === "tool_call" && (!peakRequest || block.firstRequest <= peakRequest.index));
    const evidence = [
      metricEvidence(run, "toolArgsShareAtPeak", Number(share.toFixed(4)), { label: `tool arguments are ${percent(share)} of the ${total.toLocaleString("en-US")} tok at the session peak`, unit: "ratio", provenance: "estimated.local" }),
    ];
    if (peakRequest) evidence.push(requestEvidence(run, main, peakRequest, { label: `peak request #${peakRequest.index}: ${peakRequest.usage.total.toLocaleString("en-US")} tok` }));
    for (const block of topBy(calls, (block) => block.estTokens, 3)) evidence.push(blockEvidence(run, block, { label: `${block.tool?.name ?? "tool"}${block.tool?.target ? ` ${block.tool.target}` : ""} arguments, ${Math.round(block.estTokens).toLocaleString("en-US")} tok (request #${block.firstRequest})` }));
    return [makeFinding(this, run, {
      evidence,
      tokensAffected: args,
      fix: platformFix(run, {
        claude: { summary: "Write files in chunks, use Edit for small changes, and never echo a whole file back through a tool call.", snippet: "- Create large files in parts: Write the skeleton, then Edit sections in.\n- Change a few lines with Edit (old/new strings), never by rewriting the file with Write.\n- Do not paste file contents into Bash heredocs when Edit can do it." },
        codex: { summary: "Apply small patches, write large files in parts, and never echo a whole file back through a command.", snippet: "- Use apply_patch with minimal hunks; never rewrite a whole file to change a few lines.\n- Create large files in parts (skeleton first, then append sections).\n- Do not inline file contents into shell heredocs when a patch can do it." },
      }),
    })];
  },
};
