/**
 * `experiment compare` (ADR-005 §3): the §1 engine over a named
 * baseline/candidate pair. Sessions of the experiment's repo started in
 * [baseline.at, candidate.at) are the baseline, in [candidate.at, now) the
 * candidate. "Same task" has no definition here; "comparable" means same
 * repo, same vendor, same dominant model and CLI version — sessions that
 * differ are excluded and counted. `verified` counts sessions whose observed
 * instruction hashes match the snapshot (Codex `instructionHash`, Claude
 * `nestedHashes`); hook file names are `expected.load` only.
 */
import { buildChange, startTime } from "../index/changes.mjs";
import { chainDiff } from "./snapshot.mjs";

export const DEFAULT_MIN_SESSIONS = 2;

function dominant(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
}

/** Sessions (`{ root, descendants }`) split by start time into the two arms. */
export function assignSessions(sessions, { baselineAt, candidateAt, now = Date.now() }) {
  const b = Date.parse(baselineAt ?? "");
  const c = Date.parse(candidateAt ?? "");
  const baseline = [];
  const candidate = [];
  for (const item of sessions) {
    const at = startTime(item.root);
    if (!(at > 0)) continue;
    if (Number.isFinite(b) && Number.isFinite(c) && at >= b && at < c) baseline.push(item);
    else if (Number.isFinite(c) && at >= c && at < now) candidate.push(item);
  }
  return { baseline, candidate };
}

/** How a session's stored hashes relate to a snapshot: "observed" on a hash match, "expected" on a hook file name, else "expected". */
export function verificationOf(root, snapshot) {
  const hashes = new Set((snapshot?.chain ?? []).map((file) => file.hash));
  if (root.vendor === "codex" && typeof root.instructionHash === "string" && hashes.has(root.instructionHash)) return "observed";
  for (const hash of root.nestedHashes ?? []) if (hashes.has(hash)) return "observed";
  return "expected";
}

/**
 * The report: a `Change` (anchor "experiment") plus `experiment: { name,
 * baseline, candidate, verified, excluded, comparable }`. Pure given the
 * sessions and `now`, so the markdown and JSON are stable.
 */
export function compareExperiment(experiment, sessions, { now = Date.now(), minSessions = DEFAULT_MIN_SESSIONS, titleOf } = {}) {
  if (!experiment?.baseline) throw new Error(`experiment "${experiment?.name ?? "?"}" has no baseline; run \`contextscope experiment start ${experiment?.name ?? "<name>"}\`.`);
  if (!experiment.candidate) throw new Error(`experiment "${experiment.name}" has no candidate yet; edit the instruction files, then run \`contextscope experiment candidate ${experiment.name}\`.`);
  const { baseline, candidate } = experiment;
  const vendors = new Set([...(baseline.vendors ?? []), ...(candidate.vendors ?? [])]);
  const assigned = assignSessions(sessions, { baselineAt: baseline.at, candidateAt: candidate.at, now });
  const excluded = { vendor: 0, model: 0, cliVersion: 0 };
  const byVendor = (list) => list.filter((item) => { const ok = !vendors.size || vendors.has(item.root.vendor); if (!ok) excluded.vendor += 1; return ok; });
  const arms = { baseline: byVendor(assigned.baseline), candidate: byVendor(assigned.candidate) };
  const all = [...arms.baseline, ...arms.candidate];
  const model = dominant(all.map((item) => item.root.habits?.startup?.model));
  const cliVersion = dominant(all.map((item) => item.root.cliVersion ?? item.root.habits?.startup?.cliVersion));
  const comparable = (list) => list.filter((item) => {
    const m = item.root.habits?.startup?.model;
    const v = item.root.cliVersion ?? item.root.habits?.startup?.cliVersion;
    if (model && m && m !== model) { excluded.model += 1; return false; }
    if (cliVersion && v && v !== cliVersion) { excluded.cliVersion += 1; return false; }
    return true;
  });
  const before = comparable(arms.baseline);
  const after = comparable(arms.candidate);
  const verified = {
    baseline: before.filter((item) => verificationOf(item.root, baseline) === "observed").length,
    candidate: after.filter((item) => verificationOf(item.root, candidate) === "observed").length,
  };
  const change = buildChange({
    file: experiment.name, at: candidate.at, anchor: "experiment", before, after,
    observationOf: (root) => verificationOf(root, candidate), titleOf,
  });
  change.n.baseline = change.n.before;
  change.n.candidate = change.n.after;
  change.caveats.splice(1, 1, `${change.n.before} baseline / ${change.n.after} candidate`);
  return {
    ...change,
    experiment: {
      name: experiment.name,
      repo: experiment.repo,
      baseline: { at: baseline.at, chainHash: baseline.chainHash, files: baseline.chain.length, rulesHash: baseline.rulesHash, thresholdsHash: baseline.thresholdsHash },
      candidate: { at: candidate.at, chainHash: candidate.chainHash, files: candidate.chain.length, rulesHash: candidate.rulesHash, thresholdsHash: candidate.thresholdsHash },
      changedFiles: chainDiff(baseline, candidate),
      verified,
      excluded,
      comparable: { vendors: [...vendors].sort(), model: model ?? null, cliVersion: cliVersion ?? null },
      minSessions,
      enough: change.n.before >= minSessions && change.n.after >= minSessions,
    },
  };
}
