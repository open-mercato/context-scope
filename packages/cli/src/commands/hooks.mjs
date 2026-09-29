/** `contextscope hooks`: install, inspect or remove the runtime-evidence capture hook (Claude Code). */
import path from "node:path";
import { access } from "node:fs/promises";
import { resolveRepoRoot } from "../util/repo.mjs";
import { CAPTURE_EVENTS, CAPTURE_VERSION, captureHookEntry } from "../capture/template.mjs";
import { captureStats } from "../capture/reader.mjs";
import {
  BACKUPS_KEPT, CAPTURE_MAX_AGE_DAYS, CAPTURE_MAX_FILES, SCOPES, applySettingsChange, backupDir, captureScriptPath, captureScriptStatus,
  displayName, ensureCaptureScript, installedEvents, installedNode, mergeCaptureHooks, nodeOnPath, parseEvents, pruneCaptureFiles,
  readSettingsFile, removeCaptureHooks, resolveNode, settingsPathFor,
} from "../capture/install.mjs";

export const name = "hooks";
export const usage = "contextscope hooks install|status|uninstall [--scope user|project|local] [--repo <path>] [--events a,b] [--dry-run] [--yes]";
export const summary = [
  "Capture InstructionsLoaded, compaction and subagent events from Claude Code into",
  "~/.contextscope/capture (metadata only). Nothing is written without --yes or your",
  "confirmation; the diff is previewed, the backup goes to ~/.contextscope/backups.",
];

const VALUE_OPTIONS = new Set(["--scope", "--repo", "--events"]);

/** The subcommand is the first word that is neither an option nor an option's value (`hooks --scope project install` works). */
export function subcommandOf(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("-")) { if (VALUE_OPTIONS.has(token)) i += 1; continue; }
    return token;
  }
  return "status";
}

export async function run(args, { home, cwd, env = process.env }) {
  const sub = subcommandOf(args.argv);
  const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));
  const scope = args.option("--scope", "user");
  if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(", ")}`);
  const dryRun = args.has("--dry-run");
  const yes = args.has("--yes");
  const json = args.has("--json");
  if (sub === "install") return install({ home, env, repoRoot, scope, events: parseEvents(args.option("--events", "")), dryRun, yes });
  if (sub === "uninstall") return uninstall({ home, env, repoRoot, scope, dryRun, yes });
  if (sub === "status") return status({ home, env, repoRoot, json });
  throw new Error(`unknown hooks subcommand "${sub}" (install, status or uninstall)`);
}

const show = (file, home) => displayName(file, home);

async function install({ home, env, repoRoot, scope, events, dryRun, yes }) {
  const file = settingsPathFor(scope, { home, repoRoot, env });
  const { node, source } = await resolveNode();
  const fallback = await nodeOnPath(env);
  const entry = captureHookEntry({ node });
  console.log(`ContextScope hooks install · scope ${scope} · ${show(file, home)}`);
  console.log(`Nothing is written without --yes or your confirmation; \`contextscope hooks uninstall --scope ${scope} --yes\` removes only these entries.`);
  console.log(`What changes: one matcher-less hook group per event (${events.join(", ")}) is appended to ${show(file, home)}; existing hooks and settings are kept.`);
  console.log(`Backup first: the current file is copied to ${show(backupDir(home), home)}/${scope}-settings-<timestamp>.json (mode 0600, never inside the repository, last ${BACKUPS_KEPT} kept). Undo: uninstall, or copy the backup back.`);
  console.log(`Also written: ${show(captureScriptPath(home), home)} (the capture script, mode 0700, node builtins only).`);
  console.log(`Hook command: ${entry.command}`);
  console.log(`  node: ${node ? `${node} (${source})` : "not pinned"}; PATH fallback: ${fallback ?? "no node on PATH right now"}; fail-open (|| true), ${entry.timeout} s timeout.`);
  if (scope !== "user") console.log(`Note: ${path.basename(file)} in .claude/ is usually ${scope === "project" ? "committed" : "gitignored but shared through copies"}; teammates without ${show(captureScriptPath(home), home)} run a fail-open no-op on every event until they install ContextScope.`);
  const result = await applySettingsChange({ file, transform: (settings) => mergeCaptureHooks(settings, events, { node }), dryRun, yes, home, scope });
  if (dryRun) {
    console.log(`(dry run) capture script would be written to ${show(captureScriptPath(home), home)}; no backup taken.`);
    return;
  }
  if (result.written || result.changed === false) {
    const script = await ensureCaptureScript({ home });
    console.log(`${script.written ? "Wrote" : "Kept"} ${show(script.path, home)} (${CAPTURE_VERSION}, mode 0700).`);
    if (result.pruned?.length) console.log(`Pruned ${result.pruned.length} older backup(s) of scope ${scope}.`);
    const pruned = await pruneCaptureFiles({ home });
    if (pruned.removed) console.log(`Pruned ${pruned.removed} capture file(s) older than ${CAPTURE_MAX_AGE_DAYS} days or beyond the newest ${CAPTURE_MAX_FILES}.`);
    console.log("Records land in ~/.contextscope/capture/<sessionId>.jsonl: event names, session id, project key, relative file paths. Never prompt text.");
    console.log(`Only sessions started after this install fire the hook; check with: contextscope hooks status. Remove with: contextscope hooks uninstall --scope ${scope} --yes`);
  }
}

