# Review cycle 1: existing `@contextscope/cli` (v0.8.0) before the rebuild

Scope: `packages/cli/src/*.mjs` (3,238 lines across 10 modules, one more than the
brief listed: `context-agent.mjs`), `packages/cli/test/*.mjs` (23 tests, all pass in
80 ms), `packages/cli/README.md`, and `docs/context-engineering-research.md`.
Verified against real data on this machine: 84 Claude Code project dirs (918 jsonl
files, 906 MB, largest session 18.7 MB), 80 Codex rollouts (largest 15 MB), no Gemini data.

`scan` on this repo: 0.37 s wall (with and without the Codex app-server), 415 KB JSON.

## 1. Architecture map

| Module | Lines | Responsibility |
|---|---|---|
| `contextscope.mjs` | 433 | argv parsing, 9 subcommands, loopback HTTP server, all `/api/*` routes, in-memory job state for the LLM audit |
| `scanner.mjs` | 504 | `discover()`: walks `~/.codex/sessions`, `~/.claude/projects`, `~/.gemini/tmp`, the repo; per-session metadata; regex "activity" timeline; media refs; assembles the whole result object |
| `analyzer.mjs` | 235 | `buildEvidenceGraph` (nodes/edges/coverage), `analyzeDiscovery` (5 hard-coded findings) |
| `dashboard.mjs` | 219 | server-side HTML string templates for the dashboard and the consent page |
| `codex-app-server.mjs` | 173 | spawns `codex app-server --stdio`, JSON-RPC `thread/list`, normalizes threads |
| `runtime-capture.mjs` | 258 | vendor-hook capture (`capture-event`), capture store under `~/.contextscope/captures`, hook recipes |
| `evaluator.mjs` | 225 | `redactText`, OpenAI single-shot "evaluate the static findings" call |
| `instruction-audit-agent.mjs` | 626 | directive extraction, manifest, chunked OpenAI file-by-file audit with retries, synthesis |
| `context-agent.mjs` | 493 | tool-calling OpenAI agent. **Dead code**: only its schema is imported (`instruction-audit-agent.mjs:6`); no CLI command calls `runContextAnalysisAgent` |
| `experiment.mjs` | 72 | experiment plan template + baseline/treatment comparison arithmetic |

Data flow: `discover()` (`scanner.mjs:399-504`) runs six collectors in parallel
(`scanner.mjs:427-434`), then media refs + activity timeline on repo-scoped artifact
sessions (`441-444`), then graph + findings (`458-463`), returning one ~400 KB object.
`start()` (`contextscope.mjs:127-342`) holds that object in a closure variable
`result`; every GET route slices a sub-tree of it; `POST /api/refresh` re-runs
`discover()`. `GET /` calls `renderDashboard(result)` (`dashboard.mjs:139-211`) which
builds the full page as one template literal with six inline `<style>` blocks
(`171-181`, two of them defining conflicting `:root` palettes, dark then light) and
one inline `<script>` (`192-211`, ~10 KB minified-by-hand). The client is vanilla JS:
timeline `<select>` swap (session list is embedded as base64 JSON in a `data-` attribute,
`dashboard.mjs:119,124`), audit-job polling, refresh (`location.reload()`), and
buttons that dump JSON into `<pre>` blocks. No routing, no state, no charts beyond CSS
bars. The consent page (`dashboard.mjs:213-219`) is a second template.

## 2. What the scanner actually extracts today

Per session file, `describeSession` (`scanner.mjs:245-276`) reads the first 64 KB,
finds a `cwd` string anywhere in the first 20 records (`extractCwd`, `233-243`), and
records: source, id (file basename), kind (from directory layout), parentSessionId
(Claude: `<session>/subagents/` folder name; Gemini: `chats/<parent>/`), mtime, size,
and `repositoryMatch` (exact string equality of `cwd` with `--repo`). That is all that
is stored per session.

For at most 12 repo-scoped sessions (`MAX_TIMELINE_SESSIONS`, `scanner.mjs:17`) it
reads the first 1 MiB (`readHead`, `136`) and classifies each JSON line with
`classifyActivity` (`111-131`) into 10 categories, recording `recordBytes` and
`recordTokenEstimate = ceil(bytes/4)` (`162-163`). No message content is kept.

