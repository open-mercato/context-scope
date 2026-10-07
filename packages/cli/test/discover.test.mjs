import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { discoverAll, discoverSessionFiles, encodedProjectDirToKey, projectKeyFor, vendorsPresent } from "../src/adapters/discover.mjs";
import { displayPath, readFirstLine } from "../src/util/fs.mjs";
import { CLAUDE_SESSIONS, CODEX_CHILD, CODEX_PARENT, makeFixtureHome } from "./helpers/index-fixture.mjs";

test("discovery lists main files only, folds subagents into the stat, and links Codex parents", async () => {
  const fixture = await makeFixtureHome();
  try {
    const files = await discoverSessionFiles({ home: fixture.home, env: {} });
    assert.equal(files.length, 5, "3 claude mains + 2 codex rollouts; tiny file skipped");
    const first = files.find((file) => file.sessionId === CLAUDE_SESSIONS[0]);
    assert.equal(first.vendor, "claude");
    assert.equal(first.subagentFiles, 1);
    assert.ok(first.subagentDir?.endsWith("subagents"));
    const mainSize = (await stat(fixture.files[CLAUDE_SESSIONS[0]])).size;
    assert.ok(first.size > mainSize, "size includes subagent files");
    assert.equal(first.cwd, fixture.repo);
    assert.equal(first.projectDisplay, "repo");
    assert.equal(first.projectKey, projectKeyFor(fixture.repo));
    const child = files.find((file) => file.sessionId === CODEX_CHILD);
    assert.equal(child.vendor, "codex");
    assert.equal(child.parentThreadId, CODEX_PARENT);
    const parent = files.find((file) => file.sessionId === CODEX_PARENT);
    assert.equal(parent.parentThreadId, undefined);
    assert.equal(parent.projectKey, first.projectKey, "same cwd -> same project key");
    for (const file of files) assert.equal(typeof file.mtimeMs, "number");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("discoverAll reports vendor presence; Gemini is detected and counted but never parsed", async () => {
  const fixture = await makeFixtureHome();
  try {
    const chats = path.join(fixture.home, ".gemini", "tmp", "proj-hash", "chats");
    await mkdir(chats, { recursive: true });
    await writeFile(path.join(chats, "session-1.json"), "{}\n");
    await writeFile(path.join(chats, "session-2.jsonl"), "{}\n");
    await writeFile(path.join(fixture.home, ".gemini", "tmp", "proj-hash", "notes.json"), "{}\n");
    const discovered = await discoverAll({ home: fixture.home, env: {} });
    assert.equal(discovered.files.length, 5, "gemini files are not session candidates");
    assert.ok(discovered.files.every((file) => file.vendor !== "gemini"));
    const gemini = discovered.vendors.find((row) => row.vendor === "gemini");
    assert.deepEqual(gemini, { vendor: "gemini", detected: true, files: 2, parsed: false });
    const claude = discovered.vendors.find((row) => row.vendor === "claude");
    assert.equal(claude.detected, true);
    assert.equal(claude.files, 3);
    assert.equal(claude.parsed, true);
    const present = await vendorsPresent({ home: fixture.home, env: {} });
    assert.deepEqual(present.map((row) => row.vendor), ["claude", "codex", "gemini"]);
    const bare = await vendorsPresent({ home: path.join(fixture.home, "nothing-here"), env: {} });
    assert.ok(bare.every((row) => row.detected === false && row.files === 0));
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("a Codex session_meta line longer than 256 KB is still read; a cwd inside a pasted payload is ignored", async () => {
  const fixture = await makeFixtureHome();
  try {
    const bigId = "019e0000-0000-7000-8000-000000000009";
    const bigFile = path.join(fixture.codexDir, `rollout-2026-09-01T12-00-00-${bigId}.jsonl`);
    const meta = { timestamp: "2026-09-01T12:00:00.000Z", type: "session_meta", payload: { id: bigId, timestamp: "2026-09-01T12:00:00.000Z", cwd: fixture.repo, originator: "codex-tui", cli_version: "0.150.1", source: "cli", base_instructions: { text: "y".repeat(300 * 1024) } } };
    await writeFile(bigFile, `${JSON.stringify(meta)}\n{"type":"event_msg","payload":{"type":"token_count","info":null}}\n`);
    const { line, complete } = await readFirstLine(bigFile);
    assert.equal(complete, true);
    assert.ok(line.length > 256 * 1024);
    const files = await discoverSessionFiles({ home: fixture.home, env: {} });
    const big = files.find((file) => file.sessionId === bigId);
    assert.ok(big, "the rollout is discovered");
    assert.equal(big.cwd, fixture.repo, "cwd comes from the long first line");
    assert.equal(big.projectKey, projectKeyFor(fixture.repo));

    const pastedId = "55555555-5555-4555-8555-555555555555";
    const pasted = path.join(fixture.projectDir, `${pastedId}.jsonl`);
    const broken = `{"type":"user","uuid":"u0","sessionId":"${pastedId}","message":{"role":"user","content":"{\\"cwd\\":\\"/Users/nobody/secret\\"}` + "z".repeat(400);
    await writeFile(pasted, `${broken}\n`);
    const again = await discoverSessionFiles({ home: fixture.home, env: {} });
    const entry = again.find((file) => file.sessionId === pastedId);
    assert.ok(entry);
    assert.equal(entry.cwd, null, "a cwd that only appears inside an unparseable line is not trusted");
    assert.equal(entry.projectKey, encodedProjectDirToKey(path.basename(fixture.projectDir)));
    assert.ok(!entry.projectKey.includes("Users"));
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("displayPath is POSIX and never leaks a path outside home", () => {
  const home = path.join(path.sep, "tmp", "home-x");
  assert.equal(displayPath(path.join(home, ".claude", "projects", "p", "s.jsonl"), home), "~/.claude/projects/p/s.jsonl");
  assert.equal(displayPath(home, home), "~");
  assert.equal(displayPath(path.join(path.sep, "opt", "elsewhere", "file.jsonl"), home), "file.jsonl");
});
