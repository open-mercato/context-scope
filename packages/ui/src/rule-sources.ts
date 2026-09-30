/**
 * Where each rule's "why it matters" comes from: the same knowledge base the
 * CLI attaches to `check --json` / `scan --json` (packages/cli/src/rules/sources.json),
 * bundled so findings from any backend (companion, demo, an opened export) show it.
 */
import data from "@rules/sources.json";

export type Basis = "sourced" | "inferred" | "opinion";
export interface RuleSource { id: string; title: string; publisher?: string; year?: number; url: string }
export interface RuleBasis { basis: Basis; note: string; caveats: string[]; sources: RuleSource[] }

interface RawSource extends RuleSource { [key: string]: unknown }
interface RawRule { sources?: string[]; basis?: Basis; note?: string; caveats?: string[] }
const raw = data as unknown as { sources?: RawSource[]; rules?: Record<string, RawRule> };
const byId = new Map((raw.sources ?? []).map((source) => [source.id, source]));

export function ruleBasis(ruleId: string | undefined): RuleBasis | null {
  const entry = ruleId ? raw.rules?.[ruleId] : undefined;
  if (!entry) return null;
  const sources = (entry.sources ?? []).map((id) => byId.get(id)).filter((source): source is RawSource => Boolean(source))
    .map(({ id, title, publisher, year, url }) => ({ id, title, publisher, year, url }));
  return { basis: entry.basis ?? "opinion", note: entry.note ?? "", caveats: entry.caveats ?? [], sources };
}

export const BASIS_LABEL: Record<Basis, string> = {
  sourced: "sourced",
  inferred: "inferred from sources",
  opinion: "product opinion",
};
