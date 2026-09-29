import { makeFinding, metricEvidence, percent, platformFix, requestEvidence, windowEvidence } from "./util.mjs";

export default {
  id: "B-10",
  scope: "session",
  severity: "medium",
  title: "System share high",
  whyItMatters: "A quarter of the window gone before the first user message leaves less room for the task and pushes compaction earlier.",
  thresholdKeys: ["systemShareHigh"],
  evaluate({ run }, thresholds) {
    if (!run || !(run.window?.value > 0)) return [];
    const main = run.scopes[0];
    const first = main?.requests?.[0];
    if (!first?.hiddenBase) return [];
    // Reconciliation v2 splits H into system / instructions / unlogged; only the first two are a setup defect
    // (a resumed session is B-16's business). Older runs carry no split, so fall back to H minus unlogged.
    const composition = first.composition ?? {};
    const instructions = composition.instructions ?? 0;
    const hidden = typeof composition.system === "number"
      ? composition.system + instructions
      : Math.max(0, first.hiddenBase.value - (composition.unlogged ?? 0));
    const share = hidden / run.window.value;
    if (share <= thresholds.systemShareHigh) return [];
    const evidence = [
      requestEvidence(run, main, first, { label: `system + instructions on the first request: ${hidden.toLocaleString("en-US")} tok (${percent(share)} of window)`, value: hidden, provenance: first.hiddenBase.provenance }),
      metricEvidence(run, "systemShare", Number(share.toFixed(4)), { label: `system prompt, tool schemas and instructions occupy ${percent(share)} of the window before the first prompt`, unit: "ratio" }),
      windowEvidence(run),
    ];
    if (instructions > 0) evidence.push(metricEvidence(run, "instructionTokens", instructions, { label: `of which instructions est. ${instructions.toLocaleString("en-US")} tok`, provenance: "estimated.local" }));
    return [makeFinding(this, run, {
      evidence,
      tokensAffected: hidden,
      fix: platformFix(run, {
        claude: { summary: "Remove unused MCP servers, trim CLAUDE.md, and shorten skill descriptions.", snippet: "claude mcp list\nclaude mcp remove <unused-server>\n# then move path-specific sections of CLAUDE.md into .claude/rules/<topic>.md with `paths:` frontmatter" },
        codex: { summary: "Disable unused MCP servers in config.toml and split AGENTS.md into nested files.", path: "~/.codex/config.toml", snippet: "[mcp_servers.<unused-server>]\nenabled = false" },
      }),
    })];
  },
};