**It never reads a vendor usage field.** Confirmed on real artifacts:

- Claude Code: every `type:"assistant"` record carries `message.usage` with
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`, plus
  `message.model`, `requestId`, `uuid`/`parentUuid`, `isSidechain`, `agentId`,
  `timestamp`, `version`. In the 18 MB session there are 2,493 such records; the peak
  request input (`input + cache_read + cache_creation`) is 966,747 tokens. Compaction
  is explicit: `compactMetadata{trigger, preTokens:967050, postTokens:12027,
  cumulativeDroppedTokens, preservedSegment}` and `subtype:"compact_boundary"` /
  `isCompactSummary:true` records. Subagent transcripts live at
  `<session>/subagents/agent-<id>.jsonl` with a sibling `agent-<id>.meta.json`
  (`{agentType, description, toolUseId, spawnDepth}`); the parent's `tool_use` block
  with that exact id (`name:"Agent"`) and the matching `tool_result` are in the parent
  file. That is an exact, vendor-emitted parent link; the scanner ignores `.meta.json`
  (walk accepts only `.jsonl`, `scanner.mjs:429`) and labels the link "strong" from
  directory layout instead (`analyzer.mjs:24`).
- Codex rollouts: `event_msg` records with `payload.type:"token_count"` carry
  `info.last_token_usage{input_tokens, cached_input_tokens, cache_write_input_tokens,
  output_tokens, reasoning_output_tokens, total_tokens}`, `info.total_token_usage`, and
  `info.model_context_window` (258,400 on this machine) — per-turn occupancy and
  window size in one record (583 of them in the 15 MB rollout). `session_meta.payload`
  has `id`, `cwd`, `cli_version`, `model_provider`, `base_instructions`, and `source`,
  which for spawned subagents is
  `{"subagent":{"thread_spawn":{"parent_thread_id","depth","agent_path","agent_nickname"}}}`
  (62 rollouts on disk carry it). `turn_context.payload.cwd` gives per-turn cwd,
  `context_compacted` marks compaction, `sub_agent_activity` links `agent_thread_id`.
  The artifact fallback (`scanner.mjs:266`) treats every Codex rollout as a parentless
  `session`; parent links come only from spawning `codex app-server` (`codex-app-server.mjs:65-173`).
- Gemini: no fixture, no real data here; the adapter is path-shape only (`scanner.mjs:251-256`).

So the single biggest gap is exactly as suspected: the artifacts contain exact
per-request context occupancy, cache state, model, compaction before/after, and
parent/child ids, and the tool reports `bytes/4` on the first megabyte instead. The
research doc's provenance table (`observed.vendor` vs `estimated.local`) is not
implemented; everything session-side is `estimated.local` at best.

## 3. Correctness, heuristics, performance, privacy

Correctness / heuristics:

- `classifyActivity` (`scanner.mjs:111-131`) is order-dependent regex over
  concatenated key names plus a 64 KB text window. Confirmed misclassifications on real
  data: Codex `custom_tool_call_output` (the large shell outputs) matches `tool_call`
  before any result pattern (`126`) and is reported as "Other tool calls"; Codex
  injected `user_instructions`/environment context and `# Files mentioned by the user`
  are counted as "User messages", which is why user-message is 47% of the composition
  on this repo (333k of 704k "record tokens"); any tool result whose text contains
  `" grep "` or `" find "` becomes "Search and retrieval" (`123`). Claude `attachment`,
  `system`, `file-history-*`, `queue-operation` records are silently unclassified.
- `repositoryMatch` requires `path.resolve(cwd) === repoRoot` (`scanner.mjs:271`).
  A session started in `packages/cli` is "other". Claude's project-dir encoding and
  Codex `turn_context.cwd`/`workspace_roots` are ignored.
- `contextKind` (`299-304`) returns `"memory"` for `.mcp.json` and `settings.json`;
  any path containing the substring `instructions` is a "rule".
- `isRepositoryContext` (`286-297`) misses `.claude/commands/`, `.claude/hooks/`,
  `.codex/agents`, user-level `~/.claude/{settings.json,CLAUDE.md,skills,agents}` and
  `~/.codex/{config.toml,AGENTS.md}`, so a "setup analysis" cannot see hooks, MCP
  servers, permissions, or global memory at all. Settings files are counted, never parsed.
