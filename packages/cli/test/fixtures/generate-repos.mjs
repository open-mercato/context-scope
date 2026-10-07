#!/usr/bin/env node
/**
 * Generates the synthetic setup fixtures used by setup-inventory.test.mjs and
 * rules-setup.test.mjs. Re-run with `node test/fixtures/generate-repos.mjs`.
 *
 *   test/fixtures/repos/healthy   fires no S-* rule (given quiet session stats)
 *   test/fixtures/repos/messy     fires S-01..S-06, S-08, S-09, S-11, S-12 (+S-07/S-10 with stats/git)
 *   test/fixtures/homes/{healthy,messy}   fake ~ with .claude and .codex trees
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.join(here, "repos");
const HOMES = path.join(here, "homes");

async function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

function paragraphs(topic, count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(`## ${topic} section ${i}\n\nWhen you work on ${topic} item ${i}, first read the existing code, then write a small failing test, then make the smallest change that passes it. Keep functions short and prefer explicit names over comments. Never leave commented-out code behind and always run the formatter before you stop.\n`);
  }
  return out.join("\n");
}

const SHARED_BLOCK = `## Commit rules

- Write commit subjects in the imperative mood and keep them under 72 characters.
- Reference the issue number at the end of the subject line when one exists.
- Never commit generated files, lockfile churn, or editor settings.
- Run the full test suite locally before pushing to any shared branch.
- Squash fixup commits before opening a pull request for review.
- Sign every commit with the configured identity; do not amend published history.
`;

const healthyRepo = {
  "CLAUDE.md": `# Healthy project

Small service with a clean layout. See \`docs/setup.md\` for environment setup and \`src/index.mjs\` for the entrypoint.

## Commands

- Install: \`npm install\`
- Test: \`npm test\`

## Conventions

- Keep modules under 200 lines.
- Prefer named exports.
`,
  ".claude/rules/api.md": `---
paths:
  - "src/api/**"
---
# API rules

- Validate every request body with the shared schema in \`src/api/schema.mjs\`.
- Return problem+json on errors.
`,
  ".claude/skills/release-notes/SKILL.md": `---
name: release-notes
description: Draft release notes from merged pull requests. Use when the user asks for a changelog, release summary, or "what shipped" since a tag.
---
# Release notes

Collect merged PRs since the last tag and group them by area.
`,
  ".claude/agents/reviewer.md": `---
name: reviewer
description: Reviews a diff for correctness and returns findings only, under 400 words.
model: sonnet
tools: Read, Grep
---
Review the diff. Return paths, line refs and decisions only.
`,
  ".claude/settings.json": JSON.stringify({
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "npm run lint --silent 2>&1 | tail -5" }] }] },
  }, null, 2) + "\n",
  ".claude/hooks/lint.sh": "#!/bin/sh\nnpm run lint --silent 2>&1 | tail -5\n",
  ".claude/commands/deploy.md": "Deploy the current branch to staging.\n",
  ".mcp.json": JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "docs-mcp", args: [] } } }, null, 2) + "\n",
  "AGENTS.md": `# Healthy project

Small service. Entrypoint \`src/index.mjs\`; tests under \`test/\`.

## Commands

- Install: \`npm install\`
- Test: \`npm test\`

## Conventions

- Keep modules under 200 lines.
- Prefer named exports.
`,
  "packages/api/AGENTS.md": "# API package\n\nValidate request bodies with the shared schema before handling.\n",
  ".codex/config.toml": `[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = []\n`,
  "docs/setup.md": "# Setup\n\nRun `npm install`.\n",
  "src/index.mjs": "export const main = () => 0;\n",
  "src/api/schema.mjs": "export const schema = {};\n",
  "test/index.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n",
};

const messyRepo = {
  // > 3000 est. tokens, broken refs, duplicated block, no rules with paths.
  "CLAUDE.md": `# Messy project

Read \`docs/architecture.md\` before touching anything and follow @docs/style-guide.md for formatting.
The build lives in \`scripts/build.sh\` and the real entrypoint is \`src/index.mjs\`.

${SHARED_BLOCK}
${paragraphs("frontend", 18)}
${paragraphs("backend", 18)}
`,
  "CLAUDE.local.md": "Local overrides: use the staging database.\n",
  ".claude/rules/general.md": `# General rules

Always run the linter.

${SHARED_BLOCK}
${paragraphs("lint", 30)}
`,
  ".claude/skills/no-description/SKILL.md": "---\nname: no-description\n---\n# Skill without a description\n\nDoes something.\n",
  ".claude/skills/broken-frontmatter/SKILL.md": "---\nname: broken-frontmatter\ndescription: This frontmatter never closes so the parser must flag it as invalid.\n\n# Body\n\nText.\n",
  ".claude/skills/wrong-name/SKILL.md": "---\nname: something-else\ndescription: The declared name does not match the directory name, which makes the skill unreachable.\n---\n# Wrong name\n",
  ".claude/skills/long-description/SKILL.md": `---\nname: long-description\ndescription: ${"Use this skill whenever anything happens at all. ".repeat(30)}\n---\n# Long description\n`,
  ".claude/skills/fine/SKILL.md": "---\nname: fine\ndescription: Formats SQL migrations. Use when the user asks to tidy or lint a migration file.\n---\n# Fine\n",
  ".claude/agents/researcher.md": "---\nname: researcher\ndescription: Explores the codebase and reports back with file paths.\ntools:\n  - Read\n  - Grep\n---\nExplore.\n",
  ".claude/settings.json": JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "npm test 2>&1" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "git status" }] }],
    },
  }, null, 2) + "\n",
  ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(*)"] } }, null, 2) + "\n",
  ".claude/hooks/test.sh": "#!/bin/sh\nnpm test\n",
  ".mcp.json": JSON.stringify({
    mcpServers: {
      bloated: { type: "stdio", command: "bloated-mcp" },
      unused: { type: "http", url: "http://127.0.0.1:9999/mcp" },
    },
  }, null, 2) + "\n",
  // > 1500 tokens and no nested AGENTS.md -> S-06 (codex)
  "AGENTS.md": `# Messy project (Codex)

Follow \`docs/architecture.md\` and \`scripts/build.sh\`.

${paragraphs("service", 20)}
`,
  "src/CLAUDE.md": "# src\n\nNested guidance for the source tree.\n",
  ".codex/config.toml": `[mcp_servers.codex_unused]\ncommand = "codex-unused-mcp"\n\n[mcp_servers.disabled_one]\ncommand = "x"\nenabled = false\n`,
  "src/index.mjs": "export const main = () => 0;\n",
};

const healthyHome = {
  ".claude/settings.json": JSON.stringify({ model: "sonnet" }, null, 2) + "\n",
  ".claude/skills/user-skill/SKILL.md": "---\nname: user-skill\ndescription: Summarises a pull request. Use when the user asks for a PR summary or review digest.\n---\n# User skill\n",
  ".codex/config.toml": `model = "gpt-5"\n[projects."/nowhere"]\ntrust_level = "trusted"\n`,
};

const messyHome = {
  ".claude/CLAUDE.md": "# User instructions\n\nAlways answer in English.\n",
  ".claude/settings.json": JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "cat /var/log/everything.log" }] }] },
    mcpServers: { user_server: { type: "stdio", command: "user-mcp" } },
  }, null, 2) + "\n",
  ".claude/agents/user-agent.md": "---\nname: user-agent\ndescription: A user-scope agent.\n---\nDo things.\n",
  ".claude/plugins/cache/mkt/plug/1.0.0/skills/plugin-skill/SKILL.md": "---\nname: plugin-skill\ndescription: Plugin-provided skill for generating diagrams from source trees.\n---\n# Plugin skill\n",
  ".codex/AGENTS.md": "# Codex user instructions\n\nBe terse.\n",
  ".codex/config.toml": `model = "gpt-5"\n[mcp_servers."quoted.name"]\nurl = "http://127.0.0.1:8080/sse"\n`,
  ".claude.json": JSON.stringify({ mcpServers: { global_server: { type: "sse", url: "http://127.0.0.1:1/sse", env: { SECRET: "do-not-read" } } } }, null, 2) + "\n",
};

for (const [root, files] of [
  [path.join(REPOS, "healthy"), healthyRepo],
  [path.join(REPOS, "messy"), messyRepo],
  [path.join(HOMES, "healthy"), healthyHome],
  [path.join(HOMES, "messy"), messyHome],
]) {
  await rm(root, { recursive: true, force: true });
  await write(root, files);
}
console.log("fixtures written to", REPOS, "and", HOMES);
