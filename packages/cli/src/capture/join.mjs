/**
 * Joins capture records (the installed hook's metadata-only log) to a parsed
 * Run (ADR-003 section 6). Pure: no filesystem. The adapters call
 * `finalizeRun` inside `parse`, so the worker runs this join afterwards and
 * calls `refinalizeRun` when `run.coverage.capture.applied > 0` (the forecast's
 * auto-compaction filter and the summary then see the joined triggers/status).
 *
 *   InstructionsLoaded  -> run.instructionFilesObserved (unique, as recorded:
 *                          cwd-relative or ~-relative) + per-scope capture counts
 *   PreCompact/PostCompact -> the nearest unconfirmed compaction of the scope gets
 *                          hookObserved = true; its trigger is set when the record
 *                          carries one and the transcript said "unknown"
 *   SubagentStart/Stop  -> scope by agent id (`agent_id` with or without the
 *                          `agent-` prefix, else the basename of
 *                          `agent_transcript_path`, `agent-<id>.jsonl`):
 *                          launchedAt / deliveredAt filled when missing,
 *                          agentType filled when missing, Stop => completed
 *
 * Field notes (checked against the hooks reference and the local CLI, 2026-09):
 * `memory_type` and `agent_transcript_path` are observed in the wild but not
 * documented; `CaptureRecord.transcript` and `agentTranscript` are expected
 * `~`-relative (the hook relativizes them), never absolute.
 *
 * Unmatched compaction and agent records are counted in run.coverage.capture;
 * `applied` counts the fields this join set on the run.
 */

const COMPACTION_WINDOW_MS = 15 * 60 * 1000;
const MAX_OBSERVED_FILES = 200;

/** Candidate scope ids for a subagent record: agent id with/without the `agent-` prefix, then the transcript basename. */
export function agentIdCandidates(record) {
  const out = [];
  const push = (value) => {
    if (typeof value !== "string" || !value) return;
    const bare = value.replace(/^agent-/, "");
    for (const id of [value, bare, `agent-${bare}`]) if (!out.includes(id)) out.push(id);
  };
  push(record?.agentId);
  const transcript = typeof record?.agentTranscript === "string" ? record.agentTranscript : "";
  const base = transcript.split("/").pop() ?? "";
  const match = /^(agent-[A-Za-z0-9._-]+)\.jsonl$/.exec(base);
  if (match) push(match[1]);
  return out;
}

function scopeForAgent(run, record) {
  const candidates = agentIdCandidates(record);
  if (!candidates.length) return null;
  return (run.scopes ?? []).find((scope) => candidates.includes(scope.id)) ?? null;
}

function scopeForRecord(run, record) {
  return scopeForAgent(run, record) ?? run.scopes?.[0] ?? null;
}

function nearestCompaction(scope, at, used) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const compaction of scope.compactions ?? []) {
    if (used.has(compaction)) continue;
    const distance = Math.abs(Date.parse(compaction.at) - time);
    if (Number.isFinite(distance) && distance < bestDistance) { best = compaction; bestDistance = distance; }
  }
  return best && bestDistance <= COMPACTION_WINDOW_MS ? best : null;
}

function validTrigger(value) {
  return value === "auto" || value === "manual" ? value : null;
}

export function joinCapture(run, records) {
  if (!run || !Array.isArray(run.scopes) || !run.scopes.length || !Array.isArray(records) || !records.length) return run;
  const mine = records.filter((record) => record && record.sessionId === run.sessionId);
  if (!mine.length) return run;
  mine.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const counts = new Map();
  const bump = (scope) => { if (scope) counts.set(scope.id, (counts.get(scope.id) ?? 0) + 1); };
  const observedFiles = new Set(run.instructionFilesObserved ?? []);
  const confirmed = new Map(); // scope.id -> Set<compaction> confirmed by PostCompact (Pre and Post share one compaction)
  const preSeen = new Map();   // scope.id -> Set<compaction> matched by PreCompact
  let unmatchedCompactions = 0;
  let unmatchedAgents = 0;
  let applied = 0;

  for (const record of mine) {
    switch (record.event) {
      case "InstructionsLoaded": {
        if (typeof record.file === "string" && record.file && observedFiles.size < MAX_OBSERVED_FILES) observedFiles.add(record.file);
        bump(scopeForRecord(run, record));
        break;
      }
      case "PreCompact":
      case "PostCompact": {
        const scope = scopeForRecord(run, record);
        bump(scope);
        if (!scope) break;
        const table = record.event === "PreCompact" ? preSeen : confirmed;
        const used = table.get(scope.id) ?? new Set();
        table.set(scope.id, used);
        const compaction = nearestCompaction(scope, record.at, used);
        if (!compaction) { unmatchedCompactions += 1; break; }
        used.add(compaction);
        if (!compaction.hookObserved) { compaction.hookObserved = true; applied += 1; }
        const trigger = validTrigger(record.trigger);
        if (trigger && (!compaction.trigger || compaction.trigger === "unknown")) { compaction.trigger = trigger; applied += 1; }
        break;
      }
      case "SubagentStart":
      case "SubagentStop": {
        const scope = scopeForAgent(run, record);
        if (!scope || scope.kind !== "subagent") { unmatchedAgents += 1; bump(run.scopes[0]); break; }
        bump(scope);
        if (!scope.agentType && typeof record.agentType === "string" && record.agentType) { scope.agentType = record.agentType; applied += 1; }
        if (record.event === "SubagentStart") {
          if (!scope.launchedAt) { scope.launchedAt = record.at; applied += 1; }
        } else {
          if (!scope.deliveredAt) { scope.deliveredAt = record.at; applied += 1; }
          if (scope.status !== "completed") { scope.status = "completed"; applied += 1; }
        }
        break;
      }
      default:
        bump(run.scopes[0]);
    }
  }

  for (const scope of run.scopes) {
    const n = counts.get(scope.id);
    if (n) scope.capture = { records: n };
  }
  if (observedFiles.size) run.instructionFilesObserved = [...observedFiles];
  run.coverage = { ...run.coverage, capture: { records: mine.length, unmatchedCompactions, unmatchedAgents, applied } };
  return run;
}
