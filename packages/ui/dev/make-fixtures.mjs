/**
 * Generates the synthetic dev fixtures for the shell screens:
 *   dev/fixtures/overview.json, setup.json, findings.json, thresholds.json
 * Deterministic (seeded PRNG), type-conformant with packages/cli/src/ir/types.ts,
 * and free of any real transcript content. Re-run: `node dev/make-fixtures.mjs`.
 *
 * `node dev/make-fixtures.mjs --demo` writes the hosted-demo dataset to dev/demo/
 * instead (ADR-003 section 4): the same overview/setup/findings/thresholds files
 * plus one generated run per overview row, in the layout the static backend reads:
 *   demo/runs/<vendor>--<id>.json              run response (main full, children partial)
 *   demo/runs/<vendor>--<id>.scopes/<scope>.json   every full child scope (main is inside the run file)
 * Every number in overview.json and findings.json is derived from those runs.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateRun } from "./demo-runs.mjs";
import { contextAtSessionEnd } from "../../cli/src/index/overview.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.argv.includes("--demo");
const out = path.join(here, DEMO ? "demo" : "fixtures");

let seed = 20260902;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const NOW = new Date("2026-09-02T14:05:00Z");
const daysAgo = (d, h = 0) => new Date(NOW.getTime() - d * 86_400_000 - h * 3_600_000).toISOString();
const uuid = (n) => `${n.toString(16).padStart(8, "0")}-4c1d-4e2a-9b1f-${(n * 7919).toString(16).padStart(12, "0").slice(-12)}`;
const measured = (value, provenance) => ({ value: Math.round(value), provenance });

const PROJECTS = {
  "context-viewer": { key: "p-ctxv", displayName: "context-viewer", cwdHash: "3f9c1a", cwdDisplay: "~/projects/context-viewer" },
  "billing-api": { key: "p-bill", displayName: "billing-api", cwdHash: "77ab02", cwdDisplay: "~/work/billing-api" },
  "docs-site": { key: "p-docs", displayName: "docs-site", cwdHash: "c04d9e", cwdDisplay: "~/projects/docs-site" },
};
const WINDOW = { claude: measured(200_000, "estimated.local"), codex: measured(272_000, "observed.vendor") };

// ---------- runs ----------
// The repository the demo companion "was launched from" is context-viewer: every row of the repo
// overview belongs to it. `extra` rows are a second project (billing-api, docs-site) that only the
// All-projects overview lists (review cycle 2, #7).
const specs = [
  { n: 1, vendor: "claude", project: "context-viewer", day: 0.2, hours: 2.4, requests: 412, peak: 168_400, compactions: 3, subagents: 4, findings: [5, 3], model: "claude-sonnet-4-5", live: true },
  { n: 2, vendor: "claude", project: "context-viewer", day: 1.1, hours: 1.1, requests: 188, peak: 92_100, compactions: 0, subagents: 2, findings: [2, 1], model: "claude-sonnet-4-5" },
  { n: 3, vendor: "codex", project: "context-viewer", day: 1.6, hours: 3.2, requests: 264, peak: 221_900, compactions: 2, subagents: 2, findings: [4, 2], model: "gpt-5-codex", parent: true },
  { n: 4, vendor: "claude", project: "context-viewer", day: 2.3, hours: 0.6, requests: 71, peak: 44_300, compactions: 0, subagents: 0, findings: [1, 0], model: "claude-opus-4-1" },
  { n: 5, vendor: "claude", project: "context-viewer", day: 3.4, hours: 1.8, requests: 233, peak: 131_700, compactions: 1, subagents: 3, findings: [3, 1], model: "claude-sonnet-4-5" },
  { n: 6, vendor: "codex", project: "context-viewer", day: 4.0, hours: 0.9, requests: 96, peak: 78_500, compactions: 0, subagents: 0, findings: [1, 0], model: "gpt-5-codex" },
  { n: 7, vendor: "claude", project: "context-viewer", day: 6.5, hours: 4.7, requests: 611, peak: 176_200, compactions: 4, subagents: 6, findings: [6, 4], model: "claude-sonnet-4-5" },
  { n: 8, vendor: "claude", project: "context-viewer", day: 9.2, hours: 1.3, requests: 142, peak: 88_900, compactions: 0, subagents: 1, findings: [2, 0], model: "claude-opus-4-1" },
  { n: 9, vendor: "codex", project: "context-viewer", day: 12.8, hours: 2.1, requests: 175, peak: 149_300, compactions: 1, subagents: 0, findings: [2, 1], model: "gpt-5-codex" },
  { n: 10, vendor: "claude", project: "context-viewer", day: 18.4, hours: 0.4, requests: 38, peak: 31_200, compactions: 0, subagents: 0, findings: [0, 0], model: "claude-sonnet-4-5" },
  { n: 11, vendor: "claude", project: "context-viewer", day: 24.9, hours: 2.9, requests: 356, peak: 158_800, compactions: 2, subagents: 2, findings: [3, 2], model: "claude-sonnet-4-5" },
  { n: 12, vendor: "gemini", project: "context-viewer", day: 27.1, hours: 0.7, requests: 52, peak: 60_100, compactions: 0, subagents: 0, findings: [1, 0], model: "gemini-2.5-pro" },
  { n: 21, vendor: "claude", project: "billing-api", day: 0.8, hours: 1.4, requests: 160, peak: 121_300, compactions: 1, subagents: 2, findings: [2, 1], model: "claude-opus-4-1", extra: true },
  { n: 22, vendor: "codex", project: "billing-api", day: 5.3, hours: 1.0, requests: 110, peak: 97_800, compactions: 0, subagents: 0, findings: [1, 0], model: "gpt-5-codex", extra: true },
  { n: 23, vendor: "claude", project: "docs-site", day: 8.9, hours: 0.7, requests: 84, peak: 63_500, compactions: 0, subagents: 1, findings: [1, 0], model: "claude-sonnet-4-5", extra: true },
  { n: 24, vendor: "claude", project: "billing-api", day: 16.2, hours: 2.2, requests: 240, peak: 151_900, compactions: 1, subagents: 2, findings: [3, 1], model: "claude-opus-4-1", extra: true },
];

const runs = [];
const extraRuns = [];
const byN = new Map();
for (const s of specs) {
  const sessionId = uuid(s.n);
  const win = WINDOW[s.vendor] ?? measured(1_000_000, "estimated.local");
  const processed = Math.round(s.requests * s.peak * 0.62);
  const run = {
    id: `${s.vendor}:${sessionId}`,
    vendor: s.vendor,
    project: PROJECTS[s.project],
    startedAt: daysAgo(s.day, s.hours),
    endedAt: daysAgo(s.day),
    activeMs: Math.round(s.hours * 3_600_000 * 0.82),
    summary: {
      requests: s.requests,
      turns: Math.round(s.requests / 6),
      processedInputTokens: processed,
      outputTokens: Math.round(s.requests * between(180, 420)),
      cacheReadShare: Number((0.55 + rand() * 0.35).toFixed(3)),
      peak: measured(s.peak, "observed.vendor"),
      peakShareOfWindow: Number((s.peak / win.value).toFixed(3)),
      compactions: s.compactions,
      subagents: s.subagents,
      toolCalls: Math.round(s.requests * 0.7),
      models: [s.model],
      compositionAtPeak: { system: Math.round(s.peak * 0.11), instructions: Math.round(s.peak * 0.05), user: Math.round(s.peak * 0.04), assistant_text: Math.round(s.peak * 0.12), tool_call: Math.round(s.peak * 0.06), "tool_result.file": Math.round(s.peak * 0.31), "tool_result.shell": Math.round(s.peak * 0.16), "tool_result.search": Math.round(s.peak * 0.07), subagent_handoff: Math.round(s.peak * 0.05), attachments: Math.round(s.peak * 0.03) },
      compositionAtEnd: { system: Math.round(s.peak * 0.1), instructions: Math.round(s.peak * 0.04), user: Math.round(s.peak * 0.05), assistant_text: Math.round(s.peak * 0.14), tool_call: Math.round(s.peak * 0.08), "tool_result.file": Math.round(s.peak * 0.26), "tool_result.shell": Math.round(s.peak * 0.15), "tool_result.search": Math.round(s.peak * 0.05), subagent_handoff: Math.round(s.peak * 0.06), attachments: Math.round(s.peak * 0.03) },
    },
    window: win,
    findingsCount: s.findings[0],
    findingsHigh: s.findings[1],
    ...(s.live ? { live: { at: daysAgo(0, 0.002) } } : {}),
  };
  byN.set(s.n, run);
  (s.extra ? extraRuns : runs).push(run);
}

// Codex parent (n=3) with two thread_spawn children nested under it.
const parent = byN.get(3);
parent.children = [1, 2].map((k) => {
  const sessionId = uuid(300 + k);
  const peak = k === 1 ? 64_200 : 41_800;
  return {
    id: `codex:${sessionId}`,
    vendor: "codex",
    project: PROJECTS["context-viewer"],
    parentRunId: parent.id,
    agentType: "worker",
    startedAt: daysAgo(1.6, 2.6 - k * 0.4),
    endedAt: daysAgo(1.6, 1.9 - k * 0.4),
    activeMs: Math.round((0.6 - k * 0.1) * 3_600_000),
    summary: {
      requests: k === 1 ? 58 : 34, turns: 1, processedInputTokens: k === 1 ? 2_310_000 : 980_000, outputTokens: k === 1 ? 14_200 : 8_900,
      cacheReadShare: 0.71, peak: measured(peak, "observed.vendor"), peakShareOfWindow: Number((peak / 272_000).toFixed(3)),
      compactions: 0, subagents: 0, toolCalls: k === 1 ? 41 : 22, models: ["gpt-5-codex"],
      compositionAtPeak: { system: Math.round(peak * 0.2), user: Math.round(peak * 0.05), assistant_text: Math.round(peak * 0.15), "tool_result.file": Math.round(peak * 0.4), "tool_result.shell": Math.round(peak * 0.2) },
      compositionAtEnd: { system: Math.round(peak * 0.2), user: Math.round(peak * 0.06), assistant_text: Math.round(peak * 0.16), "tool_result.file": Math.round(peak * 0.37), "tool_result.shell": Math.round(peak * 0.19) },
    },
    window: WINDOW.codex,
    findingsCount: k === 1 ? 1 : 0,
    findingsHigh: 0,
  };
});

// ---------- findings ----------
const run1 = byN.get(1), run7 = byN.get(7), run3 = byN.get(3), run5 = byN.get(5);
const findings = [
  {
    id: "B-05:9f1c2a7d31", ruleId: "B-05", severity: "high", scope: "subagent", vendor: "claude", runId: run1.id,
    title: "Fat subagent handoff",
    whyItMatters: "A subagent exists to isolate context; this one returned 11,400 tokens (38% of its own peak) into the parent window.",
    evidence: [
      { kind: "block", ref: `${run1.id}#main:412`, label: "handoff block #main:412", value: 11_400, unit: "tokens", provenance: "estimated.local" },
      { kind: "scope", ref: `${run1.id}#agent-a71f`, label: "child peak (audit-deepdive)", value: 29_800, unit: "tokens", provenance: "observed.vendor" },
      { kind: "metric", ref: "ratio", label: "compression ratio", value: 2.6, unit: "ratio", provenance: "derived.exact" },
    ],
    fix: { platform: "claude", summary: "Constrain what the agent returns", path: ".claude/agents/audit-deepdive.md", snippet: "Return findings only: file:line references, decisions, and open questions. Under 600 words. Do not paste file contents or command output." },
    thresholdKeys: ["fatHandoffTokens", "fatHandoffShare"], tokensAffected: 11_400, recurrence: 3, count: 1, scopeId: "agent-a71f",
  },
  {
    id: "B-03:44e0b19c2f", ruleId: "B-03", severity: "high", scope: "session", vendor: "claude", runId: run7.id,
    title: "Huge file read",
    whyItMatters: "Large generated files are the most common cause of a single-turn window jump; this Read occupied 12% of the window until the next compaction.",
    evidence: [
      { kind: "block", ref: `${run7.id}#main:188`, label: "Read package-lock.json", value: 24_600, unit: "tokens", provenance: "estimated.local" },
      { kind: "request", ref: `${run7.id}#main#61`, label: "request 61 occupancy", value: 141_300, unit: "tokens", provenance: "observed.vendor" },
    ],
    fix: { platform: "claude", summary: "Read only the sections you need", snippet: "Read with offset/limit, or `sed -n 1,120p package-lock.json`. Add to CLAUDE.md: \"Never read lockfiles or build output in full.\"" },
    thresholdKeys: ["hugeFileReadTokens"], tokensAffected: 24_600, recurrence: 2, count: 1, scopeId: "main",
  },
  {
    id: "S-01:7ab3d0e5c1", ruleId: "S-01", severity: "high", scope: "setup", vendor: "claude",
    title: "Instruction file oversized",
    whyItMatters: "Instructions are resent on every request and sit at the top of the prompt; every 1k tokens there is paid on every turn and competes with task content for attention.",
    evidence: [
      { kind: "file", ref: "CLAUDE.md", label: "CLAUDE.md", value: 4_180, unit: "tokens", provenance: "estimated.local" },
      { kind: "metric", ref: "chain", label: "loaded chain total", value: 6_940, unit: "tokens", provenance: "estimated.local" },
    ],
    fix: { platform: "claude", summary: "Move path-specific guidance into scoped rules", path: ".claude/rules/api.md", snippet: "---\npaths:\n  - \"packages/api/**\"\n---\n# API conventions\n(move the API section of CLAUDE.md here; keep CLAUDE.md to conventions and pointers)" },
    thresholdKeys: ["instructionFileTokens", "instructionChainTokens"], tokensAffected: 4_180, recurrence: 9,
  },
  {
    id: "B-07:c31f9e8a02", ruleId: "B-07", severity: "high", scope: "session", vendor: "claude", runId: run7.id,
    title: "Frequent compaction",
    whyItMatters: "Each compaction discards state that later turns may need; four boundaries in 4.7 hours means the model rebuilt its working set four times.",
    evidence: [
      { kind: "run", ref: run7.id, label: "compactions in session", value: 4, unit: "count", provenance: "observed.vendor" },
      { kind: "request", ref: `${run7.id}#main#203`, label: "first auto compaction at request 203", value: 176_200, unit: "tokens", provenance: "observed.vendor" },
    ],
    fix: { platform: "claude", summary: "Split the task and fix the fat results first", snippet: "Start a fresh session per task (/clear), delegate exploration to subagents, and fix B-01/B-03 causes first." },
    thresholdKeys: ["compactionsPerSession", "compactionsPerHour"], tokensAffected: 3_900, recurrence: 2,
  },
  {
    id: "B-01:e21c7f5d90", ruleId: "B-01", severity: "high", scope: "session", vendor: "codex", runId: run3.id,
    title: "Fat tool result",
    whyItMatters: "One oversized result can occupy a tenth of the window until compaction and pushes the task instructions toward the lost-in-the-middle zone.",
    evidence: [
      { kind: "block", ref: `${run3.id}#main:97`, label: "shell: npm test", value: 9_850, unit: "tokens", provenance: "estimated.local" },
    ],
    fix: { platform: "codex", summary: "Cap command output", snippet: "npm test 2>&1 | tail -60\n# or lower [shell] truncation_policy.limit in ~/.codex/config.toml" },
    thresholdKeys: ["fatToolResultTokens"], tokensAffected: 9_850, recurrence: 1, count: 1, scopeId: "main",
  },
  {
    id: "S-08:0d4b7e2a66", ruleId: "S-08", severity: "medium", scope: "setup", vendor: "claude",
    title: "MCP schema bloat",
    whyItMatters: "Every tool schema is prompt text on every request; a 22-tool server can cost more than the entire CLAUDE.md.",
    evidence: [
      { kind: "file", ref: ".mcp.json", label: "server github: tools observed", value: 22, unit: "count", provenance: "observed.artifact" },
      { kind: "metric", ref: "mcpSchemaTokens", label: "estimated schema tokens at startup", value: 5_300, unit: "tokens", provenance: "estimated.local" },
    ],
    fix: { platform: "claude", summary: "Disable the server for this project or rely on deferred tool loading", snippet: "claude mcp remove github -s project\n# re-add at user scope only when needed: claude mcp add github -s user -- npx @modelcontextprotocol/server-github" },
    thresholdKeys: ["mcpServerTools", "mcpTotalTools"], tokensAffected: 5_300, recurrence: 9,
  },
  {
    id: "B-12:88a1c3f7de", ruleId: "B-12", severity: "medium", scope: "session", vendor: "claude", runId: run5.id,
    title: "Tool results dominate the window",
    whyItMatters: "The window should hold the task and decisions, not raw output; results are the most compressible content.",
    evidence: [
      { kind: "request", ref: `${run5.id}#main#144`, label: "tool_result.* share at peak (request 144)", value: 0.64, unit: "percent", provenance: "estimated.local" },
      { kind: "request", ref: `${run5.id}#main#144`, label: "peak occupancy", value: 131_700, unit: "tokens", provenance: "observed.vendor" },
    ],
    fix: { platform: "claude", summary: "Delegate exploration and prefer bounded searches", snippet: "Use the Explore agent for broad searches; Grep with head_limit; start a new phase after research." },
    thresholdKeys: ["toolResultsShareAtPeak"], tokensAffected: 4_200, recurrence: 4,
  },
  {
    id: "S-05:5c9e2b1a48", ruleId: "S-05", severity: "medium", scope: "setup", vendor: "claude",
    title: "Instruction references a missing path",
    whyItMatters: "The model trusts instructions; a dead path costs a failed tool call and a wrong assumption per session.",
    evidence: [
      { kind: "file", ref: ".claude/rules/testing.md", label: ".claude/rules/testing.md references scripts/test-all.sh", provenance: "observed.artifact" },
    ],
    fix: { platform: "both", summary: "Update or delete the reference", path: ".claude/rules/testing.md", snippet: "- Run `scripts/test-all.sh` before committing\n+ Run `npm test --workspaces` before committing" },
    thresholdKeys: [], tokensAffected: 900, recurrence: 9,
  },
  {
    id: "S-09:b7d13e4f09", ruleId: "S-09", severity: "medium", scope: "setup", vendor: "claude",
    title: "MCP server never used",
    whyItMatters: "Pure schema cost with no observed benefit: the server's tools were never invoked across 30 days of indexed sessions.",
    evidence: [
      { kind: "file", ref: ".mcp.json", label: "server postgres: invocations in 30 days", value: 0, unit: "count", provenance: "derived.exact" },
    ],
    fix: { platform: "claude", summary: "Disable it for this project; re-enable on demand", snippet: "claude mcp remove postgres -s project" },
    thresholdKeys: [], tokensAffected: 1_400, recurrence: 9,
  },
  {
    id: "S-12:2e6a9c0d77", ruleId: "S-12", severity: "medium", scope: "setup", vendor: "codex",
    title: "Codex sessions without AGENTS.md",
    whyItMatters: "Evidence shows repository instructions reduce runtime and output tokens for comparable completion; three Codex sessions ran here with no AGENTS.md.",
    evidence: [
      { kind: "metric", ref: "codexSessions", label: "Codex sessions for this repo", value: 3, unit: "count", provenance: "observed.artifact" },
    ],
    fix: { platform: "codex", summary: "Create AGENTS.md with conventions, build and test commands, and layout", path: "AGENTS.md", snippet: "# AGENTS.md\n## Build\nnpm install && npm run build\n## Test\nnpm test\n## Layout\npackages/cli (Node, zero deps), packages/ui (Preact)" },
    thresholdKeys: [], tokensAffected: 0, recurrence: 3,
  },
  {
    id: "B-11:a9c4e7f2b3", ruleId: "B-11", severity: "low", scope: "session", vendor: "claude", runId: run1.id,
    title: "Turn overhead",
    whyItMatters: "Each tiny follow-up resends the entire window; 14 requests carried under 50 new tokens on top of 150k+.",
    evidence: [
      { kind: "request", ref: `${run1.id}#main#377`, label: "example request 377 (new content 31 tok)", value: 162_900, unit: "tokens", provenance: "observed.vendor" },
      { kind: "metric", ref: "count", label: "requests matching", value: 14, unit: "count", provenance: "derived.exact" },
    ],
    fix: { platform: "claude", summary: "Batch small follow-ups and compact between phases", snippet: "/compact focus on the remaining migration steps" },
    thresholdKeys: ["turnOverheadRequests", "turnOverheadRequestTokens", "turnOverheadNewTokens"], tokensAffected: 2_280_000, recurrence: 5,
  },
  {
    id: "S-10:6f0b3d8e15", ruleId: "S-10", severity: "low", scope: "setup", vendor: "claude",
    title: "Memory index empty",
    whyItMatters: "Without memory, each session re-discovers the same facts through tool calls.",
    evidence: [
      { kind: "file", ref: "~/.claude/projects/-Users-me-projects-context-viewer/memory/MEMORY.md", label: "MEMORY.md", value: 0, unit: "chars", provenance: "observed.artifact" },
      { kind: "metric", ref: "sessions", label: "sessions for this repo", value: 6, unit: "count", provenance: "observed.artifact" },
    ],
    fix: { platform: "claude", summary: "Seed MEMORY.md with durable facts", path: "~/.claude/projects/-Users-me-projects-context-viewer/memory/MEMORY.md", snippet: "- Monorepo: packages/cli (Node ESM, zero deps) and packages/ui (Preact + esbuild)\n- Tests: node --test packages/cli/test\n- UI build output is committed to packages/cli/ui" },
    thresholdKeys: ["memoryMinSessions"], tokensAffected: 600, recurrence: 6,
  },
  {
    id: "B-15:d2a8f61c04", ruleId: "B-15", severity: "low", scope: "subagent", vendor: "claude", runId: run7.id,
    title: "Parallel subagents duplicated work",
    whyItMatters: "Parallel agents that duplicate work double cost without adding coverage; two children read the same four files.",
    evidence: [
      { kind: "scope", ref: `${run7.id}#agent-3b2c`, label: "agent-3b2c (Explore)", value: 4, unit: "count", provenance: "observed.artifact" },
      { kind: "scope", ref: `${run7.id}#agent-9e41`, label: "agent-9e41 (Explore)", value: 4, unit: "count", provenance: "observed.artifact" },
    ],
    fix: { platform: "claude", summary: "Give each subagent a disjoint scope in the delegation prompt", snippet: "Agent A: only packages/cli/src/adapters/**. Agent B: only packages/cli/src/index/**. Do not read outside your scope." },
    thresholdKeys: ["parallelDuplicateFiles"], tokensAffected: 8_100, recurrence: 1, count: 2, scopeId: "agent-3b2c",
  },
];

// Cross-session habit findings (ADR-003 §2, rules H-01..H-06): `scope: "habit"`, `sessions` = distinct top-level runs.
const habitFindings = [
  {
    id: "H-01:3e8c1b7a90", ruleId: "H-01", severity: "high", scope: "habit", vendor: "claude", sessions: 5,
    title: "Read keeps returning fat results",
    whyItMatters: "The same tool produces results over 3,000 tokens in 5 of 7 sessions of this repository; this is a habit an instruction line can change, not a one-off.",
    evidence: [
      { kind: "metric", ref: "tool:Read", label: "Read results over 3,000 tokens", value: 41, unit: "count", provenance: "derived.exact" },
      { kind: "metric", ref: "sessions", label: "sessions affected", value: 5, unit: "count", provenance: "derived.exact" },
      { kind: "run", ref: run7.id, label: "largest in session", value: 24_600, unit: "tokens", provenance: "estimated.local" },
    ],
    fix: { platform: "claude", summary: "Add a standing rule for targeted reads", path: "CLAUDE.md", snippet: "Never read lockfiles, build output or generated files in full. Read with offset/limit or grep for the symbol." },
    thresholdKeys: ["repeatedFatResultTokens", "repeatedFatResultCount"], tokensAffected: 412_000, recurrence: 5,
  },
  {
    id: "H-02:9a41d0c6e2", ruleId: "H-02", severity: "medium", scope: "habit", vendor: "claude", sessions: 4,
    title: "Whole-file re-reads of the same files",
    whyItMatters: "Four files were read in full in 4 sessions each; every re-read pays their size again and the model never needed all of it.",
    evidence: [
      { kind: "metric", ref: "file:package-lock.json", label: "package-lock.json read whole", value: 4, unit: "count", provenance: "derived.exact" },
      { kind: "metric", ref: "file:docs/adr-001-product-architecture.md", label: "docs/adr-001-product-architecture.md read whole", value: 4, unit: "count", provenance: "derived.exact" },
      { kind: "run", ref: run1.id, label: "example session", provenance: "observed.artifact" },
    ],
    fix: { platform: "claude", summary: "Point the model at the sections it needs", path: "CLAUDE.md", snippet: "docs/adr-001-product-architecture.md: read section 5.3 (IR) only unless asked for the whole ADR." },
    thresholdKeys: ["subagentRereadFiles"], tokensAffected: 96_000, recurrence: 4,
  },
  {
    id: "H-03:5b2f7e9d14", ruleId: "H-03", severity: "medium", scope: "habit", vendor: "claude", sessions: 3,
    title: "Explore agents return verbose handoffs",
    whyItMatters: "Median handoff of the Explore agent is 6,100 tokens at 4.2x compression across 3 sessions; a subagent that returns a third of what it read is not isolating context.",
    evidence: [
      { kind: "metric", ref: "agent:Explore", label: "median handoff (Explore)", value: 6_100, unit: "tokens", provenance: "estimated.local" },
      { kind: "metric", ref: "ratio", label: "median compression", value: 4.2, unit: "ratio", provenance: "derived.exact" },
      { kind: "scope", ref: `${run7.id}#agent-3b2c`, label: "fattest instance", value: 6_900, unit: "tokens", provenance: "estimated.local" },
    ],
    fix: { platform: "claude", summary: "Constrain the return format in the agent definition", path: ".claude/agents/explore.md", snippet: "Return file:line references and one sentence per finding. Under 400 words. Never paste file contents." },
    thresholdKeys: ["fatHandoffTokens", "fatHandoffShare"], tokensAffected: 18_300, recurrence: 3,
  },
];
findings.push(...habitFindings);

// Aggregated per-block findings (ADR-002 B): one B-01 per run × scope with `count`, up to 5 evidence blocks.
const fatRuns = [
  { run: run1, scope: "main", count: 23, top: [["Read", "src/generated/schema.ts", 9_400], ["Bash", "npm test", 8_900], ["Read", "package-lock.json", 8_200], ["Grep", "Grep useState", 6_100], ["Read", "docs/adr-001.md", 5_300]], tokens: 118_000 },
  { run: run7, scope: "main", count: 41, top: [["Read", "package-lock.json", 24_600], ["Bash", "node --test", 12_100], ["Read", "src/index/manifest.mjs", 7_800], ["WebFetch", "docs.anthropic.com", 7_200], ["Bash", "git diff", 5_900]], tokens: 236_000 },
  { run: run7, scope: "agent-3b2c", count: 9, top: [["Read", "src/adapters/claude.mjs", 6_700], ["Grep", "Grep compactMetadata", 4_100], ["Read", "README.md", 3_600]], tokens: 41_000 },
  { run: run5, scope: "main", count: 12, top: [["WebFetch", "docs.example.dev", 8_700], ["Read", "content/guide.md", 6_400], ["Bash", "npm run build", 4_200]], tokens: 58_000 },
  { run: byN.get(11), scope: "agent-c2d1", count: 7, top: [["Read", "src/generated/schema.ts", 8_120], ["Bash", "npm test", 3_900]], tokens: 29_000 },
  { run: byN.get(2), scope: "main", count: 4, top: [["Read", "packages/ui/src/screens/Session.tsx", 5_100], ["Bash", "npm run typecheck", 3_200]], tokens: 15_000 },
];
for (const [i, r] of fatRuns.entries()) {
  findings.push({
    id: `B-01:${(0x1a2b3c + i * 7919).toString(16)}`, ruleId: "B-01", severity: r.top[0][2] >= 20_000 ? "high" : "medium", scope: r.scope === "main" ? "session" : "subagent", vendor: r.run.vendor, runId: r.run.id, scopeId: r.scope,
    title: "Fat tool result", count: r.count,
    whyItMatters: `${r.count} tool results over 3,000 tokens entered ${r.scope === "main" ? "the main scope" : r.scope} and were resent on every request until dropped; the largest is ${r.top[0][2].toLocaleString()} tokens.`,
    evidence: r.top.map(([tool, label, value], k) => ({ kind: "block", ref: `${r.run.id}#${r.scope}:${100 + k * 37}`, label: `${tool} ${label}`, value, unit: "tokens", provenance: "estimated.local" })),
    fix: { platform: r.run.vendor === "codex" ? "codex" : "claude", summary: "Read with offset/limit or grep for the symbol instead of loading whole files; pipe shell output through head.", snippet: "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000.", path: r.run.vendor === "codex" ? "AGENTS.md" : "CLAUDE.md" },
    thresholdKeys: ["fatToolResultTokens"], tokensAffected: r.tokens, recurrence: 5,
  });
}
const b02 = {
  id: "B-02:9c7e21ab04", ruleId: "B-02", severity: "high", scope: "session", vendor: "claude", runId: run7.id, scopeId: "main",
  title: "Repeated fat results", count: fatRuns.reduce((s, r) => s + r.count, 0),
  whyItMatters: "The same tools keep returning fat results in 5 of 7 sessions; this is a habit the instruction file can change, not a one-off.",
  evidence: [
    { kind: "metric", ref: "sessions", label: "sessions with fat results", value: 5, unit: "count", provenance: "derived.exact" },
    { kind: "metric", ref: "count", label: "fat results in 30 days", value: fatRuns.reduce((s, r) => s + r.count, 0), unit: "count", provenance: "derived.exact" },
    { kind: "block", ref: `${run7.id}#main:188`, label: "largest: Read package-lock.json", value: 24_600, unit: "tokens", provenance: "estimated.local" },
  ],
  fix: { platform: "claude", summary: "Prefer targeted reads", path: "CLAUDE.md", snippet: "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000. Never read lockfiles or build output in full." },
  thresholdKeys: ["repeatedFatResultTokens", "repeatedFatResultCount"], tokensAffected: fatRuns.reduce((s, r) => s + r.tokens, 0), recurrence: 5,
};
findings.unshift(b02);
const SEV = { high: 3, medium: 2, low: 1 };
findings.sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || ((b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)) || a.id.localeCompare(b.id));
const firstChange = { ...b02, removes: { findings: fatRuns.length, sessions: 5 } };

// ---------- trends (30 days) ----------
const days = Array.from({ length: 30 }, (_, i) => daysAgo(29 - i).slice(0, 10));
const trend = (base, jitter, spikes = {}) => days.map((_, i) => Math.round(Math.max(0, base + (rand() - 0.5) * jitter + (spikes[i] ?? 0))));
const sessionsPerDay = days.map((_, i) => ({ 29: 2, 28: 1, 27: 1, 26: 1, 25: 1, 23: 1, 20: 1, 17: 1, 11: 1, 5: 1, 2: 1 })[i] ?? 0);
const trends = {
  days,
  processedInputTokens: trend(9_000_000, 8_000_000, { 29: 26_000_000, 28: 9_000_000, 23: 31_000_000, 17: 5_000_000, 5: 20_000_000 }),
  requests: trend(120, 110, { 29: 420, 28: 180, 23: 610, 17: 160, 5: 356 }),
  compactions: days.map((_, i) => ({ 29: 3, 28: 0, 27: 2, 26: 1, 23: 4, 20: 0, 17: 1, 5: 2 })[i] ?? (rand() < 0.15 ? 1 : 0)),
  subagents: days.map((_, i) => ({ 29: 4, 28: 2, 27: 2, 26: 3, 23: 6, 20: 1, 17: 0, 5: 2 })[i] ?? (rand() < 0.3 ? between(1, 2) : 0)),
  // Cycle-2 series (ADR-003 §2): zero on days without a session, as a real companion reports them.
  sessions: sessionsPerDay,
  peakShareMedian: sessionsPerDay.map((n) => (n ? Number((0.4 + rand() * 0.5).toFixed(3)) : 0)),
  startupH0Median: sessionsPerDay.map((n, i) => (n ? 22_000 + (i > 26 ? -1_200 : 0) + between(-800, 800) : 0)),
  instructionEdits: [{ path: "CLAUDE.md", at: daysAgo(3) }, { path: ".claude/rules/ui.md", at: daysAgo(12) }],
};

const allRuns = [...runs, ...parent.children];
const totals = {
  runs: allRuns.length,
  subagents: allRuns.reduce((s, r) => s + r.summary.subagents, 0),
  requests: allRuns.reduce((s, r) => s + r.summary.requests, 0),
  processedInputTokens: allRuns.reduce((s, r) => s + r.summary.processedInputTokens, 0),
  outputTokens: allRuns.reduce((s, r) => s + r.summary.outputTokens, 0),
  cacheReadShare: Number((allRuns.reduce((s, r) => s + r.summary.cacheReadShare * r.summary.processedInputTokens, 0) / allRuns.reduce((s, r) => s + r.summary.processedInputTokens, 0)).toFixed(3)),
  compactions: allRuns.reduce((s, r) => s + r.summary.compactions, 0),
  vendors: ["claude", "codex", "gemini"],
};

const overview = {
  scope: { mode: "repo", repo: { name: "context-viewer", key: PROJECTS["context-viewer"].key }, sessions: runs.length, machineSessions: runs.length + extraRuns.length + 2, unattributed: 2 },
  range: "all",
  since: null,
  runs,
  totals,
  trends,
  contextAtEnd: contextAtSessionEnd(runs),
  topOffenders: {
    largestBlocks: [
      { runId: run7.id, scopeId: "main", blockId: "main:188", category: "tool_result.file", estTokens: 24_600, firstRequest: 61, tool: "Read", label: "package-lock.json" },
      { runId: run1.id, scopeId: "main", blockId: "main:230", category: "tool_result.search", estTokens: 14_900, firstRequest: 118, tool: "Grep", label: "Grep useState" },
      { runId: run1.id, scopeId: "main", blockId: "main:412", category: "subagent_handoff", estTokens: 11_400, firstRequest: 201, tool: "Agent", label: "audit-deepdive handoff" },
      { runId: run3.id, scopeId: "main", blockId: "main:97", category: "tool_result.shell", estTokens: 9_850, firstRequest: 40, tool: "shell", label: "npm test" },
      { runId: run5.id, scopeId: "main", blockId: "main:301", category: "tool_result.web", estTokens: 8_700, firstRequest: 144, tool: "WebFetch", label: "docs.example.dev" },
      { runId: byN.get(11).id, scopeId: "agent-c2d1", blockId: "agent-c2d1:44", category: "tool_result.file", estTokens: 8_120, firstRequest: 12, tool: "Read", label: "src/generated/schema.ts" },
    ],
    fattestHandoffs: [
      { runId: run1.id, scopeId: "agent-a71f", agentType: "audit-deepdive", handoffTokens: 11_400, childPeak: 29_800, ratio: 2.6 },
      { runId: run7.id, scopeId: "agent-3b2c", agentType: "Explore", handoffTokens: 6_900, childPeak: 48_200, ratio: 7.0 },
      { runId: run5.id, scopeId: "agent-77aa", agentType: "general-purpose", handoffTokens: 5_200, childPeak: 22_100, ratio: 4.3 },
      { runId: run3.id, scopeId: "thread-2", agentType: "worker", handoffTokens: 4_400, childPeak: 41_800, ratio: 9.5 },
      { runId: byN.get(11).id, scopeId: "agent-c2d1", agentType: "Plan", handoffTokens: 3_100, childPeak: 35_600, ratio: 11.5 },
    ],
    mostCompacted: [
      { runId: run7.id, compactions: 4, processedInputTokens: run7.summary.processedInputTokens },
      { runId: run1.id, compactions: 3, processedInputTokens: run1.summary.processedInputTokens },
      { runId: run3.id, compactions: 2, processedInputTokens: run3.summary.processedInputTokens },
      { runId: byN.get(11).id, compactions: 2, processedInputTokens: byN.get(11).summary.processedInputTokens },
      { runId: run5.id, compactions: 1, processedInputTokens: run5.summary.processedInputTokens },
    ],
  },
  firstFinding: firstChange,
  // ADR-002 C: `files` is the corpus size, `lastPass` the last indexing pass; `total/done` are legacy aliases of the pass.
  index: { files: 14, indexed: 14, failed: 0, runsInRange: allRuns.length, state: "idle", lastPass: { parsed: 3, skipped: 11, failed: 0, ms: 1840, at: daysAgo(0, 0.035) }, total: 3, done: 3, lastRunAt: daysAgo(0, 0.035) },
};

// ---------- setup inventory ----------
const setupFindings = findings.filter((f) => f.scope === "setup");
const setup = {
  repo: { name: "context-viewer", root: "cwd", git: true },
  vendorsDetected: ["claude", "codex"],
  instructionFiles: [
    { path: "~/.claude/CLAUDE.md", scope: "user", vendors: ["claude"], bytes: 2_140, estTokens: 560, precedence: 1, mtime: daysAgo(94), loadState: "observed.loaded", brokenRefs: [] },
    { path: "CLAUDE.md", scope: "project", vendors: ["claude"], bytes: 16_900, estTokens: 4_180, precedence: 2, mtime: daysAgo(3), loadState: "observed.loaded", brokenRefs: [] },
    { path: ".claude/CLAUDE.local.md", scope: "local", vendors: ["claude"], bytes: 780, estTokens: 210, precedence: 3, mtime: daysAgo(41), loadState: "expected.load", brokenRefs: [] },
    { path: ".claude/rules/testing.md", scope: "rules", vendors: ["claude"], bytes: 3_420, estTokens: 860, precedence: 4, mtime: daysAgo(210), loadState: "expected.load", brokenRefs: ["scripts/test-all.sh"], pathsFrontmatter: [] },
    { path: ".claude/rules/ui.md", scope: "rules", vendors: ["claude"], bytes: 4_510, estTokens: 1_130, precedence: 5, mtime: daysAgo(12), loadState: "discoverable", brokenRefs: [], pathsFrontmatter: ["packages/ui/**"] },
    { path: "packages/cli/CLAUDE.md", scope: "nested", vendors: ["claude"], bytes: 2_980, estTokens: 740, precedence: 6, mtime: daysAgo(20), loadState: "discoverable", brokenRefs: ["packages/cli/docs/api.md", "scripts/release.sh"] },
    { path: "AGENTS.md", scope: "project", vendors: ["codex"], bytes: 0, estTokens: 0, precedence: 1, mtime: daysAgo(0), loadState: "discoverable", brokenRefs: [] },
  ].filter((f) => f.bytes > 0),
  skills: [
    { name: "release-notes", path: ".claude/skills/release-notes/SKILL.md", scope: "project", hasDescription: true, descriptionChars: 212, bodyEstTokens: 1_840, frontmatterValid: true, invocations30d: 7 },
    { name: "db-migrate", path: ".claude/skills/db-migrate/SKILL.md", scope: "project", hasDescription: false, descriptionChars: 0, bodyEstTokens: 960, frontmatterValid: true, invocations30d: 0 },
    { name: "dataviz", path: "~/.claude/skills/dataviz/SKILL.md", scope: "user", hasDescription: true, descriptionChars: 1_080, bodyEstTokens: 3_320, frontmatterValid: false, invocations30d: 3 },
    { name: "pr-review", path: "~/.claude/plugins/cache/reviewer/skills/pr-review/SKILL.md", scope: "plugin", hasDescription: true, descriptionChars: 14, bodyEstTokens: 2_150, frontmatterValid: true, invocations30d: 12 },
  ],
  agents: [
    { name: "audit-deepdive", path: ".claude/agents/audit-deepdive.md", scope: "project", model: "sonnet", tools: ["Read", "Grep", "Glob", "Bash"], descriptionChars: 240, runs30d: 5 },
    { name: "docs-writer", path: ".claude/agents/docs-writer.md", scope: "project", model: "haiku", tools: ["Read", "Write", "Edit"], descriptionChars: 118, runs30d: 2 },
    { name: "security-scan", path: "~/.claude/agents/security-scan.md", scope: "user", descriptionChars: 310, runs30d: 0 },
  ],
  hooks: [
    { event: "PostToolUse", matcher: "Edit|Write", command: "npm run lint --silent -- --fix", scope: "project", runs30d: 214, stdoutP50: 40, stdoutP95: 2_380 },
    { event: "Stop", command: "git status --short | head -20", scope: "project", runs30d: 61, stdoutP50: 90, stdoutP95: 310 },
    { event: "SessionStart", command: "echo \"branch: $(git branch --show-current)\"", scope: "user", runs30d: 18, stdoutP50: 12, stdoutP95: 14 },
  ],
  mcpServers: [
    { name: "github", scope: "project", transport: "stdio", toolsObserved: Array.from({ length: 22 }, (_, i) => `mcp__github__${["list_issues", "get_issue", "create_issue", "update_issue", "list_pull_requests", "get_pull_request", "create_pull_request", "merge_pull_request", "list_commits", "get_commit", "search_code", "search_issues", "list_branches", "create_branch", "get_file_contents", "push_files", "create_or_update_file", "list_workflows", "run_workflow", "get_workflow_run", "list_releases", "create_release"][i]}`), invocations30d: 41 },
    { name: "postgres", scope: "project", transport: "stdio", toolsObserved: ["mcp__postgres__query", "mcp__postgres__list_tables", "mcp__postgres__describe_table"], invocations30d: 0 },
    { name: "claude-in-chrome", scope: "user", transport: "stdio", toolsObserved: ["mcp__claude-in-chrome__navigate", "mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__read_page", "mcp__claude-in-chrome__find", "mcp__claude-in-chrome__read_console_messages"], invocations30d: 27 },
  ],
  commands: [{ name: "ship", path: ".claude/commands/ship.md" }, { name: "triage", path: ".claude/commands/triage.md" }],
  memory: { present: true, bytes: 18_440, files: 4, indexBytes: 0 },
  settings: [
    { path: "~/.claude/settings.json", scope: "user", keys: ["model", "hooks", "permissions"] },
    { path: ".claude/settings.json", scope: "project", keys: ["hooks", "permissions", "enabledMcpjsonServers"] },
    { path: ".claude/settings.local.json", scope: "local", keys: ["permissions"] },
  ],
  startupBudget: {
    claude: { instructions: measured(5_810, "estimated.local"), skills: measured(330, "estimated.local"), agents: measured(170, "estimated.local"), mcpTools: measured(6_900, "estimated.local"), total: measured(13_210, "estimated.local") },
    codex: { instructions: measured(2_450, "observed.artifact"), skills: measured(0, "estimated.local"), agents: measured(0, "estimated.local"), mcpTools: measured(1_100, "estimated.local"), total: measured(3_550, "estimated.local") },
  },
  findings: setupFindings,
  // Instruction files found under fixture directories: listed, never counted (ADR-003 §1; types.ts `excluded`).
  excluded: [
    { path: "packages/cli/test/fixtures/repo-a/CLAUDE.md", reason: "fixture" },
    { path: "packages/cli/test/fixtures/repo-a/.claude/rules/api.md", reason: "fixture" },
    { path: "packages/cli/test/fixtures/repo-b/AGENTS.md", reason: "fixture" },
  ],
};

const thresholds = {
  fatToolResultTokens: 8000, repeatedFatResultTokens: 3000, repeatedFatResultCount: 5, hugeFileReadTokens: 20000, identicalCallCount: 3,
  fatHandoffTokens: 4000, fatHandoffShare: 0.4, subagentRereadFiles: 3, compactionsPerHour: 1, compactionsPerSession: 3,
  runningHotShare: 0.8, runningHotRequests: 10, cacheChurnShare: 0.2, cacheChurnRequestShare: 0.3, systemShareOfWindow: 0.25,
  turnOverheadNewTokens: 50, turnOverheadRequestTokens: 100000, turnOverheadRequests: 10, toolResultsShareAtPeak: 0.6,
  sessionProcessedTokens: 3000000, sessionHours: 4, searchFloodTokens: 4000, parallelDuplicateFiles: 3,
  instructionFileTokens: 3000, instructionChainTokens: 6000, skillDescriptionMinChars: 20, skillDescriptionMaxChars: 1024,
  noRulesInstructionTokens: 1500, staleInstructionDays: 180, staleInstructionCommits: 50, mcpServerTools: 15, mcpTotalTools: 40,
  memoryMinSessions: 5, hookStdoutTokens: 1500, hookStdoutRunShare: 0.2,
};

const write = (name, data, pretty = true) => writeFile(path.join(out, name), pretty ? JSON.stringify(data, null, 2) + "\n" : JSON.stringify(data));

if (!DEMO) {
  await mkdir(out, { recursive: true });
  await Promise.all([
    write("overview.json", overview),
    write("setup.json", setup),
    write("findings.json", { findings, firstChange }),
    write("thresholds.json", thresholds),
  ]);
  console.log(`wrote ${out}/{overview,setup,findings,thresholds}.json (${allRuns.length} runs, ${findings.length} findings)`);
} else {
  await writeDemo();
}

// ---------- demo dataset (--demo) ----------
/**
 * One generated run per overview row. Request counts, compactions and subagent
 * counts come from `specs`; peaks, totals, trends and offenders are read back
 * from the generated runs so every screen agrees with every other.
 */
