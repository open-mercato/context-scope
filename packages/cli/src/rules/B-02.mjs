import { blockEvidence, formatTokens, isToolResult, iterBlocks, makeFinding, metricEvidence, platformFix, resultKind, sum } from "./util.mjs";

const RULE_LINE = {
  file: "Prefer targeted reads: never read a whole file when a range will do; read at most 200 lines per call.",
  search: "Search returns lists: ask for file names first, then read the specific lines you need.",
  shell: "Keep shell output short: pipe through head, tail, or grep; never dump whole logs into the conversation.",
  web: "When fetching pages, extract only the facts you need; never paste whole pages.",
  other: "Keep tool results small: ask for summaries, not dumps.",
};

export default {
  id: "B-02",
  scope: "session",
  severity: "high",
  title: "Repeated fat results",
  whyItMatters: "Repetition is a habit signal, not an accident; fix it in instructions once.",
  thresholdKeys: ["repeatedFatResultTokens", "repeatedFatResultCount"],
  evaluate({ run }, thresholds) {
    if (!run) return [];
    const minTokens = thresholds.repeatedFatResultTokens;
    const minCount = thresholds.repeatedFatResultCount;
    const byKind = new Map();
    for (const { block } of iterBlocks(run, (b) => isToolResult(b) && b.estTokens > minTokens)) {
      const kind = resultKind(block);
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(block);
    }
    const findings = [];
    for (const [kind, blocks] of byKind) {
      if (blocks.length < minCount) continue;
      const total = sum(blocks.map((b) => b.estTokens));
      const line = RULE_LINE[kind] ?? RULE_LINE.other;
      const evidence = [
        metricEvidence(run, `fatResults.${kind}`, blocks.length, { label: `${blocks.length} ${kind} results over ${formatTokens(minTokens)} (${formatTokens(total)} together)`, unit: "count" }),
        ...blocks.sort((a, b) => b.estTokens - a.estTokens).slice(0, 8).map((block) => blockEvidence(run, block)),
      ];
      findings.push(makeFinding(this, run, {
        evidence,
        tokensAffected: total,
        fix: platformFix(run, {
          claude: { summary: `Add a standing rule to CLAUDE.md so ${kind} results stay small.`, path: "CLAUDE.md", snippet: `- ${line}` },
          codex: { summary: `Add a standing rule to AGENTS.md so ${kind} results stay small.`, path: "AGENTS.md", snippet: `- ${line}` },
        }),
      }));
    }
    return findings;
  },
};
