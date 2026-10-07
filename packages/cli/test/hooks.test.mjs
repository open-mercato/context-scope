/** Hook installer: merge/remove semantics, diff preview, guarded writes, CLI dry-run. */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CAPTURE_EVENTS, CAPTURE_MARKER, CAPTURE_SCRIPT, captureHookEntry, nodeOfCommand } from "../src/capture/template.mjs";
import {
  applySettingsChange, backupDir, backupNameFor, captureScriptPath, ensureCaptureScript, installedEvents, installedNode, mergeCaptureHooks,
  parseEvents, pruneBackups, pruneCaptureFiles, removeCaptureHooks, settingsPathFor, unifiedDiff,
} from "../src/capture/install.mjs";
import { hooksStatus, subcommandOf } from "../src/commands/hooks.mjs";

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "contextscope.mjs");

const EXISTING = {
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", timeout: 15, command: "npx prettier --write \"$CLAUDE_FILE_PATH\"" }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
  },
};

async function makeEnv() {
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-hooks-"));
  const repo = path.join(home, "work", "repo");
  await mkdir(path.join(repo, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  return { home, repo };
}

function cli(args, { home, cwd, env = {} }) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, HOME: home, ...env };
    delete childEnv.CLAUDE_CONFIG_DIR;
    Object.assign(childEnv, env);
    execFileCb(process.execPath, [CLI, ...args], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** Runs an installed hook command the way Claude Code does: through a shell, payload on stdin. */
function runHook(command, { home, payload, env = {} }) {
  return new Promise((resolve) => {
    const child = execFileCb("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home, ...env } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("merge appends our entry per event, leaves existing groups byte-for-byte and is idempotent", () => {
  const before = JSON.stringify(EXISTING);
  const once = mergeCaptureHooks(EXISTING);
  assert.equal(JSON.stringify(EXISTING), before, "input not mutated");
  assert.deepEqual(installedEvents(once).sort(), [...CAPTURE_EVENTS].sort());
  assert.deepEqual(once.hooks.PostToolUse, EXISTING.hooks.PostToolUse);
  assert.deepEqual(once.hooks.SessionStart[0], EXISTING.hooks.SessionStart[0]);
  assert.equal(once.hooks.SessionStart.length, 2);
  assert.equal(once.hooks.SessionStart[1].matcher, undefined);
  assert.ok(once.hooks.SessionStart[1].hooks[0].command.includes(CAPTURE_MARKER));
  assert.equal(once.hooks.SessionStart[1].hooks[0].command, "sh -c 'node \"$HOME/.contextscope/bin/capture.mjs\" 2>/dev/null || true'", "no node given: PATH only");
  assert.equal(once.hooks.SessionStart[1].hooks[0].timeout, 5);
  const pinned = mergeCaptureHooks({}, ["PreCompact"], { node: "/opt/node/bin/node" });
  assert.equal(pinned.hooks.PreCompact[0].hooks[0].command, "sh -c '\"/opt/node/bin/node\" \"$HOME/.contextscope/bin/capture.mjs\" 2>/dev/null || node \"$HOME/.contextscope/bin/capture.mjs\" 2>/dev/null || true'", "pinned node first, PATH fallback, fail-open");
  assert.equal(installedNode(pinned), "/opt/node/bin/node");
  assert.equal(installedNode(once), null);
  assert.equal(nodeOfCommand(captureHookEntry({ node: "/it's/odd/node" }).command), null, "a quote in the path degrades to PATH only");
  assert.deepEqual(once.permissions, EXISTING.permissions);
  const twice = mergeCaptureHooks(once);
  assert.deepEqual(twice, once);
  const partial = mergeCaptureHooks({}, ["PreCompact"]);
  assert.deepEqual(installedEvents(partial), ["PreCompact"]);
});

test("remove drops only our entries and restores the original shape", () => {
  const installed = mergeCaptureHooks(EXISTING);
  assert.deepEqual(removeCaptureHooks(installed), EXISTING);
  assert.deepEqual(removeCaptureHooks(mergeCaptureHooks({ model: "opus" })), { model: "opus" });
  assert.deepEqual(removeCaptureHooks({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "x" }, { type: "command", command: `node ~/${CAPTURE_MARKER}` }] }] } }), { hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } });
});

