/**
 * Project identity without leaking paths (backend review #1).
 *
 * `project.key` used to be the Claude project-directory name, which is the
 * absolute cwd with `/` and `.` replaced by `-` (an absolute path in
 * disguise). Both adapters now use `projectKeyFor(cwd)`:
 *
 *   key = `${basename(cwd)}-${sha1(cwd).slice(0, 8)}`
 *
 * so a Claude and a Codex session launched from the same directory share a key
 * and the key reveals only the directory's basename.
 *
 * `encodedProjectDirToKey(dirName)` derives the same key from a Claude project
 * directory name without opening any file, for the discovery stream: it
 * decodes `-Users-x-projects-foo` to `/Users/x/projects/foo` and hashes that.
 * The decode is a heuristic: Claude encodes both `/` and `.` as `-`, so a dash
 * or a dot inside a real path segment (`open-mercato-2`, `.config`) makes the
 * decode ambiguous and the derived hash will not match `projectKeyFor(cwd)`.
 * `encodedDirIsReversible(cwd)` tells the adapter side whether that is the
 * case; the index must treat the discovery key as provisional and adopt
 * `run.project.key` once the file is parsed. When the name is not an encoded
 * absolute path at all (no leading `-`, e.g. a Windows drive), the encoded
 * name itself is hashed, deterministically on both sides.
 *
 * `displaySessionFile()` renders a session path `~`-relative and replaces the
 * encoded project-directory segment with `projects/<projectKey>/`, so neither
 * the run's `source.file` nor an SSE/manifest display path carries the cwd.
 */
import path from "node:path";
import { createHash } from "node:crypto";

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

function normalizeCwd(cwd) {
  return String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function projectKeyFor(cwd) {
  const normalized = normalizeCwd(cwd);
  const base = path.posix.basename(normalized) || normalized || "unknown";
  return `${safeSegment(base)}-${sha1(normalized).slice(0, 8)}`;
}

/** The Claude project-directory name for a cwd (`/` and `.` become `-`). */
export function claudeProjectDirFor(cwd) {
  return normalizeCwd(cwd).replace(/[/.]/g, "-");
}

/** True when decoding `claudeProjectDirFor(cwd)` gives back `cwd` exactly. */
export function encodedDirIsReversible(cwd) {
  return decodeProjectDir(claudeProjectDirFor(cwd)) === normalizeCwd(cwd);
}

/** Heuristic inverse of the Claude encoding: every `-` becomes `/`. Returns null when the name is not an encoded absolute path. */
export function decodeProjectDir(dirName) {
  const name = String(dirName ?? "");
  if (!name.startsWith("-")) return null;
  return "/" + name.slice(1).replace(/-/g, "/");
}

export function encodedProjectDirToKey(dirName) {
  const name = String(dirName ?? "");
  const decoded = decodeProjectDir(name);
  if (decoded === null) return `${safeSegment(name || "unknown")}-${sha1(name).slice(0, 8)}`;
  return projectKeyFor(decoded);
}

/**
 * `~`-relative display path for a session file with the encoded project-dir
 * segment replaced. `projectKey` is used when given (the adapter knows the
 * real cwd); otherwise it is derived from the directory name.
 */
export function displaySessionFile(absolute, { home, projectDir, projectKey } = {}) {
  if (!absolute) return "";
  const normalized = String(absolute).replace(/\\/g, "/");
  const root = String(home ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const dir = projectDir ? String(projectDir).replace(/\\/g, "/").replace(/\/+$/, "") : null;
  const encodedSegment = dir ? path.posix.basename(dir) : null;
  let display;
  if (root && (normalized === root || normalized.startsWith(root + "/"))) display = "~" + normalized.slice(root.length);
  else display = path.posix.basename(normalized);
  const segment = encodedSegment ?? findEncodedSegment(display);
  if (!segment) return display;
  const key = projectKey ?? encodedProjectDirToKey(segment);
  return display.split("/").map((part) => (part === segment ? key : part)).join("/");
}

function findEncodedSegment(display) {
  const parts = display.split("/");
  const at = parts.indexOf("projects");
  const candidate = at >= 0 ? parts[at + 1] : undefined;
  return candidate && candidate.startsWith("-") ? candidate : null;
}

function safeSegment(text) {
  return String(text).replace(/[\\/]/g, "-").slice(0, 80);
}
