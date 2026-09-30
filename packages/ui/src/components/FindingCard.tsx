import type { Evidence, Finding } from "@ir/types.ts";
import { BASIS_LABEL, ruleBasis } from "../rule-sources.ts";
import { hrefs, navigate, route, splitRunId } from "../router.ts";
import { copyText, thresholdEditKey, thresholds, thresholdsDrawerOpen } from "../store.ts";
import { formatNumber, formatRatio, formatTokens, percent, plural } from "../format.ts";
import { findingSessions } from "../findings.ts";
import { Badge } from "./Badge.tsx";

export interface FindingCardProps {
  finding: Finding;
  /** Optional headline above the card, e.g. "One change to make first". */
  headline?: string;
  /** Extra line under the headline, e.g. "removes 141 findings in 7 sessions". */
  subline?: string;
  highlight?: boolean;
  compact?: boolean;
  /** Overrides the "Fix (<platform>)" label, e.g. when the majority vendor of the recurrence differs from the head finding's. */
  platformLabel?: string;
}

/** Where "Show evidence" goes for a given evidence row; undefined when nothing to open. */
export function evidenceHref(evidence: Evidence, finding: Finding): string | undefined {
  const ref = evidence.ref ?? "";
  switch (evidence.kind) {
    case "request": {
      const [runId, scopeId, index] = ref.split("#");
      if (!runId) return undefined;
      const { vendor, id } = splitRunId(runId);
      return hrefs.session(vendor, id, { scope: scopeId || undefined, request: index && /^\d+$/.test(index) ? Number(index) : undefined });
    }
    case "block": {
      const [runId, blockId] = ref.split("#");
      if (!runId) return undefined;
      const { vendor, id } = splitRunId(runId);
      const scope = blockId?.includes(":") ? blockId.slice(0, blockId.indexOf(":")) : finding.scopeId;
      return hrefs.session(vendor, id, { scope });
    }
    case "scope": {
      const [runId, scopeId] = ref.split("#");
      if (!runId) return undefined;
      const { vendor, id } = splitRunId(runId);
      return hrefs.session(vendor, id, { scope: scopeId || undefined });
    }
    case "run": {
      const runId = ref || finding.runId;
      if (!runId) return undefined;
      const { vendor, id } = splitRunId(runId);
      return hrefs.session(vendor, id);
    }
    case "file":
      return hrefs.setup({ file: ref });
    case "metric":
      if (finding.runId) { const { vendor, id } = splitRunId(finding.runId); return hrefs.session(vendor, id, { scope: finding.scopeId }); }
      return finding.scope === "setup" ? hrefs.setup() : undefined;
    default:
      return undefined;
  }
}

/** First navigable evidence link of a finding. */
export function primaryHref(finding: Finding): string | undefined {
  for (const e of finding.evidence ?? []) { const href = evidenceHref(e, finding); if (href) return href; }
  if (finding.runId) { const { vendor, id } = splitRunId(finding.runId); return hrefs.session(vendor, id, { scope: finding.scopeId }); }
  return undefined;
}

export function formatEvidenceValue(evidence: Evidence): string {
  if (evidence.value === undefined || evidence.value === null) return "";
  switch (evidence.unit) {
    case "tokens": return `${formatNumber(evidence.value)} tok`;
    case "chars": return `${formatNumber(evidence.value)} chars`;
    case "count": return formatNumber(evidence.value);
    case "ratio": return formatRatio(evidence.value);
    case "percent": return percent(evidence.value > 1 ? evidence.value / 100 : evidence.value);
    case "ms": return `${formatNumber(evidence.value)} ms`;
    default: return formatNumber(evidence.value);
  }
}

/** "fatToolResultTokens" -> "8,000 tok"; "fatHandoffShare" -> "40%". */
export function formatThreshold(key: string, value: number): string {
  if (/tokens$/i.test(key)) return `${formatNumber(value)} tok`;
  if (/(share|percent|pct)$/i.test(key)) return percent(value > 1 ? value / 100 : value);
  if (/ratio$/i.test(key)) return formatRatio(value);
  if (/ms$/i.test(key)) return `${formatNumber(value)} ms`;
  if (/days$/i.test(key)) return `${formatNumber(value)} days`;
  if (/hours$/i.test(key)) return `${formatNumber(value)} h`;
  if (/(chars|characters)$/i.test(key)) return `${formatNumber(value)} chars`;
  return `${formatNumber(value)} ${humanizeKey(key)}`;
}

/** "compactionsPerSession" -> "compactions per session" */
export function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

export function fixText(finding: Finding): string {
  return finding.fix.snippet?.trim() || finding.fix.summary;
}

export function openThreshold(key: string) {
  thresholdEditKey.value = key;
  thresholdsDrawerOpen.value = true;
  if (route.value.name !== "findings") navigate(hrefs.findings());
}

/** "fires above 8,000 tok or 40% (edit)"; thresholds are loaded once by the screen, never by the card. */
export function ThresholdLine({ keys }: { keys: string[] }) {
  const current = thresholds.value;
  const parts = keys.filter((key) => current && typeof current[key] === "number").map((key) => ({ key, text: formatThreshold(key, current![key]) }));
  if (parts.length) {
    return (
      <li class="evidence-row evidence-threshold">
        <span class="evidence-label">fires above {parts.map((p, i) => <span key={p.key}>{i > 0 ? " or " : ""}<span class="evidence-value">{p.text}</span></span>)}</span>
        <button type="button" class="link" onClick={() => openThreshold(parts[0].key)} title={`Edit ${parts.map((p) => p.key).join(", ")}`}>(edit)</button>
      </li>
    );
  }
  if (!keys.length) return null;
  return (
    <li class="evidence-row evidence-threshold">
      <span class="evidence-label">threshold: {keys.join(", ")}</span>
      <button type="button" class="link" onClick={() => openThreshold(keys[0])}>(edit)</button>
    </li>
  );
}

