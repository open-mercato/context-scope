/**
 * Documented instruction-file precedence per vendor (lower number = higher
 * precedence, loaded first). Sources: docs/one-command-discovery-research.md
 * "Context configuration" and the vendor memory docs.
 */
import { estTokensFor } from "../ir/estimate.mjs";

export const CLAUDE_PRECEDENCE = { user: 1, project: 2, local: 3, rules: 4, nested: 5 };
export const CODEX_PRECEDENCE = { user: 1, project: 2, override: 3, nested: 4 };
export const GEMINI_PRECEDENCE = { user: 1, project: 2, nested: 3 };

export function precedenceFor(vendor, scope) {
  const table = vendor === "codex" ? CODEX_PRECEDENCE : vendor === "gemini" ? GEMINI_PRECEDENCE : CLAUDE_PRECEDENCE;
  return table[scope] ?? 9;
}

export function isLoaded(file) {
  return file.loadState === "expected.load" || file.loadState === "observed.loaded";
}

/** Files that enter the startup prompt for a vendor, ordered by precedence. */
export function chainFor(files, vendor) {
  return files
    .filter(file => file.vendors.includes(vendor) && isLoaded(file))
    .sort((a, b) => a.precedence - b.precedence || a.path.localeCompare(b.path));
}

/** The chain's size as that vendor's tokenizer would see it (`estTokensBy[vendor]`; neutral for uncalibrated vendors). */
export function chainTokens(files, vendor) {
  return chainFor(files, vendor).reduce((sum, file) => sum + estTokensFor(file, vendor), 0);
}

export function rootInstructionFile(files, vendor) {
  const names = vendor === "codex" ? ["AGENTS.md"] : vendor === "gemini" ? ["GEMINI.md"] : ["CLAUDE.md", ".claude/CLAUDE.md"];
  return files.find(file => file.scope === "project" && names.includes(file.path) && file.vendors.includes(vendor)) ?? null;
}
