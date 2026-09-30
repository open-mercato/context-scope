/**
 * Small filesystem helpers shared by discovery, the index, and the server.
 * Bounded reads only: nothing here loads a session file whole.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";

/** `~`-relative POSIX display path (forward slashes on every platform); basename when outside home. */
export function displayPath(filePath, home = os.homedir()) {
  const relative = path.relative(home, filePath);
  if (relative === "") return "~";
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.posix.join("~", ...relative.split(path.sep));
  }
  return path.basename(filePath);
}

export async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

export async function walkFiles(root, { maxDepth = 6, maxFiles = 20_000, accept = () => true, ignore = new Set() } = {}) {
  if (!(await directoryExists(root))) return [];
  const found = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && found.length < maxFiles) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isFile() && accept(fullPath)) found.push(fullPath);
      if (entry.isDirectory() && current.depth < maxDepth && !ignore.has(entry.name)) {
        queue.push({ directory: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

/** Reads at most `byteLimit` bytes from the start of a file. */
export async function readHead(filePath, byteLimit = 64 * 1024) {
  const handle = await open(filePath, "r");
  try {
    const details = await handle.stat();
    const length = Math.min(details.size, byteLimit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Reads the first line of a file in chunks, stopping at the first `\n` or at
 * `byteLimit`. Returns `{ line, complete }`; `complete` is false when the
 * limit was hit before a newline.
 */
export async function readFirstLine(filePath, { byteLimit = 4 * 1024 * 1024, chunkBytes = 64 * 1024 } = {}) {
  const handle = await open(filePath, "r");
  try {
    const chunks = [];
    let position = 0;
    while (position < byteLimit) {
      const buffer = Buffer.alloc(Math.min(chunkBytes, byteLimit - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        return { line: Buffer.concat(chunks).toString("utf8"), complete: true };
      }
      chunks.push(Buffer.from(slice));
      position += bytesRead;
    }
    return { line: Buffer.concat(chunks).toString("utf8"), complete: false };
  } finally {
    await handle.close();
  }
}

/** Resolves the vendor stores, honouring CLAUDE_CONFIG_DIR, CODEX_HOME and GEMINI_CLI_HOME. */
export function resolveRoots({ home = os.homedir(), env = process.env, roots = {} } = {}) {
  const claudeHome = roots.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const codexHome = roots.codexHome ?? env.CODEX_HOME ?? path.join(home, ".codex");
  const geminiHome = roots.geminiHome ?? (env.GEMINI_CLI_HOME ? path.join(env.GEMINI_CLI_HOME, ".gemini") : path.join(home, ".gemini"));
  return {
    claudeHome: path.resolve(claudeHome),
    codexHome: path.resolve(codexHome),
    geminiHome: path.resolve(geminiHome),
    claudeProjects: roots.claudeProjects ? path.resolve(roots.claudeProjects) : path.join(path.resolve(claudeHome), "projects"),
    codexSessions: roots.codexSessions ? path.resolve(roots.codexSessions) : path.join(path.resolve(codexHome), "sessions"),
    geminiTmp: roots.geminiTmp ? path.resolve(roots.geminiTmp) : path.join(path.resolve(geminiHome), "tmp"),
  };
}

/** Writes JSON through a temp file and a rename so readers never see a torn file. */
export async function writeJsonAtomic(filePath, value, { mode = 0o600 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, typeof value === "string" ? value : JSON.stringify(value), { mode });
  await rename(tmp, filePath);
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}
