/** `contextscope index`: build, update or clear ~/.contextscope/index. */
import { createIndex } from "../index/writer.mjs";
import { formatCount } from "../util/format.mjs";
import { concurrencyOf } from "./args.mjs";
import { installSignalHandlers, progressPrinter, stopIndex } from "./shared.mjs";

export const name = "index";
export const usage = "contextscope index [--clear | --refresh] [--json] [--concurrency 4]";
export const summary = [
  "Build or update ~/.contextscope/index (metadata only). --clear deletes it,",
  "--refresh re-parses every session file.",
];

export async function run(args, { home }) {
  const json = args.has("--json");
  const index = createIndex({ home, concurrency: concurrencyOf(args) });
  if (args.has("--clear")) {
    await index.clear();
    if (json) console.log(JSON.stringify({ cleared: true, root: "~/.contextscope/index/v1" }));
    else console.log("ContextScope index cleared (~/.contextscope/index/v1).");
    return;
  }
  installSignalHandlers(stopIndex(index));
  const result = await index.ensure({ force: args.has("--refresh"), onProgress: progressPrinter({ json }) });
  if (json) {
    console.log(JSON.stringify({ parsed: result.parsed, reevaluated: result.reevaluated, skipped: result.skipped, failed: result.failed, removed: result.removed, files: result.files, ms: result.ms, aborted: result.aborted, estimatorChanged: result.estimatorChanged, rulesChanged: result.rulesChanged ?? 0 }));
  } else {
    console.log(`Indexed ${formatCount(result.files)} session file(s): ${formatCount(result.parsed)} parsed, ${formatCount(result.reevaluated)} re-evaluated, ${formatCount(result.skipped)} unchanged, ${formatCount(result.failed)} failed, ${formatCount(result.removed)} removed in ${(result.ms / 1000).toFixed(1)} s${result.aborted ? " (aborted)" : ""}.`);
    if (result.rulesChanged > 0) console.log(`Rules changed: ${formatCount(result.rulesChanged)} stored run(s) re-evaluated without re-parsing.`);
    console.log("Index: ~/.contextscope/index/v1 (metadata only; no transcript text).");
  }
}
