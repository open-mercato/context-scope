import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildSetupInventory } from "../src/setup/inventory.mjs";
import { parseFrontmatter } from "../src/setup/frontmatter.mjs";
import { extractImports, extractPathCandidates, findBrokenRefs, looksLikePath, suffixIndex } from "../src/setup/references.mjs";
import { parseTomlMcpServers, hookRunStats } from "../src/setup/config.mjs";
import { duplicateBlocks } from "../src/setup/instructions.mjs";
import { projectKeyCandidates } from "../src/setup/extensions.mjs";
import { chainFor } from "../src/setup/precedence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.join(here, "fixtures", "repos");
const HOMES = path.join(here, "fixtures", "homes");

const messyStats = {
  sessionCount: 8,
  vendorsWithSessions: ["claude", "codex"],
  skillInvocations: { fine: 3 },
  agentRuns: { researcher: 2 },
  hookRuns: { "PostToolUse:Write|Edit": { runs: 10, stdoutSizes: [9000, 9000, 9000, 100, 100, 100, 100, 100, 100, 100] } },
  mcpInvocations: { bloated: 12 },
  mcpToolsObserved: { bloated: Array.from({ length: 20 }, (_, i) => `tool${i}`) },
  instructionFilesObserved: ["CLAUDE.md"],
  codexInstructionChars: 4000,
};

test("messy fixture: instruction files carry precedence, load state, imports and broken refs", async () => {
  const inv = await buildSetupInventory({ repoRoot: path.join(REPOS, "messy"), home: path.join(HOMES, "messy"), sessionStats: messyStats });
  assert.deepEqual(inv.vendorsDetected, ["claude", "codex"]);
  assert.equal(inv.repo.root, "cwd");
  const byPath = Object.fromEntries(inv.instructionFiles.map(f => [f.path, f]));
  assert.equal(byPath["~/.claude/CLAUDE.md"].scope, "user");
  assert.equal(byPath["~/.claude/CLAUDE.md"].precedence, 1);
  assert.equal(byPath["CLAUDE.md"].loadState, "observed.loaded");
  assert.deepEqual(byPath["CLAUDE.md"].imports, ["docs/style-guide.md"]);
  assert.deepEqual(byPath["CLAUDE.md"].brokenRefs.sort(), ["docs/architecture.md", "docs/style-guide.md", "scripts/build.sh"]);
  assert.equal(byPath["CLAUDE.local.md"].scope, "local");
  assert.equal(byPath[".claude/rules/general.md"].scope, "rules");
  assert.deepEqual(byPath[".claude/rules/general.md"].pathsFrontmatter, []);
  assert.equal(byPath[".claude/rules/general.md"].loadState, "expected.load");
  assert.equal(byPath["src/CLAUDE.md"].scope, "nested");
  assert.equal(byPath["src/CLAUDE.md"].loadState, "discoverable");
  assert.equal(byPath["AGENTS.md"].vendors[0], "codex");
  assert.equal(byPath["~/.codex/AGENTS.md"].scope, "user");
  for (const file of inv.instructionFiles) {
    assert.ok(!path.isAbsolute(file.path), `path must be relative: ${file.path}`);
    assert.ok(file.estTokens > 0 && file.bytes > 0);
    assert.match(file.mtime, /^\d{4}-\d{2}-\d{2}T/);
  }
  // Claude chain = user + project + local + rules (nested is lazy)
  assert.deepEqual(chainFor(inv.instructionFiles, "claude").map(f => f.path), ["~/.claude/CLAUDE.md", "CLAUDE.md", "CLAUDE.local.md", ".claude/rules/general.md"]);
  // Duplicate block between CLAUDE.md and the rules file
  assert.equal(inv.instructionDuplicates.length, 1);
  assert.equal(inv.instructionDuplicates[0].a, "CLAUDE.md");
  assert.equal(inv.instructionDuplicates[0].b, ".claude/rules/general.md");
  assert.ok(inv.instructionDuplicates[0].lines >= 5);
});

