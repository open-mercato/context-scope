/**
 * Per-file indexing work. Runs inside a worker thread (default) or in-process
 * (fallback, and when adapters/rules are injected as functions for tests).
 *
 * Task: { kind: "parse" | "reevaluate", vendor, path, runDir, shellFile, findingsFile, candidate, file }
 * Context (workerData, or `context` on the message for the persistent live worker):
 *   { home, thresholds, thresholdsHash, siblingIndex, adapterVersions, estimatorVersion, calibrationVersion }
 * Reply: { ok: true, entry } | { ok: false, error }
 *
 * Storage per run (docs/adr-002 section C, H.5):
 *   <runDir>/shell.json      Run without requests/blocks; scopes are ScopeSummary objects
 *   <runDir>/findings.json   findings (stored once)
 *   <runDir>/scopes/<id>.json one full AgentScope per scope (main included)
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { writeJsonAtomic } from "../util/fs.mjs";
import { encodedProjectDirToKey } from "../adapters/discover.mjs";
import { publicMessage, shortError } from "../util/errors.mjs";
import { buildEntry, scrubForbiddenKeys, slimScopeForStorage, summarizeScope } from "./entry.mjs";
import { scopeFileName } from "./manifest.mjs";
import { readCaptureRecords } from "../capture/reader.mjs";
import { joinCapture } from "../capture/join.mjs";
import { refinalizeRun } from "../ir/finalize.mjs";

let warned = false;

/** Loads the real adapters and rules; missing modules degrade to empty results. */
export async function loadDeps({ warn = (message) => console.error(message) } = {}) {
  const adapters = {};
  const warnings = [];
  try {
    const claude = await import("../adapters/claude.mjs");
    adapters.claude = { parse: claude.parseClaudeSession, version: claude.CLAUDE_ADAPTER_VERSION ?? "claude-v1" };
  } catch (error) {
    warnings.push(`Claude adapter unavailable (${shortError(error)}); Claude sessions are skipped.`);
  }
  try {
    const codex = await import("../adapters/codex.mjs");
    adapters.codex = { parse: codex.parseCodexRollout, version: codex.CODEX_ADAPTER_VERSION ?? "codex-v1" };
  } catch (error) {
    warnings.push(`Codex adapter unavailable (${shortError(error)}); Codex sessions are skipped.`);
  }
  let rules = null;
  try {
    rules = await import("../rules/index.mjs");
  } catch (error) {
    warnings.push(`Rules engine unavailable (${shortError(error)}); findings are empty.`);
  }
  let estimator = { estimatorVersion: "unknown", calibrationVersion: "none" };
  try {
    const estimate = await import("../ir/estimate.mjs");
    estimator = { estimatorVersion: estimate.ESTIMATOR_VERSION ?? "unknown", calibrationVersion: estimate.CALIBRATION_VERSION ?? "none" };
  } catch {}
  if (warnings.length && !warned) {
    warned = true;
    for (const message of warnings) warn(`ContextScope: ${message}`);
  }
  return { adapters, rules, estimator, warnings };
}

export { publicMessage };

const ENCODED_DIR = /^-[A-Za-z0-9._-]*$/;

function keyForEncodedDir(dirName) {
  return encodedProjectDirToKey(dirName);
}

/**
 * Defensive privacy pass on adapter output (review #1): a `project.key` that
 * is a Claude project directory name (`-Users-me-repo`) is an encoded absolute
 * path, and `source.file` values under `~/.claude/projects/<dir>/` carry the
 * same segment. Both are replaced with a hash of the segment.
 */
export function sanitizeRunPaths(run) {
  if (run?.project && typeof run.project.key === "string" && ENCODED_DIR.test(run.project.key) && run.project.key.length > 1) {
    run.project.key = keyForEncodedDir(run.project.key);
  }
  const fix = (file) => (typeof file === "string" ? sanitizeDisplayFile(file) : file);
  if (run?.source) run.source.file = fix(run.source.file);
  for (const scope of run?.scopes ?? []) if (scope?.source) scope.source.file = fix(scope.source.file);
  return run;
}

export function sanitizeDisplayFile(file) {
  return String(file).replace(/(~\/[^/]+\/projects\/)(-[^/]*)(\/)/, (_, head, dir, tail) => `${head}${keyForEncodedDir(dir)}${tail}`);
}

async function readScopeFiles(runDir) {
  const dir = path.join(runDir, "scopes");
  const scopes = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    scopes.push(JSON.parse(await readFile(path.join(dir, name), "utf8")));
  }
  return scopes;
}