async function writeDemo() {
  const AGENT_TYPES = ["Explore", "general-purpose", "Plan", "code-reviewer", "docs-writer"];
  const agentId = () => `agent-${Math.floor(rand() * 0xffff).toString(16).padStart(4, "0")}`;
  const spread = (count, n, lo = 0.2, hi = 0.85) => Array.from({ length: n }, (_, k) => Math.floor(count * (lo + ((hi - lo) * (k + 1)) / (n + 1))));
  // Compactions land when the window fills, so boundaries sit at even fractions of the session.
  const compactAt = (s) => (s.compactions ? spread(s.requests, s.compactions, 0, 1) : []);
  const longestSegment = (count, boundaries) => Math.max(...[...boundaries, count].map((b, i) => b - (i === 0 ? 0 : boundaries[i - 1])));
  const TOKENS_PER_REQUEST = 1_800; // visible growth per request at size 1 (calibrated against the sample fixture)
  const codexChildIds = [uuid(301), uuid(302)];
  const results = [];
  const generated = new Map();

  for (const s of specs) {
    if (s.vendor === "gemini") continue;
    const sessionId = uuid(s.n);
    const startMs = NOW.getTime() - s.day * 86_400_000 - s.hours * 3_600_000;
    const day = new Date(startMs).toISOString().slice(0, 10).replace(/-/g, "/");
    const requests = s.requests;
    const isCodex = s.vendor === "codex";
    const subagents = [];
    if (s.parent) {
      // Codex parent: two thread_spawn children live in their own rollouts (nested overview rows), so the
      // parent scope keeps the launch blocks only.
      subagents.push({ id: codexChildIds[0], at: Math.floor(requests * 0.3), agentType: "worker", count: 58, handoffBytes: 15_800, description: "Migrate invoice tax rates" });
      subagents.push({ id: codexChildIds[1], at: Math.floor(requests * 0.55), agentType: "worker", count: 34, handoffBytes: 6_400, description: "Add controller tests" });
    } else {
      for (const [k, at] of spread(requests, s.subagents, 0.1, 0.9).entries()) {
        const type = AGENT_TYPES[(k + s.n) % AGENT_TYPES.length];
        subagents.push({ id: agentId(), at, agentType: type, count: between(14, 60), handoffBytes: k === 0 && s.n === 1 ? 41_000 : k % 3 === 2 ? between(20_000, 36_000) : between(2_000, 12_000), open: k === s.subagents - 1 && s.n === 7, nested: k === 1 && s.n === 7, description: `${type} task ${k + 1}` });
      }
    }
    const window = isCodex ? 272_000 : 200_000;
    const baseSystem = isCodex ? 12_400 : 18_400;
    const baseInstructions = isCodex ? 2_450 : 4_600;
    const unlogged0 = s.n === 7 ? 62_000 : 0; // a resumed session: earlier history the transcript does not carry
    // Block-size multiplier so the main scope's peak lands near the spec's peak; refined by re-generating (deterministic seed).
    let size = Math.min(1.2, Math.max(0.08, (s.peak - baseSystem - baseInstructions - unlogged0) / (TOKENS_PER_REQUEST * longestSegment(requests, compactAt(s)))));
    const spec = {
      seed: 20260900 + s.n * 97, vendor: s.vendor, sessionId, project: PROJECTS[s.project], projectName: s.project, day,
      startMs, mainCount: requests, compactAt: compactAt(s), subagents, window, forecast: !!s.live,
      baseSystem, baseInstructions,
      models: isCodex ? ["gpt-5-codex"] : [s.model, s.model === "claude-sonnet-4-5" ? "claude-opus-4-1" : "claude-sonnet-4-5"],
      unlogged0,
      steps: s.n === 1 ? [{ at: Math.floor(requests * 0.25), delta: 18_000 }] : s.n === 7 ? [{ at: Math.floor(requests * 0.5), delta: -41_000 }] : [],
      size, idleGapAt: s.n === 1 ? 0.575 : undefined, cliVersion: isCodex ? "0.150.1" : "2.1.258", gitBranch: ["main", "feat/tax-rates", "docs/cli-reference"][s.n % 3],
    };
    let result = generateRun(spec);
    for (let attempt = 0; attempt < 4; attempt++) {
      const ratio = s.peak / result.run.summary.peak.value;
      if (Math.abs(ratio - 1) < 0.12) break;
      size = Math.min(1.2, Math.max(0.08, size * ratio));
      result = generateRun({ ...spec, size });
    }
    generated.set(s.n, { spec: s, ...result });
    results.push(result);
    if (s.parent) {
      for (const [k, childId] of codexChildIds.entries()) {
        const child = generateRun({
          seed: 20269000 + k, vendor: "codex", sessionId: childId, project: PROJECTS[s.project], projectName: s.project, day,
          startMs: startMs + (0.3 + k * 0.25) * s.hours * 3_600_000, mainCount: k === 0 ? 58 : 34, compactAt: [], subagents: [], window,
          baseSystem: 9_800, baseInstructions: 2_450, models: ["gpt-5-codex"], size: 0.3, cliVersion: "0.150.1", gitBranch: "feat/tax-rates", parentRunId: result.run.id,
        });
        generated.set(300 + k + 1, { spec: { ...s, n: 300 + k + 1, child: true }, ...child });
        results.push(child);
      }
    }
  }

  const rowOf = ({ run, spec: sp }) => {
    const { topBlocks, findingIds, ...summary } = run.summary;
    return { id: run.id, vendor: run.vendor, project: run.project, startedAt: run.startedAt, endedAt: run.endedAt, activeMs: run.activeMs, summary, window: run.window, findingsCount: run.findings.length, findingsHigh: run.findings.filter((f) => f.severity === "high").length, ...(run.gitBranch ? { gitBranch: run.gitBranch } : {}), ...(run.parentRunId ? { parentRunId: run.parentRunId, agentType: "worker" } : {}), ...(sp.live ? { live: { at: new Date(NOW.getTime() - 90_000).toISOString() } } : {}) };
  };
  // A session is a top-level run; Codex thread_spawn children are subagents of their parent (ADR-004 §2).
  const allTop = [...generated.values()].filter((g) => !g.spec.child);
  const topRuns = allTop.filter((g) => !g.spec.extra);
  const extraTop = allTop.filter((g) => g.spec.extra);
  const rowsOf = (list) => list.map((g) => {
    const row = rowOf(g);
    if (g.spec.parent) row.children = [...generated.values()].filter((c) => c.spec.child).map(rowOf);
    return row;
  });
  const rows = rowsOf(topRuns);
  const everyRun = [...generated.values()].filter((g) => !g.spec.extra);
  const sessionFindings = everyRun.flatMap((g) => g.run.findings);

  // Cross-session habit: repeated fat results (B-02) over the B-01 findings of the repo's sessions.
  // A session is a top-level run: findings of Codex children count toward their parent (ADR-004 §2).
  const rootOf = (runId) => { const g = [...generated.values()].find((x) => x.run.id === runId); return g?.run.parentRunId ?? runId; };
  const b01 = sessionFindings.filter((f) => f.ruleId === "B-01");
  const b02Demo = {
    id: "B-02:9c7e21ab04", ruleId: "B-02", severity: "high", scope: "session", vendor: "claude", runId: generated.get(7).run.id, scopeId: "main",
    title: "Repeated fat results", count: b01.reduce((s, f) => s + (f.count ?? 1), 0),
    whyItMatters: `The same tools keep returning fat results in ${new Set(b01.map((f) => rootOf(f.runId))).size} of ${topRuns.length} sessions; this is a habit the instruction file can change, not a one-off.`,
    evidence: [
      { kind: "metric", ref: "sessions", label: "sessions with fat results", value: new Set(b01.map((f) => rootOf(f.runId))).size, unit: "count", provenance: "derived.exact" },
      { kind: "metric", ref: "count", label: "fat results in 30 days", value: b01.reduce((s, f) => s + (f.count ?? 1), 0), unit: "count", provenance: "derived.exact" },
      ...b01.flatMap((f) => f.evidence.slice(0, 1)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 1),
    ],
    fix: { platform: "claude", summary: "Prefer targeted reads", path: "CLAUDE.md", snippet: "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000. Never read lockfiles or build output in full." },
    thresholdKeys: ["repeatedFatResultTokens", "repeatedFatResultCount"], tokensAffected: b01.reduce((s, f) => s + (f.tokensAffected ?? 0), 0),
  };
  const sessionsByRule = new Map();
  for (const f of sessionFindings) sessionsByRule.set(f.ruleId, (sessionsByRule.get(f.ruleId) ?? new Set()).add(rootOf(f.runId)));
  const demoHabits = habitFindings.map((f) => ({ ...f, evidence: f.evidence.map((e) => (e.kind === "run" ? { ...e, ref: generated.get(7).run.id } : e.kind === "scope" ? { ...e, ref: `${generated.get(7).run.id}#${Object.keys(generated.get(7).scopes)[1] ?? "main"}` } : e)) }));
  const demoFindings = [b02Demo, ...sessionFindings, ...setupFindings, ...demoHabits].map((f) => ({ ...f, recurrence: f.scope === "habit" ? f.sessions : f.scope === "setup" ? (["S-01", "S-02", "S-06"].includes(f.ruleId) ? topRuns.length : 1) : f.ruleId === "B-02" ? sessionsByRule.get("B-01")?.size ?? 1 : sessionsByRule.get(f.ruleId)?.size ?? 1 }));
  demoFindings.sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || ((b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)) || ((b.recurrence ?? 0) - (a.recurrence ?? 0)) || a.id.localeCompare(b.id));
  const groupMap = new Map();
  for (const f of demoFindings) {
    const g = groupMap.get(f.ruleId) ?? { ruleId: f.ruleId, title: f.title, severity: f.severity, scope: f.scope, sessions: f.recurrence ?? 1, occurrences: 0, tokensAffected: 0, findings: [] };
    g.occurrences += f.count ?? 1; g.tokensAffected += f.tokensAffected ?? 0; g.sessions = Math.max(g.sessions, f.recurrence ?? 1);
    if (SEV[f.severity] > SEV[g.severity]) g.severity = f.severity;
    g.findings.push(f); groupMap.set(f.ruleId, g);
  }
  const groups = [...groupMap.values()].sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || b.tokensAffected - a.tokensAffected || b.sessions - a.sessions || a.ruleId.localeCompare(b.ruleId));
  const demoFirst = { ...b02Demo, recurrence: sessionsByRule.get("B-01")?.size ?? 1, removes: { findings: b01.length, sessions: sessionsByRule.get("B-01")?.size ?? 0 } };

  // Trends: per-day sums over the generated runs (sparse days stay zero, as in a real 30-day window).
  const dayOf = (iso) => iso.slice(0, 10);
  const dayTotals = (list, pick) => days.map((d) => list.filter((g) => dayOf(g.run.endedAt) === d).reduce((s, g) => s + pick(g.run), 0));
  const byDay = (pick) => dayTotals(everyRun, pick);
  const median = (list) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
  const perDayMedian = (pick) => days.map((d) => median(everyRun.filter((g) => dayOf(g.run.endedAt) === d).map((g) => pick(g.run))));
  const demoTrends = {
    days,
    processedInputTokens: byDay((r) => r.summary.processedInputTokens),
    requests: byDay((r) => r.summary.requests),
    compactions: byDay((r) => r.summary.compactions),
    subagents: byDay((r) => r.summary.subagents),
    sessions: days.map((d) => topRuns.filter((g) => dayOf(g.run.endedAt) === d).length),
    peakShareMedian: perDayMedian((r) => Number(r.summary.peakShareOfWindow.toFixed(3))),
    startupH0Median: perDayMedian((r) => r.scopes[0].requests[0].hiddenBase.value),
    instructionEdits: [{ path: "CLAUDE.md", at: daysAgo(3) }, { path: ".claude/rules/ui.md", at: daysAgo(12) }, { path: "CLAUDE.md", at: daysAgo(20) }],
  };
  const offendersOf = (list) => ({
    largestBlocks: list.flatMap((g) => g.run.summary.topBlocks.map((b) => ({ runId: g.run.id, scopeId: b.scopeId, blockId: b.id, category: b.category, estTokens: b.estTokens, firstRequest: b.firstRequest, tool: b.tool, label: b.label }))).sort((a, b) => b.estTokens - a.estTokens).slice(0, 8),
    fattestHandoffs: list.flatMap((g) => Object.values(g.scopes).filter((s) => s.handoff).map((s) => ({ runId: g.run.id, scopeId: s.id, agentType: s.agentType, handoffTokens: s.handoff.tokens.value, childPeak: s.peak.value, ratio: s.handoff.compressionRatio.value }))).sort((a, b) => b.handoffTokens - a.handoffTokens).slice(0, 6),
    mostCompacted: list.filter((g) => g.run.summary.compactions > 0).map((g) => ({ runId: g.run.id, compactions: g.run.summary.compactions, processedInputTokens: g.run.summary.processedInputTokens })).sort((a, b) => b.compactions - a.compactions || b.processedInputTokens - a.processedInputTokens).slice(0, 6),
  });
  const totalsOf = (list) => ({
    runs: list.filter((g) => !g.spec.child).length,
    subagents: list.reduce((s, g) => s + g.run.summary.subagents, 0),
    requests: list.reduce((s, g) => s + g.run.summary.requests, 0),
    processedInputTokens: list.reduce((s, g) => s + g.run.summary.processedInputTokens, 0),
    outputTokens: list.reduce((s, g) => s + g.run.summary.outputTokens, 0),
    cacheReadShare: Number((list.reduce((s, g) => s + g.run.summary.cacheReadShare * g.run.summary.processedInputTokens, 0) / list.reduce((s, g) => s + g.run.summary.processedInputTokens, 0)).toFixed(3)),
    compactions: list.reduce((s, g) => s + g.run.summary.compactions, 0),
    vendors: [...new Set(list.map((g) => g.run.vendor))].sort(),
  });
  const machineSessions = topRuns.length + extraTop.length + 2; // + 2 sessions in temp isolation directories: unattributed, never a row
  const files = [...generated.values()].reduce((s, g) => s + 1 + g.run.source.subagentFiles, 0) + 2;
  const indexOf = (runsInRange) => ({ files, indexed: files, failed: 0, runsInRange, state: "idle", lastPass: { parsed: 3, skipped: files - 3, failed: 0, ms: 1840, at: daysAgo(0, 0.035) }, total: 3, done: 3, lastRunAt: daysAgo(0, 0.035) });
  const demoOverview = {
    scope: { mode: "repo", repo: { name: "context-viewer", key: PROJECTS["context-viewer"].key }, sessions: topRuns.length, machineSessions, unattributed: 2 },
    range: "all",
    since: null,
    runs: rows,
    totals: totalsOf(everyRun),
    trends: demoTrends,
    topOffenders: offendersOf(everyRun),
    contextAtEnd: contextAtSessionEnd(topRuns.map((g) => g.run)),
    firstFinding: demoFirst,
    index: indexOf(topRuns.length),
  };
  // All projects: every session on the "machine", the all-projects default range (30 d), no per-repo trend series.
  const allList = [...generated.values()].filter((g) => Date.parse(g.run.endedAt) >= NOW.getTime() - 30 * 86_400_000);
  const allRows = rowsOf([...topRuns, ...extraTop].filter((g) => allList.includes(g))).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const allOverview = {
    scope: { mode: "all", repo: { name: "context-viewer", key: PROJECTS["context-viewer"].key }, sessions: topRuns.length, machineSessions, unattributed: 2 },
    range: "30d",
    since: daysAgo(30),
    runs: allRows,
    totals: totalsOf(allList),
    trends: { days, processedInputTokens: dayTotals(allList, (r) => r.summary.processedInputTokens), requests: dayTotals(allList, (r) => r.summary.requests), compactions: dayTotals(allList, (r) => r.summary.compactions), subagents: dayTotals(allList, (r) => r.summary.subagents) },
    topOffenders: offendersOf(allList),
    contextAtEnd: contextAtSessionEnd(allList.filter((g) => !g.spec.child).map((g) => g.run)),
    firstFinding: demoFirst,
    index: indexOf(allRows.length),
  };
  const demoSetup = { ...setup, findings: setupFindings.map((f) => ({ ...f, recurrence: ["S-01", "S-02", "S-06"].includes(f.ruleId) ? topRuns.length : 1 })) };

  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, "runs"), { recursive: true });
  let bytes = 0;
  const writeCounted = async (name, data, pretty) => { const text = pretty ? JSON.stringify(data, null, 2) + "\n" : JSON.stringify(data); bytes += Buffer.byteLength(text); await writeFile(path.join(out, name), text); };
  await writeCounted("overview.json", demoOverview, true);
  await writeCounted("overview-all.json", allOverview, true);
  await writeCounted("setup.json", demoSetup, true);
  await writeCounted("findings.json", { findings: demoFindings, groups, firstChange: demoFirst }, true);
  await writeCounted("thresholds.json", thresholds, true);
  for (const { run, scopes } of results) {
    const base = `runs/${run.vendor}--${run.sessionId}`;
    await writeCounted(`${base}.json`, run, false);
    await mkdir(path.join(out, `${base}.scopes`), { recursive: true });
    // The main scope travels in full inside the run response; only child scopes need their own file.
    for (const [id, scope] of Object.entries(scopes)) if (id !== run.scopes[0].id) await writeCounted(`${base}.scopes/${id}.json`, scope, false);
  }
  await writeFile(path.join(out, "README.md"), "# Demo dataset\n\nGenerated by `node dev/make-fixtures.mjs --demo`; synthetic sessions, no transcript content. Do not edit by hand.\n");
  const mainRequests = results.reduce((s, r) => s + r.run.scopes[0].requests.length, 0);
  console.log(`wrote ${out}: ${results.length} runs (${mainRequests} main requests, ${demoOverview.totals.subagents} subagents, ${demoOverview.totals.compactions} compactions), ${demoFindings.length} findings, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}
