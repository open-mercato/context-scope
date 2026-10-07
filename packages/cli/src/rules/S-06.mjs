import { chainFor, rootInstructionFile } from "../setup/precedence.mjs";
import { fileEvidence, makeFinding, metricEvidence } from "../setup/findings.mjs";

const rule = {
  id: "S-06",
  scope: "setup",
  severity: "medium",
  title: "No rules scoping",
  whyItMatters: "Global instructions load for every task; scoped ones load only when the model touches those files.",
  thresholdKeys: ["rulesScopingMinTokens"],
  evaluate(input, thresholds) {
    const setup = input.setup;
    if (!setup) return [];
    const min = thresholds.rulesScopingMinTokens;
    const files = setup.instructionFiles;
    const findings = [];

    const claudeRoot = rootInstructionFile(files, "claude");
    const scopedRules = files.filter(f => f.scope === "rules" && f.pathsFrontmatter?.length);
    // Project CLAUDE.md plus whatever it @imports (an importer of a 10k-token AGENTS.md is a 10k-token CLAUDE.md).
    const projectTokens = chainFor(files, "claude").filter(f => f.scope === "project").reduce((sum, f) => sum + f.estTokens, 0);
    if (claudeRoot && projectTokens > min && !scopedRules.length) {
      findings.push(makeFinding(rule, {
        primaryRef: `claude:${claudeRoot.path}`,
        vendor: "claude",
        tokensAffected: projectTokens - min,
        evidence: [
          fileEvidence(claudeRoot.path, `${claudeRoot.path}${projectTokens !== claudeRoot.estTokens ? " with its imports" : ""} is ${projectTokens} est. tokens (threshold ${min})`, projectTokens),
          metricEvidence(".claude/rules", `.claude/rules/*.md files with paths: frontmatter: ${scopedRules.length}`, scopedRules.length, "count", "observed.artifact"),
        ],
        fix: {
          platform: "claude",
          summary: "Create .claude/rules/<topic>.md files with `paths:` frontmatter so directory-specific guidance loads only when those files are touched.",
          path: ".claude/rules/<topic>.md",
          snippet: "---\npaths:\n  - \"src/<area>/**\"\n---\n# <area> rules\n<move the <area>-specific section out of CLAUDE.md>\n",
        },
      }));
    }

    const codexRoot = rootInstructionFile(files, "codex");
    const nestedAgents = files.filter(f => f.scope === "nested" && f.vendors.includes("codex"));
    if (codexRoot && codexRoot.estTokens > min && !nestedAgents.length) {
      findings.push(makeFinding(rule, {
        primaryRef: `codex:${codexRoot.path}`,
        vendor: "codex",
        tokensAffected: codexRoot.estTokens - min,
        evidence: [
          fileEvidence(codexRoot.path, `${codexRoot.path} is ${codexRoot.estTokens} est. tokens (threshold ${min})`, codexRoot.estTokens),
          metricEvidence("**/AGENTS.md", "nested AGENTS.md files: 0", 0, "count", "observed.artifact"),
        ],
        fix: {
          platform: "codex",
          summary: "Add nested AGENTS.md files in the directories that need specific guidance; Codex loads them only when working there.",
          path: "<subdir>/AGENTS.md",
          snippet: "# <subdir>\n<guidance that only applies under <subdir>; remove it from the root AGENTS.md>\n",
        },
      }));
    }
    return findings;
  },
};

export default rule;