- `analyzeDiscovery` (`analyzer.mjs:115-235`) has five rules. `instruction-load-observability`
  fires for every repo that has any context file (`168`), and `media-delivery-evidence`
  fires whenever a string ending in `.png`/`.pdf` appears in the last 512 KB of a
  transcript (`scanner.mjs:358-375`). Both are permanent nags, not findings.
- `hasCapability` compares the token with `===` (`contextscope.mjs:83`); harmless on
  loopback but trivially fixable with `timingSafeEqual`.
- Codex app-server threads are stamped `repositoryMatch:"exact"` unconditionally
  (`codex-app-server.mjs:61`), trusting the `cwd` filter param; `sizeBytes`/`path` are null.

Performance: not a problem today. Full `JSON.parse` of the 18 MB Claude file takes
~70 ms in Node; the whole scan is 0.37 s. The caps (`MAX_TIMELINE_SESSIONS=12`,
1 MiB head, 400 events, `scanner.mjs:15-18`) exist for memory and for the 64 KB regex
window, not for speed, and they discard 93% of a 15 MB rollout (`truncated:true` on 6 of
11 inspected sessions here). A streaming line reader (`readline` over
`createReadStream`, ~60 ms on 18 MB, measured) removes the need for caps. `walkFiles`
(`48-72`) is BFS with `readdir` and is fine; `describeSession` opens ~1,000 files
concurrently via `Promise.all` (`280`), which should get a concurrency limit.

Privacy / security posture (good, keep the shape):

- Binds `127.0.0.1` only (`contextscope.mjs:334`); rejects non-loopback `Host`
  (`77-80`); 256-bit per-launch token as `Bearer` or `?token=` (`82-89`); `Origin`
  check on POST (`91-94`); body caps (`105-114`); error messages strip paths (`101-103`).
- Nothing leaves the machine on `scan`/`start`. Network egress exists only in
  `evaluator.mjs:197` and `instruction-audit-agent.mjs:313` (OpenAI, user key, `store:false`,
  explicit hash-confirmed preview). `codex app-server` is spawned locally with the full
  environment (`codex-app-server.mjs:71-75`) on every scan.
- Output hides absolute paths by default and never includes transcript text. The
  bootstrap URL carries the token in the query string and the page keeps reading it
  from `location.search`; move it to `sessionStorage` after first load in the SPA.

## 4. Keep / rewrite / delete for v1

v1 = (a) real-session context statistics with subagent windows linked to parents and kept
separate; (b) deterministic setup analysis of instruction files, hooks, skills, agents,
MCP, memory, settings.

KEEP as-is (move into the new tree):

- HTTP hardening: `isLocalHost`, `hasCapability`, `hasSafeOrigin`, `sendJson`,
  `publicError`, `readJsonBody`, `openBrowser`, listen/URL printing
  (`contextscope.mjs:77-125, 334-341`).
- `walkFiles`, `directoryExists`, `displayPath` (`scanner.mjs:33-72`); `readHead` (`74-85`)
  for the cheap cwd probe only.
- `IGNORED_REPO_DIRS` (`scanner.mjs:9-11`) and the root-resolution env handling
  (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `scanner.mjs:404-413`).
- `redactText` (`evaluator.mjs:61-80`) if any LLM feature survives.
- Deterministic pieces of the audit that belong in setup analysis: `extractDirectives`
  (`instruction-audit-agent.mjs:103-152`), `repositoryEnforcement` (`168-192`),
  `referenceCandidates`/`checkReferences` (`194-223`, stale path and npm-script checks),
  `duplicateEvidence` (`225-239`). Wire them to a deterministic report, not to OpenAI.
- `escapeHtml` (`dashboard.mjs:1-5`) and `renderConsent` (`213-219`) as the only
  server-rendered page.
- Test harness style: `node:test`, temp-dir fixtures, fetch mocks (`test/*.test.mjs`).
- `normalizeCodexThread` field mapping (`codex-app-server.mjs:40-63`) as the reference
  for what a Codex subagent record should look like.

REWRITE:

