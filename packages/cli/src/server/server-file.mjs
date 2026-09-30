/**
 * `~/.contextscope/server.json` (ADR-005 section 6): written by `start` once
 * the companion listens, removed on close, read by `contextscope status` so a
 * diagnostic can say whether a companion is running without probing ports.
 *
 *   { pid, port, url, repoRoot, startedAt, version }
 *
 * The URL carries no token (a future `statusline` asks the running companion
 * for a number; it never gets a capability from this file). Mode 0600. A file
 * whose pid is not alive is reported as stale; `removeServerFile` deletes only
 * a file written by the calling pid so two companions never erase each other.
 */
import os from "node:os";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { contextscopeDir } from "../index/manifest.mjs";
import { writeJsonAtomic } from "../util/fs.mjs";

export function serverFilePath(home = os.homedir()) {
  return path.join(contextscopeDir(home), "server.json");
}

export async function writeServerFile(home, { pid = process.pid, port, url, repoRoot, startedAt = new Date().toISOString(), version } = {}) {
  const info = { pid, port, url, repoRoot, startedAt, ...(version ? { version } : {}) };
  await writeJsonAtomic(serverFilePath(home), info, { mode: 0o600 });
  return info;
}

/** Removes the file when it belongs to `pid` (default: this process); a file left by another companion is kept. */
export async function removeServerFile(home, { pid = process.pid } = {}) {
  const file = serverFilePath(home);
  let owner;
  try { owner = JSON.parse(await readFile(file, "utf8"))?.pid; } catch { return false; }
  if (owner !== pid) return false;
  await rm(file, { force: true }).catch(() => {});
  return true;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/**
 * `{ present, info, alive }`: `present` when the file parses, `alive` when its
 * pid answers `kill(pid, 0)`. A present file with a dead pid is a stale one
 * (a companion killed with SIGKILL, or a crash before close).
 */
export async function readServerFile(home = os.homedir()) {
  let info = null;
  try { info = JSON.parse(await readFile(serverFilePath(home), "utf8")); } catch { return { present: false, info: null, alive: false }; }
  if (!info || typeof info !== "object") return { present: false, info: null, alive: false };
  return { present: true, info, alive: processAlive(info.pid) };
}
