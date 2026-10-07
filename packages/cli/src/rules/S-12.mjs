import { rootInstructionFile } from "../setup/precedence.mjs";
import { makeFinding, metricEvidence } from "../setup/findings.mjs";

const FILES = { claude: "CLAUDE.md", codex: "AGENTS.md", gemini: "GEMINI.md" };

const SNIPPET = `# <project name>

## What this is
<one paragraph: purpose and main components>

## Layout
- \`src/\` — <what lives here>
- \`test/\` — <how tests are organised>

## Commands
- Install: \`<command>\`
- Build: \`<command>\`
- Test: \`<command>\`

## Conventions
- <style, naming, commit rules the agent must follow>
`;

const rule = {
  id: "S-12",
  scope: "setup",
  severity: "medium",
  title: "Vendor without instructions",
  whyItMatters: "Evidence shows repository instructions reduce runtime and output tokens for comparable completion.",
  thresholdKeys: [],
  evaluate(input) {
    const setup = input.setup;
    const vendors = input.sessionStats?.vendorsWithSessions ?? [];
    if (!setup || !vendors.length) return [];
    const findings = [];
    for (const vendor of vendors) {
      if (!FILES[vendor]) continue;
      if (rootInstructionFile(setup.instructionFiles, vendor)) continue;
      // A Claude import chain or CLAUDE.local.md also counts as project instructions.
      if (vendor === "claude" && setup.instructionFiles.some(f => f.vendors.includes("claude") && f.scope === "local")) continue;
      const count = Number(input.sessionStats?.sessionsByVendor?.[vendor] ?? input.sessionStats?.sessionCount ?? 0) || 0;
      findings.push(makeFinding(rule, {
        primaryRef: `${vendor}:${FILES[vendor]}`,
        vendor,
        evidence: [
          metricEvidence(`sessions:${vendor}`, `${vendor} sessions exist for this repo${count ? ` (${count})` : ""} but ${FILES[vendor]} is absent`, count, "count", "derived.exact"),
          metricEvidence(FILES[vendor], `${FILES[vendor]} not found at the repository root`, 0, "count", "observed.artifact"),
        ],
        fix: {
          platform: vendor,
          summary: `Create ${FILES[vendor]} with conventions, build/test commands and the repository layout.`,
          path: FILES[vendor],
          snippet: SNIPPET,
        },
      }));
    }
    return findings;
  },
};

export default rule;
