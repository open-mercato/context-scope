/**
 * `contextscope experiment`: baseline/candidate bookkeeping over the user's
 * own sessions (ADR-005 §3). No task runner, no grader, no model call; the
 * comparison is observational and says so.
 */
import { resolveRepoRoot } from "../util/repo.mjs";
import { createIndex } from "../index/writer.mjs";
import { createAnalysis } from "../server/analysis.mjs";
import { projectKeyFor } from "../adapters/discover.mjs";
import { concurrencyOf } from "./args.mjs";
import { installSignalHandlers, progressPrinter, stopIndex } from "./shared.mjs";
import { assertName, assertNoAbsolutePaths, buildSnapshot, chainDiff, deleteExperiment, EXPERIMENT_VERSION, listExperiments, loadExperiment, sameChain, saveExperiment } from "../experiment/snapshot.mjs";
import { compareExperiment, DEFAULT_MIN_SESSIONS } from "../experiment/compare.mjs";
import { renderCompareMarkdown } from "../experiment/markdown.mjs";

export const name = "experiment";
export const usage = "contextscope experiment start|candidate|compare|list|show|delete <name> [--repo <path>] [--md|--json] [--min-sessions 2]";
export const summary = [
  "Observational baseline/candidate comparison of your own sessions around an",
  "instruction-file edit. `start <name>` snapshots the instruction chain; edit the",
  "files; `candidate <name>` snapshots again (refused when nothing changed); run a",
  "few sessions; `compare <name>` prints the before/after table (--md, --json).",
  "No task runner, no grader, no model call; no causal claim.",
];

async function inventoryFor({ home, cwd, args, adapters, rules, setup, index: given }) {
  const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));
  const index = given ?? createIndex({ home, adapters, rules, concurrency: concurrencyOf(args), useWorkers: adapters ? false : undefined });
  if (!given) {
    installSignalHandlers(stopIndex(index));
    await index.ensure({ onProgress: progressPrinter({ json: true }) });
  }
  const analysis = createAnalysis({ index, home, repoRoot, rules, setup, warn: (message) => console.error(message) });
  return { repoRoot, index, analysis };
}

async function snapshotNow({ home, repoRoot, analysis, rules, now }) {
  const inventory = await analysis.getSetup();
  let rulesHash = null;
  try {
    const rulesModule = rules ?? (await import("../rules/index.mjs"));
    if (typeof rulesModule.rulesHash === "function") rulesHash = await rulesModule.rulesHash({ home });
  } catch {}
  const thresholds = await analysis.thresholds();
  return buildSnapshot({ inventory, repoRoot, home, rulesHash, thresholds, now });
}

