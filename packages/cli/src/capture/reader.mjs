/**
 * Reads capture records written by the installed hook
 * (~/.contextscope/capture/<sessionId>.jsonl). Bounded, tolerant: malformed
 * lines and records with an unexpected shape are skipped, never thrown.
 */
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

export const MAX_RECORDS_PER_SESSION = 5000;
export const MAX_LINE_BYTES = 4096;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
// `memoryType` (from `memory_type` / `is_global_instructions`) and `agentTranscript` (from `agent_transcript_path`) are
// observed in the wild on current CLI builds but absent from the hooks reference; they are optional everywhere.
const KNOWN_FIELDS = new Set(["v", "at", "event", "sessionId", "cwdKey", "transcript", "file", "memoryType", "loadReason", "source", "agentId", "agentType", "agentTranscript", "trigger"]);

export function captureDir(home) {
  return path.join(home, ".contextscope", "capture");
}

/** Validates one parsed line; returns a clean CaptureRecord or null. Unknown keys are dropped. */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  if (typeof raw.event !== "string" || !raw.event || typeof raw.sessionId !== "string" || !SESSION_ID.test(raw.sessionId)) return null;
  if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return null;
  const record = {};
  for (const key of KNOWN_FIELDS) {
    const value = raw[key];
    if (key === "v") record.v = 1;
    else if (typeof value === "string") record[key] = value.slice(0, 300);
  }
  if (typeof record.cwdKey !== "string") record.cwdKey = "unknown";
  if (typeof record.transcript !== "string") record.transcript = "";
  return record;
}

export function parseCaptureText(text, { limit = MAX_RECORDS_PER_SESSION } = {}) {
  const records = [];
  let malformed = 0;
  for (const line of String(text).split("\n")) {
    if (records.length >= limit) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_LINE_BYTES) { malformed += 1; continue; }
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { malformed += 1; continue; }
    const record = normalizeRecord(parsed);
    if (record) records.push(record);
    else malformed += 1;
  }
  return { records, malformed };
}

/** Records for one session id (empty when the hook never ran for it). */
export async function readCaptureRecords({ home, sessionId, limit = MAX_RECORDS_PER_SESSION } = {}) {
  if (!home || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return [];
  let text;
  try {
    text = await readFile(path.join(captureDir(home), `${sessionId}.jsonl`), "utf8");
  } catch {
    return [];
  }
  return parseCaptureText(text, { limit }).records.filter((record) => record.sessionId === sessionId);
}

/** Capture files newest first: [{ sessionId, file, bytes, mtimeMs }], bounded. */
export async function listCaptureFiles({ home, maxFiles = 500 } = {}) {
  let names = [];
  try { names = await readdir(captureDir(home)); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!SESSION_ID.test(sessionId)) continue;
    const file = path.join(captureDir(home), name);
    let info;
    try { info = await stat(file); } catch { continue; }
    if (!info.isFile()) continue;
    files.push({ sessionId, file, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, maxFiles);
}

/**
 * Records across the most recent capture files, optionally filtered by
 * project key (the inventory uses this to mark files `observed.loaded` for the
 * launched repository without going through the index).
 */
export async function readRecentCaptureRecords({ home, cwdKey, maxFiles = 50, events, limitPerFile = MAX_RECORDS_PER_SESSION } = {}) {
  const out = [];
  for (const entry of await listCaptureFiles({ home, maxFiles })) {
    let text;
    try { text = await readFile(entry.file, "utf8"); } catch { continue; }
    for (const record of parseCaptureText(text, { limit: limitPerFile }).records) {
      if (cwdKey && record.cwdKey !== cwdKey) continue;
      if (events && !events.includes(record.event)) continue;
      out.push(record);
    }
  }
  return out;
}

/** Per-event record counts and file count over the capture directory (for `hooks status`). */
export async function captureStats({ home, maxFiles = 500 } = {}) {
  const files = await listCaptureFiles({ home, maxFiles });
  const byEvent = {};
  let records = 0;
  let malformed = 0;
  let newest = null;
  for (const entry of files) {
    let text;
    try { text = await readFile(entry.file, "utf8"); } catch { continue; }
    const parsed = parseCaptureText(text);
    malformed += parsed.malformed;
    for (const record of parsed.records) {
      records += 1;
      byEvent[record.event] = (byEvent[record.event] ?? 0) + 1;
      if (!newest || record.at > newest) newest = record.at;
    }
  }
  return { files: files.length, records, malformed, byEvent, newest };
}
