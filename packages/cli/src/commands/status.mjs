/**
 * `contextscope status`: a diagnostic that answers in well under a second
 * without running an index pass (ADR-005 section 6). Everything printed is
 * read from what already exists: the vendor stores (a listing and stats, no
 * transcript is opened for a known file), the manifest on disk, the repo's
 * instruction files, the hook settings and capture records, a one-shot
 * `fs.watch` probe, and `~/.contextscope/server.json`. `scan` reads and
 * evaluates sessions; `status` never does. Exit 0 always; `--json` mirrors
 * the lines as one object.
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { resolveRepoRoot } from "../util/repo.mjs";
import { displayPath, mapLimit, resolveRoots, walkFiles } from "../util/fs.mjs";
import { formatCount } from "../util/format.mjs";
import { discoverAll, projectKeyFor } from "../adapters/discover.mjs";
import { indexRoot, loadManifest } from "../index/manifest.mjs";
import { repoSessions } from "../index/reader.mjs";
import { aggregateStats } from "../index/overview.mjs";
import { probeWatchCapability } from "../index/watch.mjs";
import { readServerFile, serverFilePath } from "../server/server-file.mjs";
import { CAPTURE_EVENTS } from "../capture/template.mjs";
import { hooksStatus } from "./hooks.mjs";

export const name = "status";
export const usage = "contextscope status [--repo <path>] [--json]";
export const summary = [
  "Diagnostics without an index pass: vendors detected with file counts, the repo's",
  "instruction files, index size and last pass, hooks per scope with record counts,",
  "watcher capability, and whether a companion is running (~/.contextscope/server.json).",
];

const INDEX_WALK_MAX_FILES = 50_000;
const STAT_CONCURRENCY = 64;

async function section(fn, fallback) {
  try { return await fn(); } catch (error) { return { ...fallback, error: error?.message ?? String(error) }; }
}

/** Bytes and files under the index root, bounded; no file is opened. */
async function indexOnDisk(root) {
  const files = await walkFiles(root, { maxDepth: 6, maxFiles: INDEX_WALK_MAX_FILES });
  const sizes = await mapLimit(files, STAT_CONCURRENCY, async (file) => { try { return (await stat(file)).size; } catch { return 0; } });
  return { files: files.length, bytes: sizes.reduce((sum, size) => sum + size, 0), truncated: files.length >= INDEX_WALK_MAX_FILES };
}

/** The repo's instruction files with sizes and load state; the setup module is optional so status works without it. */
async function instructionFiles({ repoRoot, home, sessionStats }) {
  const inventory = await import("../setup/inventory.mjs").catch(() => null);
  const instructions = await import("../setup/instructions.mjs").catch(() => null);
  if (!inventory?.detectVendors || !instructions?.collectInstructionFiles) return [];
  const vendorsDetected = await inventory.detectVendors({ home, sessionStats });
  const captureObserved = typeof inventory.captureObservedFiles === "function" ? await inventory.captureObservedFiles({ home, repoRoot, repoRootRaw: repoRoot }) : [];
  const collected = await instructions.collectInstructionFiles({ repoRoot, home, vendorsDetected, sessionStats, captureObserved });
  const files = Array.isArray(collected) ? collected : collected?.files ?? [];
  const isFixture = typeof inventory.isFixturePath === "function" ? inventory.isFixturePath : () => false;
  return files
    .filter((file) => !isFixture(file.path))
    .map((file) => ({ path: file.path, scope: file.scope, vendors: file.vendors ?? [], bytes: file.bytes ?? 0, estTokens: file.estTokens ?? 0, estBasis: file.estBasis, estTokensBy: file.estTokensBy, loadState: file.loadState ?? "discoverable" }));
}