test("messy fixture: skills, agents, hooks, MCP, settings, budget", async () => {
  const inv = await buildSetupInventory({ repoRoot: path.join(REPOS, "messy"), home: path.join(HOMES, "messy"), sessionStats: messyStats });
  const skills = Object.fromEntries(inv.skills.map(s => [s.path, s]));
  assert.equal(skills[".claude/skills/no-description/SKILL.md"].hasDescription, false);
  assert.equal(skills[".claude/skills/broken-frontmatter/SKILL.md"].frontmatterValid, false);
  assert.equal(skills[".claude/skills/wrong-name/SKILL.md"].frontmatterValid, false);
  assert.ok(skills[".claude/skills/long-description/SKILL.md"].descriptionChars > 1024);
  assert.equal(skills[".claude/skills/fine/SKILL.md"].invocations30d, 3);
  assert.equal(skills[".claude/skills/fine/SKILL.md"].frontmatterValid, true);
  assert.equal(skills["~/.claude/plugins/cache/mkt/plug/1.0.0/skills/plugin-skill/SKILL.md"].scope, "plugin");

  const researcher = inv.agents.find(a => a.name === "researcher");
  assert.deepEqual(researcher.tools, ["Read", "Grep"]);
  assert.equal(researcher.runs30d, 2);
  assert.equal(inv.agents.find(a => a.name === "user-agent").scope, "user");

  const post = inv.hooks.find(h => h.event === "PostToolUse");
  assert.equal(post.matcher, "Write|Edit");
  assert.equal(post.scope, "project");
  assert.equal(post.runs30d, 10);
  assert.ok(post.stdoutP95 > 1500 && post.stdoutP50 < 100);
  assert.equal(inv.hooks.find(h => h.event === "PreToolUse").scope, "user");
  assert.deepEqual(inv.hookScripts, [".claude/hooks/test.sh"]);

  const mcp = Object.fromEntries(inv.mcpServers.map(s => [`${s.vendor}:${s.name}`, s]));
  assert.equal(mcp["claude:bloated"].toolsObserved.length, 20);
  assert.equal(mcp["claude:bloated"].invocations30d, 12);
  assert.equal(mcp["claude:unused"].transport, "http");
  assert.equal(mcp["claude:global_server"].scope, "user");
  assert.equal(mcp["codex:quoted.name"].transport, "sse");
  assert.equal(mcp["codex:codex_unused"].scope, "project");
  assert.equal(mcp["codex:disabled_one"], undefined);
  assert.ok(!JSON.stringify(inv).includes("do-not-read"), "env values must never enter the inventory");

  assert.deepEqual(inv.settings.find(s => s.path === "~/.claude/settings.json").keys, ["hooks", "mcpServers"]);
  assert.equal(inv.memory.present, false);
  assert.equal(inv.startupBudget.codex.instructions.provenance, "observed.artifact");
  assert.equal(inv.startupBudget.codex.instructions.value, Math.ceil(4000 / 3.6));
  // Only CLAUDE.md is observed.loaded (instructionFilesObserved) while the rest of the expected chain is not:
  // one observed file does not make the chain observed, so the budget stays an estimate over the expected chain.
  assert.equal(inv.instructionFiles.find(f => f.path === "CLAUDE.md").loadState, "observed.loaded");
  assert.equal(inv.startupBudget.claude.instructions.provenance, "estimated.local");
  assert.equal(inv.startupBudget.claude.instructions.value, inv.instructionFiles.filter(f => f.vendors.includes("claude") && ["expected.load", "observed.loaded"].includes(f.loadState)).reduce((sum, f) => sum + f.estTokens, 0));
  const claude = inv.startupBudget.claude;
  assert.equal(claude.total.value, claude.instructions.value + claude.skills.value + claude.agents.value + claude.mcpTools.value);
  assert.ok(claude.mcpTools.value >= 20 * 150);
});

