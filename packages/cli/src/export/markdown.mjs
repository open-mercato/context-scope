/**
 * Markdown summary embedded in every export (`doc.markdown`) and written next
 * to it by `contextscope export --md`. Everything comes from the export
 * document itself: facts row, peak and window share, composition at peak with
 * provenance, compactions, subagents, findings grouped by rule with the fix,
 * and the "not in transcript" line when the unlogged share is material.
 * No score, no grade; every number keeps its provenance label.
 */
import { formatCount, formatPercent, formatTokens } from "../util/format.mjs";
import { TOOL_COST_CAVEATS, TOOL_COST_UNIT, toolCostCacheReadShare } from "../ir/finalize.mjs";

const UNLOGGED_NOTE_SHARE = 0.05;
const TOP_CATEGORIES = 5;
const MAX_FINDINGS_PER_RULE = 3;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

const PROVENANCE_LABEL = {
  "observed.vendor": "observed (vendor)",
  "observed.artifact": "observed (artifact)",
  "derived.exact": "derived",
  "estimated.local": "estimated",
  unknown: "unknown",
};
const provenance = (value) => PROVENANCE_LABEL[value?.provenance ?? value] ?? String(value?.provenance ?? value ?? "unknown");
const escapeCell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (value) => `\`${String(value).replace(/`/g, "'")}\``;