/** The whole report as one object; every section is independent and degrades to an `error` string. */
export async function statusReport({ home, repoRoot, env = process.env, now = Date.now() } = {}) {
  const startedAt = Date.now();
  const root = indexRoot(home);
  const roots = resolveRoots({ home, env });
  const manifest = await loadManifest(root);
  const entries = Object.values(manifest.files ?? {});
  const known = manifest.files ?? {};

  const [discovered, disk, hooks, watcher, server] = await Promise.all([
    section(() => discoverAll({ home, env, known }), { vendors: [], files: [] }),
    section(() => indexOnDisk(root), { files: 0, bytes: 0 }),
    section(() => hooksStatus({ home, repoRoot, env }), { scopes: [], capture: { files: 0, records: 0, byEvent: {}, newest: null }, hint: null }),
    section(() => probeWatchCapability({ home, env }), { mode: "unknown" }),
    section(() => readServerFile(home), { present: false, info: null, alive: false }),
  ]);

  const vendorRoots = { claude: roots.claudeProjects, codex: roots.codexSessions, gemini: roots.geminiTmp };
  const vendors = (discovered.vendors ?? []).map((row) => ({ ...row, path: displayPath(vendorRoots[row.vendor] ?? "", home) }));

  const projectKey = projectKeyFor(repoRoot);
  const population = repoSessions({ entries, repoRoot, projectKey });
  const machine = repoSessions({ entries });
  const sessionsByVendor = {};
  for (const entry of population.roots) sessionsByVendor[entry.vendor] = (sessionsByVendor[entry.vendor] ?? 0) + 1;
  let sessionStats;
  try { sessionStats = aggregateStats(population.entries, { sessions: population.roots.length }); } catch { sessionStats = undefined; }
  const files = await section(() => instructionFiles({ repoRoot, home, sessionStats }), []);

  const failed = entries.filter((entry) => entry.error).length;
  const pass = manifest.lastPass ?? null;
  const live = manifest.lastLivePass ?? null;

  const serverInfo = server.present && server.info ? server.info : null;
  return {
    version: manifest.version ?? null,
    repo: { name: path.basename(repoRoot), root: displayPath(repoRoot, home), key: projectKey, sessions: population.roots.length, sessionsByVendor, subagents: population.entries.length - population.roots.length, machineSessions: machine.roots.length, unattributed: machine.unattributed.length },
    vendors,
    instructionFiles: Array.isArray(files) ? files : [],
    index: {
      root: displayPath(root, home),
      entries: entries.length,
      failed,
      files: disk.files,
      bytes: disk.bytes,
      truncated: disk.truncated ?? false,
      adapterVersions: manifest.adapterVersions ?? {},
      estimatorVersion: manifest.estimatorVersion ?? null,
      rulesHash: manifest.rulesHash ?? null,
      lastPass: pass ? { at: pass.at ?? manifest.lastRunAt ?? null, ms: pass.ms ?? null, total: pass.total ?? null, parsed: pass.parsed ?? 0, reevaluated: pass.reevaluated ?? 0, skipped: pass.skipped ?? 0, failed: pass.failed ?? 0, removed: pass.removed ?? 0, aborted: Boolean(pass.aborted) } : null,
      lastLivePass: live ? { at: live.at ?? null, ms: live.ms ?? null, files: live.files ?? null } : null,
      ...(disk.error ? { error: disk.error } : {}),
    },
    hooks: {
      scopes: (hooks.scopes ?? []).map((scope) => ({ scope: scope.scope, path: scope.path, exists: scope.exists, installed: scope.installed ?? [], node: scope.node ?? null, ...(scope.error ? { error: scope.error } : {}) })),
      script: hooks.script ?? null,
      capture: hooks.capture ?? { files: 0, records: 0, byEvent: {}, newest: null },
      hint: hooks.hint ?? null,
      ...(hooks.error ? { error: hooks.error } : {}),
    },
    watcher: { mode: watcher.mode ?? "unknown", dir: watcher.dir ? displayPath(watcher.dir, home) : null, reason: watcher.reason ?? null, ...(watcher.error ? { error: watcher.error } : {}) },
    server: {
      file: displayPath(serverFilePath(home), home),
      running: Boolean(serverInfo && server.alive),
      stale: Boolean(serverInfo && !server.alive),
      pid: serverInfo?.pid ?? null,
      url: serverInfo?.url ?? null,
      repoRoot: serverInfo?.repoRoot ? displayPath(String(serverInfo.repoRoot), home) : null,
      startedAt: serverInfo?.startedAt ?? null,
      ...(server.error ? { error: server.error } : {}),
    },
    ms: Date.now() - startedAt,
    at: new Date(now).toISOString(),
  };
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
  return `${value} B`;
}

function ago(iso, now = Date.now()) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

const LABEL = 10;
const line = (label, text) => `  ${label.padEnd(LABEL)}${text}`;