test("subcommand is the first non-option word wherever it stands", () => {
  assert.equal(subcommandOf(["install", "--scope", "project"]), "install");
  assert.equal(subcommandOf(["--scope", "project", "install"]), "install");
  assert.equal(subcommandOf(["--scope", "project"]), "status");
  assert.equal(subcommandOf(["--dry-run", "uninstall"]), "uninstall");
  assert.equal(subcommandOf([]), "status");
});

test("parseEvents accepts raw names and ADR aliases, rejects unknown", () => {
  assert.deepEqual(parseEvents(""), CAPTURE_EVENTS);
  assert.deepEqual(parseEvents("compaction,instructions"), ["InstructionsLoaded", "PreCompact", "PostCompact"]);
  assert.deepEqual(parseEvents("SubagentStop"), ["SubagentStop"]);
  assert.throws(() => parseEvents("PreToolUse"), /unknown hook event/);
});

test("unified diff shows added lines only for an append", () => {
  const before = JSON.stringify(EXISTING, null, 2) + "\n";
  const after = JSON.stringify(mergeCaptureHooks(EXISTING), null, 2) + "\n";
  const diff = unifiedDiff(before, after, "settings.json");
  assert.match(diff, /^--- settings\.json\n\+\+\+ settings\.json\n@@ /);
  assert.equal(diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length, 0, "nothing removed");
  assert.ok(diff.split("\n").filter((line) => line.startsWith("+")).length > 6);
  assert.equal(unifiedDiff("a\n", "a\n"), "");
});

test("settingsPathFor honours CLAUDE_CONFIG_DIR for the user scope only", () => {
  const home = "/h";
  assert.equal(settingsPathFor("user", { home, repoRoot: "/r", env: {} }), path.join("/h", ".claude", "settings.json"));
  assert.equal(settingsPathFor("user", { home, repoRoot: "/r", env: { CLAUDE_CONFIG_DIR: "/cfg" } }), path.join("/cfg", "settings.json"));
  assert.equal(settingsPathFor("project", { home, repoRoot: "/r", env: { CLAUDE_CONFIG_DIR: "/cfg" } }), path.join("/r", ".claude", "settings.json"));
  assert.equal(settingsPathFor("local", { home, repoRoot: "/r", env: { CLAUDE_CONFIG_DIR: "/cfg" } }), path.join("/r", ".claude", "settings.local.json"));
});

test("applySettingsChange: dry-run writes nothing, --yes writes with a backup outside the repo, uninstall restores, invalid JSON refused", async () => {
  const { home, repo } = await makeEnv();
  const file = settingsPathFor("project", { home, repoRoot: repo, env: {} });
  assert.equal(file, path.join(repo, ".claude", "settings.json"));
  const original = JSON.stringify(EXISTING, null, 2) + "\n";
  await writeFile(file, original);
  const out = [];
  const log = (line) => out.push(line);

  const dry = await applySettingsChange({ file, transform: mergeCaptureHooks, dryRun: true, out: log, home, scope: "project" });
  assert.equal(dry.changed, true);
  assert.equal(dry.written, false);
  assert.equal(await readFile(file, "utf8"), original);
  assert.ok(out.some((line) => line.includes("\n+++ ")), "diff printed");

  const declined = await applySettingsChange({ file, transform: mergeCaptureHooks, confirm: async () => false, out: log, home, scope: "project" });
  assert.equal(declined.written, false);
  assert.equal(await readFile(file, "utf8"), original);

  const written = await applySettingsChange({ file, transform: mergeCaptureHooks, yes: true, out: log, now: new Date("2026-09-02T10:11:12.000Z"), home, scope: "project" });
  assert.equal(written.written, true);
  assert.equal(written.backup, backupNameFor(file, new Date("2026-09-02T10:11:12.000Z"), { home, scope: "project" }));
  assert.equal(written.backup, path.join(home, ".contextscope", "backups", "project-settings-2026-09-02T10-11-12-000.json"), "backups live under ~/.contextscope, never in the repository");
  assert.equal((await stat(written.backup)).mode & 0o777, 0o600);
  assert.equal(await readFile(written.backup, "utf8"), original);
  assert.deepEqual(await readdir(path.join(repo, ".claude")), ["settings.json"], "nothing new next to the committed file");
  assert.ok(out.some((line) => line.includes("backup: ~/.contextscope/backups/project-settings-2026-09-02T10-11-12-000.json")), "the backup path is printed");
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(after.hooks.PostToolUse, EXISTING.hooks.PostToolUse);
  assert.deepEqual(installedEvents(after).sort(), [...CAPTURE_EVENTS].sort());

  const again = await applySettingsChange({ file, transform: mergeCaptureHooks, yes: true, out: log, home, scope: "project" });
  assert.equal(again.changed, false, "second install is a no-op");

  const removed = await applySettingsChange({ file, transform: removeCaptureHooks, yes: true, out: log, home, scope: "project" });
  assert.equal(removed.written, true);
  assert.equal(await readFile(file, "utf8"), original, "uninstall restores the original text");

  await writeFile(file, "{ not json");
  await assert.rejects(applySettingsChange({ file, transform: mergeCaptureHooks, yes: true, out: log, home, scope: "project" }), /not valid JSON/);
  assert.equal(await readFile(file, "utf8"), "{ not json");

  // A missing file is created (no backup) with our entries only.
  const local = settingsPathFor("local", { home, repoRoot: repo, env: {} });
  const created = await applySettingsChange({ file: local, transform: mergeCaptureHooks, yes: true, out: log, home, scope: "local" });
  assert.equal(created.written, true);
  assert.equal(created.backup, null);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(local, "utf8"))), ["hooks"]);

  // Backups are pruned to the last 10 per scope.
  for (let i = 0; i < 12; i += 1) await writeFile(path.join(backupDir(home), `local-settings-2026-01-${String(i + 1).padStart(2, "0")}T00-00-00.json`), "{}");
  await writeFile(path.join(backupDir(home), "user-settings-2026-01-01T00-00-00.json"), "{}");
  const stale = await pruneBackups({ home, scope: "local" });
  assert.deepEqual(stale, ["local-settings-2026-01-01T00-00-00.json", "local-settings-2026-01-02T00-00-00.json"]);
  const left = (await readdir(backupDir(home))).filter((name) => name.startsWith("local-"));
  assert.equal(left.length, 10);
  assert.ok((await readdir(backupDir(home))).includes("user-settings-2026-01-01T00-00-00.json"), "other scopes untouched");
});

