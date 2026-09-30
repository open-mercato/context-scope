#!/usr/bin/env node
/**
 * ContextScope CLI (0.11.0). Thin dispatcher over the command registry in
 * commands/index.mjs; each command lives in commands/<name>.mjs
 * (start, scan, index, export, hooks, check, status, experiment, help).
 * Everything is read-only and limited to the vendor stores and the launched
 * repository, with two opt-in exceptions: `hooks install` edits a Claude
 * settings.json after a diff preview and backup, and the installed hook
 * appends metadata-only records under ~/.contextscope/capture. The index under
 * ~/.contextscope holds sizes, hashes, tool names and token counts only.
 */
import os from "node:os";
import { parseArgs } from "./commands/args.mjs";
import { COMMANDS } from "./commands/index.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args.command];
  if (!command) throw new Error(`Unknown command: ${args.command}. Commands: ${Object.keys(COMMANDS).join(", ")}.`);
  await command.run(args, { home: os.homedir(), cwd: process.cwd(), commands: COMMANDS });
}

main().catch((error) => {
  console.error(`ContextScope: ${error.message}`);
  process.exitCode = 1;
});
