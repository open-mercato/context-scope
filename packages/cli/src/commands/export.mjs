/** `contextscope export`: write a privacy-safe `contextscope.export/1` document for one run. */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createIndex } from "../index/writer.mjs";
import { createAnalysis } from "../server/analysis.mjs";
import { buildExport, parseScopeSelection } from "../export/schema.mjs";
import { resolveRepoRoot } from "../util/repo.mjs";
import { concurrencyOf } from "./args.mjs";
import { installSignalHandlers, progressPrinter, stopIndex } from "./shared.mjs";

export const name = "export";
export const usage = "contextscope export  --run <vendor:id> [--out <file.json>] [--scopes main|all|<id,id>] [--redact-labels] [--md]";
export const summary = [
  "Write a shareable export of one session: the run shell, the chosen scopes,",
  "thresholds and a markdown summary. Sizes, hashes and token counts only;",
  "--redact-labels hashes every file name, label and path-like token (salted per export);",
  "--md also writes <file>.md. Refuses documents above the 50 MB importer cap.",
];

/** Accepts `vendor:id` or a bare Claude session id. */
export function normalizeRunId(value) {
  if (!value) return null;
  return value.includes(":") ? value : `claude:${value}`;
}

/** `context.adapters` / `context.rules` are test seams (the fixtures index with fakes). */
export async function run(args, { home, cwd, adapters, rules }) {
  const runId = normalizeRunId(args.option("--run", undefined));
  if (!runId) throw new Error("export needs --run <vendor:id> (see `contextscope scan` for session ids).");
  const scopes = parseScopeSelection(args.option("--scopes", "main"));
  const redact = args.has("--redact-labels");
  const out = args.option("--out", undefined);
  const writeMarkdown = args.has("--md");
  const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));

  const index = createIndex({ home, adapters, rules, concurrency: concurrencyOf(args), useWorkers: adapters ? false : undefined });
  installSignalHandlers(stopIndex(index));
  await index.ensure({ onProgress: progressPrinter({ json: !out }) });
  const analysis = createAnalysis({ index, home, repoRoot, rules, warn: (message) => console.error(message) });
  const thresholds = await analysis.thresholds();
  let doc;
  try {
    doc = await buildExport({ index, runId, scopes, redact, thresholds, recurrence: await analysis.repoRecurrence() });
  } catch (error) {
    if (error?.status === 413) throw new Error(`${error.message}. The importer (#/open, the hosted demo) refuses larger files.`);
    throw error;
  }
  const json = JSON.stringify(doc);

  if (!out) {
    process.stdout.write(`${json}\n`);
    return;
  }
  const target = path.resolve(cwd, out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, json);
  const lines = [`Wrote ${target} (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB, ${Object.keys(doc.scopes).length} of ${doc.run.scopes.length} scope(s), labels ${doc.redaction.labels}${redact ? ", salted per export" : ""})`];
  if (!redact) lines.push("Plain labels: repo-relative file names and the project name are readable; add --redact-labels before sharing outside the team.");
  if (writeMarkdown) {
    const mdPath = target.replace(/\.json$/i, "") + ".md";
    await writeFile(mdPath, doc.markdown);
    lines.push(`Wrote ${mdPath}`);
  }
  console.error(lines.join("\n"));
}
