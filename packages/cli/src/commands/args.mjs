/**
 * Argument parsing for the CLI. `parseArgs(argv)` picks the command name
 * (`--help`/`-h` → help; a leading option → start; otherwise the first word)
 * and returns `{ command, argv, option(name, fallback), has(name) }` for the
 * remaining arguments.
 */
export function parseArgs(argv, { defaultCommand = "start" } = {}) {
  const rest = [...argv];
  const first = rest[0];
  const command = first === "--help" || first === "-h"
    ? (rest.shift(), "help")
    : first?.startsWith("-") ? defaultCommand : (rest.shift() ?? defaultCommand);
  return {
    command,
    argv: rest,
    /** Value after `name`, or `fallback` when the flag is absent or bare. */
    option(name, fallback) {
      const index = rest.indexOf(name);
      return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
    },
    has(name) {
      return rest.includes(name);
    },
  };
}

/** `--concurrency` as a positive integer, defaulting to 4. */
export function concurrencyOf(args) {
  return Number(args.option("--concurrency", "4")) || 4;
}
