import { chainFor } from "../setup/precedence.mjs";
import { observedChainFor } from "../setup/budget.mjs";
import { fileEvidence, makeFinding, metricEvidence } from "../setup/findings.mjs";
import { basisFor, estimateTokensFromBytes, estTokensFor } from "../ir/estimate.mjs";
import { formatBasis } from "../util/format.mjs";

const FIX = {
  claude: {
    summary: "Move path-specific guidance into .claude/rules/<topic>.md with `paths:` frontmatter; keep CLAUDE.md to conventions and pointers.",
    path: ".claude/rules/<topic>.md",
    snippet: "---\npaths:\n  - \"src/api/**\"\n---\n# API conventions\n<move the API-specific section of CLAUDE.md here>\n",
  },
  codex: {
    summary: "Split the root AGENTS.md into nested AGENTS.md files per directory; keep machine-local overrides in AGENTS.override.md.",
    path: "<subdir>/AGENTS.md",
    snippet: "# <subdir> guidance\n<move the section that only applies to this directory here; Codex loads it when working under <subdir>>\n",
  },
  gemini: {
    summary: "Split GEMINI.md into per-directory context files; Gemini discovers nested GEMINI.md files just in time.",
    path: "<subdir>/GEMINI.md",
    snippet: "# <subdir> guidance\n<move the section that only applies to this directory here>\n",
  },
};

const rule = {
  id: "S-01",
  scope: "setup",
  severity: "high",
  title: "Instruction file oversized",
  whyItMatters: "Instructions are resent on every request and sit at the top of the prompt; every 1k tokens there is paid on every turn and competes with task content for attention.",
  thresholdKeys: ["instructionFileTokens", "instructionChainTokens"],
  evaluate(input, thresholds) {
    const setup = input.setup;
    if (!setup) return [];
    const fileMax = thresholds.instructionFileTokens;
    const chainMax = thresholds.instructionChainTokens;
    const findings = [];
    const seen = new Set();
    for (const file of setup.instructionFiles) {
      if (file.estTokens <= fileMax || seen.has(file.path)) continue;
      seen.add(file.path);
      const vendor = file.vendors[0];
      // Nested / path-scoped files are loaded lazily (only when the model works
      // under that directory), so they never sit in the startup chain. Report
      // them, but as hygiene, and with a fix that trims rather than splits.
      const lazy = file.loadState === "discoverable";
      findings.push(makeFinding(rule, {
        primaryRef: file.path,
        vendor: file.vendors.length === 1 ? vendor : undefined,
        tokensAffected: file.estTokens,
        ...(lazy ? { severity: "low", title: "Nested instruction file oversized" } : {}),
        evidence: [
          // estTokens is the file's own vendor's figure, or the larger of two vendors' (estBasis says which).
          fileEvidence(file.path, `${file.path} is ${file.estTokens} est. tokens (${file.bytes} bytes, ${formatBasis(file.estBasis)}); threshold ${fileMax}`, file.estTokens),
          metricEvidence(file.path, `${file.bytes} bytes on disk, load state ${file.loadState}`, file.bytes, "count", "observed.artifact"),
        ],
        fix: lazy
          ? { platform: file.vendors.length === 1 ? vendor : "both", summary: `Trim ${file.path}: it loads whenever the model works under ${file.path.split("/").slice(0, -1).join("/") || "."}, so keep it to what that directory needs.`, path: file.path }
          : { platform: file.vendors.length === 1 ? vendor : "both", ...(FIX[vendor] ?? FIX.claude) },
      }));
    }
    const vendors = setup.vendorsDetected.length ? setup.vendorsDetected : [...new Set(setup.instructionFiles.flatMap(f => f.vendors))];
    for (const vendor of vendors) {
      // The observed chain (InstructionsLoaded hook) wins over the documented expectation when present.
      const observedChain = observedChainFor(setup.instructionFiles, vendor);
      const chain = observedChain ?? chainFor(setup.instructionFiles, vendor);
      // The chain as this vendor's tokenizer sees it (the same per-vendor figure as the startup budget).
      const tokensOf = (f) => estTokensFor(f, vendor);
      const basis = formatBasis(basisFor([vendor])); // "neutral ratio" for a vendor without a calibration (gemini)
      let total = chain.reduce((sum, f) => sum + tokensOf(f), 0);
      let provenance = observedChain ? "observed.artifact" : "estimated.local";
      if (vendor === "codex" && Number.isFinite(input.sessionStats?.codexInstructionChars) && input.sessionStats.codexInstructionChars > 0) {
        total = estimateTokensFromBytes(input.sessionStats.codexInstructionChars, "prose", { vendor: "codex" });
        provenance = "observed.artifact";
      }
      if (total <= chainMax || !chain.length) continue;
      const largest = [...chain].sort((a, b) => tokensOf(b) - tokensOf(a))[0];
      findings.push(makeFinding(rule, {
        primaryRef: `chain:${vendor}`,
        vendor,
        title: "Instruction chain oversized",
        tokensAffected: total,
        evidence: [
          metricEvidence(`chain:${vendor}`, `${vendor} instruction chain is ${total} est. tokens (${basis}) across ${chain.length} file(s)${observedChain ? " (membership observed by the InstructionsLoaded hook)" : ""}; threshold ${chainMax}`, total, "tokens", provenance),
          ...chain.slice(0, 8).map(f => fileEvidence(f.path, `${f.path} (${f.scope}, precedence ${f.precedence})`, tokensOf(f))),
        ],
        fix: { platform: vendor, ...(FIX[vendor] ?? FIX.claude), summary: `${FIX[vendor]?.summary ?? FIX.claude.summary} Start with ${largest.path} (${tokensOf(largest)} tokens, ${basis}).` },
      }));
    }
    return findings;
  },
};

export default rule;