export async function processFile(task, context, deps) {
  const adapter = deps.adapters?.[task.vendor];
  if (!adapter) throw new Error(`no adapter for ${task.vendor}`);
  let run;
  if (task.kind === "reevaluate") {
    const shell = JSON.parse(await readFile(task.shellFile, "utf8"));
    const scopes = await readScopeFiles(task.runDir);
    const order = new Map(shell.scopes.map((scope, index) => [scope.id, index]));
    scopes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    run = { ...shell, scopes };
    delete run.findings;
    // Runs stored before `compositionAtEnd` existed: derive it from the stored main scope (no re-parse).
    if (!run.summary?.compositionAtEnd) run.summary = { ...run.summary, compositionAtEnd: scopes[0]?.requests?.at(-1)?.composition ?? {} };
  } else {
    // Map<threadId, { path, parentThreadId }> so the Codex adapter can find spawned children.
    run = await adapter.parse(task.path, {
      home: context.home,
      projectDir: task.candidate?.projectDir,
      siblingIndex: context.siblingIndex instanceof Map ? context.siblingIndex : undefined,
      instructionTokensEstimate: context.instructionTokensEstimate ?? 0,
    });
    // Runtime evidence from the installed hook (ADR-003 section 6); absent files simply yield no records.
    // The adapters finalise inside `parse`, so a join that changed triggers or subagent status re-derives
    // the forecast and the summary (no second reconciliation).
    if (run?.sessionId && context.home) {
      try {
        joinCapture(run, await readCaptureRecords({ home: context.home, sessionId: run.sessionId }));
        if (run.coverage?.capture?.applied > 0) refinalizeRun(run);
      } catch {}
    }
  }
  if (!run || !Array.isArray(run.scopes) || !run.scopes.length) throw new Error("adapter returned no scopes");
  sanitizeRunPaths(run);
  let findings = [];
  if (deps.rules?.evaluateRun) {
    try {
      // `rulesHash` from the pass context stamps run.coverage.rulesHash without re-hashing per file (S5).
      findings = (await deps.rules.evaluateRun(run, { thresholds: context.thresholds ?? {}, rulesHash: context.rulesHash ?? undefined, home: context.home })) ?? [];
    } catch (error) {
      findings = [];
      run.coverage = { ...run.coverage, rulesError: publicMessage(error) };
    }
  }
  const scrubbed = scrubForbiddenKeys(run) + scrubForbiddenKeys(findings);
  if (scrubbed) run.coverage = { ...run.coverage, scrubbedKeys: scrubbed };
  run.summary = { ...run.summary, findingIds: findings.map((finding) => finding.id) };
  run.coverage = { ...run.coverage, estimatorVersion: context.estimatorVersion ?? run.coverage?.estimatorVersion, calibrationVersion: context.calibrationVersion ?? run.coverage?.calibrationVersion };

  // Write scopes first, then the shell; the manifest entry is the last thing to land.
  const scopesDir = path.join(task.runDir, "scopes");
  await rm(scopesDir, { recursive: true, force: true }).catch(() => {});
  const seen = new Set();
  for (const scope of run.scopes) {
    if (seen.has(scope.id)) continue;
    seen.add(scope.id);
    await writeJsonAtomic(path.join(scopesDir, scopeFileName(scope.id)), slimScopeForStorage(scope));
  }
  const shell = { ...run, scopes: run.scopes.map(summarizeScope) };
  await writeJsonAtomic(task.shellFile, shell);
  await writeJsonAtomic(task.findingsFile, findings);
  return buildEntry({
    run,
    findings,
    candidate: task.candidate,
    adapterVersion: adapter.version,
    estimatorVersion: context.estimatorVersion,
    calibrationVersion: context.calibrationVersion,
    thresholdsHash: context.thresholdsHash,
    file: task.file,
    thresholds: context.thresholds ?? {},
  });
}

if (!isMainThread && parentPort) {
  const depsPromise = loadDeps({ warn: () => {} }).then((deps) => {
    if (deps.warnings?.length) parentPort.postMessage({ type: "warnings", warnings: deps.warnings.map((message) => `ContextScope: ${message}`) });
    return deps;
  });
  // `context` on the message overrides workerData: the persistent live worker (index/writer.mjs) serves
  // several passes, each with its own thresholds/rulesHash/siblingIndex.
  parentPort.on("message", async ({ id, task, context }) => {
    try {
      const deps = await depsPromise;
      const entry = await processFile(task, context ?? workerData ?? {}, deps);
      parentPort.postMessage({ id, ok: true, entry });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: publicMessage(error), taskError: true });
    }
  });
}
