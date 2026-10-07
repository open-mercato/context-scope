/** `contextscope scan`: terminal summary of the index for one repository. */
import path from "node:path";
import { resolveRepoRoot } from "../util/repo.mjs";
import { createIndex } from "../index/writer.mjs";
import { renderScan, scanJson, scanReport } from "../index/scan.mjs";
import { createAnalysis } from "../server/analysis.mjs";
import { concurrencyOf } from "./args.mjs";
import { installSignalHandlers, printPassNotes, progressPrinter, stopIndex } from "./shared.mjs";

export const name = "scan";
export const usage = "contextscope scan  [--repo <path>] [--all] [--since 30d|90d|all] [--json]";
export const summary = [
  "Print a terminal summary of the index for the repository: sessions, tokens,",
  "cost by tool, the one change to make first, cross-session habits, what moved",
  "since the last instruction-file edits (observational), and findings by leverage.",
  "--all prints the machine-wide population; the repo line and findings stay repo-scoped.",
  "Range: all time for the repo, the last 30 days with --all; --since overrides both.",
];

export async function run(args, { home, cwd }) {
  const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));
  const json = args.has("--json");
  const all = args.has("--all");
  const since = args.option("--since", undefined);
  const index = createIndex({ home, concurrency: concurrencyOf(args) });
  installSignalHandlers(stopIndex(index));
  const pass = await index.ensure({ onProgress: progressPrinter({ json }) });
  if (!json) printPassNotes(pass);
  const analysis = createAnalysis({ index, home, repoRoot, warn: (message) => console.error(message) });
  const report = await scanReport(analysis, { since, all });
  if (json) console.log(JSON.stringify(scanJson(report), null, 2));
  else console.log(renderScan(report, { repoName: path.basename(repoRoot), since }));
}
