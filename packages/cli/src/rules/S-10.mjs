import { makeFinding, metricEvidence } from "../setup/findings.mjs";

const rule = {
  id: "S-10",
  scope: "setup",
  severity: "low",
  title: "Memory missing",
  whyItMatters: "Without memory, each session re-discovers the same facts through tool calls.",
  thresholdKeys: ["memoryMinSessions"],
  evaluate(input, thresholds) {
    const setup = input.setup;
    const sessions = Number(input.sessionStats?.sessionCount ?? setup?.sessionCount ?? 0) || 0;
    if (!setup || !(sessions > thresholds.memoryMinSessions)) return [];
    const memory = setup.memory;
    if (memory.present && memory.indexBytes > 0) return [];
    const codexOnly = setup.vendorsDetected.length === 1 && setup.vendorsDetected[0] === "codex";
    const label = memory.present
      ? `auto-memory directory exists but MEMORY.md is ${memory.indexBytes} bytes (${memory.files} file(s))`
      : "no auto-memory directory for this project";
    return [makeFinding(rule, {
      primaryRef: "memory",
      evidence: [
        metricEvidence("~/.claude/projects/<project>/memory/MEMORY.md", label, memory.indexBytes, "count", "observed.artifact"),
        metricEvidence("sessions", `${sessions} indexed session(s) for this repo (threshold ${thresholds.memoryMinSessions})`, sessions, "count", "derived.exact"),
      ],
      fix: codexOnly ? {
        platform: "codex",
        summary: "Add the durable facts each session re-discovers (layout, build/test commands, gotchas) to AGENTS.md.",
        path: "AGENTS.md",
        snippet: "## Durable facts\n- Build: <command>\n- Test: <command>\n- Layout: <where things live>\n- Gotchas: <what keeps tripping sessions up>\n",
      } : {
        platform: "both",
        summary: "Let Claude auto-memory run, or seed MEMORY.md with durable facts; on Codex put them in AGENTS.md.",
        path: "~/.claude/projects/<project>/memory/MEMORY.md",
        snippet: "# Project memory\n- Build: <command>\n- Test: <command>\n- Layout: <where things live>\n- Gotchas: <what keeps tripping sessions up>\n",
      },
    })];
  },
};

export default rule;
