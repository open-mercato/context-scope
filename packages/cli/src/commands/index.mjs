/**
 * Command registry. A command module exports `{ name, summary, usage, run(args, context) }`
 * where `args` comes from commands/args.mjs and `context` is `{ home, cwd, commands }`.
 * A stream adds a command by appending one line here; `help` is generated from this table.
 */
import * as start from "./start.mjs";
import * as scan from "./scan.mjs";
import * as index from "./index-command.mjs";
import * as exportCommand from "./export.mjs";
import * as hooks from "./hooks.mjs";
import * as check from "./check.mjs";
import * as status from "./status.mjs";
import * as experiment from "./experiment.mjs";
import * as help from "./help.mjs";

export const COMMANDS = {
  start,
  scan,
  index,
  export: exportCommand,
  hooks,
  check,
  status,
  experiment,
  help,
};
