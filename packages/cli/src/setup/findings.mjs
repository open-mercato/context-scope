/**
 * Shared helpers for the S-* rules: stable finding ids and evidence builders.
 */
import { createHash } from "node:crypto";

export function findingId(ruleId, primaryRef) {
  return `${ruleId}:${createHash("sha1").update(String(primaryRef)).digest("hex").slice(0, 10)}`;
}

export function fileEvidence(ref, label, value, unit = "tokens", provenance = "estimated.local") {
  const evidence = { kind: "file", ref, label, provenance };
  if (typeof value === "number") { evidence.value = value; evidence.unit = unit; }
  return evidence;
}

export function metricEvidence(ref, label, value, unit = "count", provenance = "derived.exact") {
  return { kind: "metric", ref, label, value, unit, provenance };
}

/** Builds a Finding from a rule module plus the variable parts. */
export function makeFinding(rule, { primaryRef, evidence, fix, vendor, tokensAffected, severity, title }) {
  if (!evidence?.length) throw new Error(`${rule.id}: a finding needs at least one evidence reference`);
  const finding = {
    id: findingId(rule.id, primaryRef),
    ruleId: rule.id,
    severity: severity ?? rule.severity,
    scope: rule.scope,
    title: title ?? rule.title,
    whyItMatters: rule.whyItMatters,
    evidence,
    fix,
    thresholdKeys: [...rule.thresholdKeys],
  };
  if (vendor) finding.vendor = vendor;
  if (typeof tokensAffected === "number" && tokensAffected > 0) finding.tokensAffected = Math.round(tokensAffected);
  return finding;
}
