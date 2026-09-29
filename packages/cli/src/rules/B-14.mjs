import { aggregatedBlockEvidence, blockEvidence, blockSeverity, countedTitle, findingScopeFor, formatTokens, groupByScope, makeFinding, platformFix, scopeRef, sum, toolName } from "./util.mjs";

export default {
  id: "B-14",
  scope: "session",
  severity: "medium",
  title: "Search flood",
  whyItMatters: "Search results are lists; the model needs the top hits, not all hits.",
  thresholdKeys: ["searchFloodTokens", "fatBlockWindowShare"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const limit = thresholds.searchFloodTokens;
    const findings = [];
    for (const { scope, blocks } of groupByScope(run, (b) => b.category === "tool_result.search" && b.estTokens > limit)) {
      const evidence = aggregatedBlockEvidence(run, scope, blocks, (block) =>
        blockEvidence(run, block, { label: `${toolName(block)} result ${formatTokens(block.estTokens)} at request #${block.firstRequest}` }));
      const fattest = blocks.reduce((best, b) => (b.estTokens > best.estTokens ? b : best), blocks[0]);
      const isGlob = /glob|find/i.test(toolName(fattest));
      findings.push(makeFinding(this, run, {
        scope: findingScopeFor(scope),
        scopeId: scope.id,
        primaryRef: scopeRef(run, scope),
        count: blocks.length,
        title: countedTitle(this, blocks.length),
        severity: blockSeverity(this, run, blocks, limit, thresholds),
        evidence,
        tokensAffected: sum(blocks.map((b) => b.estTokens)),
        fix: platformFix(run, {
          claude: isGlob
            ? { summary: "Narrow the Glob pattern or path so it returns the top hits only.", snippet: "Glob { pattern: \"src/**/<narrower>.ts\", path: \"<subdir>\" }" }
            : { summary: "Ask Grep for file names first and cap the hit count.", snippet: "Grep { pattern: \"<pattern>\", output_mode: \"files_with_matches\", head_limit: 50 }" },
          codex: { summary: "List matching files first, then cap matches per file.", snippet: "rg -l '<pattern>' | head -50\nrg --max-count 3 -n '<pattern>' <file>" },
        }),
      }));
    }
    return findings;
  },
};
