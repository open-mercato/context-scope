/**
 * Startup budget per vendor: tokens that enter every request before the user
 * types. Instruction chain + skill descriptions + agent descriptions + MCP
 * tool schemas. All estimated.local except: the Codex chain when the index
 * observed `user_instructions` (observed.artifact), and a chain whose every
 * expected file was seen by the InstructionsLoaded hook (observed.artifact,
 * sizes from disk). One observed file does not make the whole chain observed.
 */
import { estimateTokensFromBytes } from "../ir/estimate.mjs";
import { chainFor, chainTokens } from "./precedence.mjs";

/** Documented working assumptions; surfaced in the UI as estimates. */
export const MCP_TOKENS_PER_TOOL = 150;
export const MCP_DEFAULT_TOOLS_PER_SERVER = 10; // used when no session observed the server's tools

function measured(value, provenance = "estimated.local") {
  return { value: Math.round(value), provenance };
}

export function mcpToolCount(server) {
  return server.toolsObserved?.length ? server.toolsObserved.length : MCP_DEFAULT_TOOLS_PER_SERVER;
}

/**
 * The instruction chain as the runtime hook saw it: the vendor's
 * `observed.loaded` files (InstructionsLoaded capture), but only when the
 * WHOLE expected chain (`chainFor`: every `expected.load` file of the vendor)
 * was observed. A partial observation (the root CLAUDE.md seen, `.claude/rules`
 * not) says nothing about the rest of the chain, so it returns null and the
 * budget stays `estimated.local`. Extra observed files (a path-scoped rule
 * that fired) join the chain; sizes always come from disk.
 */
export function observedChainFor(instructionFiles, vendor) {
  const observed = instructionFiles.filter(file => file.vendors.includes(vendor) && file.loadState === "observed.loaded");
  if (!observed.length) return null;
  const expected = chainFor(instructionFiles, vendor);
  if (expected.some(file => file.loadState !== "observed.loaded")) return null;
  return observed.sort((a, b) => a.precedence - b.precedence || a.path.localeCompare(b.path));
}

export function buildStartupBudget({ vendorsDetected, instructionFiles, skills, agents, mcpServers, sessionStats }) {
  const budget = {};
  for (const vendor of vendorsDetected) {
    let instructions = measured(chainTokens(instructionFiles, vendor));
    const observedChain = observedChainFor(instructionFiles, vendor);
    if (observedChain) instructions = measured(observedChain.reduce((sum, file) => sum + file.estTokens, 0), "observed.artifact");
    if (vendor === "codex" && Number.isFinite(sessionStats?.codexInstructionChars) && sessionStats.codexInstructionChars > 0) {
      instructions = measured(estimateTokensFromBytes(sessionStats.codexInstructionChars, "prose"), "observed.artifact");
    }
    // Each vendor lists the skills it can see (Claude: .claude/skills, ~/.claude/skills, plugins; Codex: .agents/skills, ~/.agents/skills).
    const skillTokens = skills.filter((s) => (s.vendors ?? ["claude"]).includes(vendor)).reduce((sum, s) => sum + estimateTokensFromBytes(s.descriptionChars, "prose"), 0);
    const agentTokens = vendor === "claude" ? agents.reduce((sum, a) => sum + estimateTokensFromBytes(a.descriptionChars, "prose"), 0) : 0;
    const servers = mcpServers.filter(server => (server.vendor ?? "claude") === vendor);
    const mcpTokens = servers.reduce((sum, server) => sum + mcpToolCount(server) * MCP_TOKENS_PER_TOOL, 0);
    const entry = {
      instructions,
      skills: measured(skillTokens),
      agents: measured(agentTokens),
      mcpTools: measured(mcpTokens),
    };
    entry.total = measured(instructions.value + skillTokens + agentTokens + mcpTokens);
    budget[vendor] = entry;
  }
  return budget;
}