async function uninstall({ home, env, repoRoot, scope, dryRun, yes }) {
  const file = settingsPathFor(scope, { home, repoRoot, env });
  console.log(`ContextScope hooks uninstall · scope ${scope} · ${show(file, home)}`);
  console.log(`Removes only the entries whose command names .contextscope/bin/capture.mjs; other hooks stay. Backup first to ${show(backupDir(home), home)}/${scope}-settings-<timestamp>.json.`);
  const result = await applySettingsChange({ file, transform: removeCaptureHooks, dryRun, yes, home, scope });
  if (result.written) console.log(`Removed the ContextScope entries; other hooks untouched. Capture records stay in ~/.contextscope/capture until you delete that directory.`);
}

export async function hooksStatus({ home, repoRoot, env = process.env }) {
  const scopes = [];
  const nodes = new Set();
  for (const scope of SCOPES) {
    const file = settingsPathFor(scope, { home, repoRoot, env });
    let exists = false;
    let installed = [];
    let otherEvents = [];
    let node = null;
    let error;
    try {
      const read = await readSettingsFile(file);
      exists = read.exists;
      installed = installedEvents(read.settings);
      node = installedNode(read.settings);
      otherEvents = Object.keys(read.settings.hooks ?? {}).filter((event) => !installed.includes(event));
    } catch (caught) {
      error = caught.message;
    }
    const entry = { scope, path: show(file, home), exists, installed, missing: CAPTURE_EVENTS.filter((event) => !installed.includes(event)), otherHookEvents: otherEvents };
    if (installed.length) { entry.node = node ?? "PATH"; if (node) nodes.add(node); }
    if (error) entry.error = error;
    scopes.push(entry);
  }
  const script = await captureScriptStatus({ home });
  const capture = await captureStats({ home });
  const nodeReport = { pinned: [...nodes], onPath: await nodeOnPath(env), current: process.execPath };
  for (const pinned of nodes) {
    try { await access(pinned); } catch { nodeReport.missing = [...(nodeReport.missing ?? []), pinned]; }
  }
  const installedAnywhere = scopes.some((entry) => entry.installed.length);
  const hint = !installedAnywhere ? null
    : !script.present ? "capture script missing: run `contextscope hooks install` again"
    : nodeReport.missing?.length ? `the pinned node ${nodeReport.missing[0]} no longer exists; the hook falls back to node on PATH (${nodeReport.onPath ?? "none found"}); re-run hooks install to re-pin`
    : capture.records === 0 ? "no records yet: only sessions started after the install fire the hook; if sessions ran since, Claude Code's PATH may lack node (re-run hooks install to pin it)"
    : null;
  return { version: CAPTURE_VERSION, scopes, script: { path: show(captureScriptPath(home), home), ...script }, node: nodeReport, capture, hint };
}

async function status({ home, env, repoRoot, json }) {
  const pruned = await pruneCaptureFiles({ home });
  const report = await hooksStatus({ home, repoRoot, env });
  if (pruned.removed) report.capture.pruned = pruned.removed;
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`ContextScope hooks status (${report.version})`);
  for (const entry of report.scopes) {
    const state = entry.error ? `invalid JSON: ${entry.error}` : !entry.exists ? "no settings file" : entry.installed.length === 0 ? "not installed" : entry.installed.length === CAPTURE_EVENTS.length ? "installed (all events)" : `installed: ${entry.installed.join(", ")}`;
    const others = entry.otherHookEvents.length ? ` · other hooks: ${entry.otherHookEvents.join(", ")}` : "";
    const node = entry.node ? ` · node ${entry.node}` : "";
    console.log(`  ${entry.scope.padEnd(8)} ${entry.path}  ${state}${node}${others}`);
  }
  console.log(`  script   ${report.script.path}  ${report.script.present ? (report.script.upToDate ? "present" : "present (outdated; re-run hooks install)") : "missing"}`);
  console.log(`  node     pinned ${report.node.pinned.length ? report.node.pinned.join(", ") : "none"}${report.node.missing?.length ? ` (missing: ${report.node.missing.join(", ")})` : ""} · on PATH ${report.node.onPath ?? "none"}`);
  const counts = CAPTURE_EVENTS.map((event) => `${event} ${report.capture.byEvent[event] ?? 0}`).join(" · ");
  console.log(`  capture  ~/.contextscope/capture  ${report.capture.files} session file(s), ${report.capture.records} record(s), last record ${report.capture.newest ?? "never"}`);
  console.log(`           ${counts}`);
  if (report.capture.malformed) console.log(`           ${report.capture.malformed} malformed line(s) skipped`);
  if (report.capture.pruned) console.log(`           pruned ${report.capture.pruned} file(s) older than ${CAPTURE_MAX_AGE_DAYS} days or beyond the newest ${CAPTURE_MAX_FILES}`);
  console.log(`  backups  ${show(backupDir(home), home)}  last ${BACKUPS_KEPT} per scope; undo = hooks uninstall, or copy one back`);
  if (report.hint) console.log(`  hint     ${report.hint}`);
}
