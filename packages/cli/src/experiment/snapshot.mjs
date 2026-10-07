/**
 * Experiment bookkeeping (ADR-005 §3): a snapshot is the instruction chain of
 * the launched repo ({ path, hash, bytes } per file), the rules and thresholds
 * hashes, the repo key and the detected vendors at one instant. Two snapshots
 * (baseline, candidate) make an experiment, stored as
 * `~/.contextscope/experiments/<name>.json` (0600). Nothing stored is an
 * absolute path: file paths are repo-relative or `~`-relative display paths and
 * the repo is its basename plus the project key.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { contextscopeDir, hashThresholds } from "../index/manifest.mjs";
import { projectKeyFor } from "../adapters/discover.mjs";
import { writeJsonAtomic } from "../util/fs.mjs";

export const EXPERIMENT_VERSION = 1;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_CHAIN = 64;

export function experimentsDir(home = os.homedir()) {
  return path.join(contextscopeDir(home), "experiments");
}

export function assertName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) throw new Error("experiment name must be 1-64 characters: letters, digits, dot, dash, underscore.");
  return name;
}

export function experimentFile(home, name) {
  return path.join(experimentsDir(home), `${assertName(name)}.json`);
}

export function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

/** The absolute path of an inventory file record: its private `_abs`, else the display path resolved against the repo or home. */
function absOf(file, { repoRoot, home }) {
  if (typeof file._abs === "string" && file._abs) return file._abs;
  if (typeof file.path !== "string" || !file.path) return null;
  if (file.path.startsWith("~/")) return path.join(home, file.path.slice(2));
  return path.join(repoRoot, file.path);
}

/**
 * Snapshot of the instruction chain from a setup inventory. Reads each file
 * once for its content hash unless the inventory already carries `hash`
 * (ADR-005 §2 `InstructionFile.hash`). Fixture files are already excluded by
 * the inventory.
 */
export async function buildSnapshot({ inventory, repoRoot, home = os.homedir(), rulesHash = null, thresholds = null, now = new Date() }) {
  const chain = [];
  for (const file of (inventory?.instructionFiles ?? []).slice(0, MAX_CHAIN)) {
    if (typeof file?.path !== "string") continue;
    let hash = typeof file.hash === "string" && file.hash ? file.hash : null;
    let bytes = Number.isFinite(file.bytes) ? file.bytes : 0;
    if (!hash) {
      const abs = absOf(file, { repoRoot, home });
      if (!abs) continue;
      try {
        const body = await readFile(abs);
        hash = sha1(body);
        bytes = body.length;
      } catch { continue; }
    }
    chain.push({ path: file.path, hash, bytes, vendors: Array.isArray(file.vendors) ? [...file.vendors] : [] });
  }
  chain.sort((a, b) => a.path.localeCompare(b.path));
  return {
    at: now.toISOString(),
    repo: { name: path.basename(repoRoot), key: projectKeyFor(repoRoot) },
    chain,
    chainHash: sha1(chain.map((file) => `${file.path}\0${file.hash}`).join("\n")),
    rulesHash: rulesHash ?? null,
    thresholdsHash: thresholds ? hashThresholds(thresholds) : null,
    vendors: [...(inventory?.vendorsDetected ?? [])].sort(),
  };
}

/** True when two snapshots hold the same files with the same content. */
export function sameChain(a, b) {
  if (!a?.chain || !b?.chain || a.chain.length !== b.chain.length) return false;
  return a.chain.every((file, i) => file.path === b.chain[i].path && file.hash === b.chain[i].hash);
}

/** Files that differ between two snapshots: `{ path, from?, to?, state: "changed" | "added" | "removed" }`. */
export function chainDiff(a, b) {
  const before = new Map((a?.chain ?? []).map((file) => [file.path, file]));
  const after = new Map((b?.chain ?? []).map((file) => [file.path, file]));
  const out = [];
  for (const [p, file] of before) {
    const next = after.get(p);
    if (!next) out.push({ path: p, from: file.hash, state: "removed" });
    else if (next.hash !== file.hash) out.push({ path: p, from: file.hash, to: next.hash, bytesFrom: file.bytes, bytesTo: next.bytes, state: "changed" });
  }
  for (const [p, file] of after) if (!before.has(p)) out.push({ path: p, to: file.hash, state: "added" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export async function loadExperiment(home, name) {
  try {
    const parsed = JSON.parse(await readFile(experimentFile(home, name), "utf8"));
    if (parsed?.version !== EXPERIMENT_VERSION || typeof parsed.name !== "string") return null;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveExperiment(home, experiment) {
  const dir = experimentsDir(home);
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(experimentFile(home, experiment.name), experiment, { mode: 0o600 });
  return experimentFile(home, experiment.name);
}

export async function deleteExperiment(home, name) {
  const file = experimentFile(home, name);
  const existing = await loadExperiment(home, name);
  if (!existing) return false;
  await rm(file, { force: true });
  return true;
}

export async function listExperiments(home) {
  let names = [];
  try { names = (await readdir(experimentsDir(home))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((n) => NAME_PATTERN.test(n)).sort(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const out = [];
  for (const name of names) {
    const experiment = await loadExperiment(home, name);
    if (experiment) out.push(experiment);
  }
  return out;
}

/** Throws when a value (the stored document) contains an absolute path or a home-relative one that is not a display path. */
export function assertNoAbsolutePaths(value, where = "experiment") {
  const text = JSON.stringify(value);
  const home = os.homedir();
  if (text.includes(home) || /"(?:\/Users\/|\/home\/|[A-Z]:\\\\)/.test(text)) throw new Error(`${where}: an absolute path would be stored; refusing.`);
}
