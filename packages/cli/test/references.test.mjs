/**
 * S-05 precision: references.mjs context filters (negation, template, placeholder paths,
 * `~/` and build-output prefixes) and the S-05 rule's own filter over the inventory.
 */
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { extractPathCandidates, findBrokenRefs, isPlaceholderPath } from "../src/setup/references.mjs";
import { assertFindingShape } from "../src/rules/index.mjs";
import rule from "../src/rules/S-05.mjs";

test("negation context: a line that says a path is not used, must not be created or does not exist is not a reference", () => {
  const text = [
    "Do not create `lib/utils.ts`; helpers live in `src/helpers.ts`.",
    "`config/legacy.json` is no longer used.",
    "Plik `.env.local` nie istnieje w repo; nigdy nie dodawaj `secrets/keys.json`.",
    "Don’t add `scripts/deploy.sh` here.",
    "Read `docs/architecture.md` first.",
    "Note: `docs/notes.md` holds the meeting notes.",
  ].join("\n");
  const candidates = extractPathCandidates(text);
  assert.deepEqual(candidates.sort(), ["docs/architecture.md", "docs/notes.md"]);
});

test("template context: lines about templates, patterns, naming, conventions and formats show a shape, not a file", () => {
  const text = [
    "File naming: `src/modules/foo/index.ts` for every module.",
    "Follow the pattern `packages/carrier/src/client.ts` when adding a carrier.",
    "The route format is `app/routes/items.ts`.",
    "Template: `docs/adr/0001-record.md`.",
    "Formatting is enforced by `biome.json`.",
    "Conventions are listed in `docs/conventions.md`.",
  ].join("\n");
  assert.deepEqual(extractPathCandidates(text).sort(), ["biome.json"]);
});

test("placeholder paths: NAME, example, all-caps and underscore segments; README and ADR files are real", () => {
  assert.ok(isPlaceholderPath("packages/NAME/src"));
  assert.ok(isPlaceholderPath("modules/MODULE_NAME/index.ts"));
  assert.ok(isPlaceholderPath("docs/example.md"));
  assert.ok(isPlaceholderPath("src/examples/demo.ts"));
  assert.ok(isPlaceholderPath("apps/PLACEHOLDER/package.json"));
  assert.ok(isPlaceholderPath("src/MY_APP/main.ts"));
  assert.equal(isPlaceholderPath("docs/README.md"), false);
  assert.equal(isPlaceholderPath("docs/ADR-001.md"), false);
  assert.equal(isPlaceholderPath("src/index.ts"), false);
  assert.equal(isPlaceholderPath("CHANGELOG.md"), false);
  assert.equal(isPlaceholderPath("src/rename.ts"), false);
  assert.equal(isPlaceholderPath("docs/username/profile.md"), false);
  const text = "See `packages/NAME/src/index.ts`, `docs/example.md` and @docs/MODULE_NAME.md; the real one is `src/index.ts`.";
  assert.deepEqual(extractPathCandidates(text), ["src/index.ts"]);
});

test("findBrokenRefs never judges `~/` refs and skips build-output prefixes; a missing repo path is still broken", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "contextscope-refs-"));
  const repoRoot = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(repoRoot, "docs", "present.md"), "ok\n");
  try {
    const broken = await findBrokenRefs(
      ["docs/present.md", "docs/missing.md", "~/.claude/CLAUDE.md", "~/notes.md", "dist/bundle.js", "node_modules/pkg/index.js", "./build/out.txt", "target/debug/app"],
      { repoRoot, home, fileDir: repoRoot, basenames: new Set(["present.md"]) },
    );
    assert.deepEqual(broken, ["docs/missing.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function setupWith(files, excluded = []) {
  return { setup: { instructionFiles: files.map((file) => ({ path: file.path, scope: "root", vendors: file.vendors ?? ["claude"], bytes: 10, hash: "h", estTokens: 3, precedence: 1, loadState: "expected.load", brokenRefs: file.brokenRefs })), excluded } };
}

test("S-05 is low severity and drops refs it cannot judge: `~/`, ignored build dirs and directories the inventory skipped", () => {
  const input = setupWith(
    [
      { path: "CLAUDE.md", brokenRefs: ["docs/missing.md", "~/.claude/commands/x.md", "dist/index.js", ".mercato/generated/app.ts", "./.mercato/generated/other.ts", "apps/vendored/README.md"] },
      { path: "AGENTS.md", vendors: ["codex"], brokenRefs: ["~/.codex/AGENTS.md", "node_modules/pkg/index.js"] },
    ],
    [{ path: ".mercato/generated/", reason: "gitignored" }, { path: "apps/vendored/", reason: "nested-repo" }, { path: "test/fixtures/x.md", reason: "fixture" }],
  );
  const findings = rule.evaluate(input, {});
  findings.forEach(assertFindingShape);
  assert.equal(findings.length, 1, "AGENTS.md has only unjudgeable refs");
  const [f] = findings;
  assert.equal(f.severity, "low");
  assert.equal(f.evidence[0].ref, "CLAUDE.md");
  assert.equal(f.evidence[0].value, 1);
  assert.deepEqual(f.evidence.slice(1).map((e) => e.ref), ["docs/missing.md"]);
  assert.match(f.fix.summary, /docs\/missing\.md/);
  assert.doesNotMatch(f.fix.snippet, /~\/|dist\/|mercato|vendored/);
  assert.equal(f.fix.platform, "claude");
  assert.deepEqual(rule.evaluate(setupWith([{ path: "CLAUDE.md", brokenRefs: [] }]), {}), []);
});