/** `context.adapters` / `context.rules` / `context.setup` / `context.index` / `context.now` are test seams. */
export async function run(args, context) {
  const { home, cwd } = context;
  const [sub, rawName] = args.argv.filter((arg) => !arg.startsWith("-") && arg !== args.option("--repo", undefined) && arg !== args.option("--min-sessions", undefined));
  const out = context.stdout ?? ((line) => console.log(line));
  const now = context.now ? new Date(context.now) : new Date();
  if (!sub || sub === "list") {
    const experiments = await listExperiments(home);
    if (!experiments.length) { out("No experiments. Start one with `contextscope experiment start <name>`."); return; }
    for (const x of experiments) out(`${x.name}  repo ${x.repo?.name ?? "?"}  baseline ${x.baseline?.at?.slice(0, 16) ?? "?"}  candidate ${x.candidate?.at?.slice(0, 16) ?? "—"}`);
    return;
  }
  const experimentName = assertName(rawName ?? "");
  if (sub === "show") {
    const experiment = await loadExperiment(home, experimentName);
    if (!experiment) throw new Error(`No experiment named "${experimentName}".`);
    out(JSON.stringify(experiment, null, 2));
    return;
  }
  if (sub === "delete") {
    const removed = await deleteExperiment(home, experimentName);
    out(removed ? `Deleted experiment ${experimentName}.` : `No experiment named "${experimentName}".`);
    return;
  }
  if (sub === "start") {
    const existing = await loadExperiment(home, experimentName);
    if (existing) throw new Error(`Experiment "${experimentName}" already exists; delete it first or pick another name.`);
    const { repoRoot, analysis } = await inventoryFor({ ...context, args });
    const baseline = await snapshotNow({ home, repoRoot, analysis, rules: context.rules, now });
    const experiment = { version: EXPERIMENT_VERSION, name: experimentName, repo: baseline.repo, createdAt: baseline.at, baseline };
    assertNoAbsolutePaths(experiment, "experiment start");
    await saveExperiment(home, experiment);
    out(`Baseline for ${experimentName}: ${baseline.chain.length} instruction file(s) in ${baseline.repo.name} at ${baseline.at} (rules ${baseline.rulesHash ?? "?"}, thresholds ${baseline.thresholdsHash ?? "?"}).`);
    out("Edit the instruction files, then run `contextscope experiment candidate " + experimentName + "`.");
    return;
  }
  if (sub === "candidate") {
    const experiment = await loadExperiment(home, experimentName);
    if (!experiment) throw new Error(`No experiment named "${experimentName}"; run \`contextscope experiment start ${experimentName}\` first.`);
    const { repoRoot, analysis } = await inventoryFor({ ...context, args });
    const candidate = await snapshotNow({ home, repoRoot, analysis, rules: context.rules, now });
    if (candidate.repo.key !== experiment.repo?.key) throw new Error(`Experiment "${experimentName}" was started in ${experiment.repo?.name ?? "another repo"}; run this from the same repository (or pass --repo).`);
    if (sameChain(experiment.baseline, candidate)) throw new Error(`Nothing changed: the instruction chain is identical to the baseline of ${experiment.baseline.at}. Edit an instruction file first.`);
    const changed = chainDiff(experiment.baseline, candidate);
    experiment.candidate = candidate;
    assertNoAbsolutePaths(experiment, "experiment candidate");
    await saveExperiment(home, experiment);
    out(`Candidate for ${experimentName}: ${changed.map((file) => `${file.path} (${file.state})`).join(", ")} at ${candidate.at}.`);
    out("Run a few sessions, then `contextscope experiment compare " + experimentName + "`.");
    return;
  }
  if (sub === "compare") {
    const experiment = await loadExperiment(home, experimentName);
    if (!experiment) throw new Error(`No experiment named "${experimentName}".`);
    const { repoRoot, analysis } = await inventoryFor({ ...context, args });
    if (experiment.repo?.key && projectKeyFor(repoRoot) !== experiment.repo.key) throw new Error(`Experiment "${experimentName}" belongs to ${experiment.repo.name}; run compare from that repository (or pass --repo).`);
    const minSessions = Math.max(1, Number(args.option("--min-sessions", String(DEFAULT_MIN_SESSIONS))) || DEFAULT_MIN_SESSIONS);
    const pop = await analysis.population();
    const sessions = pop.roots.map((root) => ({ root, descendants: pop.children.get(root.runId) ?? [] }));
    let titleOf;
    try {
      const { rules: rulesModule } = await analysis.deps();
      const catalogue = new Map();
      if (typeof rulesModule?.loadRules === "function") for (const rule of await rulesModule.loadRules({ onWarning: false })) catalogue.set(rule.id, rule.title);
      titleOf = (ruleId) => catalogue.get(ruleId);
    } catch {}
    const report = compareExperiment(experiment, sessions, { now: now.getTime(), minSessions, titleOf });
    if (args.has("--json")) out(JSON.stringify(report, null, 2));
    else out(renderCompareMarkdown(report));
    return report;
  }
  throw new Error(`Unknown experiment subcommand "${sub}". Use start, candidate, compare, list, show or delete.`);
}