- Session adapters (`scanner.mjs:133-284`) as one streaming parser per vendor that emits
  a canonical per-request record: `{source, sessionId, agentId|null, parentSessionId,
  parentToolUseId, requestIndex, timestamp, model, input, cacheRead, cacheWrite, output,
  reasoning, contextWindow|null, compaction:{pre,post}|null, provenance:"observed.vendor"}`.
  Claude: `message.usage` + `compactMetadata` + `subagents/*.meta.json` + `isSidechain`.
  Codex: `session_meta.source.subagent.thread_spawn`, `turn_context`, `token_count.info`,
  `context_compacted`, `sub_agent_activity`. Keep parent and subagent series separate;
  link by id, never sum.
- Repository matching: normalize cwd, accept descendants of `--repo`, use Claude's
  project-dir encoding and Codex `workspace_roots` as corroboration.
- Repository context inventory (`scanner.mjs:286-343`) into a typed setup model:
  instruction files (with `@import` resolution), `.claude/settings*.json` (parse
  `hooks`, `permissions`, `env`, `enabledPlugins`), `.mcp.json`, `.claude/agents/*.md`
  frontmatter, skills `SKILL.md` frontmatter, `.claude/commands`, `.codex/config.toml`,
  user-level equivalents under `~/.claude` and `~/.codex`, each with scope (user/project/local).
- `analyzeDiscovery` (`analyzer.mjs:115-235`) into rule modules over that model
  (missing entrypoint, oversize instruction file, duplicate blocks, dangling `@import`
  or path, hook referencing a missing script, MCP server with no matching permission,
  skill without frontmatter description, agent file without `tools`, etc.), each finding
  carrying `evidence: [{file, line}]` and no severity inflation.
- HTTP routes (`contextscope.mjs:163-329`): keep the auth wrapper, replace the
  route list (section 6).
- `buildEvidenceGraph` (`analyzer.mjs:35-109`): keep the idea (nodes, edges, confidence
  from evidence type), rebuild on the canonical records so Claude links are "exact"
  (tool_use id) and Codex links come from rollouts.

DELETE:

- `context-agent.mjs` (dead), `evaluator.mjs` except `redactText` (README already calls
  it legacy), `experiment.mjs` (a JSON template with no runner; the research doc puts
  the experiment runner in P2), `runtime-capture.mjs` and the `instrument`,
  `capture-status`, `capture-event` commands (artifacts already contain what the hooks
  were meant to capture; v1 reads hook config, it does not install hooks), the media
  reference scanner (`scanner.mjs:14-15, 345-375`), the `contextActivity` timeline and
  its `bytes/4` estimates (`scanner.mjs:111-221`), `renderDashboard` and all `render*`
  helpers (`dashboard.mjs:7-211`), `codex-app-server.mjs` as a scan dependency (optional
  enrichment at most; not required for parent links), the OpenAI audit runner
  (`instruction-audit-agent.mjs:312-624`) and its job plumbing (`contextscope.mjs:216-291`)
  unless a provider-agnostic LLM step is explicitly scoped for v1.

## 5. Test coverage

23 tests, 80 ms, all green. Distribution: scanner 2, analyzer 1, dashboard 3, codex
app-server 1, evaluator 3, experiment 2, runtime-capture 3, context-agent 2 (dead code),
instruction-audit 6. The LLM modules are the best covered (fetch mocks, retry paths,
partial coverage, log redaction). The scanner test (`test/scanner.test.mjs:16-72`) builds
toy records like `{cwd, role:"user"}` and `{type:"function_call", name:"read_file"}`;
none resemble a real Claude record (`type:"assistant", message:{usage,...}`), a Codex
`session_meta`/`token_count`, or any Gemini file. There are **no vendor-format
fixtures** in the repo; `classifyActivity` and `extractCwd` are untested against real
shapes, which is how the misclassifications in section 3 survived. Dashboard tests
are regex matches on HTML plus a `vm.Script` syntax check of the inline script
(`test/dashboard.test.mjs:75-77`), i.e. they pin copy strings, not behaviour. For the
rebuild: commit anonymized fixtures (one Claude session with a subagent + meta.json +
compaction, one Codex parent rollout + thread_spawn child, one Gemini chat), assert
token sums and parent links numerically, and test the setup rules with golden findings.

## 6. API surface today

All routes require the token; all GET routes 404 until consent (`result` is null).

