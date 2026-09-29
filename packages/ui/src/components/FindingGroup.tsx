/**
 * One card per rule (ADR-002 B): severity, title, "N sessions · M occurrences
 * · ~X tok", why, the threshold line, one Copy fix, and an expandable instance
 * list (per run / scope) with evidence rows and a Show evidence link.
 */
import { useState } from "preact/hooks";
import type { Finding } from "@ir/types.ts";
import { copyText } from "../store.ts";
import { formatNumber, plural } from "../format.ts";
import { formatTokens } from "../categories.ts";
import { splitRunId } from "../router.ts";
import type { RuleGroup } from "../findings.ts";
import { Badge } from "./Badge.tsx";
import { EvidenceList, ThresholdLine, fixText, primaryHref } from "./FindingCard.tsx";

export interface FindingGroupProps {
  group: RuleGroup;
  defaultOpen?: boolean;
  /** Label for a run id (project name); falls back to the short session id. */
  runLabel?: (runId: string) => string;
  /** Session screen: pin the evidence in place instead of navigating. */
  onShowEvidence?: (finding: Finding) => void;
  /** Instances shown before "Show all". */
  preview?: number;
}

function instanceTitle(f: Finding, runLabel?: (runId: string) => string): string {
  if (!f.runId) return f.scope === "setup" ? "repository setup" : f.title;
  const base = runLabel ? runLabel(f.runId) : splitRunId(f.runId).id.slice(0, 8);
  return f.scopeId && f.scopeId !== "main" ? `${base} · ${f.scopeId}` : base;
}

export function FindingGroup({ group, defaultOpen = false, runLabel, onShowEvidence, preview = 3 }: FindingGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const shown = all ? group.findings : group.findings.slice(0, preview);
  const f = group.primary;
  const platform = f.fix.platform === "both" ? "claude and codex" : f.fix.platform;
  const bodyId = `fg-${group.ruleId}-${group.scope}`;
  return (
    <article class={`fg fg-${group.severity}`} data-finding={f.id} aria-label={`${group.severity} rule ${group.ruleId}: ${group.title}`}>
      <div class="fg-head" onClick={(e) => { if ((e.target as HTMLElement).closest("a, button")) return; setOpen(!open); }}>
        <button type="button" class="fg-toggle" aria-expanded={open} aria-controls={bodyId} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={open ? "M1 3l4 4 4-4" : "M3 1l4 4-4 4"} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <Badge severity={group.severity} />
        <span class="fg-title">{group.title}</span>
        <span class="fg-stats">
          <strong>{plural(group.sessions, "session")}</strong> · <strong>{plural(group.occurrences, "occurrence")}</strong>
          {group.tokensAffected ? <> · ~<strong>{formatTokens(group.tokensAffected)}</strong> tok</> : null}
        </span>
        <span class="fg-meta">
          {group.scope}{group.vendor ? ` · ${group.vendor}` : ""}
          <span class="finding-rule" title="Rule id">{group.ruleId}</span>
        </span>
      </div>
      {open && (
        <div class="fg-body" id={bodyId}>
          <p class="fg-why"><span class="finding-k">Why:</span> {f.whyItMatters}</p>
          <ul class="evidence-list"><ThresholdLine keys={f.thresholdKeys} /></ul>
          <ol class="fg-instances" aria-label={`${group.findings.length} instances`}>
            {shown.map((inst) => {
              const href = primaryHref(inst);
              return (
                <li key={inst.id} class="fg-instance" data-finding={inst.id}>
                  <div class="fg-instance-main">
                    <div class="fg-instance-title">
                      {inst.vendor ? <span class={`vendor vendor-${inst.vendor}`}>{inst.vendor}</span> : null}
                      <span>{instanceTitle(inst, runLabel)}</span>
                      {inst.severity !== group.severity ? <Badge severity={inst.severity} /> : null}
                    </div>
                    {inst.whyItMatters !== f.whyItMatters ? <div class="fg-instance-sub">{inst.whyItMatters}</div> : null}
                    <ul class="fg-instance-evidence"><EvidenceList finding={inst} limit={3} /></ul>
                  </div>
                  <div class="fg-instance-side">
                    <span>{inst.count && inst.count > 1 ? `${formatNumber(inst.count)} × · ` : ""}{inst.tokensAffected ? `~${formatTokens(inst.tokensAffected)} tok` : ""}</span>
                    {onShowEvidence
                      ? <button type="button" class="btn" onClick={() => onShowEvidence(inst)}>Show evidence</button>
                      : href ? <a class="btn" href={href}>Show evidence</a> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {group.findings.length > preview && (
            <button type="button" class="btn btn-ghost fg-more" onClick={() => setAll(!all)}>{all ? `Show top ${preview}` : `Show all ${group.findings.length} instances`}</button>
          )}
          <div class="finding-fix">
            <div class="finding-fix-head">
              <span class="finding-k">Fix ({platform}):</span> {f.fix.summary}
              {f.fix.path ? <> → <code class="fix-path">{f.fix.path}</code></> : null}
            </div>
            {f.fix.snippet ? <pre class="fix-snippet" tabIndex={0}><code>{f.fix.snippet}</code></pre> : null}
          </div>
          <div class="fg-footer">
            <button type="button" class="btn btn-primary" data-copy-fix onClick={() => copyText(fixText(f), "Fix copied to clipboard")}>Copy fix</button>
            <span class="fg-count">The fix is per rule; it applies to every instance above.</span>
          </div>
        </div>
      )}
    </article>
  );
}