test("healthy fixture: everything resolves and the codex chain includes nested AGENTS.md as discoverable", async () => {
  const inv = await buildSetupInventory({ repoRoot: path.join(REPOS, "healthy"), home: path.join(HOMES, "healthy") });
  assert.deepEqual(inv.vendorsDetected, ["claude", "codex"]);
  for (const file of inv.instructionFiles) assert.deepEqual(file.brokenRefs, [], file.path);
  const rules = inv.instructionFiles.find(f => f.path === ".claude/rules/api.md");
  assert.deepEqual(rules.pathsFrontmatter, ["src/api/**"]);
  assert.equal(rules.loadState, "discoverable");
  const nested = inv.instructionFiles.find(f => f.path === "packages/api/AGENTS.md");
  assert.equal(nested.scope, "nested");
  assert.equal(nested.loadState, "discoverable");
  assert.equal(inv.instructionDuplicates.length, 0);
  assert.deepEqual(inv.commands, [{ name: "deploy", path: ".claude/commands/deploy.md" }]);
  assert.equal(inv.skills.every(s => s.frontmatterValid && s.hasDescription), true);
  assert.equal(inv.agents[0].model, "sonnet");
  assert.equal(inv.mcpServers.length, 2);
  assert.equal(inv.hooks.length, 1);
  assert.equal(inv.hooks[0].runs30d, 0);
});

test("memory directory is found under the Claude project key and symlinks outside the roots are rejected", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cs-setup-"));
  const repo = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await mkdir(path.join(repo, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  const outside = path.join(tmp, "outside.md");
  await writeFile(outside, "# secret instructions\n");
  await symlink(outside, path.join(repo, "CLAUDE.md"));
  await writeFile(path.join(repo, "AGENTS.md"), "# ok\n");
  const key = projectKeyCandidates(repo)[0];
  const memoryDir = path.join(home, ".claude", "projects", key, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(path.join(memoryDir, "MEMORY.md"), "# memory\n- fact\n");
  await writeFile(path.join(memoryDir, "notes.md"), "more\n");
  const inv = await buildSetupInventory({ repoRoot: repo, home });
  assert.equal(inv.instructionFiles.find(f => f.path === "CLAUDE.md"), undefined, "symlink escaping the roots is skipped");
  assert.ok(inv.instructionFiles.find(f => f.path === "AGENTS.md"));
  assert.equal(inv.memory.present, true);
  assert.equal(inv.memory.files, 2);
  assert.ok(inv.memory.indexBytes > 0);
});

test("frontmatter parser handles quoted strings, block scalars, lists and errors", () => {
  const ok = parseFrontmatter(`---\nname: "x"\ndescription: >\n  first line\n  second line\ntools:\n  - Read\n  - Grep\nmodel: sonnet\npaths: [src/**, "lib/**"]\n---\nbody`);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.name, "x");
  assert.equal(ok.data.description, "first line second line");
  assert.deepEqual(ok.data.tools, ["Read", "Grep"]);
  assert.deepEqual(ok.data.paths, ["src/**", "lib/**"]);
  assert.equal(ok.body, "body");
  const literal = parseFrontmatter(`---\ndescription: |\n  a\n  b\n---\n`);
  assert.equal(literal.data.description, "a\nb");
  assert.equal(parseFrontmatter("no frontmatter").present, false);
  assert.equal(parseFrontmatter("---\nname: a\n").ok, false);
  assert.equal(parseFrontmatter("---\nname a\n---\n").ok, false);
});

test("reference extraction keeps paths and drops URLs, globs, commands and versions", () => {
  const text = "Read `src/index.mjs` and `docs/`; run `npm test`; see https://example.com/x, `*.test.mjs`, `v1.2.3`, `3.11`, `foo()` and @docs/style.md plus mail me@host.com. Code: ```\n@ignored/path.md\n```";
  assert.deepEqual(extractImports(text), ["docs/style.md"]);
  assert.deepEqual(extractPathCandidates(text).sort(), ["docs/", "docs/style.md", "src/index.mjs"]);
  assert.equal(looksLikePath("package.json"), true);
  assert.equal(looksLikePath("PreToolUse"), false);
  assert.equal(looksLikePath("example.com/path"), false);
});

test("toml MCP sections, hook run matching and duplicate block detection", () => {
  const servers = parseTomlMcpServers(`[mcp_servers.a]\ncommand = "x"\n[mcp_servers."b.c"]\nurl = "http://h/sse"\nenabled = false\n[other]\ncommand = "no"\n`);
  assert.deepEqual(servers.map(s => s.name), ["a", "b.c"]);
  assert.equal(servers[1].enabled, false);
  const stats = hookRunStats({ event: "PostToolUse", matcher: "Write", command: "npm test" }, { "PostToolUse:Write": { runs: 2, stdoutSizes: [3600, 36] }, other: { runs: 5, stdoutSizes: [1] } });
  assert.equal(stats.runs, 2);
  assert.deepEqual(stats.stdoutTokens, [1000, 10]);
  const lines = ["l1", "l2", "l3", "l4", "l5", "l6"];
  const blocks = duplicateBlocks({ path: "a", lines: ["x", ...lines, "y"] }, { path: "b", lines: ["z", ...lines] });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines, 6);
  assert.equal(duplicateBlocks({ path: "a", lines: ["1", "2"] }, { path: "b", lines: ["1", "2"] }).length, 0);
});

