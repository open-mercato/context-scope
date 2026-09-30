/**
 * Where each rule's "why it matters" comes from (src/rules/sources.json):
 * vendor docs, papers and engineering posts, each verified when added, plus a
 * per-rule `basis` ("sourced" | "inferred" | "opinion") so a reader can tell a
 * documented mechanism from a product opinion (every numeric threshold is one).
 * Attached at read time, never stored in the index: updating the knowledge
 * base needs no re-index.
 */
import fs from "node:fs";

let cached = null;

export function loadSources() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(new URL("./sources.json", import.meta.url), "utf8")); }
    catch { cached = { sources: [], rules: {} }; }
  }
  return cached;
}

/** `{ basis, note, caveats, sources: [{ id, title, publisher, year, url }] }` for a rule id, or null. */
export function sourcesFor(ruleId) {
  const { sources, rules } = loadSources();
  const entry = rules?.[ruleId];
  if (!entry) return null;
  const byId = new Map((sources ?? []).map((source) => [source.id, source]));
  return {
    basis: entry.basis ?? "opinion",
    note: entry.note ?? "",
    caveats: entry.caveats ?? [],
    sources: (entry.sources ?? []).map((id) => byId.get(id)).filter(Boolean).map(({ id, title, publisher, year, url }) => ({ id, title, publisher, year, url })),
  };
}

/** A finding with its rule's sources attached (a copy; the input is not mutated). */
export function withSources(finding) {
  if (!finding?.ruleId) return finding;
  const basis = sourcesFor(finding.ruleId);
  return basis ? { ...finding, basis } : finding;
}
