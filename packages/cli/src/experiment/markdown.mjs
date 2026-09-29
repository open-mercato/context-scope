/**
 * Markdown for `experiment compare` (ADR-005 §3): the §1 table, N per side,
 * the interval when it exists, the confound line, and the observational
 * sentence first and last. Deterministic for a given report.
 */
import { METRICS } from "../index/changes.mjs";
import { formatTokens } from "../util/format.mjs";

export const OBSERVATIONAL_SENTENCE = "observational comparison; no causal claim";

function cell(metric, value) {
  if (value === null || value === undefined) return "—";
  if (metric.unit === "tokens") return formatTokens(value);
  if (metric.unit === "ratio") return metric.key === "peakShare" ? `${Math.round(value * 100)}%` : `${Number(value).toFixed(2)}x`;
  return String(Math.round(value * 100) / 100);
}

function deltaCell(metric, report) {
  const delta = report.delta?.[metric.key];
  if (delta === undefined) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const ratio = report.delta[`${metric.key}Ratio`];
  const ci = report.ci?.[metric.key];
  let text = `${sign}${cell(metric, Math.abs(delta))}`;
  if (ratio !== undefined) text += ` (${ratio.toFixed(2)}x)`;
  if (ci) text += ` · 90% [${cell(metric, ci.low)}, ${cell(metric, ci.high)}]`;
  return text;
}

function day(iso) {
  return String(iso ?? "").slice(0, 10) || "?";
}

export function renderCompareMarkdown(report) {
  const x = report.experiment ?? {};
  const n = report.n ?? { before: 0, after: 0 };
  const lines = [];
  lines.push(`# Experiment ${x.name ?? report.file}: ${OBSERVATIONAL_SENTENCE}`);
  lines.push("");
  lines.push("Observational comparison of your own sessions. Each session is a different task, so \"same task\" has no definition here; comparable means same repo, same vendor, same dominant model and CLI version. Nothing below attributes a result to the change; a number moved, that is all.");
  lines.push("");
  lines.push(`- Baseline: ${day(x.baseline?.at)} · chain ${x.baseline?.files ?? 0} file(s) · rules ${x.baseline?.rulesHash ?? "?"} · thresholds ${x.baseline?.thresholdsHash ?? "?"}`);
  lines.push(`- Candidate: ${day(x.candidate?.at)} · chain ${x.candidate?.files ?? 0} file(s) · rules ${x.candidate?.rulesHash ?? "?"} · thresholds ${x.candidate?.thresholdsHash ?? "?"}`);
  const changed = x.changedFiles ?? [];
  lines.push(`- Changed files: ${changed.length ? changed.map((file) => `\`${file.path}\` (${file.state}${file.state === "changed" ? `, ${file.bytesFrom ?? "?"} → ${file.bytesTo ?? "?"} bytes` : ""})`).join(", ") : "none"}`);
  lines.push(`- Sessions: n = {baseline: ${n.before}, candidate: ${n.after}} · verified by hash: ${x.verified?.baseline ?? 0} / ${x.verified?.candidate ?? 0} · excluded: vendor ${x.excluded?.vendor ?? 0}, model ${x.excluded?.model ?? 0}, CLI version ${x.excluded?.cliVersion ?? 0}`);
  lines.push(`- Comparable: ${x.comparable?.vendors?.length ? x.comparable.vendors.join(", ") : "any vendor"} · model ${x.comparable?.model ?? "any"} · CLI ${x.comparable?.cliVersion ?? "any"}`);
  lines.push(`- Model/CLI confound: ${report.confounds?.confounded ? report.confounds.reason : "none"}`);
  lines.push(`- Interval: ${report.ci ? "90% bootstrap interval of the difference of medians (seeded)" : "none (n small: below 5 sessions per side)"}`);
  lines.push("");
  if (x.enough === false) lines.push(`Not enough sessions to read the rows: need ${x.minSessions} per side (pass \`--min-sessions 1\` to show values anyway).`);
  lines.push("");
  lines.push("| Metric | Provenance | Baseline | Candidate | Delta (candidate − baseline) | n |");
  lines.push("|---|---|---|---|---|---|");
  for (const metric of METRICS) {
    const b = report.before?.[metric.key] ?? { value: null, n: 0 };
    const a = report.after?.[metric.key] ?? { value: null, n: 0 };
    const show = x.enough !== false;
    lines.push(`| ${metric.label} | ${metric.provenance} | ${show ? cell(metric, b.value) : `n < ${x.minSessions}`} | ${show ? cell(metric, a.value) : `n < ${x.minSessions}`} | ${show ? deltaCell(metric, report) : "—"} | ${b.n} / ${a.n} |`);
  }
  lines.push("");
  if (report.findingsByRule?.length) {
    lines.push("| Rule | Baseline sessions | Candidate sessions |");
    lines.push("|---|---|---|");
    for (const row of report.findingsByRule) lines.push(`| ${row.ruleId} ${row.title} | ${row.before.sessions}/${row.before.of} | ${row.after.sessions}/${row.after.of} |`);
    lines.push("");
  }
  lines.push(`Caveats: ${(report.caveats ?? []).join(" · ")}`);
  lines.push("");
  lines.push(OBSERVATIONAL_SENTENCE);
  return lines.join("\n");
}