test("pruneCaptureFiles drops files older than 90 days or beyond the newest 500", async () => {
  const { home } = await makeEnv();
  const dir = path.join(home, ".contextscope", "capture");
  await mkdir(dir, { recursive: true });
  const now = Date.parse("2026-09-02T00:00:00Z");
  const old = path.join(dir, "old-session.jsonl");
  await writeFile(old, "{}\n");
  await utimes(old, new Date(now - 100 * 86_400_000), new Date(now - 100 * 86_400_000));
  await writeFile(path.join(dir, "fresh-session.jsonl"), "{}\n");
  await writeFile(path.join(dir, "notes.txt"), "keep");
  const first = await pruneCaptureFiles({ home, now });
  assert.deepEqual(first, { removed: 1, kept: 1 });
  assert.deepEqual((await readdir(dir)).sort(), ["fresh-session.jsonl", "notes.txt"]);
  for (let i = 0; i < 5; i += 1) { const f = path.join(dir, `s${i}.jsonl`); await writeFile(f, "{}\n"); await utimes(f, new Date(now - i * 1000), new Date(now - i * 1000)); }
  assert.deepEqual(await pruneCaptureFiles({ home, now, maxFiles: 3 }), { removed: 3, kept: 3 });
});

test("ensureCaptureScript writes ~/.contextscope/bin/capture.mjs with mode 0700 and reports drift", async () => {
  const { home, repo } = await makeEnv();
  const first = await ensureCaptureScript({ home });
  assert.equal(first.written, true);
  assert.equal(first.path, captureScriptPath(home));
  assert.equal((await stat(first.path)).mode & 0o777, 0o700);
  assert.equal(await readFile(first.path, "utf8"), CAPTURE_SCRIPT);
  assert.equal((await ensureCaptureScript({ home })).upToDate, true);
  await writeFile(first.path, "// stale\n");
  const status = await hooksStatus({ home, repoRoot: repo, env: {} });
  assert.equal(status.script.present, true);
  assert.equal(status.script.upToDate, false);
  assert.equal(status.capture.records, 0);
  assert.equal(status.capture.newest, null);
  assert.deepEqual(status.scopes.map((scope) => scope.scope), ["user", "project", "local"]);
  assert.equal(status.node.current, process.execPath);
  assert.equal(status.hint, null, "nothing installed: no hint");
});

