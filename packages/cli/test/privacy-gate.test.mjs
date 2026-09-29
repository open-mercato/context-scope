/**
 * Release gate (review #26): the REAL adapters and rules run through the index
 * on the synthetic fixtures, and nothing that reaches disk or the API carries
 * content keys, the lorem sentinel, the fixture home, or an absolute path
 * segment (`/Users/`, `/home/`, encoded `-Users-` / `-home-`). Every run is
 * also exported plain (`--scopes all`) and redacted (`--scopes main` and
 * `all`): the redacted documents, real rules and subagent findings included,
 * carry no path-like token anywhere.
 *
 * The manifest is the one place where absolute paths are allowed by contract
 * (its keys and `cwd`); those two are stripped before the check.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createIndex } from "../src/index/index.mjs";
import { indexRoot } from "../src/index/manifest.mjs";
import { createServer } from "../src/server/app.mjs";
import { buildExport, validateExport } from "../src/export/schema.mjs";
import { collectUserNames, findPathLikeTokens } from "../src/export/redact.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES = path.join(HERE, "fixtures", "claude");
const CODEX_FIXTURES = path.join(HERE, "fixtures", "codex");
const CLAUDE_IDS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
const CODEX_FILES = [
  ["plain-cli.jsonl", "01a00000-0000-7000-8000-000000000001"],
  ["compacted-desktop.jsonl", "01a00000-0000-7000-8000-000000000002"],
  ["thread-spawn-child.jsonl", "01a00000-0000-7000-8000-000000000003"],
];
const FORBIDDEN_KEYS = ["content", "text", "stdout", "stderr", "prompt"];
const FORBIDDEN_STRINGS = ["/Users/", "/home/", "-Users-", "-home-", "LOREMSENTINEL"];
const TOKEN = "p".repeat(64);
const quiet = () => {};

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function ensureFixtures() {
  if (!(await exists(path.join(CLAUDE_FIXTURES, `${CLAUDE_IDS[0]}.jsonl`)))) await run(process.execPath, [path.join(CLAUDE_FIXTURES, "make-fixtures.mjs")]);
  if (!(await exists(path.join(CODEX_FIXTURES, "plain-cli.jsonl")))) await run(process.execPath, [path.join(CODEX_FIXTURES, "make-fixtures.mjs")]);
}

async function makeRealHome() {
  await ensureFixtures();
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-gate-"));
  const projectDir = path.join(home, ".claude", "projects", "-Users-fixture-projects-lorem");
  await mkdir(projectDir, { recursive: true });
  for (const id of CLAUDE_IDS) {
    await cp(path.join(CLAUDE_FIXTURES, `${id}.jsonl`), path.join(projectDir, `${id}.jsonl`));
    if (await exists(path.join(CLAUDE_FIXTURES, id))) await cp(path.join(CLAUDE_FIXTURES, id), path.join(projectDir, id), { recursive: true });
  }
  const codexDir = path.join(home, ".codex", "sessions", "2026", "09", "01");
  await mkdir(codexDir, { recursive: true });
  for (const [name, id] of CODEX_FILES) await cp(path.join(CODEX_FIXTURES, name), path.join(codexDir, `rollout-2026-09-01T10-00-00-${id}.jsonl`));
  return { home, projectDir, codexDir };
}

function keysIn(value, found = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 64) return found;
  if (Array.isArray(value)) { for (const item of value) keysIn(item, found, depth + 1); return found; }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) found.add(key);
    keysIn(nested, found, depth + 1);
  }
  return found;
}

function assertClean(value, label, { home }) {
  assert.deepEqual([...keysIn(value)], [], `${label}: forbidden keys`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of [...FORBIDDEN_STRINGS, home]) assert.ok(!text.includes(needle), `${label}: contains ${JSON.stringify(needle)}`);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

test("privacy gate: real adapters through the index and the API leak neither content nor absolute paths", async () => {
  const fixture = await makeRealHome();
  const { home } = fixture;
  try {
    const index = createIndex({ home, env: {}, useWorkers: false, warn: quiet });
    const events = [];
    const result = await index.ensure({ onProgress: (event) => events.push(event) });
    assert.equal(result.failed, 0, `real adapters failed on a fixture: ${JSON.stringify(Object.values((await index.manifest()).files).filter((entry) => entry.error).map((entry) => entry.error))}`);
    assert.equal(result.parsed, 6, "3 claude sessions + 3 codex rollouts");
    for (const event of events) assertClean(event, `event ${event.type}`, { home });

    const root = indexRoot(home);
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const manifestView = { ...manifest, files: Object.values(manifest.files).map(({ cwd, ...entry }) => entry) };
    assertClean(manifestView, "manifest", { home });
    for (const entry of Object.values(manifest.files)) {
      assert.ok(entry.project.key && !entry.project.key.startsWith("-"), `project key ${entry.project.key} is not an encoded path`);
      assert.ok(entry.file.startsWith("~/"), `entry.file ${entry.file} is ~-relative`);
    }
    const runFiles = await walk(path.join(root, "runs"));
    assert.ok(runFiles.length >= 6 * 3, "shell + findings + at least one scope per run");
    for (const file of runFiles) assertClean(JSON.parse(await readFile(file, "utf8")), path.relative(root, file), { home });

    const app = createServer({ home, repoRoot: path.join(home, "work", "orchard"), token: TOKEN, consent: false, autoIndex: false, env: {}, warn: quiet, now: () => Date.parse("2026-09-03T12:00:00.000Z") }); // fixture sessions are dated 2026-09-01
    const { port } = await app.listen(0);
    const get = async (route) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 200, route);
      return response.json();
    };
    try {
      const overview = await get("/api/v1/overview?scope=all");
      assertClean(overview, "overview", { home });
      assertClean(await get("/api/v1/habits"), "habits", { home });
      assert.equal(overview.totals.runs + overview.totals.subagents > 0, true);
      const runIds = overview.runs.flatMap((row) => [row.id, ...(row.children ?? []).map((child) => child.id)]);
      assert.equal(runIds.length, 6);
      for (const runId of runIds) {
        const [vendor, id] = runId.split(":");
        const payload = await get(`/api/v1/runs/${vendor}/${id}`);
        assertClean(payload, `run ${runId}`, { home });
        assert.ok(Array.isArray(payload.scopes[0].blocks));
        for (const scope of payload.scopes.slice(1)) {
          assert.equal(scope.partial, true);
          assertClean(await get(`/api/v1/runs/${vendor}/${id}/scopes/${encodeURIComponent(scope.id)}`), `scope ${runId}/${scope.id}`, { home });
        }
      }
      assertClean(await get("/api/v1/findings"), "findings", { home });
      assertClean(await get("/api/v1/setup"), "setup", { home });

      // Exports: plain documents pass the absolute-path gate, redacted ones the path-like-token gate.
      let withSubagents = 0;
      let redactedFindings = 0;
      let namesRedacted = 0;
      let builtinKept = 0;
      for (const runId of runIds) {
        const plain = await buildExport({ index, runId, scopes: "all" });
        assertClean(plain, `export ${runId} plain`, { home });
        assert.deepEqual(validateExport(plain), { valid: true, errors: [] });
        if (plain.run.scopes.length > 1) withSubagents += 1;
        for (const scopes of ["main", "all"]) {
          const redacted = await buildExport({ index, runId, scopes, redact: true });
          assertClean(redacted, `export ${runId} redacted ${scopes}`, { home });
          assert.deepEqual(validateExport(redacted), { valid: true, errors: [] });
          assert.deepEqual(findPathLikeTokens(redacted), [], `export ${runId} redacted ${scopes}: path-like token survived`);
          // The project name is hashed; so are MCP server / tool names, custom agent types, skill names and hook
          // matchers (ADR-005 section 7). Built-in tool names and vendor agent types stay readable.
          const text = JSON.stringify(redacted);
          assert.ok(!text.includes(JSON.stringify(plain.run.project.displayName)), `${runId}: the fixture repo name leaked`);
          assert.notEqual(redacted.run.project.displayName, plain.run.project.displayName);
          const userNames = collectUserNames(plain);
          for (const name of userNames) assert.ok(!text.includes(name), `${runId} redacted ${scopes}: user-authored name ${JSON.stringify(name)} survived`);
          assert.deepEqual([...collectUserNames(redacted)], [], `${runId} redacted ${scopes}: a user-authored name survived`);
          for (const needle of ["lorem-server", "lorem_tool", "other_tool", "lorem-skill"]) assert.ok(!text.includes(needle), `${runId} redacted ${scopes}: ${needle} survived`);
          if (userNames.size) namesRedacted += userNames.size;
          redactedFindings += redacted.run.findings.length;
        }
      }
      assert.ok(withSubagents >= 1, "at least one fixture run has subagent scopes");
      assert.ok(redactedFindings > 0, "the real rules produced findings whose prose went through redaction");
      assert.ok(namesRedacted > 0, "the fixtures carry MCP tool names / skill names that went through the names policy");
      for (const runId of runIds) {
        const redacted = await buildExport({ index, runId, scopes: "all", redact: true });
        for (const scope of Object.values(redacted.scopes)) for (const block of scope.blocks ?? []) if (block.tool?.name && (block.tool.name === "Read" || block.tool.name === "Bash" || block.tool.name === "exec" || block.tool.name === "Agent")) builtinKept += 1;
        for (const scope of redacted.run.scopes) if (scope.agentType === "Explore" || scope.agentType === "general-purpose") builtinKept += 1;
        assert.ok(redacted.run.summary.models.every((model) => !/^h:/.test(model)), `${runId}: model ids stay readable`);
      }
      assert.ok(builtinKept > 0, "built-in tool names and vendor agent types stay readable");
    } finally {
      await app.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
