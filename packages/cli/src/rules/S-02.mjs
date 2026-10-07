import { fileEvidence, makeFinding, metricEvidence } from "../setup/findings.mjs";

const rule = {
  id: "S-02",
  scope: "setup",
  severity: "medium",
  title: "Duplicate instruction blocks",
  whyItMatters: "Duplicates double the cost and, when they drift, create contradictions the model resolves arbitrarily.",
  thresholdKeys: ["duplicateBlockMinLines"],
  evaluate(input, thresholds) {
    const setup = input.setup;
    const duplicates = setup?.instructionDuplicates ?? [];
    const minLines = thresholds.duplicateBlockMinLines;
    const byPair = new Map();
    for (const block of duplicates) {
      if (block.lines < minLines) continue;
      const key = `${block.a}|${block.b}`;
      const entry = byPair.get(key) ?? { a: block.a, b: block.b, blocks: [], lines: 0 };
      entry.blocks.push(block);
      entry.lines += block.lines;
      byPair.set(key, entry);
    }
    const files = new Map((setup?.instructionFiles ?? []).map(f => [f.path, f]));
    const findings = [];
    for (const pair of byPair.values()) {
      const fa = files.get(pair.a);
      const fb = files.get(pair.b);
      // Keep the copy in the higher-precedence (lower number) file; point from the other.
      const keep = fa && fb && fb.precedence < fa.precedence ? pair.b : pair.a;
      const drop = keep === pair.a ? pair.b : pair.a;
      const vendor = fa && fb ? fa.vendors.find(v => fb.vendors.includes(v)) : undefined;
      const tokensAffected = Math.round(pair.lines * 12); // ~12 tokens per instruction line
      const claude = vendor !== "codex";
      findings.push(makeFinding(rule, {
        primaryRef: `${pair.a}|${pair.b}|${pair.blocks[0].hash}`,
        vendor,
        tokensAffected,
        evidence: [
          fileEvidence(pair.a, `${pair.a} shares ${pair.lines} normalized line(s) in ${pair.blocks.length} block(s) with ${pair.b}`, pair.lines, "count", "derived.exact"),
          fileEvidence(pair.b, `${pair.b} (duplicate copy)`, pair.lines, "count", "derived.exact"),
          ...pair.blocks.slice(0, 5).map(b => metricEvidence(`block:${b.hash}`, `block ${b.hash}: ${b.lines} lines`, b.lines, "count", "derived.exact")),
        ],
        fix: {
          platform: vendor ?? "both",
          summary: `Keep one copy in ${keep}; replace the block in ${drop} with a one-line pointer.`,
          path: drop,
          snippet: claude ? `See @${keep} for the shared conventions.\n` : `See ${keep} for the shared conventions (do not duplicate them here).\n`,
        },
      }));
    }
    return findings;
  },
};

export default rule;
