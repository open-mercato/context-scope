/**
 * Privacy-safe export (ADR-003 section 5): schema validation, redaction,
 * markdown content, the HTTP route, the CLI command, the privacy gate
 * (no forbidden keys, no absolute paths) and the size bound on the largest
 * real run when this machine has it indexed.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { createIndex } from "../src/index/index.mjs";
import { createServer } from "../src/server/app.mjs";
import { parseArgs } from "../src/commands/args.mjs";
import { run as exportCommand } from "../src/commands/export.mjs";
import { buildExport, EXPORT_SCHEMA, MAX_EXPORT_BYTES, findAbsolutePaths, forbiddenKeysIn, parseScopeSelection, validateExport } from "../src/export/schema.mjs";
import { BUILTIN_AGENT_TYPES, BUILTIN_TOOLS, collectUserNames, findPathLikeTokens, hashLabel, isPathLike, isPathLikeToken, redactExport, redactName, scrubTokens } from "../src/export/redact.mjs";
import { renderMarkdown } from "../src/export/markdown.mjs";
import { CLAUDE_SESSIONS, fakeAdapters, fakeRules, fakeSetup, makeFixtureHome } from "./helpers/index-fixture.mjs";

const quiet = () => {};
const TOKEN = "e".repeat(64);
const RUN_ID = `claude:${CLAUDE_SESSIONS[0]}`;
const LARGEST_REAL_RUN = "claude:5ca0d315-1bf9-4c05-82b5-31ceb7aa5806";
const REAL_RUNS = ["claude:cc87cfe5-e572-43f6-abff-54e5796be5f3", LARGEST_REAL_RUN];
const THREE_MB = 3 * 1024 * 1024;

async function indexedFixture() {
  const fixture = await makeFixtureHome();
  const index = createIndex({ home: fixture.home, env: {}, adapters: fakeAdapters(), rules: fakeRules(), warn: quiet });
  await index.ensure();
  return { fixture, index };
}

/** Every label a reader could learn a path or command from, collected from an unredacted document. */
function plainLabels(doc) {
  const labels = new Set();
  const scopes = [...doc.run.scopes, ...Object.values(doc.scopes)];
  for (const scope of scopes) {
    for (const block of scope.blocks ?? []) { if (block.label) labels.add(block.label); if (block.tool?.target) labels.add(block.tool.target); }
    for (const top of scope.topBlocks ?? []) if (top.label) labels.add(top.label);
  }
  for (const finding of doc.run.findings) for (const evidence of finding.evidence ?? []) if (["file", "block"].includes(evidence.kind)) labels.add(evidence.label);
  labels.add(doc.run.project.displayName);
  labels.add(doc.run.source.file);
  return [...labels].filter(isPathLike);
}

test("export: parseScopeSelection", () => {
  assert.deepEqual(parseScopeSelection(undefined), { mode: "main", ids: [] });
  assert.deepEqual(parseScopeSelection("all"), { mode: "all", ids: [] });
  assert.deepEqual(parseScopeSelection("a1, a2"), { mode: "list", ids: ["a1", "a2"] });
});

