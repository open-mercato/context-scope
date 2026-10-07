/**
 * Single source of truth for category labels, colours, and grouping in the UI.
 * Colours are CSS tokens defined in theme.css (`--cat-*`, with dark overrides)
 * so SVG fills, legend swatches and tooltip keys all follow the theme.
 */
import type { Category } from "@ir/types.ts";

export interface CategoryMeta { label: string; short: string; color: string; group: "base" | "conversation" | "tools" | "agents" | "system" }

const token = (name: string) => `var(--cat-${name})`;

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  system:               { label: "System prompt & tool schemas", short: "System",     color: token("system"), group: "base" },
  instructions:         { label: "Instructions (CLAUDE.md / AGENTS.md / rules)", short: "Instructions", color: token("instructions"), group: "base" },
  unlogged:             { label: "Not in transcript (resumed history, hidden injections, tool schemas)", short: "Unlogged", color: token("unlogged"), group: "base" },
  skills:               { label: "Skills",                       short: "Skills",     color: token("skills"), group: "base" },
  user:                 { label: "User messages",                short: "User",       color: token("user"), group: "conversation" },
  assistant_text:       { label: "Assistant text",               short: "Assistant",  color: token("assistant"), group: "conversation" },
  assistant_thinking:   { label: "Assistant thinking (output only)", short: "Thinking", color: token("thinking"), group: "conversation" },
  tool_call:            { label: "Tool call arguments",          short: "Tool args",  color: token("tool-call"), group: "tools" },
  "tool_result.file":   { label: "Tool results: file reads",     short: "File reads", color: token("result-file"), group: "tools" },
  "tool_result.shell":  { label: "Tool results: shell output",   short: "Shell",      color: token("result-shell"), group: "tools" },
  "tool_result.search": { label: "Tool results: search",         short: "Search",     color: token("result-search"), group: "tools" },
  "tool_result.web":    { label: "Tool results: web & browser",  short: "Web",        color: token("result-web"), group: "tools" },
  "tool_result.other":  { label: "Tool results: other",          short: "Other tools", color: token("result-other"), group: "tools" },
  subagent_handoff:     { label: "Subagent handoffs",            short: "Handoffs",   color: token("handoff"), group: "agents" },
  compaction_summary:   { label: "Compaction summaries",         short: "Compaction", color: token("compaction"), group: "system" },
  attachments:          { label: "Attachments & reminders",      short: "Attachments", color: token("attachments"), group: "system" },
  memory:               { label: "Memory",                       short: "Memory",     color: token("memory"), group: "base" },
  other:                { label: "Other",                        short: "Other",      color: token("other"), group: "system" },
};

/** Stack order: hidden base at the bottom (unlogged directly above system, ADR-002 A), then conversation, tools, agents, system extras. */
export const STACK_ORDER: Category[] = [
  "system", "unlogged", "instructions", "skills", "memory", "user", "assistant_text", "tool_call",
  "tool_result.file", "tool_result.shell", "tool_result.search", "tool_result.web", "tool_result.other",
  "subagent_handoff", "compaction_summary", "attachments", "other",
];

/**
 * Provenance labels are one word each so a badge fits next to a number in a
 * table cell; the hover hint carries the full meaning and the footer legend
 * repeats it once per page (ADR-001: every number carries its provenance).
 */
export const PROVENANCE_META = {
  "observed.vendor":   { label: "vendor",    long: "observed · vendor",   hint: "Observed · vendor: emitted by the vendor runtime (token usage, compaction metadata, window size)." },
  "observed.artifact": { label: "artifact",  long: "observed · artifact", hint: "Observed · artifact: directly present in a session or repository file (sizes, paths, tool names)." },
  "derived.exact":     { label: "derived",   long: "derived · exact",     hint: "Derived: deterministic arithmetic over observed values." },
  "estimated.local":   { label: "estimated", long: "estimated · local",   hint: "Estimated: local chars-per-token estimate, reconciled to the exact vendor total where one exists." },
  unknown:             { label: "unknown",   long: "unknown",             hint: "No evidence available." },
} as const;

/**
 * Token formatting rule (ADR-002 E, ADR-004 §7.9): three significant digits,
 * unit chosen so the mantissa stays below 1,000: 1.74M, 17.4M, 174M; 1.23k,
 * 12.3k, 123k; 1.11B. Never `11097M`, never `~1,739,210`.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  const sig3 = (v: number) => (v >= 99.95 ? v.toFixed(0) : v >= 9.995 ? v.toFixed(1) : v.toFixed(2));
  if (abs >= 999.5e6) return `${sign}${sig3(abs / 1e9)}B`;
  if (abs >= 999.5e3) return `${sign}${sig3(abs / 1e6)}M`;
  if (abs >= 999.5) return `${sign}${sig3(abs / 1e3)}k`;
  return `${sign}${Math.round(abs)}`;
}