function duration(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function table(header, rows) {
  const line = (cells) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

function compositionAtPeak(run, main) {
  const composition = run.summary?.compositionAtPeak ?? {};
  const entries = Object.entries(composition).filter(([, value]) => Number(value) > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "_No composition recorded at the peak request._";
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  // Category provenance: vendor usage is observed, categories are reconciled estimates; the unlogged band is the residual.
  const rows = entries.slice(0, TOP_CATEGORIES).map(([category, value]) => [category, formatTokens(value), formatPercent(value / total), category === "unlogged" ? "derived" : "estimated"]);
  const rest = entries.slice(TOP_CATEGORIES).reduce((sum, [, value]) => sum + value, 0);
  if (rest > 0) rows.push([`other (${entries.length - TOP_CATEGORIES} categories)`, formatTokens(rest), formatPercent(rest / total), "estimated"]);
  const peakIndex = main?.requests?.reduce((best, request) => (request.usage?.total > (best?.usage?.total ?? -1) ? request : best), null)?.index;
  const where = peakIndex !== undefined ? ` (request ${peakIndex})` : "";
  return `Composition at the peak request${where}:\n\n${table(["Category", "Tokens", "Share", "Provenance"], rows)}`;
}

function compactionsSection(main) {
  const list = main?.compactions ?? [];
  if (!list.length) return "No compaction boundaries in the main scope.";
  const rows = list.map((c) => [String(c.atRequest), c.trigger ?? "unknown", `${formatTokens(c.preTokens?.value)} (${provenance(c.preTokens)})`, `${formatTokens(c.postTokens?.value)} (${provenance(c.postTokens)})`, `${formatTokens(c.droppedTokens?.value)} (${provenance(c.droppedTokens)})`]);
  return `${formatCount(list.length)} compaction${list.length === 1 ? "" : "s"} in the main scope:\n\n${table(["Before request", "Trigger", "Pre", "Post", "Dropped"], rows)}`;
}

function subagentsSection(run, scopes) {
  const children = (run.scopes ?? []).slice(1);
  if (!children.length) return "No subagents in this session.";
  const rows = children.map((summary) => {
    const scope = scopes?.[summary.id] ?? summary;
    const handoff = scope.handoff?.tokens?.value;
    const ratio = scope.handoff?.compressionRatio?.value;
    const status = scope.status === "open" ? "open (no handoff yet)" : scope.status ?? "unknown";
    return [
      scope.agentType ?? "subagent",
      scope.id,
      `${formatTokens(scope.peak?.value)} (${provenance(scope.peak)})`,
      handoff !== undefined ? `${formatTokens(handoff)} (${provenance(scope.handoff.tokens)})` : "—",
      ratio !== undefined && ratio > 0 ? `${ratio.toFixed(1)}×` : "—",
      status,
    ];
  });
  return `${formatCount(children.length)} subagent${children.length === 1 ? "" : "s"}; a ratio is the child's peak divided by what came back to the parent (an em dash means not observed):\n\n${table(["Type", "Scope", "Peak", "Handoff", "Ratio", "Status"], rows)}`;
}

/** Per-tool cost (ADR-005 section 5): the run summary's table, else the main scope's. */
function toolCostSection(run, main) {
  const rows = Array.isArray(run.summary?.toolCost) ? run.summary.toolCost : Array.isArray(main?.toolCost) ? main.toolCost : [];
  if (!rows.length) return "No tool, handoff or attachment blocks to attribute (or the run was indexed before per-tool cost existed).";
  const table_ = table(["Tool", "Kind", "Blocks", "Token-requests", "Uncached", "Cache read", "Share"], rows.map((row) => [
    row.name, row.kind, formatCount(row.blocks), formatTokens(row.tokenRequests), formatTokens(row.uncached), formatPercent(toolCostCacheReadShare(row)), formatPercent(row.share),
  ]));
  return `Each tool's blocks multiplied by the requests they sat in (${TOOL_COST_UNIT}, estimated); share of the run's processed input.\n\n${table_}\n\n${TOOL_COST_CAVEATS.map((line) => `- ${line}`).join("\n")}`;
}

function findingsSection(run) {
  const findings = run.findings ?? [];
  if (!findings.length) return "No findings for this session at the current thresholds.";
  const groups = new Map();
  for (const finding of findings) {
    const group = groups.get(finding.ruleId) ?? { ruleId: finding.ruleId, title: finding.title, severity: finding.severity, findings: [], occurrences: 0, tokens: 0 };
    group.findings.push(finding);
    group.occurrences += finding.count ?? 1;
    group.tokens += finding.tokensAffected ?? 0;
    if ((SEVERITY_RANK[finding.severity] ?? 3) < (SEVERITY_RANK[group.severity] ?? 3)) group.severity = finding.severity;
    groups.set(finding.ruleId, group);
  }
  const ordered = [...groups.values()].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.tokens - a.tokens || a.ruleId.localeCompare(b.ruleId));
  const parts = [];
  for (const group of ordered) {
    const head = `### ${group.ruleId} ${group.title} · ${group.severity} · ${formatCount(group.occurrences)} occurrence${group.occurrences === 1 ? "" : "s"} · ${formatTokens(group.tokens)} tokens affected`;
    const lines = [head, ""];
    const first = group.findings[0];
    if (first?.whyItMatters) lines.push(first.whyItMatters, "");
    for (const finding of group.findings.slice(0, MAX_FINDINGS_PER_RULE)) {
      const where = finding.scopeId ? ` in ${code(finding.scopeId)}` : "";
      const evidence = (finding.evidence ?? []).slice(0, 3).map((e) => `${e.label}${e.value !== undefined ? ` = ${e.unit === "tokens" ? formatTokens(e.value) : e.unit === "percent" ? formatPercent(e.value) : formatCount(e.value)}${e.unit && !["tokens", "percent", "count"].includes(e.unit) ? ` ${e.unit}` : ""}` : ""} (${provenance(e)})`);
      lines.push(`- ${finding.count && finding.count > 1 ? `${formatCount(finding.count)} occurrences` : "1 occurrence"}${where}${evidence.length ? `: ${evidence.join("; ")}` : ""}`);
    }
    if (group.findings.length > MAX_FINDINGS_PER_RULE) lines.push(`- … and ${formatCount(group.findings.length - MAX_FINDINGS_PER_RULE)} more`);
    const fix = first?.fix;
    if (fix?.summary) {
      lines.push("", `**Fix (${fix.platform ?? "both"})${fix.path ? ` → ${code(fix.path)}` : ""}:** ${fix.summary}`);
      if (fix.snippet) lines.push("", "```", fix.snippet, "```");
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/** "main scope exported (1,365 of 1,817 requests); 16 subagents summarised" or "all N scopes exported". */
function scopesLine(run, scopes, main, summary) {
  const total = run.scopes?.length ?? 1;
  const exported = Object.keys(scopes).length;
  const mainRequests = main?.requests?.length ?? main?.requestCount ?? 0;
  if (total <= 1) return `**Exported** the main scope (${formatCount(mainRequests)} requests)`;
  if (exported >= total) return `**Exported** all ${formatCount(total)} scopes (${formatCount(summary.requests ?? mainRequests)} requests)`;
  const rest = total - exported;
  return `**Exported** ${exported === 1 ? "the main scope" : `${formatCount(exported)} scopes`} (${formatCount(mainRequests)} of ${formatCount(summary.requests ?? mainRequests)} requests); ${formatCount(rest)} subagent scope${rest === 1 ? "" : "s"} summarised only`;
}

/** Renders the markdown summary for an export document (`{ run, scopes, redaction }`). */
export function renderMarkdown(doc) {
  const run = doc.run ?? {};
  const scopes = doc.scopes ?? {};
  const summary = run.summary ?? {};
  const mainId = run.scopes?.[0]?.id ?? "main";
  const main = scopes[mainId] ?? run.scopes?.[0] ?? {};
  const peak = summary.peak ?? main.peak ?? { value: 0, provenance: "unknown" };
  const windowValue = run.window?.value ?? 0;
  const share = windowValue ? peak.value / windowValue : summary.peakShareOfWindow ?? 0;
  const redacted = doc.redaction?.labels === "sha1-10";
  const started = run.startedAt ? run.startedAt.slice(0, 16).replace("T", " ") : "unknown";
  const facts = [
    `**Session** ${code(run.id ?? "?")} · ${run.vendor ?? "?"} · project ${code(run.project?.displayName ?? "?")}${redacted ? " (labels hashed)" : ""}`,
    `**When** ${started} UTC · active ${duration(run.activeMs)} · ${formatCount(summary.requests ?? 0)} requests · ${formatCount(summary.turns ?? 0)} turns · ${formatCount(summary.toolCalls ?? 0)} tool calls`,
    `**Tokens** processed input ${formatTokens(summary.processedInputTokens ?? 0)} · output ${formatTokens(summary.outputTokens ?? 0)} · cache read share ${formatPercent(summary.cacheReadShare ?? 0)}`,
    `**Peak** ${formatTokens(peak.value)} tokens (${provenance(peak)}) = ${formatPercent(share)} of a ${formatTokens(windowValue)}-token window (${provenance(run.window)})`,
    `**Models** ${(summary.models ?? []).join(", ") || "unknown"} · **Subagents** ${formatCount(summary.subagents ?? 0)} · **Compactions** ${formatCount(summary.compactions ?? 0)}`,
    scopesLine(run, scopes, main, summary),
  ];
  const unloggedShare = main.unloggedShare ?? run.coverage?.unloggedShare ?? 0;
  if (unloggedShare > UNLOGGED_NOTE_SHARE) {
    const unlogged = Math.round(unloggedShare * (main.processedInputTokens ?? summary.processedInputTokens ?? 0));
    facts.push(`**Not in transcript** ${formatTokens(unlogged)} tokens (${formatPercent(unloggedShare)} of processed input) the model saw but the transcript does not carry: resumed history, hidden injections or tool schemas beyond the baseline (derived).`);
  }
  const sections = [
    `# ContextScope session export`,
    "",
    facts.join("  \n"),
    "",
    "## Where the context went",
    "",
    compositionAtPeak(run, main),
    "",
    "## Compactions",
    "",
    compactionsSection(main),
    "",
    "## Subagents",
    "",
    subagentsSection(run, scopes),
    "",
    "## Cost by tool",
    "",
    toolCostSection(run, main),
    "",
    "## Findings",
    "",
    findingsSection(run),
    "",
    "---",
    `Generated by ${doc.generator?.name ?? "contextscope"} ${doc.generator?.version ?? ""} at ${doc.exportedAt ?? ""}; schema ${doc.schema ?? ""}. Sizes, hashes, tool names and token counts only; no transcript text${redacted ? "; labels hashed with a per-export salt" : ""}. Provenance: observed = reported by the vendor runtime or present in an artifact; derived = exact arithmetic over observations; estimated = local reconstruction.`,
    "",
  ];
  return sections.join("\n");
}