test("REAL: install into a temp CLAUDE_CONFIG_DIR, run the installed command with an InstructionsLoaded payload, read the record back", async () => {
  const { home, repo } = await makeEnv();
  const configDir = path.join(home, "claude-config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "settings.json"), JSON.stringify(EXISTING, null, 2) + "\n");
  const elsewhere = path.join(home, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: configDir };

  // Install from a different cwd: --repo is honoured (irrelevant for user scope, checked for project below).
  const installed = await cli(["hooks", "--scope", "user", "install", "--yes", "--repo", repo], { home, cwd: elsewhere, env });
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /^ContextScope hooks install · scope user · .*claude-config\/settings\.json\n(Nothing is written without --yes or your confirmation)/, "the guarantee line comes first");
  assert.match(installed.stdout, /Backup first: the current file is copied to ~\/\.contextscope\/backups\/user-settings-<timestamp>\.json/);
  assert.match(installed.stdout, /node: .* \(process\.execPath\)/, "the resolved node is printed");
  assert.match(installed.stdout, /Only sessions started after this install fire the hook/);
  const settings = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"));
  assert.deepEqual(installedEvents(settings).sort(), [...CAPTURE_EVENTS].sort());
  assert.deepEqual(settings.hooks.PostToolUse, EXISTING.hooks.PostToolUse, "other hooks untouched");
  assert.equal(installedNode(settings), process.execPath, "the command pins the installer's node");
  const backups = await readdir(backupDir(home));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^user-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/);
  assert.deepEqual(await readdir(configDir), ["settings.json"], "no backup next to the settings file");
  let userClaudeDir = null;
  try { userClaudeDir = await readdir(path.join(home, ".claude")); } catch {}
  assert.deepEqual(userClaudeDir, [], "~/.claude untouched when CLAUDE_CONFIG_DIR points elsewhere");

  // Run the installed command exactly as Claude Code would (shell + stdin) with an InstructionsLoaded payload.
  const command = settings.hooks.InstructionsLoaded.find((group) => group.hooks.some((hook) => hook.command.includes(CAPTURE_MARKER))).hooks[0].command;
  const sessionId = "0f0f0f0f-0000-4000-8000-0f0f0f0f0f0f";
  const payload = {
    session_id: sessionId, transcript_path: path.join(home, ".claude", "projects", repo.replace(/[/.]/g, "-"), `${sessionId}.jsonl`), cwd: repo,
    hook_event_name: "InstructionsLoaded", file_path: path.join(repo, "CLAUDE.md"), load_reason: "session_start", memory_type: "project",
    custom_instructions: "SECRET PROMPT TEXT", permission_mode: "default",
  };
  const ran = await runHook(command, { home, payload, env: { PATH: "/usr/bin:/bin" } });
  assert.equal(ran.code, 0, ran.stderr);
  const recordFile = path.join(home, ".contextscope", "capture", `${sessionId}.jsonl`);
  const lines = (await readFile(recordFile, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.v, 1);
  assert.equal(record.event, "InstructionsLoaded");
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.file, "CLAUDE.md");
  assert.equal(record.loadReason, "session_start");
  assert.equal(record.memoryType, "project");
  assert.match(record.transcript, /^~\/\.claude\/projects\/repo-[0-9a-f]{8}\/0f0f0f0f-0000-4000-8000-0f0f0f0f0f0f\.jsonl$/, "encoded project dir replaced by the project key");
  assert.equal((await stat(recordFile)).mode & 0o777, 0o600);
  const text = lines[0];
  assert.ok(!text.includes("SECRET") && !text.includes(home) && !text.includes("custom_instructions") && !text.includes("permission_mode"), "only whitelisted fields, no absolute path");

  // A second event for a file outside the repo but under home: basename only (no other project named).
  const other = { ...payload, hook_event_name: "InstructionsLoaded", file_path: path.join(home, "work", "other-client", "CLAUDE.md"), load_reason: "nested", memory_type: "project" };
  assert.equal((await runHook(command, { home, payload: other, env: { PATH: "/usr/bin:/bin" } })).code, 0);
  const second = JSON.parse((await readFile(recordFile, "utf8")).trim().split("\n")[1]);
  assert.equal(second.file, "CLAUDE.md");
  const user = { ...payload, file_path: path.join(home, ".claude", "CLAUDE.md"), load_reason: "session_start", memory_type: "user" };
  assert.equal((await runHook(command, { home, payload: user, env: { PATH: "/usr/bin:/bin" } })).code, 0);
  const third = JSON.parse((await readFile(recordFile, "utf8")).trim().split("\n")[2]);
  assert.equal(third.file, "~/.claude/CLAUDE.md");

  // Status sees the pinned node, the counts and the last record time.
  const status = await cli(["hooks", "status", "--json"], { home, cwd: elsewhere, env });
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  const userScope = report.scopes.find((scope) => scope.scope === "user");
  assert.deepEqual(userScope.installed.sort(), [...CAPTURE_EVENTS].sort());
  assert.equal(userScope.node, process.execPath);
  assert.deepEqual(report.node.pinned, [process.execPath]);
  assert.equal(report.node.missing, undefined);
  assert.equal(report.capture.records, 3);
  assert.equal(report.capture.byEvent.InstructionsLoaded, 3);
  assert.equal(report.capture.newest, third.at);
  assert.equal(report.hint, null);
  const human = await cli(["hooks", "status"], { home, cwd: elsewhere, env });
  assert.match(human.stdout, /node     pinned .*\n/);
  assert.match(human.stdout, /3 record\(s\), last record 20\d\d-/);
  assert.match(human.stdout, /backups  ~\/\.contextscope\/backups/);

  // --repo puts the project-scope file in that repository even when run from elsewhere.
  const project = await cli(["hooks", "install", "--scope", "project", "--yes", "--repo", repo, "--events", "compaction"], { home, cwd: elsewhere, env });
  assert.equal(project.code, 0, project.stderr);
  assert.match(project.stdout, /usually committed; teammates without/);
  assert.deepEqual(installedEvents(JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8"))), ["PreCompact", "PostCompact"]);
  assert.deepEqual(await readdir(path.join(repo, ".claude")), ["settings.json"]);

  // Uninstall restores the user file to its original content.
  const removed = await cli(["hooks", "uninstall", "--scope", "user", "--yes"], { home, cwd: elsewhere, env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8")), EXISTING);
  assert.equal((await readdir(backupDir(home))).filter((name) => name.startsWith("user-")).length, 2, "uninstall backs up too");
});

test("CLI: hooks install --dry-run prints a diff and writes nothing; without --yes and a TTY it refuses; status runs", async () => {
  const { home, repo } = await makeEnv();
  await writeFile(path.join(repo, ".claude", "settings.json"), JSON.stringify(EXISTING, null, 2) + "\n");
  const dry = await cli(["hooks", "install", "--scope", "project", "--dry-run"], { home, cwd: repo });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\+\+\+ .*settings\.json/);
  assert.match(dry.stdout, /InstructionsLoaded/);
  assert.match(dry.stdout, /dry run/);
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8")), EXISTING);
  assert.deepEqual(await readdir(path.join(repo, ".claude")), ["settings.json"], "no backup, no temp file");
  let contextscopeDir = null;
  try { contextscopeDir = await readdir(path.join(home, ".contextscope")); } catch {}
  assert.equal(contextscopeDir, null, "dry run installs no script");

  assert.match(dry.stdout, /Nothing is written without --yes/);
  assert.match(dry.stdout, /no backup taken/);

  const refused = await cli(["hooks", "install", "--scope", "project"], { home, cwd: repo });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--yes/);
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8")), EXISTING);

  const installed = await cli(["hooks", "install", "--scope", "project", "--yes", "--events", "instructions"], { home, cwd: repo });
  assert.equal(installed.code, 0, installed.stderr);
  const settings = JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(installedEvents(settings), ["InstructionsLoaded"]);
  assert.deepEqual(settings.hooks.PostToolUse, EXISTING.hooks.PostToolUse);
  assert.equal((await stat(captureScriptPath(home))).mode & 0o777, 0o700);

  const status = await cli(["hooks", "status", "--json"], { home, cwd: repo });
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.deepEqual(report.scopes.find((scope) => scope.scope === "project").installed, ["InstructionsLoaded"]);
  assert.equal(report.script.upToDate, true);

  const removed = await cli(["hooks", "uninstall", "--scope", "project", "--yes"], { home, cwd: repo });
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".claude", "settings.json"), "utf8")), EXISTING);

  const bad = await cli(["hooks", "install", "--scope", "global"], { home, cwd: repo });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--scope/);
});