export function EvidenceList({ finding, limit }: { finding: Finding; limit?: number }) {
  const all = finding.evidence ?? [];
  const rows = limit ? all.slice(0, limit) : all;
  return (
    <>
      {rows.map((evidence, i) => {
        const href = evidenceHref(evidence, finding);
        const value = formatEvidenceValue(evidence);
        return (
          <li key={i} class="evidence-row">
            {href ? <a href={href} class="evidence-label">{evidence.label}</a> : <span class="evidence-label">{evidence.label}</span>}
            {evidence.kind === "file" && !evidence.label.includes(evidence.ref) ? <code class="evidence-ref">{evidence.ref}</code> : null}
            {value ? <span class="evidence-value">{value}</span> : null}
            <Badge provenance={evidence.provenance} />
          </li>
        );
      })}
      {limit && all.length > limit ? <li class="evidence-row muted">+{all.length - limit} more</li> : null}
    </>
  );
}

/** The single finding card from ADR-001 section 2.5, used for the "one change to make first" slot. */
export function FindingCard({ finding, headline, subline, highlight, compact, platformLabel }: FindingCardProps) {
  const primary = primaryHref(finding);
  const platform = platformLabel ?? (finding.fix.platform === "both" ? "claude and codex" : finding.fix.platform);
  const sessions = findingSessions(finding);
  const count = finding.count ?? 1;
  const evidence = finding.evidence ?? [];
  // An empty evidence list is rendered as a hint, never as a bare "Evidence:" label (ADR-004 §1).
  const hasEvidence = evidence.length > 0 || (finding.thresholdKeys?.length ?? 0) > 0 || !!primary;

  return (
    <article class={`finding finding-${finding.severity} ${highlight ? "finding-highlight" : ""} ${compact ? "finding-compact" : ""}`} data-finding={finding.id} tabIndex={0} aria-label={`${finding.severity} finding: ${finding.title}`}>
      {headline ? <div class="finding-headline">{headline}{subline ? <span class="muted"> · {subline}</span> : null}</div> : null}
      <header class="finding-head">
        <Badge severity={finding.severity} />
        <h3 class="finding-title">{finding.title}</h3>
        <span class="finding-meta">
          {finding.scope}{finding.vendor ? <> · {finding.vendor}</> : null}
          {finding.scopeId && finding.scopeId !== "main" ? <> · <span class="finding-rule">{finding.scopeId}</span></> : null}
          {sessions > 1 ? <span title="Sessions in which the same rule fired"> · {plural(sessions, "session")}</span> : null}
          {count > 1 ? <span title="Occurrences aggregated into this finding"> · {plural(count, "occurrence")}</span> : null}
          <span class="finding-rule" title="Rule id">{finding.ruleId}</span>
        </span>
      </header>
      <p class="finding-why"><span class="finding-k">Why:</span> {finding.whyItMatters}</p>
      <SourcesLine ruleId={finding.ruleId} />
      {hasEvidence ? (
        <div class="finding-evidence">
          <span class="finding-k">Evidence:</span>
          <ul class="evidence-list">
            {evidence.length ? <EvidenceList finding={finding} /> : <li class="evidence-row muted">no evidence rows attached to this summary{primary ? "; open it to see the instances" : ""}</li>}
            <ThresholdLine keys={finding.thresholdKeys ?? []} />
          </ul>
        </div>
      ) : null}
      <div class="finding-fix">
        <div class="finding-fix-head">
          <span class="finding-k">Fix ({platform}):</span> {finding.fix.summary}
          {finding.fix.path ? <> → <code class="fix-path">{finding.fix.path}</code></> : null}
        </div>
        {finding.fix.snippet ? <pre class="fix-snippet" tabIndex={0}><code>{finding.fix.snippet}</code></pre> : null}
      </div>
      <footer class="finding-actions">
        {primary ? <a class="btn" href={primary}>Show evidence</a> : <button type="button" class="btn" disabled title="No navigable evidence">Show evidence</button>}
        <button type="button" class="btn btn-primary" data-copy-fix onClick={() => copyText(fixText(finding), "Fix copied to clipboard")}>Copy fix</button>
        {finding.tokensAffected ? <span class="finding-affected" title={`Estimated tokens affected: ${formatNumber(finding.tokensAffected)}`}>~{formatTokens(finding.tokensAffected)} tok affected</span> : null}
      </footer>
    </article>
  );
}

/** "Based on: 3 sources · sourced" with the links, the note (what is our own opinion) and any caveat, collapsed by default. */
function SourcesLine({ ruleId }: { ruleId: string }) {
  const basis = ruleBasis(ruleId);
  if (!basis) return null;
  return (
    <details class="finding-sources">
      <summary>
        <span class="finding-k">Based on:</span>{" "}
        {basis.sources.length ? `${basis.sources.length} source${basis.sources.length === 1 ? "" : "s"}` : "no external source"}
        {" · "}<span class={`basis basis-${basis.basis}`}>{BASIS_LABEL[basis.basis]}</span>
      </summary>
      {basis.note ? <p class="finding-sources-note">{basis.note}</p> : null}
      {basis.sources.length ? (
        <ul class="finding-sources-list">
          {basis.sources.map((source) => (
            <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>{source.publisher || source.year ? <span class="muted"> · {[source.publisher, source.year].filter(Boolean).join(", ")}</span> : null}</li>
          ))}
        </ul>
      ) : null}
      {basis.caveats.length ? <p class="finding-sources-caveat"><span class="finding-k">Caveat:</span> {basis.caveats.join(" ")}</p> : null}
    </details>
  );
}