| Route | Payload |
|---|---|
| `GET /api/discovery`, `/api/v1/discovery` | the entire `discover()` object (`schemaVersion, privacy, repository{contextItems[]}, sources[], totals, mediaReferences, contextActivity{sessions[].events[]}, runtimeEvidence, recentSessions[≤500], evidenceGraph{nodes,edges,coverage}, improvements{findings[]}, analysis`) |
| `GET /api/v1/evidence-graph` | `result.evidenceGraph` |
| `GET /api/v1/findings` | `result.improvements` |
| `GET /api/v1/sources` | `{repository, sources, totals}` |
| `GET /api/v1/context-activity` | `result.contextActivity` |
| `GET /api/v1/runtime-evidence` | `result.runtimeEvidence` |
| `GET /api/v1/instrumentation?platform=` | hook recipe |
| `GET /api/v1/evaluation-preview?includeContext=` | `{payload, payloadHash, estimatedInputTokens}` |
| `GET /api/v1/experiment?findingId=` | plan template |
| `GET /api/v1/agent-report`, `GET /api/v1/agent-analyze/status?jobId=` | audit result / job |
| `POST /api/v1/agent-analyze`, `POST /api/v1/evaluate` | start audit (202) / run evaluator (OpenAI) |
| `POST /api/authorize`, `POST /api/refresh` | run `discover()`; 204 |

Verdict: not suitable to back a real SPA. It is one blob sliced six ways, with no
session list/detail split, no pagination, no per-request series, no subagent detail,
no setup model. Only the auth wrapper and the `202 + status poll` job pattern
(`contextscope.mjs:233-291`) are worth carrying over. Proposed v1 surface:
`GET /api/v1/meta` (roots, privacy, version), `GET /api/v1/sessions?repo=&source=&limit=&cursor=`
(summary rows: id, source, model(s), started/ended, requests, peak occupancy, window,
cache hit ratio, compactions, subagent count), `GET /api/v1/sessions/:source/:id`
(request series + compaction markers + subagent summaries with parent tool-use link),
`GET /api/v1/sessions/:source/:id/subagents/:agentId` (private series),
`GET /api/v1/setup` (typed inventory + findings with file:line evidence),
`POST /api/v1/rescan`. Every numeric field carries `provenance`.

## 7. UI delivery recommendation

Serve a prebuilt static SPA from the package; stop string-templating HTML in
`dashboard.mjs`. Reasons: the current template is already unmaintainable at 219
lines of 64 KB (six style blocks, conflicting themes, base64 data attributes to pass
state), v1 needs per-session drill-down, series charts and filters that a reload-per-action
page cannot give, and the API split in section 6 only pays off with a client that
holds state.

Do not build it from the root app. The root is `vinext` + RSC + `@cloudflare/vite-plugin`
+ Drizzle/D1 (`vite.config.ts`, `package.json`), a hosted marketing/app shell; its
build output is server-dependent and pulls a worker runtime. The CLI needs a plain
static bundle.

Concrete layout: `packages/ui` as a plain Vite + React (or Preact) app with
`@vitejs/plugin-react` only, `base: "./"`, output to `packages/cli/ui/` (or inline to a
single HTML via `vite-plugin-singlefile` so there is one file to serve and no
asset-path handling). Add `"ui"` to the CLI `package.json` `files` array
(`packages/cli/package.json:9-12`), commit or CI-build it on `prepublishOnly`, and have
`start()` serve it with a ~20-line static handler (whitelist the `ui/` dir, set
`cache-control: no-store` on `index.html`, immutable on hashed assets). The npx path
runs zero build steps and the CLI keeps zero runtime dependencies. Keep
`renderConsent` server-rendered so the consent gate cannot be bypassed by a stale
bundle, or fold consent into the SPA and gate every data route on `result !== null`
as today. The SPA reads `?token=` once, stores it in `sessionStorage`, and calls the
API with `Authorization: Bearer`. Charts: a small hand-rolled SVG layer or a single
pinned library; provenance badges on every number per the research doc.

Suggested v1 module tree for the CLI: `src/cli.mjs`, `src/server/{http,routes,static}.mjs`,
`src/adapters/{claude,codex,gemini}.mjs` (streaming, emit canonical records),
`src/model/{session,setup}.mjs`, `src/setup/{inventory,rules/*.mjs}`,
`src/util/{fs,redact,paths}.mjs`, `test/fixtures/{claude,codex,gemini}/`.
