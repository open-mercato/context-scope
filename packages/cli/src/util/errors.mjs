/**
 * Path-free error messages. One helper for the server, the index and the
 * worker so every surface redacts the same way: POSIX segments, Windows
 * drive paths, and `~`-prefixed paths are replaced with `[local path]`.
 */
const POSIX_PATH = /(?:^|[\s"'(=:,])(?:~|\/)(?:[^\s"'):,]+\/?)+/g;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\s"'):,\\]+\\?)+/g;

export function redactPaths(text) {
  return String(text ?? "")
    .replace(WINDOWS_PATH, "[local path]")
    .replace(POSIX_PATH, (match) => {
      const lead = /^[\s"'(=:,]/.test(match) ? match[0] : "";
      return `${lead}[local path]`;
    });
}

export function publicMessage(error, limit = 300) {
  return redactPaths(error?.message ?? error ?? "Unknown error").slice(0, limit);
}

export function shortError(error) {
  return redactPaths(error?.code ?? error?.message ?? error).slice(0, 120);
}
