/**
 * Path references inside instruction files: Claude `@path` imports and
 * backticked repo paths. Deterministic port of the candidate logic in
 * instruction-audit-agent.mjs, narrowed to things that look like files/dirs.
 */
import path from "node:path";
import { isDirectory, isInside, statSafe } from "./fs.mjs";

const MAX_CANDIDATES = 60;
const DOMAIN_TLD = /\.(com|org|net|io|dev|ai|co|app|md|sh|edu|gov)$/i;
// Bare file names (no slash) only count when they carry a real file extension;
// `em.find`, `z.infer`, `sales.order.created` are identifiers, not paths.
const FILE_EXTENSIONS = new Set([
  "md", "mdx", "markdown", "txt", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "lock",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rb", "go", "rs", "sh", "bash", "zsh", "fish", "ps1", "bat",
  "sql", "css", "scss", "less", "html", "htm", "xml", "csv", "tsv", "graphql", "gql", "prisma", "proto", "java", "kt", "kts",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "vue", "svelte", "astro", "dockerfile", "makefile", "gradle", "tf", "hcl",
  "png", "jpg", "jpeg", "svg", "gif", "webp", "pdf", "wasm", "zip", "tgz", "gz",
]);

function stripCode(text) {
  // Claude does not evaluate imports inside fenced or inline code.
  return String(text).replace(/```[\s\S]*?```/g, "\n").replace(/`[^`\n]*`/g, " ");
}

/** `@path` imports as written (Claude memory import syntax). */
export function extractImports(text) {
  const values = new Set();
  for (const match of stripCode(text).matchAll(/(?:^|[\s(])@((?:~\/|\.{0,2}\/)?[A-Za-z0-9_][A-Za-z0-9_.@\/-]*)/gm)) {
    const value = match[1].replace(/[.,;:)]+$/, "");
    if (looksLikePath(value)) values.add(value);
  }
  return [...values].slice(0, MAX_CANDIDATES);
}

const MIME_TOPS = new Set(["text", "application", "image", "audio", "video", "font", "multipart", "message", "model"]);

export function looksLikePath(value) {
  if (!value || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  if (/[^\x21-\x7E]/.test(value)) return false; // `Ctrl/⌘`, prose symbols: not a path anyone types
  if (/^[a-z]+\/[A-Za-z0-9.+-]+$/.test(value) && MIME_TOPS.has(value.split("/")[0])) return false; // MIME type
  if (/:\/\//.test(value) || /^(mailto|www\.)/i.test(value)) return false;
  if (/[*?{}<>|;&$()"'=+…]/.test(value) || value.includes("...")) return false;
  if (/^-/.test(value)) return false;
  if (/^@[A-Za-z0-9_-]+\//.test(value) && !/\.[a-z0-9]{1,8}$/i.test(value)) return false; // scoped npm package specifier
  if (/^\d+(\.\d+)+$/.test(value) || /^v\d+(\.\d+)+$/.test(value)) return false;
  const segments = value.replace(/\/+$/, "").split("/");
  if (segments.length > 1 && DOMAIN_TLD.test(segments[0]) && !/^\.{1,2}$/.test(segments[0]) && segments[0] !== "~") return false;
  const last = segments.at(-1) ?? "";
  const hasSlash = value.includes("/");
  // `../../../`, `./x`, `../x`: import-syntax examples, not references.
  const named = segments.filter((segment) => segment && !/^\.{1,2}$/.test(segment));
  if (hasSlash && named.length === 0) return false;
  if (hasSlash && named.length === 1 && segments[0].startsWith(".") && named[0].length <= 1) return false;
  if (hasSlash && /^\d+$/.test(last)) return false; // `brand-violet/10`: a utility class / opacity step
  // `catalog.product.created/updated`: event ids (two or more dots, no known extension).
  if (segments.some((segment) => (segment.match(/\./g) ?? []).length >= 2 && !segment.startsWith(".") && !FILE_EXTENSIONS.has(segment.split(".").at(-1).toLowerCase()))) return false;
  // `staff.timesheets.lock`: a dotted id; lockfiles are `yarn.lock`, `Cargo.lock` (one dot).
  if (/\.lock$/i.test(last) && (last.match(/\./g) ?? []).length > 1) return false;
  // `loop.stopWhen/prepareStep`: dotted camelCase identifiers, not directories.
  if (segments.some((segment) => { const m = /^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/.exec(segment); return m && /[A-Z]/.test(m[1]) && !FILE_EXTENSIONS.has(m[1].toLowerCase()); })) return false;
  if (hasSlash) return true;
  const ext = last.match(/^[A-Za-z0-9_@-][A-Za-z0-9_@.-]*\.([a-z0-9]{1,10})$/i)?.[1];
  return Boolean(ext) && FILE_EXTENSIONS.has(ext.toLowerCase());
}

// A path named as an example ("for example `packages/carrier-inpost`") is an illustration, not a reference.
const EXAMPLE_CONTEXT = /\b(?:for example|for instance|e\.g\.|such as|like|np\.|na przykład|przykładowo)(?![\w])/i;
// A path the text itself marks as optional or external to the checkout (an uncommitted submodule) may be absent.
const OPTIONAL_CONTEXT = /\b(?:submodule|optional|if present|when present|uncommitted|not committed|opcjonaln\w*)\b/i;
// A path the text says no longer exists ("`lib/x.ts` ... are gone") is history, not a reference.
const ABSENT_CONTEXT = /\b(?:gone|removed|deleted|no longer|renamed|deprecated|was replaced|usunięt\w*)\b/i;

/** Backticked tokens and @imports that look like repository paths. */
export function extractPathCandidates(text) {
  const source = String(text);
  const values = new Set(extractImports(source));
  for (const match of source.matchAll(/`([^`\n]{1,160})`/g)) {
    const value = match[1].trim().replace(/[.,;:]+$/, "");
    if (value.startsWith("@")) continue; // package specifiers / decorators, not imports
    if (!looksLikePath(value)) continue;
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    const before = source.slice(lineStart, match.index);
    // The clause the path sits in: from the last "(", "|" or sentence break before it.
    const clause = before.slice(Math.max(before.lastIndexOf("("), before.lastIndexOf("|"), before.lastIndexOf(". ")) + 1);
    if (EXAMPLE_CONTEXT.test(clause) || OPTIONAL_CONTEXT.test(line) || ABSENT_CONTEXT.test(line)) continue;
    values.add(value);
  }
  return [...values].slice(0, MAX_CANDIDATES);
}