test("fixture directories: instruction files under test/fixtures and __fixtures__ are listed under excluded, never counted", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-fixtures-"));
  try {
    const repo = path.join(base, "repo");
    const home = path.join(base, "home");
    await mkdir(path.join(repo, "packages", "cli", "test", "fixtures", "repos", "messy", ".claude", "rules"), { recursive: true });
    await mkdir(path.join(repo, "src", "__fixtures__"), { recursive: true });
    await mkdir(path.join(repo, "spec", "fixture"), { recursive: true });
    await mkdir(path.join(repo, "packages", "api"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(repo, "CLAUDE.md"), "# root\n" + "rule\n".repeat(50));
    await writeFile(path.join(repo, "packages", "api", "CLAUDE.md"), "# nested real\n");
    await writeFile(path.join(repo, "packages", "cli", "test", "fixtures", "repos", "messy", "CLAUDE.md"), "# fixture\n" + "rule\n".repeat(50));
    await writeFile(path.join(repo, "packages", "cli", "test", "fixtures", "repos", "messy", "AGENTS.md"), "# fixture agents\n");
    await writeFile(path.join(repo, "packages", "cli", "test", "fixtures", "repos", "messy", ".claude", "rules", "x.md"), "# fixture rule\n");
    await writeFile(path.join(repo, "src", "__fixtures__", "CLAUDE.md"), "# fixture 2\n");
    await writeFile(path.join(repo, "spec", "fixture", "AGENTS.md"), "# fixture 3\n");
    const inventory = await buildSetupInventory({ repoRoot: repo, home, capture: false, sessionStats: { sessionCount: 1, vendorsWithSessions: ["claude"] } });
    const paths = inventory.instructionFiles.map((file) => file.path).sort();
    assert.ok(paths.includes("CLAUDE.md"));
    assert.ok(paths.includes("packages/api/CLAUDE.md"), "a real nested file stays");
    assert.ok(!paths.some((file) => /fixture/.test(file)), `no fixture file in the chain: ${paths.join(", ")}`);
    const excluded = inventory.excluded.map((item) => item.path).sort();
    assert.deepEqual(excluded, [
      "packages/cli/test/fixtures/repos/messy/.claude/rules/x.md",
      "packages/cli/test/fixtures/repos/messy/AGENTS.md",
      "packages/cli/test/fixtures/repos/messy/CLAUDE.md",
      "spec/fixture/AGENTS.md",
      "src/__fixtures__/CLAUDE.md",
    ].filter((file) => excluded.includes(file)).sort(), "every discovered fixture file is listed");
    assert.ok(excluded.length >= 3, `fixture files listed: ${excluded.join(", ")}`);
    assert.ok(inventory.excluded.every((item) => item.reason === "fixture"));
    assert.ok(!(inventory.instructionDuplicates ?? []).some((block) => /fixture/.test(block.a) || /fixture/.test(block.b)), "duplicate pairs never reference a fixture file");
    const rootTokens = inventory.instructionFiles.find((file) => file.path === "CLAUDE.md").estTokens;
    const budget = inventory.startupBudget.claude?.instructions?.value ?? 0;
    assert.ok(budget > 0 && budget < rootTokens * 2, `the fixture copy of the root file is not in the budget (${budget} vs ${rootTokens})`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reference extraction drops examples, placeholders, identifiers and non-paths seen in a real monorepo (open-mercato)", () => {
  const text = [
    "| Official modules via the `external/official-modules` submodule | docs |",
    "- Put providers under `packages/<p>/` (for example `packages/gateway-stripe`, `packages/carrier-inpost`).",
    "- Prefer package imports over deep relative imports (`../../../...`, `../../../`).",
    "- Keep short relative imports for siblings (`./x`, `../x`).",
    "| Loop controls (`loop.stopWhen/prepareStep/budget`) | ai |",
    "- Own `lib/tasks/executionPrincipal.ts` and the principals are gone.",
    "- Send `text/plain` and `application/x-om-ledger-path`; style with `brand-violet/10`; press `Ctrl/⌘`.",
    "- Emit `catalog.product.created/updated/deleted`; gate on `staff.timesheets.lock`.",
    "- Validate in `data/validators.ts`; edit `docker/opencode/opencode.json`; lockfile `yarn.lock`.",
  ].join("\n");
  assert.deepEqual(extractPathCandidates(text).sort(), ["data/validators.ts", "docker/opencode/opencode.json", "yarn.lock"]);
});

test("broken refs resolve module-relative conventions, import specifiers and generated outputs; anchor extension-less tokens", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-refs-"));
  try {
    const repo = path.join(base, "repo");
    const moduleDir = path.join(repo, "packages", "core", "src", "modules", "sales");
    await mkdir(path.join(moduleDir, "data"), { recursive: true });
    await mkdir(path.join(repo, "packages", "shared", "src", "lib", "crud"), { recursive: true });
    const files = [
      "packages/core/src/modules/sales/data/validators.ts",
      "packages/core/src/modules/sales/lib/customerAuth.ts",
      "packages/shared/src/lib/crud/factory.ts",
    ];
    const suffixes = suffixIndex(files);
    const candidates = [
      "data/validators.ts",          // module-relative convention: exists in a module
      "lib/customerAuth",            // import specifier without extension
      "shared/lib/crud/factory.ts",  // package export path (src/ elided)
      "modules.generated.ts",        // build output
      "integrations/detail",         // route id: first segment is no directory
      "openai/gpt-5-mini",           // model id
      "packages/missing.ts",         // a real miss
      "data/gone.ts",                // anchored miss (data/ exists next to the file)
    ];
    const broken = await findBrokenRefs(candidates, { repoRoot: repo, fileDir: moduleDir, basenames: new Set(), suffixes });
    assert.deepEqual(broken, ["packages/missing.ts", "data/gone.ts"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("repo walk skips nested repositories / worktrees and git-ignored directories, and lists them as excluded", async () => {
  const { execFileSync } = await import("node:child_process");
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-worktrees-"));
  try {
    const repo = path.join(base, "repo");
    const home = path.join(base, "home");
    await mkdir(path.join(repo, ".ai", "cezar", "worktrees", "abc"), { recursive: true });
    await mkdir(path.join(repo, "vendored", "clone"), { recursive: true });
    await mkdir(path.join(repo, "packages", "api"), { recursive: true });
    await mkdir(home, { recursive: true });
    const body = "# rules\n" + Array.from({ length: 12 }, (_, i) => `- rule number ${i} about the repository layout`).join("\n") + "\n";
    await writeFile(path.join(repo, "AGENTS.md"), body);
    await writeFile(path.join(repo, ".gitignore"), ".ai/cezar/\n");
    await writeFile(path.join(repo, ".ai", "notes.md"), "# kept\n");
    await writeFile(path.join(repo, ".ai", "cezar", "worktrees", "abc", "AGENTS.md"), body);   // ignored worktree copy
    await writeFile(path.join(repo, "vendored", "clone", ".git"), "gitdir: /elsewhere\n");     // a worktree / submodule marker
    await writeFile(path.join(repo, "vendored", "clone", "AGENTS.md"), body);
    await writeFile(path.join(repo, "packages", "api", "AGENTS.md"), "# api\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const inventory = await buildSetupInventory({ repoRoot: repo, home, capture: false, sessionStats: { sessionCount: 0, vendorsWithSessions: ["codex"] } });
    const paths = inventory.instructionFiles.map((file) => file.path).sort();
    assert.deepEqual(paths, ["AGENTS.md", "packages/api/AGENTS.md"]);
    assert.deepEqual((inventory.instructionDuplicates ?? []).length, 0, "no duplicate against a skipped copy");
    const skipped = inventory.excluded.filter((item) => item.reason !== "fixture").map((item) => `${item.path}:${item.reason}`).sort();
    assert.deepEqual(skipped, [".ai/cezar/:gitignored", "vendored/clone/:nested-repo"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("skills: symlinked .claude/skills folders are followed, .agents/skills is read for Codex, one row per physical skill", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "contextscope-skills-"));
  try {
    const repo = path.join(base, "repo");
    const home = path.join(base, "home");
    const outside = path.join(base, "outside");
    await mkdir(path.join(repo, ".agents", "skills", "shared"), { recursive: true });
    await mkdir(path.join(repo, ".agents", "skills", "codex-only"), { recursive: true });
    await mkdir(path.join(repo, ".claude", "skills", "claude-only"), { recursive: true });
    await mkdir(path.join(outside, "escape"), { recursive: true });
    await mkdir(home, { recursive: true });
    const skill = (name) => `---\nname: ${name}\ndescription: Use when testing ${name} discovery.\n---\n# ${name}\n`;
    await writeFile(path.join(repo, ".agents", "skills", "shared", "SKILL.md"), skill("shared"));
    await writeFile(path.join(repo, ".agents", "skills", "codex-only", "SKILL.md"), skill("codex-only"));
    await writeFile(path.join(repo, ".claude", "skills", "claude-only", "SKILL.md"), skill("claude-only"));
    await writeFile(path.join(outside, "escape", "SKILL.md"), skill("escape"));
    await symlink(path.join("..", "..", ".agents", "skills", "shared"), path.join(repo, ".claude", "skills", "shared"));
    await symlink(path.join(outside, "escape"), path.join(repo, ".claude", "skills", "escape")); // leaves the repo: not followed
    const inventory = await buildSetupInventory({ repoRoot: repo, home, capture: false, sessionStats: { sessionCount: 0, vendorsWithSessions: ["claude", "codex"] } });
    const project = inventory.skills.filter((s) => s.scope === "project").map((s) => ({ name: s.name, path: s.path, vendors: [...s.vendors].sort(), aliases: s.aliases }));
    project.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(project, [
      { name: "claude-only", path: ".claude/skills/claude-only/SKILL.md", vendors: ["claude"], aliases: [] },
      { name: "codex-only", path: ".agents/skills/codex-only/SKILL.md", vendors: ["codex"], aliases: [] },
      { name: "shared", path: ".agents/skills/shared/SKILL.md", vendors: ["claude", "codex"], aliases: [".claude/skills/shared/SKILL.md"] },
    ]);
    assert.ok(inventory.startupBudget.claude.skills.value > 0 && inventory.startupBudget.codex.skills.value > 0, "each vendor's budget counts the skills it sees");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
