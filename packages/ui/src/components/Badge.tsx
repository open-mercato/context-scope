import type { Provenance, Severity } from "@ir/types.ts";
import { PROVENANCE_META } from "../categories.ts";

export type BadgeTone = "neutral" | "accent" | "good" | "warn" | "danger" | "info";

export interface BadgeProps {
  /** Provenance badge: label + hover hint from PROVENANCE_META. */
  provenance?: Provenance;
  /** Severity badge: uppercase HIGH / MEDIUM / LOW in the severity colour. */
  severity?: Severity;
  /** Free-form badge. */
  label?: string;
  tone?: BadgeTone;
  title?: string;
  class?: string;
}

const PROVENANCE_TONE: Record<Provenance, BadgeTone> = {
  "observed.vendor": "good",
  "observed.artifact": "info",
  "derived.exact": "accent",
  "estimated.local": "warn",
  unknown: "neutral",
};

/** Small inline badge. `Badge({ provenance })` is the contract used by the session view. */
export function Badge(props: BadgeProps) {
  if (props.provenance) {
    const meta = PROVENANCE_META[props.provenance] ?? PROVENANCE_META.unknown;
    return (
      <span class={`badge badge-prov badge-${PROVENANCE_TONE[props.provenance] ?? "neutral"} ${props.class ?? ""}`} title={props.title ?? meta.hint} data-provenance={props.provenance}>
        {meta.label}
      </span>
    );
  }
  if (props.severity) {
    return (
      <span class={`badge badge-sev badge-sev-${props.severity} ${props.class ?? ""}`} title={props.title ?? `Severity: ${props.severity}`}>
        {props.severity.toUpperCase()}
      </span>
    );
  }
  return <span class={`badge badge-${props.tone ?? "neutral"} ${props.class ?? ""}`} title={props.title}>{props.label}</span>;
}