export function renderStatus(report, { now = Date.now() } = {}) {
  const lines = [`ContextScope status · repo ${report.repo.name} (${report.repo.root}) · ${report.ms} ms`];
  const vendors = report.vendors.length
    ? report.vendors.map((row) => `${row.vendor} ${row.detected ? `${row.path}: ${formatCount(row.files)} file${row.files === 1 ? "" : "s"}${row.parsed ? "" : " (detected, no adapter)"}` : "not found"}`).join(" · ")
    : "none detected";
  lines.push(line("vendors", vendors));
  const byVendor = Object.entries(report.repo.sessionsByVendor).sort().map(([vendor, n]) => `${vendor} ${formatCount(n)}`).join(", ");
  lines.push(line("sessions", `${formatCount(report.repo.sessions)} in this repo${byVendor ? ` (${byVendor})` : ""} · ${formatCount(report.repo.subagents)} subagents · ${formatCount(report.repo.machineSessions)} on this machine${report.repo.unattributed ? ` · ${formatCount(report.repo.unattributed)} unattributed` : ""}`));
  const files = report.instructionFiles;
  lines.push(line("setup", files.length
    ? files.map((file) => `${file.path} ${formatBytes(file.bytes)} (${file.loadState})`).join(" · ")
    : "no instruction files in this repository (CLAUDE.md, AGENTS.md, .claude/rules)"));
  const index = report.index;
  const versions = Object.entries(index.adapterVersions ?? {}).map(([vendor, version]) => version ?? vendor).join(", ");
  lines.push(line("index", `${index.root} · ${formatCount(index.entries)} entr${index.entries === 1 ? "y" : "ies"}${index.failed ? ` (${formatCount(index.failed)} failed)` : ""} · ${formatBytes(index.bytes)} in ${formatCount(index.files)} files${index.truncated ? "+" : ""}${versions ? ` · adapters ${versions}` : ""}${index.rulesHash ? ` · rules ${index.rulesHash}` : ""}${index.error ? ` · ${index.error}` : ""}`));
  const pass = index.lastPass;
  lines.push(line("last pass", pass
    ? `${ago(pass.at, now)} (${pass.at ?? "?"}) · ${formatCount(pass.total)} changed: ${formatCount(pass.parsed)} parsed, ${formatCount(pass.reevaluated)} re-evaluated, ${formatCount(pass.skipped)} unchanged, ${formatCount(pass.failed)} failed${pass.removed ? `, ${formatCount(pass.removed)} removed` : ""} in ${((pass.ms ?? 0) / 1000).toFixed(1)} s${pass.aborted ? " (aborted)" : ""}${index.lastLivePass ? ` · last live pass ${ago(index.lastLivePass.at, now)}` : ""}`
    : "never (run contextscope, scan or index)"));
  const hooks = report.hooks;
  const scopes = hooks.scopes.map((scope) => {
    const state = scope.error ? `invalid JSON` : !scope.exists ? "no settings file" : scope.installed.length === 0 ? "not installed" : scope.installed.length === CAPTURE_EVENTS.length ? "installed (all events)" : `installed: ${scope.installed.join(", ")}`;
    return `${scope.scope} ${state}`;
  }).join(" · ");
  const capture = hooks.capture ?? {};
  lines.push(line("hooks", `${scopes || "unknown"}${hooks.error ? ` · ${hooks.error}` : ""}`));
  lines.push(line("", `${formatCount(capture.records ?? 0)} record${capture.records === 1 ? "" : "s"} in ${formatCount(capture.files ?? 0)} capture file${capture.files === 1 ? "" : "s"} · last record ${capture.newest ? ago(capture.newest, now) : "never"}${hooks.hint ? ` · hint: ${hooks.hint}` : ""}`));
  if (!hooks.scopes.some((scope) => scope.installed.length)) lines.push(line("", "not installed: contextscope hooks install --scope user (runtime evidence for the Setup screen)"));
  const watcher = report.watcher;
  const watcherText = watcher.mode === "watch" ? `fs.watch available (${watcher.dir})`
    : watcher.mode === "poll" ? `fs.watch unavailable (${watcher.reason}); the companion polls live sessions every 5 s`
    : watcher.mode === "none" ? "no session directory to watch yet"
    : `unknown${watcher.error ? ` (${watcher.error})` : ""}`;
  lines.push(line("watcher", watcherText));
  const server = report.server;
  const companion = server.running ? `running · pid ${server.pid} · ${server.url} · repo ${server.repoRoot ?? "?"} · started ${ago(server.startedAt, now)}`
    : server.stale ? `stale ${server.file} (pid ${server.pid} is not running; it is replaced on the next start)`
    : `not running (${server.file} absent) · start with: contextscope`;
  lines.push(line("companion", companion));
  return lines.join("\n");
}

export async function run(args, { home, cwd, env = process.env }) {
  const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));
  const report = await statusReport({ home, repoRoot, env });
  if (args.has("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderStatus(report));
}
