/**
 * Synthetic session store + fake adapter/rules for the index and e2e tests.
 * No real transcript content anywhere: bodies are filler strings.
 */
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { finalizeRun } from "../../src/ir/finalize.mjs";

export const CLAUDE_SESSIONS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
export const CODEX_PARENT = "019e0000-0000-7000-8000-000000000001";
export const CODEX_CHILD = "019e0000-0000-7000-8000-000000000002";

const FILLER = "x".repeat(400);

function claudeLine(sessionId, cwd, index) {
  return JSON.stringify({ type: "user", uuid: `u${index}`, sessionId, cwd, timestamp: `2026-09-01T10:0${index}:00.000Z`, message: { role: "user", content: FILLER } });
}

export async function makeFixtureHome({ repoCwd, otherCwd } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "contextscope-home-"));
  const repo = repoCwd ?? path.join(home, "work", "repo");
  const other = otherCwd ?? path.join(home, "work", "other");
  await mkdir(repo, { recursive: true });
  await mkdir(other, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", repo.replace(/[/.]/g, "-"));
  const otherDir = path.join(home, ".claude", "projects", other.replace(/[/.]/g, "-"));
  await mkdir(projectDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  const files = {};
  for (const [position, sessionId] of CLAUDE_SESSIONS.entries()) {
    const dir = position < 2 ? projectDir : otherDir;
    const cwd = position < 2 ? repo : other;
    const file = path.join(dir, `${sessionId}.jsonl`);
    await writeFile(file, [claudeLine(sessionId, cwd, 0), claudeLine(sessionId, cwd, 1), ""].join("\n"));
    files[sessionId] = file;
  }
  // A subagent directory for the first session (folded into its stat).
  const subagents = path.join(projectDir, CLAUDE_SESSIONS[0], "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(subagents, "agent-a1ee861386cb26b5b.jsonl"), `${claudeLine(CLAUDE_SESSIONS[0], repo, 2)}\n`);
  await writeFile(path.join(subagents, "agent-a1ee861386cb26b5b.meta.json"), JSON.stringify({ agentType: "Explore", description: "look", toolUseId: "toolu_1", spawnDepth: 1 }));
  // A tiny file that must be skipped (< 200 bytes).
  await writeFile(path.join(projectDir, "44444444-4444-4444-8444-444444444444.jsonl"), "{}\n");

  const codexDir = path.join(home, ".codex", "sessions", "2026", "09", "01");
  await mkdir(codexDir, { recursive: true });
  const meta = (id, extra) => JSON.stringify({ timestamp: "2026-09-01T11:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-09-01T11:00:00.000Z", cwd: repo, originator: "codex-tui", cli_version: "0.150.1", source: "cli", model_provider: "openai", base_instructions: { text: FILLER }, ...extra } });
  const usage = JSON.stringify({ timestamp: "2026-09-01T11:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 20, total_tokens: 5020 }, model_context_window: 258400 } } });
  files[CODEX_PARENT] = path.join(codexDir, `rollout-2026-09-01T11-00-00-${CODEX_PARENT}.jsonl`);
  files[CODEX_CHILD] = path.join(codexDir, `rollout-2026-09-01T11-05-00-${CODEX_CHILD}.jsonl`);
  await writeFile(files[CODEX_PARENT], `${meta(CODEX_PARENT, {})}\n${usage}\n`);
  await writeFile(files[CODEX_CHILD], `${meta(CODEX_CHILD, { source: { subagent: { thread_spawn: { parent_thread_id: CODEX_PARENT, depth: 1, agent_path: "x", agent_nickname: "worker" } } }, parent_thread_id: CODEX_PARENT })}\n${usage}\n`);
  return { home, repo, other, files, projectDir, codexDir };
}

function block(scopeId, seq, category, estTokens, firstRequest, extra = {}) {
  return { id: `${scopeId}:${seq}`, seq, at: "2026-09-01T10:00:00Z", category, bytes: estTokens * 4, estTokens, firstRequest, hash: `h${seq}`, ...extra };
}

function request(index, total) {
  return { index, at: `2026-09-01T10:0${index}:00Z`, model: "m", turn: 1, usage: { input: 100, cacheCreation: 200, cacheRead: Math.max(0, total - 300), output: 50, total } };
}

/** Builds a finished Run for any path; the vendor and session id come from the file name. */
export function fakeRun(filePath, vendor, { home } = {}) {
  const base = path.basename(filePath, ".jsonl");
  const sessionId = vendor === "codex" ? base.slice(base.length - 36) : base;
  const cwdHash = "c".repeat(8);
  const compactions = sessionId.startsWith("2222") ? [{ id: "c1", at: "2026-09-01T10:01:30Z", atRequest: 2, trigger: "auto", preTokens: { value: 60_000, provenance: "observed.vendor" }, postTokens: { value: 8_000, provenance: "observed.vendor" }, droppedTokens: { value: 52_000, provenance: "observed.vendor" } }] : [];
  // Session 3 carries enough blocks to push its payload above the 8 KB gzip threshold.
  const bulk = sessionId.startsWith("3333") ? Array.from({ length: 120 }, (_, i) => block("main", 10 + i, "tool_result.shell", 50, 2, { tool: { name: "Bash", kind: "shell", argsHash: `bulk${i}` }, label: `cmd ${i}` })) : [];
  const run = {
    id: `${vendor}:${sessionId}`,
    vendor,
    sessionId,
    project: { key: "fixture-key", displayName: "repo", cwdHash },
    startedAt: "",
    endedAt: "",
    activeMs: 0,
    window: { value: 200_000, provenance: "estimated.local" },
    coverage: { records: 3, unparsedRecords: 0, unparsedTypes: {}, syntheticRecordsSkipped: 0, adapterVersion: `${vendor}-test` },
    source: { file: home ? path.join("~", path.relative(home, filePath)) : path.basename(filePath), bytes: 1000, mtimeMs: 1, subagentFiles: 1 },
    scopes: [
      {
        id: "main", kind: "main", compactions,
        requests: [request(0, 20_000), request(1, 30_000), request(2, 12_000)],
        blocks: [
          block("main", 0, "user", 1_000, 0),
          block("main", 1, "tool_result.file", 9_000, 1, { tool: { name: "Read", kind: "file", argsHash: "a" }, label: "src/index.mjs" }),
          block("main", 2, "tool_call", 100, 1, { tool: { name: "Skill", kind: "skill", argsHash: "b", target: "deploy" }, label: "deploy" }),
          block("main", 3, "tool_call", 100, 2, { tool: { name: "mcp__github__list_prs", kind: "mcp", argsHash: "c", server: "github" } }),
          block("main", 4, "attachments", 800, 2, { attachmentType: "hook_success", label: "PreToolUse" }),
          block("main", 5, "subagent_handoff", 3_000, 2, { agentId: "a1" }),
          ...bulk,
        ],
      },
      {
        id: "a1", kind: "subagent", agentType: "Explore", parentScopeId: "main", compactions: [],
        requests: [request(0, 50_000), request(1, 120_000)],
        blocks: [block("a1", 0, "user", 800, 0)],
        handoff: { blockId: "main:5", tokens: { value: 3_000, provenance: "estimated.local" }, compressionRatio: { value: 0, provenance: "derived.exact" } },
      },
    ],
  };
  if (vendor === "codex" && sessionId === CODEX_PARENT) run.handoffsByThread = { [CODEX_CHILD]: { blockId: "main:5", tokens: 3_000, firstRequest: 2 } };
  return finalizeRun(run);
}

export function fakeAdapters({ failOn = null } = {}) {
  const parse = (vendor) => async (filePath, opts = {}) => {
    if (failOn && filePath.includes(failOn)) throw new Error(`synthetic parse failure for ${filePath}`);
    return fakeRun(filePath, vendor, opts);
  };
  return {
    claude: { parse: parse("claude"), version: "claude-test" },
    codex: { parse: parse("codex"), version: "codex-test" },
  };
}

export function fakeRules({ thresholds = { fatToolResultTokens: 8000, fatHandoffTokens: 4000 } } = {}) {
  return {
    async loadThresholds() { return { ...thresholds }; },
    async evaluateRun(run, { thresholds: current = thresholds } = {}) {
      const findings = [];
      for (const scope of run.scopes) {
        for (const b of scope.blocks) {
          if (b.category.startsWith("tool_result") && b.estTokens > (current.fatToolResultTokens ?? 8000)) {
            findings.push({
              id: `B-01:${run.id}:${b.id}`, ruleId: "B-01", severity: "high", scope: "session", vendor: run.vendor, runId: run.id,
              title: "Fat tool result", whyItMatters: "why",
              evidence: [{ kind: "block", ref: `${run.id}#${b.id}`, label: b.label ?? "block", value: b.estTokens, unit: "tokens", provenance: "estimated.local" }],
              fix: { platform: "both", summary: "read less" }, thresholdKeys: ["fatToolResultTokens"], tokensAffected: b.estTokens,
            });
          }
        }
      }
      return findings;
    },
    async evaluateSetup(setup) {
      return [{
        id: "S-12:setup", ruleId: "S-12", severity: "medium", scope: "setup", title: "Vendor without instructions", whyItMatters: "why",
        evidence: [{ kind: "file", ref: "CLAUDE.md", label: "CLAUDE.md", provenance: "observed.artifact" }],
        fix: { platform: "claude", summary: "add CLAUDE.md" }, thresholdKeys: [], tokensAffected: 0,
      }];
    },
  };
}

export function fakeSetup() {
  return {
    async buildSetupInventory({ repoRoot }) {
      return {
        repo: { name: path.basename(repoRoot), root: "cwd", git: false }, vendorsDetected: ["claude"], instructionFiles: [], skills: [], agents: [], hooks: [],
        mcpServers: [], commands: [], memory: { present: false, bytes: 0, files: 0, indexBytes: 0 }, settings: [], startupBudget: {},
      };
    },
  };
}

export function forbiddenKeys(value, found = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 64) return found;
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeys(item, found, depth + 1);
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (["content", "text", "stdout", "stderr", "prompt"].includes(key)) found.add(key);
    forbiddenKeys(nested, found, depth + 1);
  }
  return found;
}
