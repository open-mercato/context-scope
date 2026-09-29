/** `contextscope help`: usage text generated from the command registry. */
export const name = "help";
export const usage = "contextscope help";
export const summary = [];

const INDENT = " ".repeat(21);

export function renderHelp(commands) {
  const lines = ["ContextScope: context-window profiler for Claude Code and Codex sessions", "", "Usage:"];
  for (const command of Object.values(commands)) {
    lines.push(`  ${command.usage}`);
    for (const line of command.summary ?? []) lines.push(`${INDENT}${line}`);
  }
  lines.push("", "Everything is read-only and limited to ~/.claude, ~/.codex (and ~/.gemini for detection)");
  lines.push("plus the selected repository. The index stores sizes, hashes, tool names and token counts;");
  lines.push("never transcript text or absolute paths outside your home directory.");
  return lines.join("\n");
}

export async function run(args, { commands }) {
  console.log(renderHelp(commands));
}
