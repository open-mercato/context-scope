/**
 * Findings grouping (ADR-002 B): every list of findings is shown as one card
 * per rule, with the per-run / per-scope findings as instances inside.
 * Ordering inside and across groups: severity → Σ tokensAffected → sessions → id.
 */
import type { Finding, Severity } from "@ir/types.ts";

export interface RuleGroup {
  ruleId: string;
  title: string;
  severity: Severity;
  scope: Finding["scope"];
  vendor?: Finding["vendor"];
  /** Distinct runs in which the rule fired (setup findings count as the API's recurrence, else 1). */
  sessions: number;
  /** Σ count over the grouped findings (per-block rules aggregate several blocks into one finding). */
  occurrences: number;
  tokensAffected: number;
  /** Instances, highest tokensAffected first. */
  findings: Finding[];
  /** Representative finding (highest ranked) for why / fix / thresholds. */
  primary: Finding;
}

const SEV: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function findingSessions(f: Finding): number {
  const extra = (f as { sessions?: number }).sessions;
  return Math.max(1, f.recurrence ?? 0, extra ?? 0);
}

export function compareFindings(a: Finding, b: Finding): number {
  return (SEV[b.severity] - SEV[a.severity]) || ((b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)) || (findingSessions(b) - findingSessions(a)) || a.id.localeCompare(b.id);
}

export function groupFindings(findings: Finding[]): RuleGroup[] {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) { const list = byRule.get(f.ruleId) ?? []; list.push(f); byRule.set(f.ruleId, list); }
  const groups: RuleGroup[] = [];
  for (const [ruleId, list] of byRule) {
    list.sort(compareFindings);
    const runs = new Set(list.map((f) => f.runId).filter(Boolean) as string[]);
    let sessions = runs.size;
    for (const f of list) sessions = Math.max(sessions, findingSessions(f));
    const primary = list[0];
    groups.push({
      ruleId,
      title: primary.title,
      severity: list.reduce<Severity>((s, f) => (SEV[f.severity] > SEV[s] ? f.severity : s), primary.severity),
      scope: primary.scope,
      vendor: list.every((f) => f.vendor === primary.vendor) ? primary.vendor : undefined,
      sessions,
      occurrences: list.reduce((s, f) => s + Math.max(1, f.count ?? 1), 0),
      tokensAffected: list.reduce((s, f) => s + (f.tokensAffected ?? 0), 0),
      findings: list,
      primary,
    });
  }
  groups.sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || (b.tokensAffected - a.tokensAffected) || (b.sessions - a.sessions) || a.ruleId.localeCompare(b.ruleId));
  return groups;
}
