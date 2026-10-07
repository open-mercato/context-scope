/** Helpers shared by the index-driving commands: terminal progress and Ctrl+C handling. */
import { formatCount } from "../util/format.mjs";

/**
 * Terminal progress for an index pass. `json: true` is silent (`scan --json`,
 * `index --json` print one document at the end); `ndjson: true` writes every
 * index event as one JSON line to `out` (`start --json`, ADR-005 §6).
 */
export function progressPrinter({ json = false, ndjson = false, out = (line) => process.stdout.write(line) } = {}) {
  let lastLine = 0;
  return (event) => {
    if (ndjson) { if (event && typeof event === "object") out(`${JSON.stringify(event)}\n`); return; }
    if (json) return;
    if (event.type === "start") {
      if (event.estimatorChanged > 0) process.stderr.write(`Estimator changed (${event.estimatorVersion}); re-parsing ${formatCount(event.estimatorChanged)} file(s)\n`);
      if (event.rulesChanged > 0) process.stderr.write(`Rules changed (${event.rulesHash}); re-evaluating ${formatCount(event.rulesChanged)} stored run(s) without re-parsing\n`);
      process.stderr.write(`Indexing ${formatCount(event.total)} changed session file(s), ${formatCount(event.skipped)} up to date\n`);
    }
    if (event.type === "progress" && Date.now() - lastLine > 250) {
      lastLine = Date.now();
      process.stderr.write(`  ${event.done}/${event.total} ${event.file}${event.error ? " (failed)" : ""}\n`);
    }
  };
}

/** One stderr line for the last pass when rules changed or stored runs were re-evaluated (ADR-003 section 9). */
export function printPassNotes(pass, { write = (line) => process.stderr.write(line) } = {}) {
  if (!pass) return;
  const parts = [];
  if (pass.rulesChanged > 0) parts.push(`rules changed: ${formatCount(pass.rulesChanged)} stored run(s) flagged`);
  if (pass.reevaluated > 0) parts.push(`${formatCount(pass.reevaluated)} re-evaluated without re-parsing`);
  if (parts.length) write(`Last pass: ${parts.join(", ")}\n`);
}

export function installSignalHandlers(stop) {
  let stopping = false;
  const handler = (signal) => {
    if (stopping) {
      process.stderr.write("\nContextScope: forced exit.\n");
      process.exit(130);
    }
    stopping = true;
    process.stderr.write(`\nContextScope: ${signal} received, stopping (press Ctrl+C again to force).\n`);
    stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

/** Stops an index instance cleanly: abort the pass, wait for it to settle. */
export function stopIndex(index) {
  return async () => { index.abort(); await index.ensure().catch(() => {}); };
}
