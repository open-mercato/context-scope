/**
 * Runtime mirror of `CATEGORIES` in ./types.ts (the CLI is plain ESM and
 * cannot import the .ts file). Keep the two lists identical; test/ir-calibration.test.mjs
 * checks that every category named here appears in types.ts.
 */
export const CATEGORIES = [
  "system", "instructions", "skills", "user", "assistant_text", "assistant_thinking",
  "tool_call", "tool_result.file", "tool_result.shell", "tool_result.search", "tool_result.web",
  "tool_result.other", "subagent_handoff", "compaction_summary", "attachments", "memory", "unlogged", "other",
];

/** Stack order for the UI: `unlogged` sits directly above `system` (hatched neutral band). */
export const STACK_ORDER = [
  "system", "unlogged", "instructions", "skills", "memory", "compaction_summary", "user", "attachments",
  "tool_call", "tool_result.file", "tool_result.shell", "tool_result.search", "tool_result.web", "tool_result.other",
  "subagent_handoff", "assistant_text", "other",
];