/**
 * Every segment-suffix of the repository's files and directories
 * (`a/b/c.ts` → `c.ts`, `b/c.ts`, `a/b/c.ts`, `b/`, `a/b/`, `a/`), so a
 * module-relative reference such as `data/validators.ts` resolves when any
 * module has one. Built once per inventory.
 */
export function suffixIndex(files) {
  const index = new Set();
  const add = (segments) => {
    for (let i = 0; i < segments.length; i += 1) {
      index.add(segments.slice(i).join("/"));
      for (let j = i + 1; j < segments.length; j += 1) index.add(segments.slice(i, j).join("/") + "/");
    }
  };
  for (const file of files ?? []) {
    const segments = String(file).split("/").filter(Boolean);
    if (!segments.length) continue;
    const variants = [segments];
    // Import specifiers: `lib/customerAuth` for `lib/customerAuth.ts`, `lib/x` for `lib/x/index.ts`,
    // `shared/lib/x.ts` for `packages/shared/src/lib/x.ts` (package exports map `src/`).
    const last = segments.at(-1);
    const stem = last.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "");
    if (stem !== last) variants.push(stem === "index" ? segments.slice(0, -1) : [...segments.slice(0, -1), stem]);
    for (const variant of [...variants]) if (variant.includes("src")) variants.push(variant.filter((segment) => segment !== "src"));
    for (const variant of variants) if (variant.length) add(variant);
  }
  return index;
}

/**
 * Returns the subset of candidates that resolve to nothing inside the repo (or
 * home for `~/` refs). Relative refs are tried against the repo root and the
 * referencing file's directory; a bare file name (no slash) also counts as
 * found when any file with that name exists in the repo (`basenames`), and a
 * relative ref counts as found when it is a segment-suffix of a repository
 * file or directory (`suffixes`, see suffixIndex): module-relative conventions.
 * Refs that escape the roots are ignored.
 */
export async function findBrokenRefs(candidates, { repoRoot, home, fileDir, basenames, suffixes }) {
  const broken = [];
  for (const candidate of candidates) {
    if (!candidate.includes("/") && basenames?.has(candidate)) continue;
    if (suffixes && !candidate.startsWith("~/") && !candidate.includes("../")) {
      const key = candidate.replace(/^\.\//, "");
      if (suffixes.has(key) || (key.endsWith("/") ? suffixes.has(key) : suffixes.has(key + "/"))) continue;
    }
    // Build outputs (`modules.generated.ts`) exist only after a generate step.
    if (/\.generated\.[a-z0-9]+$/i.test(candidate)) continue;
    // Without a file extension a slash token is only a path when it starts somewhere real: its first
    // segment is a directory at the repo root or next to the instruction file. Route ids, MIME types,
    // model ids and error codes (`integrations/detail`, `openai/gpt-5-mini`) are not.
    const segments = candidate.replace(/\/+$/, "").split("/");
    const ext = segments.at(-1).match(/\.([a-z0-9]{1,10})$/i)?.[1];
    const fileLike = Boolean(ext) && FILE_EXTENSIONS.has(ext.toLowerCase());
    if (candidate.includes("/") && !fileLike && !candidate.endsWith("/") && !/^(?:\.{1,2}|~)\//.test(candidate)) {
      const first = segments[0];
      const anchored = (repoRoot && (await isDirectory(path.join(repoRoot, first)))) || (fileDir && (await isDirectory(path.join(fileDir, first))));
      if (!anchored) continue;
    }
    const targets = [];
    if (candidate.startsWith("~/")) {
      if (home) targets.push(path.join(home, candidate.slice(2)));
    } else if (path.isAbsolute(candidate)) {
      continue; // outside the allowlist; never stat arbitrary absolute paths
    } else {
      targets.push(path.resolve(repoRoot, candidate));
      if (fileDir) targets.push(path.resolve(fileDir, candidate));
    }
    let found = false;
    for (const target of targets) {
      const allowed = (repoRoot && isInside(repoRoot, target)) || (home && isInside(home, target));
      if (!allowed) continue;
      if (await statSafe(target)) { found = true; break; }
    }
    if (!found && targets.length) broken.push(candidate);
  }
  return broken;
}
