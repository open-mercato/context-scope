/**
 * Index layout and manifest persistence.
 *
 *   ~/.contextscope/index/v1/manifest.json
 *   ~/.contextscope/index/v1/runs/<vendor>/<sha1(absPath)>/shell.json          Run without requests/blocks (scopes as summaries)
 *   ~/.contextscope/index/v1/runs/<vendor>/<sha1(absPath)>/findings.json       findings, stored once
 *   ~/.contextscope/index/v1/runs/<vendor>/<sha1(absPath)>/scopes/<sha1(scopeId)>.json  one full AgentScope
 *
 * The manifest may hold absolute paths (as keys and `cwd`); it never leaves
 * the machine. Everything served over HTTP is projected through the reader.
 *
 * Change detection keys per entry: (size, mtimeMs, adapterVersion,
 * estimatorVersion, calibrationVersion) re-parse; (thresholdsHash, rulesHash)
 * re-evaluate the stored run. `manifest.rulesHash` is the hash of the last pass.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { writeJsonAtomic } from "../util/fs.mjs";

export const MANIFEST_VERSION = 2;

export function indexRoot(home = os.homedir()) {
  return path.join(home, ".contextscope", "index", "v1");
}

export function contextscopeDir(home = os.homedir()) {
  return path.join(home, ".contextscope");
}

export function sha1(value) {
  return createHash("sha1").update(String(value)).digest("hex");
}

export function runDir(root, vendor, absPath) {
  return path.join(root, "runs", vendor, sha1(absPath));
}

export function shellFilePath(root, vendor, absPath) {
  return path.join(runDir(root, vendor, absPath), "shell.json");
}

export function findingsFilePath(root, vendor, absPath) {
  return path.join(runDir(root, vendor, absPath), "findings.json");
}

export function scopeFileName(scopeId) {
  return `${sha1(scopeId).slice(0, 20)}.json`;
}

export function scopeFilePath(root, vendor, absPath, scopeId) {
  return path.join(runDir(root, vendor, absPath), "scopes", scopeFileName(scopeId));
}

export function emptyManifest(adapterVersions = {}) {
  return { version: MANIFEST_VERSION, adapterVersions, estimatorVersion: null, calibrationVersion: null, thresholdsHash: null, rulesHash: null, lastRunAt: null, lastPass: null, vendors: [], files: {} };
}

export async function ensureIndexDirs(root) {
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "runs"), { recursive: true, mode: 0o700 });
}

export async function loadManifest(root) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    // An older layout (or a corrupt file) means a full re-index; the run files of the old layout are removed by the writer.
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.files !== "object" || !parsed.files) return emptyManifest();
    return { ...emptyManifest(), ...parsed };
  } catch {
    return emptyManifest();
  }
}

export async function saveManifest(root, manifest) {
  await ensureIndexDirs(root);
  await writeJsonAtomic(path.join(root, "manifest.json"), manifest);
}

export async function removeIndex(root) {
  await rm(root, { recursive: true, force: true });
}

export async function removeRunFiles(root, vendor, absPath) {
  await rm(runDir(root, vendor, absPath), { recursive: true, force: true }).catch(() => {});
}

export function hashThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== "object") return "none";
  const keys = Object.keys(thresholds).sort();
  return sha1(JSON.stringify(keys.map((key) => [key, thresholds[key]]))).slice(0, 16);
}
