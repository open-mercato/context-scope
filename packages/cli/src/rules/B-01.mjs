import { aggregatedBlockEvidence, blockEvidence, blockSeverity, countedTitle, findingScopeFor, formatTokens, groupByScope, isToolResult, makeFinding, platformFix, resultKind, scopeRef, sum, toolName, toolTarget } from "./util.mjs";

// Fixes a child can apply itself (read in slices, cap output); the "delegate to a subagent" fallback for other kinds cannot go to a subagent.
const SELF_APPLICABLE_KINDS = new Set(["file", "search", "shell", "web"]);

/** Fix for the fattest block of the scope; every snippet is pasteable as-is (placeholders only where the transcript has no value). */
function fixFor(vendor, block) {
  const kind = resultKind(block);
  const name = toolName(block);
  const target = toolTarget(block);
  if (vendor === "claude") {
    // A Bash `cat path` (kind file, ADR-005 section 4) keeps the shell: the fix is a ranged shell read, not a Read call.
    if (kind === "file" && name === "Bash") return { summary: `Read ${target ?? "the file"} in slices instead of whole.`, snippet: `Bash { command: "sed -n '1,200p' ${target ?? "<path>"}" }` };
    if (kind === "file") return { summary: `Read ${target ?? "the file"} in slices instead of whole.`, snippet: `Read { file_path: "${target ?? "<path>"}", offset: 1, limit: 200 }` };
    if (kind === "search") return { summary: `Cap ${name} output; ask for file names first.`, snippet: `Grep { pattern: "<pattern>", output_mode: "files_with_matches", head_limit: 50 }` };
    if (kind === "shell") return { summary: "Truncate shell output before it enters the context.", snippet: `Bash { command: "${target ?? "<command>"} 2>&1 | head -c 8000" }` };
    if (kind === "web") return { summary: "Ask WebFetch for a focused extract instead of the whole page.", snippet: `WebFetch { url: "${target ?? "<url>"}", prompt: "Extract only <the fields you need>; under 300 words." }` };
    return { summary: `Delegate ${name} to a subagent and keep only its summary.`, snippet: `Agent { description: "<task>", prompt: "Run ${name} and return findings only: paths, line refs, decisions. Under 600 words. Do not paste tool output." }` };
  }
  if (kind === "file") return { summary: `Read ${target ?? "the file"} in slices instead of whole.`, snippet: `sed -n '1,200p' ${target ?? "<path>"}` };
  if (kind === "search") return { summary: "Return file names first, then targeted lines.", snippet: "rg -l '<pattern>' | head -50" };
  if (kind === "shell") return { summary: "Truncate output before it enters the context.", snippet: `${target ?? "<command>"} 2>&1 | head -c 8000` };
  return { summary: "Keep tool results small; add a standing rule to AGENTS.md.", snippet: "- Keep tool results under ~8k tokens: pipe through `head -c 8000`, use `rg -l` before `rg -n`, read files with `sed -n 'A,Bp'`." };
}

export default {
  id: "B-01",
  scope: "session",
  severity: "medium",
  title: "Fat tool result",
  whyItMatters: "One oversized result can occupy a tenth of the window until compaction and pushes the task instructions toward the \"lost in the middle\" zone.",
  thresholdKeys: ["fatToolResultTokens", "fatBlockWindowShare"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const limit = thresholds.fatToolResultTokens;
    const findings = [];
    for (const { scope, blocks } of groupByScope(run, (b) => isToolResult(b) && b.estTokens > limit)) {
      const evidence = aggregatedBlockEvidence(run, scope, blocks, (block) =>
        blockEvidence(run, block, { label: `${toolName(block)}${toolTarget(block) ? ` ${toolTarget(block)}` : ""} result ${formatTokens(block.estTokens)} at request #${block.firstRequest}` }));
      const fattest = blocks.reduce((best, b) => (b.estTokens > best.estTokens ? b : best), blocks[0]);
      const variants = { claude: fixFor("claude", fattest), codex: fixFor("codex", fattest) };
      findings.push(makeFinding(this, run, {
        scope: findingScopeFor(scope),
        scopeId: scope.id,
        primaryRef: scopeRef(run, scope),
        count: blocks.length,
        title: countedTitle(this, blocks.length),
        severity: blockSeverity(this, run, blocks, limit, thresholds),
        evidence,
        tokensAffected: sum(blocks.map((b) => b.estTokens)),
        fix: platformFix(run, { ...variants, ...(SELF_APPLICABLE_KINDS.has(resultKind(fattest)) ? { subagent: variants } : {}) }, { scope }),
      }));
    }
    return findings;
  },
};
