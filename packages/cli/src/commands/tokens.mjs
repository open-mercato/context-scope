/**
 * `contextscope tokens <file|dir|->...`: estimated tokens of files, directories
 * (text files inside, recursively) or stdin, with the same calibrated estimator
 * the index uses. Nothing is sent anywhere; the numbers are `estimated.local`.
 */
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { CALIBRATION_VERSION, tokenReport } from "../ir/estimate.mjs";
import { IGNORED_DIRS } from "../setup/fs.mjs";
import { walkFiles } from "../util/fs.mjs";
import { formatCount, formatTokens, padLeft, padRight } from "../util/format.mjs";

export const name = "tokens";
export const usage = "contextscope tokens <file|dir|->... [--kind auto|prose|code] [--top 20] [--json]";
export const summary = [
  "Estimated tokens of files, directories (text files inside, recursively) or stdin (-):",
  "bytes, lines, detected kind, and the Claude-calibrated, Codex-calibrated and neutral",
  "estimates. Local arithmetic only; exact counts need the vendor's tokenizer.",
];

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KINDS = new Set(["auto", "prose", "code"]);

export class TokensUsageError extends Error {}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** One row per readable text file; binary, oversized and unreadable files are listed as skipped. */
export async function tokensReport(targets, { cwd = process.cwd(), kind = "auto", stdin = readStdin } = {}) {
  if (!KINDS.has(kind)) throw new TokensUsageError(`--kind must be auto, prose or code (got ${kind})`);
  if (!targets.length) throw new TokensUsageError("name at least one file, directory, or - for stdin");
  const rows = [];
  const skipped = [];
  const add = (label, buffer) => {
    if (isBinary(buffer)) { skipped.push({ path: label, reason: "binary" }); return; }
    rows.push({ path: label, ...tokenReport(buffer.toString("utf8"), { kind }) });
  };
  for (const target of targets) {
    if (target === "-") { add("(stdin)", await stdin()); continue; }
    const abs = path.resolve(cwd, target);
    const info = await stat(abs).catch(() => null);
    if (!info) { skipped.push({ path: target, reason: "not found" }); continue; }
    const files = info.isDirectory()
      ? (await walkFiles(abs, { maxDepth: 12, maxFiles: MAX_FILES, ignore: IGNORED_DIRS })).sort()
      : [abs];
    for (const file of files) {
      const label = path.relative(cwd, file) || path.basename(file);
      const size = files.length === 1 && !info.isDirectory() ? info.size : (await stat(file).catch(() => null))?.size ?? 0;
      if (size > MAX_FILE_BYTES) { skipped.push({ path: label, reason: `over ${MAX_FILE_BYTES / 1024 / 1024} MB` }); continue; }
      const buffer = await readFile(file).catch(() => null);
      if (!buffer) { skipped.push({ path: label, reason: "unreadable" }); continue; }
      add(label, buffer);
    }
  }
  const total = rows.reduce((sum, row) => ({
    bytes: sum.bytes + row.bytes,
    lines: sum.lines + row.lines,
    tokens: { claude: sum.tokens.claude + row.tokens.claude, codex: sum.tokens.codex + row.tokens.codex, neutral: sum.tokens.neutral + row.tokens.neutral },
  }), { bytes: 0, lines: 0, tokens: { claude: 0, codex: 0, neutral: 0 } });
  return { files: rows, skipped, total, provenance: "estimated.local", calibrationVersion: CALIBRATION_VERSION };
}

export function renderTokens(report, { top = 20 } = {}) {
  const shown = report.files.length > top ? [...report.files].sort((a, b) => b.tokens.claude - a.tokens.claude).slice(0, top) : report.files;
  const totalLabel = `total (${formatCount(report.files.length)} files)`;
  const width = Math.min(60, Math.max(12, ...shown.map((row) => row.path.length), report.files.length > 1 ? totalLabel.length : 0));
  const header = `  ${padRight("file", width)} ${padLeft("bytes", 10)} ${padLeft("lines", 7)}  ${padRight("kind", 5)} ${padLeft("claude", 8)} ${padLeft("codex", 8)} ${padLeft("neutral", 8)}`;
  const line = (label, row, kind) => `  ${padRight(label.length > width ? "…" + label.slice(-(width - 1)) : label, width)} ${padLeft(formatCount(row.bytes), 10)} ${padLeft(formatCount(row.lines), 7)}  ${padRight(kind, 5)} ${padLeft(formatTokens(row.tokens.claude), 8)} ${padLeft(formatTokens(row.tokens.codex), 8)} ${padLeft(formatTokens(row.tokens.neutral), 8)}`;
  const lines = [header];
  for (const row of shown) lines.push(line(row.path, row, row.kind));
  if (report.files.length > shown.length) lines.push(`  … ${formatCount(report.files.length - shown.length)} more file(s) (largest ${shown.length} shown; --top <n>)`);
  if (report.files.length > 1) lines.push(line(totalLabel, report.total, ""));
  for (const item of report.skipped) lines.push(`  skipped ${item.path}: ${item.reason}`);
  lines.push(`estimated.local · calibration ${report.calibrationVersion} · claude/codex = bytes-per-token fitted on real sessions; neutral = ~3.6 B/token prose, 3.2 code`);
  return lines.join("\n");
}

export async function run(args, { cwd }) {
  const valued = new Set(["--kind", "--top"]);
  const targets = args.argv.filter((arg, index) => (arg === "-" || !arg.startsWith("-")) && !valued.has(args.argv[index - 1]));
  try {
    const report = await tokensReport(targets, { cwd, kind: args.option("--kind", "auto") });
    if (args.has("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(renderTokens(report, { top: Math.max(1, Number(args.option("--top", "20")) || 20) }));
    if (!report.files.length) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof TokensUsageError)) throw error;
    console.error(`contextscope tokens: ${error.message}\nusage: ${usage}`);
    process.exitCode = 2;
  }
}
