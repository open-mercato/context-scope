import { aggregatedBlockEvidence, blockEvidence, blockSeverity, countedTitle, findingScopeFor, formatTokens, groupByScope, makeFinding, platformFix, scopeRef, sum, toolTarget } from "./util.mjs";

export default {
  id: "B-03",
  scope: "session",
  severity: "medium",
  title: "Huge file read",
  whyItMatters: "Large generated files (lockfiles, fixtures, bundles) are the most common cause of a single-turn window jump.",
  thresholdKeys: ["hugeFileReadTokens", "fatBlockWindowShare"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const limit = thresholds.hugeFileReadTokens;
    const findings = [];
    for (const { scope, blocks } of groupByScope(run, (b) => b.category === "tool_result.file" && b.estTokens > limit)) {
      const evidence = aggregatedBlockEvidence(run, scope, blocks, (block) =>
        blockEvidence(run, block, { label: `file read ${toolTarget(block) ?? "<path>"}: ${formatTokens(block.estTokens)} at request #${block.firstRequest}` }));
      const fattest = blocks.reduce((best, b) => (b.estTokens > best.estTokens ? b : best), blocks[0]);
      const path = toolTarget(fattest) ?? "<path>";
      const files = [...new Set(blocks.map((b) => toolTarget(b)).filter(Boolean))];
      const list = files.length > 1 ? ` (${files.length} files: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""})` : "";
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
          claude: { summary: `Read only the sections of ${path} you need${list}, or exclude it from reads.`, snippet: `Read { file_path: "${path}", offset: <start line>, limit: 200 }` },
          codex: { summary: `Read only the sections of ${path} you need${list}, or exclude it from reads.`, snippet: `sed -n '<start>,<end>p' ${path}` },
        }),
      }));
    }
    return findings;
  },
};