test("export: buildExport produces a valid contextscope.export/1 document", async () => {
  const { fixture, index } = await indexedFixture();
  try {
    const doc = await buildExport({ index, runId: RUN_ID, thresholds: { fatToolResultTokens: 8000 }, version: "test", now: new Date("2026-09-02T00:00:00Z") });
    assert.equal(doc.schema, EXPORT_SCHEMA);
    assert.deepEqual(doc.generator, { name: "contextscope", version: "test" });
    assert.deepEqual(doc.redaction, { labels: "plain", project: "basename" });
    assert.equal(doc.exportedAt, "2026-09-02T00:00:00.000Z");
    assert.deepEqual(validateExport(doc), { valid: true, errors: [] });
    // Shell scopes are summaries; the main scope is full under `scopes`.
    assert.equal(doc.run.scopes[0].partial, true);
    assert.equal(doc.run.scopes[0].requests, undefined);
    assert.deepEqual(Object.keys(doc.scopes), ["main"]);
    assert.ok(Array.isArray(doc.scopes.main.requests) && doc.scopes.main.requests.length === 3);
    assert.ok(Array.isArray(doc.scopes.main.blocks));
    assert.ok(doc.run.findings.some((finding) => finding.ruleId === "B-01"), "findings travel with the run");
    assert.deepEqual(doc.thresholds, { fatToolResultTokens: 8000 });
    assert.equal(typeof doc.markdown, "string");

    const all = await buildExport({ index, runId: RUN_ID, scopes: "all" });
    assert.deepEqual(Object.keys(all.scopes).sort(), ["a1", "main"]);
    const listed = await buildExport({ index, runId: RUN_ID, scopes: "a1" });
    assert.deepEqual(Object.keys(listed.scopes).sort(), ["a1", "main"], "main is always present");

    await assert.rejects(buildExport({ index, runId: "claude:nope" }), (error) => error.status === 404);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: redaction leaves no label, path or project name in the document", async () => {
  const { fixture, index } = await indexedFixture();
  try {
    const plain = await buildExport({ index, runId: RUN_ID, scopes: "all" });
    const labels = plainLabels(plain);
    assert.ok(labels.includes("src/index.mjs"), "the fixture carries a repo-relative file label");
    assert.ok(labels.length >= 2);

    const redacted = await buildExport({ index, runId: RUN_ID, scopes: "all", redact: true });
    const { salt } = redacted.redaction;
    assert.match(salt, /^[0-9a-f]{32}$/, "a per-export random salt travels with the document");
    assert.deepEqual(redacted.redaction, { labels: "sha1-10", project: "hashed", names: "vendor-only", salt });
    assert.deepEqual(validateExport(redacted), { valid: true, errors: [] });
    const text = JSON.stringify(redacted);
    for (const label of labels) assert.ok(!text.includes(label), `redacted export still contains ${JSON.stringify(label)}`);
    assert.equal(redacted.run.project.displayName, hashLabel(plain.run.project.displayName, salt));
    assert.match(redacted.run.project.displayName, /^h:[0-9a-f]{10}$/);
    assert.ok(!text.includes(JSON.stringify(plain.run.project.displayName)), "project display name is hashed");
    // Ids, hashes and numbers are untouched.
    assert.equal(redacted.run.id, plain.run.id);
    assert.equal(redacted.scopes.main.blocks[1].hash, plain.scopes.main.blocks[1].hash);
    assert.equal(redacted.scopes.main.blocks[1].estTokens, plain.scopes.main.blocks[1].estTokens);
    assert.equal(redacted.scopes.main.blocks[1].label, hashLabel("src/index.mjs", salt));
    assert.equal(redacted.run.findings[0].evidence[0].label, hashLabel(plain.run.findings[0].evidence[0].label, salt));
    assert.ok(!redacted.markdown.includes("src/index.mjs"), "markdown is rendered after redaction");
    assert.deepEqual(findPathLikeTokens(redacted), [], "no path-like token anywhere, markdown included");
    // A second export of the same run hashes differently (salted), the same salt hashes the same.
    const again = await buildExport({ index, runId: RUN_ID, scopes: "all", redact: true });
    assert.notEqual(again.redaction.salt, salt);
    assert.notEqual(again.scopes.main.blocks[1].label, redacted.scopes.main.blocks[1].label, "unsalted hashes would be dictionary-reversible");
    const same = await buildExport({ index, runId: RUN_ID, scopes: "all", redact: true, salt });
    assert.equal(same.scopes.main.blocks[1].label, redacted.scopes.main.blocks[1].label);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: redactExport rewrites prose that embeds a label", () => {
  const doc = {
    run: {
      project: { key: "repo-abc12345", displayName: "repo", cwdHash: "abc12345" },
      source: { file: "~/.claude/projects/repo-abc12345/s.jsonl" },
      scopes: [{ id: "main", kind: "main", blocks: [{ id: "main:0", label: "package-lock.json", tool: { name: "Read", target: "package-lock.json" } }], topBlocks: [{ id: "main:0", label: "package-lock.json" }] }],
      findings: [{ id: "x", ruleId: "B-03", title: "Huge file read", whyItMatters: "One Read of package-lock.json took 12% of the window.", evidence: [{ kind: "block", ref: "claude:s#main:0", label: "Read package-lock.json" }, { kind: "metric", ref: "count", label: "requests matching" }], fix: { platform: "claude", summary: "Skip package-lock.json", snippet: "sed -n 1,80p package-lock.json", path: "CLAUDE.md" } }],
    },
    scopes: {},
  };
  const seen = redactExport(doc, { salt: "ab".repeat(16) });
  assert.ok(seen.has("package-lock.json"));
  const text = JSON.stringify(doc);
  assert.ok(!text.includes("package-lock.json"));
  assert.ok(!text.includes("repo-abc12345"));
  assert.equal(doc.run.findings[0].evidence[1].label, "requests matching", "metric labels stay readable");
  assert.equal(doc.run.findings[0].fix.path, "CLAUDE.md", "instruction-file names are vocabulary, never hashed");
  assert.equal(doc.run.findings[0].fix.summary, `Skip ${hashLabel("package-lock.json", "ab".repeat(16))}`);
  assert.equal(doc.run.project.cwdHash, "abc12345");
  assert.deepEqual(findPathLikeTokens(doc), []);
});

test("export: markdown carries the facts, composition, compactions, subagents and findings with fixes", async () => {
  const { fixture, index } = await indexedFixture();
  try {
    const doc = await buildExport({ index, runId: `claude:${CLAUDE_SESSIONS[1]}`, scopes: "all" });
    const md = doc.markdown;
    assert.match(md, /^# ContextScope session export/m);
    assert.match(md, /\*\*Session\*\* `claude:2222/);
    assert.match(md, /\*\*Peak\*\* [\d.,]+k tokens \(observed \(vendor\)\) = \d+% of a 200k-token window \(estimated\)/);
    assert.match(md, /## Where the context went/);
    assert.match(md, /\| tool_result\.file \|/);
    assert.match(md, /## Compactions/);
    assert.match(md, /\| 2 \| auto \| 60\.0k \(observed \(vendor\)\)/, "compaction row with provenance");
    assert.match(md, /## Subagents/);
    assert.match(md, /\| Explore \| a1 \|/);
    assert.match(md, /## Findings/);
    assert.match(md, /### B-01 Fat tool result · high/);
    assert.match(md, /\*\*Fix \(both\):\*\* read less/);
    assert.match(md, /no transcript text/);
    assert.doesNotMatch(md, /score|grade/i, "no score, no grade");
    // The "not in transcript" line appears only above the 5% unlogged share.
    const quietDoc = renderMarkdown({ ...doc, scopes: { main: { ...doc.scopes.main, unloggedShare: 0.01 } } });
    assert.doesNotMatch(quietDoc, /Not in transcript/);
    const loud = renderMarkdown({ ...doc, scopes: { main: { ...doc.scopes.main, unloggedShare: 0.3, processedInputTokens: 1_000_000 } } });
    assert.match(loud, /\*\*Not in transcript\*\* 300k tokens \(30% of processed input\)/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: validateExport rejects malformed documents", async () => {
  const { fixture, index } = await indexedFixture();
  try {
    const doc = await buildExport({ index, runId: RUN_ID });
    const broken = (mutate) => { const copy = JSON.parse(JSON.stringify(doc)); mutate(copy); return validateExport(copy); };
    assert.equal(validateExport(null).valid, false);
    assert.equal(validateExport([]).valid, false);
    assert.match(broken((d) => { d.schema = "contextscope.export/2"; }).errors[0], /schema must be/);
    assert.match(broken((d) => { delete d.scopes.main; }).errors[0], /must contain the main scope/);
    assert.match(broken((d) => { d.redaction.labels = "rot13"; }).errors[0], /redaction\.labels/);
    assert.match(broken((d) => { d.run.vendor = "other"; }).errors[0], /vendor/);
    assert.match(broken((d) => { d.scopes.main.blocks[0].content = "hello"; }).errors[0], /forbidden keys present: content/);
    assert.match(broken((d) => { d.scopes.main.blocks[0].label = "/Users/someone/repo/file.ts"; }).errors[0], /absolute path at scopes\.main\.blocks\[0\]\.label/);
    assert.match(broken((d) => { d.thresholds.fatToolResultTokens = "8000"; }).errors[0], /thresholds\.fatToolResultTokens/);
    assert.match(broken((d) => { d.run.findings[0].whyItMatters = "Bash: cat /Users/me/secret/keys.txt was fat"; }).errors[0], /absolute path at run\.findings\[0\]\.whyItMatters/, "substring, not line-anchored");
    assert.match(broken((d) => { d.run.findings[0].fix.snippet = "read ~/projects/other-client/CLAUDE.md whole"; }).errors[0], /absolute path at run\.findings\[0\]\.fix\.snippet/, "~/ outside the vendor config dirs is a leak");
    assert.equal(broken((d) => { d.run.project.cwdDisplay = "~/work/repo"; }).valid, true, "cwdDisplay is a ~-relative display field by contract");
    assert.equal(broken((d) => { d.run.findings[0].fix.snippet = "grep hooks ~/.claude/settings.json"; }).valid, true, "vendor config paths under ~ are allowed");
    assert.equal(broken((d) => { d.run.findings[0].fix.snippet = "see https://example.com/docs/x"; }).valid, true, "a URL is not an absolute path");
    assert.match(broken((d) => { d.redaction = { labels: "sha1-10", project: "hashed" }; }).errors[0], /redaction\.salt/, "hashed labels need their salt");
    assert.equal(broken((d) => { d.redaction = { labels: "sha1-10", project: "hashed", salt: "ab".repeat(16) }; d.run.findings[0].whyItMatters = "One Read of src/modules/plans/x.ts"; }).errors.some((error) => /path-like token at run\./.test(error)), true);
    assert.equal(broken((d) => { d.run.findings[0].fix.snippet = "/compact focus on the migration"; }).valid, true, "slash commands are not paths");
    assert.equal(broken((d) => { d.run.findings[0].fix.path = "~/.claude/CLAUDE.md"; }).valid, true, "home-relative paths are allowed");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: privacy gate: forbidden keys are scrubbed and absolute paths refuse the export", async () => {
  const fixture = await makeFixtureHome();
  try {
    const leaky = fakeAdapters();
    const base = leaky.claude.parse;
    leaky.claude.parse = async (file, opts) => {
      const run = await base(file, opts);
      // The index scrubs forbidden keys on write; the exporter scrubs again and asserts no absolute path.
      run.scopes[0].blocks[0].label = "prompt 1";
      return run;
    };
    const index = createIndex({ home: fixture.home, env: {}, adapters: leaky, rules: fakeRules(), warn: quiet });
    await index.ensure();
    const doc = await buildExport({ index, runId: RUN_ID, scopes: "all" });
    assert.deepEqual(forbiddenKeysIn(doc), []);
    assert.deepEqual(findAbsolutePaths(doc), []);
    assert.ok(!JSON.stringify(doc).includes(fixture.home), "the fixture home never appears");
    assert.deepEqual(findAbsolutePaths({ a: "Bash: cat /Users/me/secret/keys.txt", c: "read /Volumes/client/acme/plan.md whole", d: "C:\\Users\\me", e: "key -Users-me-repo-abc", f: "~/projects/other/CLAUDE.md", ok: ["~/.codex/config.toml", "/compact focus", "src/x.ts", "see https://h/a/b"] }).map((leak) => leak.path), ["a", "c", "d", "e", "f"], "substring match over every string");
    // A payload with an absolute path is refused, whatever the scope.
    const poisoned = {
      readRunShell: async () => ({ ...JSON.parse(JSON.stringify(doc.run)), findings: undefined, gitBranch: "C:\\Users\\me\\repo" }),
      readFindings: async () => [],
      readScope: async (_, id) => doc.scopes[id] ?? null,
    };
    await assert.rejects(buildExport({ index: poisoned, runId: RUN_ID }), /absolute path in run\.gitBranch/);
    const scrubbed = {
      readRunShell: async () => JSON.parse(JSON.stringify(doc.run)),
      readFindings: async () => [{ id: "f", ruleId: "B-01", severity: "low", scope: "session", title: "t", whyItMatters: "w", evidence: [{ kind: "metric", ref: "x", label: "x", provenance: "derived.exact", text: "leak" }], fix: { platform: "both", summary: "s" }, thresholdKeys: [] }],
      readScope: async (_, id) => doc.scopes[id] ?? null,
    };
    const cleaned = await buildExport({ index: scrubbed, runId: RUN_ID });
    assert.deepEqual(forbiddenKeysIn(cleaned), []);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: GET /api/v1/runs/:vendor/:id/export serves the same document as an attachment", async () => {
  const fixture = await makeFixtureHome();
  const app = createServer({ home: fixture.home, repoRoot: fixture.repo, token: TOKEN, adapters: fakeAdapters(), rules: fakeRules(), setup: fakeSetup(), consent: false, env: {}, warn: quiet });
  try {
    const { port } = await app.listen(0);
    await app.index.ensure();
    const headers = { authorization: `Bearer ${TOKEN}` };
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}/export?redact=1&scopes=all`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="contextscope-claude-11111111-redacted\.json"$/);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    const doc = await response.json();
    assert.deepEqual(validateExport(doc), { valid: true, errors: [] });
    assert.equal(doc.redaction.labels, "sha1-10");
    assert.match(doc.redaction.salt, /^[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(doc.scopes).sort(), ["a1", "main"]);
    assert.ok(doc.run.findings.every((finding) => typeof finding.recurrence === "number"), "findings carry recurrence like the run route");
    const missing = await fetch(`http://127.0.0.1:${port}/api/v1/runs/claude/nope/export`, { headers });
    assert.equal(missing.status, 404);
    const gated = await fetch(`http://127.0.0.1:${port}/api/v1/runs/claude/${CLAUDE_SESSIONS[0]}/export`);
    assert.notEqual(gated.status, 200, "the route needs the launch token");
  } finally {
    await app.close();
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: the CLI command writes <out>.json and, with --md, <out>.md", async () => {
  const { fixture, index } = await indexedFixture();
  const out = path.join(fixture.home, "exports", "session.json");
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const args = parseArgs(["export", "--run", CLAUDE_SESSIONS[0], "--out", out, "--md", "--scopes", "all", "--redact-labels"]);
    await exportCommand(args, { home: fixture.home, cwd: fixture.repo, commands: {}, adapters: fakeAdapters(), rules: fakeRules() });
    const doc = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual(validateExport(doc), { valid: true, errors: [] });
    assert.equal(doc.run.id, RUN_ID);
    assert.equal(doc.redaction.labels, "sha1-10");
    assert.equal(doc.generator.name, "contextscope");
    const md = await readFile(path.join(fixture.home, "exports", "session.md"), "utf8");
    assert.equal(md, doc.markdown);
    assert.ok(errors.some((line) => line.includes("Wrote ") && line.includes("session.json")));
    assert.ok(index, "fixture index stays readable");
  } finally {
    console.error = originalError;
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: the two real runs with subagents redact to zero path-like tokens and stay under 3 MB (skipped when not indexed here)", async (t) => {
  const index = createIndex({ home: os.homedir(), env: {}, warn: quiet });
  for (const runId of REAL_RUNS) {
    let shell = null;
    try { shell = await index.readRunShell(runId); } catch { shell = null; }
    if (!shell) { t.skip(`${runId} is not in ~/.contextscope on this machine`); return; }
    assert.ok((shell.scopes?.length ?? 0) > 1, `${runId} has subagent scopes`);
    const doc = await buildExport({ index, runId, scopes: "main", redact: true });
    const text = JSON.stringify(doc);
    const bytes = Buffer.byteLength(text);
    assert.ok(bytes < THREE_MB, `redacted export of ${runId} is ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
    assert.deepEqual(validateExport(doc), { valid: true, errors: [] });
    assert.deepEqual(findPathLikeTokens(doc), [], `${runId}: a path survived --redact-labels`);
    assert.ok(!text.includes(os.homedir()));
    assert.ok(!text.includes("/Users/") && !text.includes("-Users-"));
    assert.ok(doc.run.findings.length > 0, "the run has findings whose prose was scrubbed");
    assert.match(doc.markdown, /\*\*Exported\*\* the main scope \([\d,]+ of [\d,]+ requests\); [\d,]+ subagent scopes summarised only/);
  }
});

test("export: isPathLikeToken and scrubTokens", () => {
  for (const token of ["src/index.mjs", "package-lock.json", "~/projects/acme/plan.md", "/Users/me/x", "/private/tmp/y.txt", "packages/cli", "keys.txt", "-Users-me-repo", "src/modules/treatment_plans/x.ts", "~/.claude/projects/repo-abc/s.jsonl"]) assert.equal(isPathLikeToken(token), true, token);
  for (const token of ["CLAUDE.md", "AGENTS.md", "~/.claude/CLAUDE.md", ".claude/rules/<topic>.md", ".claude/agents/reviewer.md", "~/.claude/settings.json", ".codex/config.toml", ".mcp.json", "contextscope.export/1", "/compact", "head/tail", "offset/limit", "3/4", "1.5", "e.g.", "tool_result.file", "observed.vendor", "h:2d5d10cfc5", "claude-3.5-sonnet", "mcp__github__list_prs", "src/api/**"]) assert.equal(isPathLikeToken(token), false, token);
  const salt = "cd".repeat(16);
  assert.equal(scrubTokens("One Read of src/modules/plans.ts took 12% (see CLAUDE.md).", salt), `One Read of ${hashLabel("src/modules/plans.ts", salt)} took 12% (see CLAUDE.md).`);
  assert.equal(scrubTokens("/compact focus on the migration", salt), "/compact focus on the migration");
});

test("export: --scopes main still redacts a child-scope path quoted in a finding (labels come from every scope)", async () => {
  const { fixture, index } = await indexedFixture();
  try {
    const shell = await index.readRunShell(RUN_ID);
    const findings = await index.readFindings(RUN_ID);
    const leakyIndex = {
      readRunShell: async () => shell,
      readFindings: async () => [...findings, {
        id: "B-15:x", ruleId: "B-15", severity: "medium", scope: "subagent", scopeId: "a1", title: "Subagent read src/modules/treatment_plans/plan.ts whole",
        whyItMatters: "The child read src/modules/treatment_plans/plan.ts and services/billing.py; see ~/projects/acme/notes.md.",
        evidence: [{ kind: "metric", ref: "reads", label: "Read src/modules/treatment_plans/plan.ts whole", value: 3, unit: "count", provenance: "estimated.local" }, { kind: "scope", ref: "a1", label: "Explore a1", provenance: "derived.exact" }],
        fix: { platform: "claude", summary: "Tell Explore to read src/modules/treatment_plans/plan.ts in ranges", snippet: "sed -n 1,80p src/modules/treatment_plans/plan.ts", path: ".claude/agents/Explore.md" }, thresholdKeys: [], tokensAffected: 100,
      }],
      readScope: async (_, id) => {
        const scope = await index.readScope(RUN_ID, id);
        if (id === "a1" && scope) scope.blocks.push({ id: "a1:9", seq: 9, at: "2026-09-01T10:00:00Z", category: "tool_result.file", bytes: 40, estTokens: 10, firstRequest: 1, hash: "h9", tool: { name: "Read", kind: "file", argsHash: "z", target: "src/modules/treatment_plans/plan.ts" }, label: "src/modules/treatment_plans/plan.ts" });
        return scope;
      },
    };
    await assert.rejects(buildExport({ index: leakyIndex, runId: RUN_ID, scopes: "main" }), /absolute path in run\.findings\[\d+\]\.whyItMatters/, "plain mode refuses ~/projects/…");
    const cleaned = { ...leakyIndex, readFindings: async () => (await leakyIndex.readFindings()).map((f) => ({ ...f, whyItMatters: f.whyItMatters.replace("; see ~/projects/acme/notes.md", "") })) };
    const doc = await buildExport({ index: cleaned, runId: RUN_ID, scopes: "main", redact: true });
    assert.deepEqual(Object.keys(doc.scopes), ["main"]);
    const text = JSON.stringify(doc);
    for (const leak of ["treatment_plans", "plan.ts", "billing.py", "src/modules"]) assert.ok(!text.includes(leak), `${leak} survived`);
    const finding = doc.run.findings.find((f) => f.ruleId === "B-15");
    const hashed = hashLabel("src/modules/treatment_plans/plan.ts", doc.redaction.salt);
    assert.equal(finding.fix.snippet, `sed -n 1,80p ${hashed}`, "the same path hashes the same everywhere in the document");
    assert.ok(finding.whyItMatters.includes(hashed));
    assert.equal(finding.fix.path, ".claude/agents/Explore.md", "agent definition paths are vocabulary");
    assert.equal(finding.evidence[1].label, hashLabel("Explore a1", doc.redaction.salt));
    assert.deepEqual(findPathLikeTokens(doc), []);
    assert.deepEqual(validateExport(doc), { valid: true, errors: [] });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: the exporter refuses a document above the importer cap and points at --scopes main", async () => {
  const { fixture, index } = await indexedFixture();
  try {
    const small = await buildExport({ index, runId: RUN_ID, scopes: "all" });
    const bytes = Buffer.byteLength(JSON.stringify(small));
    await assert.rejects(buildExport({ index, runId: RUN_ID, scopes: "all", maxBytes: bytes - 1 }), (error) => error.status === 413 && /exceeds the .* importer cap; export fewer scopes \(--scopes main\)/.test(error.message));
    await assert.rejects(buildExport({ index, runId: RUN_ID, scopes: "main", maxBytes: 10 }), (error) => error.status === 413 && !/--scopes main/.test(error.message), "no hint when only main is exported");
    assert.ok(bytes < MAX_EXPORT_BYTES);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("export: names policy (--redact-labels): MCP, custom agents, skills and hook matchers hash; vendor vocabulary stays", () => {
  const salt = "ef".repeat(16);
  const doc = {
    run: {
      id: "claude:s", vendor: "claude", project: { key: "repo-abc12345", displayName: "repo", cwdHash: "abc12345" }, source: { file: "~/.claude/projects/repo-abc12345/s.jsonl" },
      mcpToolsObserved: ["mcp__acme-internal__list_customers", "mcp__acme-internal__get_invoice"],
      instructionFilesObserved: ["CLAUDE.md", ".claude/rules/api.md", "packages/billing/CLAUDE.md"],
      summary: {
        models: ["claude-opus-4-1-20250805"], topBlocks: [{ id: "main:2", label: "acme-internal", tool: "mcp__acme-internal__list_customers" }],
        toolCost: [{ name: "Bash", kind: "shell", blocks: 3, tokenRequests: 900, uncached: 200, share: 0.4 }, { name: "mcp__acme-internal__list_customers", kind: "mcp", server: "acme-internal", blocks: 1, tokenRequests: 300, uncached: 40, share: 0.1 }, { name: "Agent handoffs", kind: "agent", blocks: 1, tokenRequests: 100, uncached: 20, share: 0.05 }, { name: "hook_success", kind: "attachment", blocks: 2, tokenRequests: 50, uncached: 10, share: 0.02 }],
      },
      scopes: [
        { id: "main", kind: "main", models: ["claude-opus-4-1-20250805"], blocks: [
          { id: "main:0", category: "tool_result.shell", label: "Bash", tool: { name: "Bash", kind: "shell", argsHash: "a" } },
          { id: "main:1", category: "tool_call", label: "billing-audit", tool: { name: "Skill", kind: "skill", argsHash: "b", target: "billing-audit" } },
          { id: "main:2", category: "tool_result.other", label: "mcp__acme-internal__list_customers", tool: { name: "mcp__acme-internal__list_customers", kind: "mcp", argsHash: "c", server: "acme-internal" } },
          { id: "main:3", category: "tool_result.other", label: "mcp__acme-internal__get_invoice", tool: { name: "mcp__acme-internal__get_invoice", kind: "mcp", argsHash: "d", server: "acme-internal" } },
          { id: "main:4", category: "skills", label: "billing-audit", attachmentType: "invoked_skills" },
          { id: "main:5", category: "attachments", label: "hook_success:SessionStart:acme-bootstrap", attachmentType: "hook_success" },
          { id: "main:6", category: "attachments", label: "hook_success:PreToolUse:Bash", attachmentType: "hook_success" },
          { id: "main:7", category: "attachments", label: "hook_success:SessionStart:compact", attachmentType: "hook_success" },
          { id: "main:8", category: "subagent_handoff", label: "agent result", agentId: "a1" },
        ], toolCost: [{ name: "mcp__acme-internal__list_customers", kind: "mcp", server: "acme-internal", blocks: 1, tokenRequests: 300, uncached: 40, share: 0.1 }, { name: "Read", kind: "file", blocks: 1, tokenRequests: 10, uncached: 1, share: 0.01 }] },
        { id: "a1", kind: "subagent", agentType: "billing-reviewer", description: "audit the invoices", blocks: [], models: ["claude-sonnet-4-5"] },
        { id: "a2", kind: "subagent", agentType: "Explore", blocks: [], models: [] },
        { id: "a3", kind: "subagent", agentType: "general-purpose", blocks: [], models: [] },
      ],
      findings: [{
        id: "f", ruleId: "B-05", severity: "medium", scope: "subagent", title: "Fat handoff from billing-reviewer", whyItMatters: "billing-reviewer returned 20k tokens; acme-internal answered mcp__acme-internal__list_customers with 9k. Explore was fine.",
        evidence: [{ kind: "scope", ref: "a1", label: "billing-reviewer a1", provenance: "derived.exact" }, { kind: "metric", ref: "x", label: "mcp__acme-internal__list_customers result", value: 9000, unit: "tokens", provenance: "estimated.local" }],
        fix: { platform: "claude", summary: "Tell billing-reviewer to return findings only; skill billing-audit reads whole tables via acme-internal.", snippet: `Agent { subagent_type: "billing-reviewer", prompt: "<task>" }`, path: ".claude/agents/billing-reviewer.md" },
      }],
    },
    scopes: {},
  };
  const before = collectUserNames(doc);
  for (const name of ["mcp__acme-internal__list_customers", "acme-internal", "list_customers", "get_invoice", "billing-reviewer", "billing-audit", "acme-bootstrap"]) assert.ok(before.has(name), `${name} is a user-authored name`);
  for (const name of ["Bash", "Read", "Skill", "Explore", "general-purpose", "Agent handoffs", "hook_success", "compact", "SessionStart"]) assert.ok(!before.has(name), `${name} is vendor vocabulary`);
  redactExport(doc, { salt });
  const text = JSON.stringify(doc);
  assert.equal(doc.redaction.names, "vendor-only");
  for (const leak of ["acme-internal", "list_customers", "get_invoice", "billing-reviewer", "billing-audit", "acme-bootstrap", "packages/billing"]) assert.ok(!text.includes(leak), `${leak} survived`);
  const server = hashLabel("acme-internal", salt);
  const mcp = `mcp__${server}__${hashLabel("list_customers", salt)}`;
  assert.equal(doc.run.scopes[0].blocks[2].tool.name, mcp, "mcp__<server>__<tool> keeps its shape");
  assert.equal(doc.run.scopes[0].blocks[2].tool.server, server);
  assert.equal(doc.run.scopes[0].blocks[3].tool.name, `mcp__${server}__${hashLabel("get_invoice", salt)}`, "equal servers hash equal");
  assert.equal(doc.run.scopes[0].blocks[2].label, mcp, "a label that is the MCP name follows the same rule");
  assert.equal(doc.run.mcpToolsObserved[0], mcp);
  assert.equal(doc.run.summary.topBlocks[0].tool, mcp);
  assert.equal(doc.run.summary.toolCost[1].name, mcp);
  assert.equal(doc.run.summary.toolCost[1].server, server);
  assert.equal(doc.run.scopes[0].toolCost[0].name, mcp);
  assert.deepEqual(doc.run.summary.toolCost.map((row) => row.name), ["Bash", mcp, "Agent handoffs", "hook_success"], "cost rows: vendor names readable, MCP hashed");
  assert.equal(doc.run.scopes[0].blocks[0].tool.name, "Bash");
  assert.equal(doc.run.scopes[0].blocks[0].label, "Bash", "a label that is a built-in tool name stays");
  assert.equal(doc.run.scopes[0].blocks[1].tool.name, "Skill");
  assert.equal(doc.run.scopes[0].blocks[1].tool.target, hashLabel("billing-audit", salt), "skill names hash");
  assert.equal(doc.run.scopes[0].blocks[4].label, hashLabel("billing-audit", salt));
  assert.equal(doc.run.scopes[0].blocks[5].label, `hook_success:SessionStart:${hashLabel("acme-bootstrap", salt)}`, "hook events stay, matchers hash");
  assert.equal(doc.run.scopes[0].blocks[6].label, "hook_success:PreToolUse:Bash", "a built-in tool as matcher is vendor vocabulary");
  assert.equal(doc.run.scopes[0].blocks[7].label, "hook_success:SessionStart:compact", "vendor-defined matchers stay");
  assert.equal(doc.run.scopes[1].agentType, hashLabel("billing-reviewer", salt), "custom agent types hash");
  assert.equal(doc.run.scopes[2].agentType, "Explore");
  assert.equal(doc.run.scopes[3].agentType, "general-purpose");
  assert.deepEqual(doc.run.summary.models, ["claude-opus-4-1-20250805"], "model ids stay");
  assert.deepEqual(doc.run.scopes[1].models, ["claude-sonnet-4-5"]);
  assert.deepEqual(doc.run.instructionFilesObserved, ["CLAUDE.md", ".claude/rules/api.md", hashLabel("packages/billing/CLAUDE.md", salt)], "instruction vocabulary stays; a nested path hashes");
  const finding = doc.run.findings[0];
  assert.equal(finding.title, `Fat handoff from ${hashLabel("billing-reviewer", salt)}`, "prose mentions of a custom agent hash");
  assert.ok(finding.whyItMatters.includes(`${server} answered ${mcp} with 9k. Explore was fine.`), finding.whyItMatters);
  assert.equal(finding.fix.snippet, `Agent { subagent_type: "${hashLabel("billing-reviewer", salt)}", prompt: "<task>" }`);
  assert.equal(finding.fix.path, `.claude/agents/${hashLabel("billing-reviewer", salt)}.md`, "the .claude/agents/ convention stays; a user-authored agent file name hashes like the type");
  assert.equal(finding.evidence[1].label, `${mcp} result`, "metric labels go through the names pass");
  assert.deepEqual([...collectUserNames(doc)], [], "nothing user-authored is left");
  assert.deepEqual(findPathLikeTokens(doc), []);
  // Same name, same hash; already-hashed values are stable; vendor sets are what the ADR lists.
  assert.equal(redactName("mcp__acme-internal__list_customers", salt), mcp);
  assert.equal(redactName(mcp, salt), mcp, "idempotent");
  assert.equal(redactName("Read", salt), "Read");
  assert.equal(redactName("exec", salt), "exec");
  assert.equal(redactName("claude-code-guide", salt), "claude-code-guide");
  assert.equal(redactName("my-agent", salt), hashLabel("my-agent", salt));
  for (const name of ["Explore", "Plan", "general-purpose", "Bash", "claude-code-guide", "statusline-setup"]) assert.ok(BUILTIN_AGENT_TYPES.has(name), name);
  for (const name of ["Read", "Bash", "Agent", "Skill", "exec", "apply_patch", "spawn_agent"]) assert.ok(BUILTIN_TOOLS.has(name), name);
});
