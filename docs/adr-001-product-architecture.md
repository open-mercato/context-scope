# ADR-001: ContextScope product architecture and UI spec (cycle 1)

Status: Accepted for cycle 1 · Date: 2026-09-02 · Owner: architecture
Inputs: `docs/context-engineering-research.md`, `docs/one-command-discovery-research.md`, `packages/cli/README.md`, `packages/cli/src/{scanner,dashboard,analyzer,contextscope}.mjs`, and a metadata-only inspection of real `~/.claude/projects` and `~/.codex/sessions` files on this machine (record keys and counts only; no message content was read).

## 0. Facts we verified about the raw data (build against these, not against assumptions)

| Fact | Where | Consequence |
|---|---|---|
| Every Claude `assistant` record carries `message.usage` = `{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, output_tokens_details.thinking_tokens}` and a `requestId`. | main `<session>.jsonl` and `subagents/agent-<id>.jsonl` | Exact per-request context occupancy = `input + cache_creation + cache_read`. Label `observed.vendor`. |
| Several assistant records share one `requestId` (one file: 2,493 assistant records, 1,365 distinct request IDs). Each repeats the same `usage`. | main session | A Request is keyed by `requestId`; usage is taken once per request (last record wins). Summing records naively over-counts ~2x. |
| Compaction is a `system` record with `subtype: "compact_boundary"` and `compactMetadata: {trigger, preTokens, postTokens, cumulativeDroppedTokens, durationMs, preCompactDiscoveredTools[], preservedMessages}`; the summary text is a following `user` record with `isCompactSummary: true`. | main session (10 of 218 sessions here) | Compaction boundaries, before/after sizes, and trigger are `observed.vendor`. The summary size is `observed.artifact`. |
| Subagent transcripts have `isSidechain: true`, `agentId`, `attributionAgent` (agent type), and their own `usage` per request. The parent's `Agent` tool call has `toolUseResult.agentId`; async launches return `status: "async_launched"` plus `outputFile`; the result arrives later as a `queue-operation` record followed by a `user` record whose `message.content` is a string naming the same `agentId` (about 22 KB in the sample). That `user` record is what the model sees and is the handoff. | `<session>/subagents/agent-<id>.jsonl` (701 files here) | Parent/child link is exact via `agentId`. Handoff size = tokens of the content the parent actually received for that `agentId` (sync `tool_result`, or the later completion record), reconciled against the child's final assistant text. |
| Tool results are `user` records with `message.content[].type == "tool_result"` and a `toolUseResult` object (`commandName`, `success`, file metadata, etc.), linked by `tool_use_id` to the assistant `tool_use` block that has `name` and `input`. | main + subagent | Tool kind and result size are `observed.artifact`; per-tool attribution is deterministic (no regex on prose). |
| Hook output is an `attachment` record with `attachment.type: "hook_success"`, `hookName`, `stdout`, `stderr`, `durationMs`. `system-reminder` blocks live inside user content. | main session | Hook stdout size is measurable. |
| Codex rollouts emit `event_msg` `token_count` with `info.last_token_usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, `info.total_token_usage`, and `info.model_context_window` (258,400 in sample). `turn_context` carries `user_instructions` (the loaded AGENTS chain; 32,630 chars in sample), `model`, `truncation_policy {mode, limit}`; `session_meta` carries `cwd`, `cli_version`, `base_instructions`, `git`. Compaction appears as `compacted` / `context_compacted` / `compaction` events. Tool calls are `function_call` / `function_call_output` response items; `reasoning` items are separate. | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (80 files here) | Codex gives exact per-request input and an exact window size; Codex "instructions actually loaded" is `observed.artifact` (better than Claude, where instruction loading is only inferable without the `InstructionsLoaded` hook). |
| Volume: 906 MB Claude, 123 MB Codex on one developer machine. | | Full-file parse at every launch is unacceptable; we need an incremental on-disk index. |
| `packages/cli` has zero runtime dependencies and serves HTML strings from `dashboard.mjs` over a token-protected loopback server with `/api/v1/*` JSON routes. | `packages/cli/src/contextscope.mjs` | Keep the server, the token, the consent flow, and the zero-dependency runtime. Replace the HTML rendering. |

## 1. Product framing

ContextScope is a local profiler for coding-agent context: run `npx contextscope`, it reads the session transcripts Claude Code and Codex already keep on disk plus the repository's instruction setup, and it shows exactly what filled each model request, what each subagent cost privately and returned to its parent, and which setup defects and session habits are wasting or endangering the window, each with one platform-correct fix. It is a profiler, not a scorecard: every number carries a provenance label, exact vendor counts are never blended with estimates, and no "context health score" exists until it is calibrated against outcomes.

Within ten seconds of opening a session, the UI must answer:

- (a) Where did my context go? What filled the window, by category, over time, with compaction boundaries visible.
- (b) What did my subagents cost and return? Each subagent's private window versus the size of the handoff that came back to the parent.
- (c) What is wrong with my setup and which one change should I make first?

Anything that does not serve (a), (b) or (c) is not on the screen in cycle 1.

## 2. Information architecture

Routes are hash-based (`#/`, `#/session/:vendor/:id`, `#/setup`, `#/findings`) so the prebuilt UI works from a single `index.html`. Every metric below names its provenance label; the UI renders that label as a small badge next to the number (hover explains it).

### 2.1 `#/` Overview: "all projects, all vendors, last 30 days"

| Panel | Content | Provenance |
|---|---|---|
| Header strip | Sessions indexed / subagents indexed / vendors detected / index freshness ("indexed 2 min ago, 4 files changed"). | `observed.artifact` |
| Totals (4 stat tiles) | Processed input tokens (sum of `input+cache_creation+cache_read` over requests), cache-read share, compactions, subagent runs. Each tile shows a 30-day sparkline. | `observed.vendor`, `derived.exact` |
| Top offenders | Three ranked lists: largest single tool results, fattest subagent handoffs, most-compacted sessions. Each row deep-links to its session at that request. | `observed.artifact`, `derived.exact` |
| Sessions table | vendor · project · started · duration · requests · peak occupancy (and % of window) · compactions · subagents · findings count. Sortable, filterable by project/vendor, keyboard navigable. | `observed.vendor` (peak), `estimated.local` (window size for Claude, inferred from model), `observed.vendor` (Codex window) |
| First finding | The single highest-severity finding across the repo the CLI was launched from, with "Show evidence" and "Copy fix". | rule output |

### 2.2 `#/session/:vendor/:id` Session view (the core screen)

Layout: top-to-bottom, one scroll, all panels share the request axis (x = request index; a time ruler is shown under it).

1. **Occupancy chart** (stacked area, one series per category from section 3). Y = tokens in the model's input for that request; a horizontal line marks the context window; compaction boundaries are vertical dashed markers with the `preTokens -> postTokens` label; a thin line on top is the exact vendor total. Hovering a request shows the composition; clicking pins it and scrolls the ledger. Provenance: total `observed.vendor`; composition `estimated.local (reconciled to observed.vendor)`.
2. **Cache split bar** (per request, aligned under the chart): `cache_read` / `cache_creation` / uncached `input` as three colours. This is the honest "churn" view: a request where creation spikes without a new large block means something early in the prompt changed. Provenance `observed.vendor`.
3. **Subagent lanes**: one lane per subagent, pinned under the parent axis at the request where it was launched, spanning until its result was delivered. Lane height encodes the child's private peak; a right-pointing arrow into the parent axis is labelled with the handoff size and the compression ratio `child peak / handoff`. Clicking a lane opens the child as its own session view (breadcrumb back). Provenance: child peak `observed.vendor`; handoff `observed.artifact`; ratio `derived.exact`.
4. **Heavy hitters**: the ten largest blocks in the session (tool results, handoffs, compaction summaries, user pastes) with category, tool name, tokens (estimated) and the request where they entered, plus whether they are still present at the end. Provenance `estimated.local`, presence `derived.exact`.
5. **Ledger table** (virtualised): one row per request: index, time, model, `input`, `cache_creation`, `cache_read`, `output` (thinking split), total, delta vs previous, blocks added since previous request (count, categories), subagent activity. Row expands to list the blocks with their estimated size. Provenance `observed.vendor` for the token columns; `estimated.local` for block sizes.
6. **Session findings**: rules from section 4 that fired on this session, with evidence links into the ledger.

Right rail (collapsible): session facts (vendor, model(s), cwd, git branch, version, window size and its provenance, instruction chain size for Codex from `turn_context`), coverage ("1,365 requests, 0 unparsed records, estimator error 3.1%").

### 2.3 `#/setup` Setup view: Context Bill of Materials for the launched repository

| Panel | Content | Provenance |
|---|---|---|
| Startup budget | Per vendor: estimated tokens that enter every request before the user types: instruction files in the precedence chain, skill descriptions (frontmatter only), agent descriptions, MCP tool schemas (count of tools), hook count. Shown as a stacked horizontal bar per vendor with the total. For Codex, the observed `user_instructions` size from the latest session replaces the estimate and is badged `observed.artifact`. | `estimated.local`; Codex chain `observed.artifact` |
| Instruction files | Table: path, scope (user / project / local / nested / rules), vendor(s), bytes, est. tokens, precedence order, last modified, `discoverable` / `expected.load` / `observed.loaded` state, referenced paths that do not exist. | `observed.artifact`, `estimated.local` |
| Skills | Name, path, description present?, description length, body est. tokens, invocation count across indexed sessions (`Skill` tool_use names). | `observed.artifact`, `derived.exact` |
| Agents | Definition files with model/tools declared, and observed runs (from `attributionAgent`). | `observed.artifact` |
| Hooks | From settings files: event, command, plus observed stdout size distribution from `hook_success` attachments. | `observed.artifact` |
| MCP servers | From `.mcp.json` / settings: server, transport, tools observed (`mcp__<server>__*` names in sessions and `preCompactDiscoveredTools`), invocations in last 30 days. | `observed.artifact`, `derived.exact` |
| Memory | Auto-memory dir presence and size (`~/.claude/projects/<project>/memory/`), `MEMORY.md` size. | `observed.artifact` |
| Setup findings | Rules S-* from section 4. | rule output |

### 2.4 `#/findings` Findings and recommendations

One list, grouped by severity, filterable by scope (setup / session / subagent) and by vendor. Each card: title, severity, scope, one-sentence "why it matters", evidence block (the exact numbers and the links to ledger rows or files that triggered it), provenance badges on the evidence, and the fix as a platform-specific snippet with a "Copy fix" button. The top card is the "one change to make first"; ordering is severity, then estimated tokens affected per session, then recurrence across sessions. No aggregate score anywhere.

### 2.5 Anatomy of a finding card and the keyboard map

A finding card is the same component on every screen:

```
[HIGH]  Fat subagent handoff                                    session · claude
Why: a subagent exists to isolate context; this one returned 11,400 tokens (38% of its own peak).
Evidence:  handoff block #main:412  11,400 tok [estimated.local]   child peak 29,800 [observed.vendor]
           ratio 2.6x [derived.exact]   fires above 4,000 tok or 40% (edit)
Fix (claude): add to .claude/agents/audit-deepdive.md ->
   "Return findings only: file:line references, decisions, and open questions. Under 600 words."
[ Show evidence ]  [ Copy fix ]
```

Keyboard map (`?` opens it):

| Key | Action |
|---|---|
| `g o` / `g s` / `g f` / `g u` | Go to Overview / Setup / Findings / current Session |
| `j` / `k` | Next / previous request (session) or row (tables) |
| `Enter` | Open focused row, lane, or evidence link |
| `[` / `]` | Jump to previous / next compaction boundary |
| `p` | Pin the focused request (composition stays in the rail) |
| `/` | Focus the filter box |
| `c` | Copy the focused finding's fix |
| `t` | Toggle theme |
| `Esc` | Unpin, close rail, clear filter |

## 3. Category taxonomy: what fills the context

A fixed set of 13 categories. Adapters must map every block to exactly one; anything unmappable is `other` and counted in coverage, never silently dropped.

| Category | Claude Code measurement | Codex measurement | Exact or estimated |
|---|---|---|---|
| `system` (system prompt + tool schemas, hidden) | Not in transcript. Derived: first request's total minus estimated visible blocks (see 3.1). Cross-check: `preCompactDiscoveredTools` lists MCP tools present. | `session_meta.base_instructions` when present (artifact), else same derivation. | `estimated.local` (Claude), `observed.artifact` (Codex when present) |
| `instructions` (CLAUDE.md chain, `.claude/rules`, AGENTS.md chain) | Not in transcript (Claude injects it into system). Estimated from repo/user files in the precedence chain; `observed.loaded` only when a hook capture or nested-file `Read` proves it. | `turn_context.user_instructions` exact chars; per-turn. | `estimated.local` (Claude), `observed.artifact` (Codex) |
| `skills` | `Skill` tool_use plus the returned content block. | Not applicable in cycle 1. | `observed.artifact` size, tokens `estimated.local` |
| `user` | `user` records whose content is text and not `tool_result`, not `isCompactSummary`, minus embedded `<system-reminder>` blocks. | `response_item.message` with `role: user` / `user_message` events. | size `observed.artifact`, tokens `estimated.local` |
| `assistant_text` | assistant `text` blocks. `output_tokens` per request is exact and is the check. | `agent_message` / assistant `message` items. | `observed.vendor` per request, per-block `estimated.local` |
| `assistant_thinking` | `thinking` blocks. Note: thinking is generally not resent into later requests; it is charged as output (`thinking_tokens`) and shown in the ledger, not in occupancy. | `reasoning` items; `reasoning_output_tokens`. | `observed.vendor` |
| `tool_call` | assistant `tool_use` blocks (`name`, `input` JSON). | `function_call` items (`name`, `arguments`). | `estimated.local` |
| `tool_result.file` | `tool_result` for `Read`, `NotebookRead`, `Glob` (path lists). | `function_call_output` where the call was a read-style shell command (`cat`, `sed -n`, `head`), classified by parsing the command argv, else `shell`. | `estimated.local` |
| `tool_result.shell` | `Bash`, `BashOutput`, `Monitor`. | `exec_command` / `shell` outputs. | `estimated.local` |
| `tool_result.search` | `Grep`, `Glob` content matches, `WebSearch`. | `rg`/`grep`/`find` argv in `exec_command`. | `estimated.local` |
| `tool_result.web` | `WebFetch`, browser MCP tools. | web tool outputs when present. | `estimated.local` |
| `tool_result.other` | All other tools, including `mcp__*` and `Edit`/`Write` confirmations. | Other function outputs. | `estimated.local` |
| `subagent_handoff` | The content the parent received for an `agentId` (sync `tool_result` of `Agent`, or the async completion record). | Child thread items delivered to parent (app-server `subAgent*` sources); cycle 1 marks Codex handoffs `unknown` unless observable. | `observed.artifact` |
| `compaction_summary` | `isCompactSummary` user record content. | `compacted` event payload summary when present. | `observed.artifact` size; before/after `observed.vendor` |
| `attachments` (system-reminders, hook output, `total_tokens_reminder`, task notifications) | `attachment` records and `<system-reminder>` spans. | `turn_context` deltas, `developer` messages. | `estimated.local` |
| `memory` | Auto-memory content when a `Read` of `memory/*.md` or a hook proves it; else not counted (it is part of `system` or `instructions` derivation). | n/a | `observed.artifact` when proven |

Token estimation for `estimated.local`: `ceil(utf8_bytes / 3.6)` for prose and `ceil(bytes / 3.2)` for code/JSON (block kind decides) as the default; the estimator is a pluggable function so a real tokenizer can replace it later. The estimator's global error is reported per session (see 3.1) instead of hidden.

### 3.1 Reconciliation: estimated composition, exact totals

The transcript gives per-block sizes we can only estimate; the vendor gives per-request totals that are exact. We must never show an estimated stack that disagrees with the exact total. Algorithm, per agent scope:

1. Build the request sequence `R_1..R_n` with exact totals `T_i = input + cache_creation + cache_read` (Claude) or `last_token_usage.input_tokens` (Codex).
2. Maintain the visible block list `V_i`: all blocks emitted since the last compaction boundary (or session start) up to `R_i`, plus the compaction summary block if one exists. Thinking blocks are excluded from `V_i`.
3. Hidden base `H`: for the first request in the scope, `H = T_1 - sum(est(b) for b in V_1)`. `H` is the `system + instructions` mass. For Claude, split `H` into `instructions` (estimated from the file chain) and `system` (remainder). For Codex, `instructions = len(user_instructions)`-based estimate and the remainder is `system`. `H` is recomputed after each compaction boundary from the first post-boundary request, because Claude re-injects the system prompt and Codex re-sends instructions.
4. Per request, scale factor `k_i = (T_i - H) / sum(est(b) for b in V_i)`. Composition for category `c` is `k_i * sum(est(b) for b in V_i if b.category == c)`. This guarantees the stack sums to `T_i` exactly.
5. Estimator error: `err_i = |1 - k_i|`; the session reports the median and the p95 in the coverage rail. A p95 above 15% turns the composition badge amber and shows "composition approximate" text; above 40% the stack is hidden and only the exact total line is drawn. Thresholds are editable.
6. Independent check (Claude only): tokens newly added between `R_{i-1}` and `R_i` should be close to `input_i + cache_creation_i` when the cache was warm. The adapter records `delta_check_i = (input_i + cache_creation_i) - est(new blocks)`; large positive residuals flag hidden injections (system-reminders, tool-schema changes), which is precisely what the cache-churn finding needs.

Labelling: the composition is `estimated.local (reconciled to observed.vendor)`; the total is `observed.vendor`; `H` is `estimated.local`; cache split is `observed.vendor`; compaction before/after is `observed.vendor`.

### 3.2 Adapter edge cases (all verified in local files; each needs a fixture)

Claude Code:
- Records with `model: "<synthetic>"` (2 in a 2,493-record file) carry no real usage; skip them for requests but keep any content blocks.
- `isVisibleInTranscriptOnly: true` records are not sent to the model; exclude from `V_i`.
- `isSidechain: true` records can appear in the main file as well as in `subagents/`; scope by `agentId`, never by file alone.
- A user record may contain several `tool_result` blocks (parallel tool calls); create one Block per `tool_use_id`.
- `Agent` results with `status: "async_launched"` are tiny; the real handoff is the later `user` record (string content, references the `agentId`) that follows a `queue-operation` record. `queue-operation` records themselves are not model input; exclude from `V_i`. If the completion never appears (session ended), `handoff` is `undefined` and the lane is drawn open-ended.
- `output_tokens_details.thinking_tokens` is always less than or equal to `output_tokens` (2,491 records checked, 0 exceptions): thinking is included in output. The ledger shows `output` with a `thinking` sub-split, not a separate column.
- `usage.iterations[]` exists on some records; ignore it in cycle 1 (top-level usage is authoritative).
- Sessions mix models (main on one model, subagents on another); `window` is per scope, from the model table in 5.5.
- `compactMetadata.preCompactDiscoveredTools` is the only transcript evidence of which MCP tools were attached; S-08 uses it and says so.

Codex:
- `token_count` with `info: null` occurs (rate-limit-only events); skip.
- `total_token_usage` is cumulative for the thread; `last_token_usage` is per request. Use `last_`; use `total_` only as a checksum.
- Several `token_count` events can fire within one turn (one per model call); each is a Request. Turns without a `token_count` (interrupted) produce blocks but no request; the blocks attach to the next request.
- `turn_context.user_instructions` can change between turns (nested `AGENTS.md` picked up after `cd`); re-derive `instructions` per turn and let B-09 see the change.
- `function_call_output` for `exec_command` contains the command's stdout wrapped in a JSON string; size is the wrapped size, which is what the model saw.

## 4. Findings engine

Rules are pure functions over the IR (section 5.3): `rule(ir, thresholds) -> Finding[]`. Every finding carries `evidence[]` (typed references to files, requests, blocks, with the numbers used), `provenance` of that evidence, `fix` per platform, and `whyItMatters`. Thresholds live in `packages/cli/src/rules/thresholds.json` and are surfaced in the UI as "editable hypotheses". No rule may fire without at least one evidence reference. Severity: `high` = likely to cause task failure or compaction; `medium` = measurable waste; `low` = hygiene.

Setup rules (`S-*`) run on the repository and user config; session rules (`B-*`) run on indexed sessions and are reported per session and aggregated across sessions of the same repo.

| ID | Detects | Evidence needed | Sev | Fix (platform-specific) | Why it matters |
|---|---|---|---|---|---|
| S-01 `instruction-file-oversized` | A single instruction file over 3,000 est. tokens, or the loaded chain over 6,000. | File sizes; for Codex the observed `user_instructions` length. | high | Claude: move path-specific guidance into `.claude/rules/<topic>.md` with `paths:` frontmatter; keep `CLAUDE.md` to conventions and pointers. Codex: split into nested `AGENTS.md` per directory; put overrides in `AGENTS.override.md`. | Instructions are resent on every request and sit at the top of the prompt; every 1k tokens there is paid on every turn and competes with task content for attention. |
| S-02 `duplicate-instruction-blocks` | Identical or near-identical (normalized line-hash, >=5 lines) blocks across two instruction files in the same chain. | Block hashes and the two paths. | medium | Keep one copy in the higher-precedence file; replace the other with a one-line pointer (`@path` import on Claude). | Duplicates double the cost and, when they drift, create contradictions the model resolves arbitrarily. |
| S-03 `skill-missing-description` | `SKILL.md` without a `description` in frontmatter, or description under 20 characters. | Parsed frontmatter. | high | Add `description:` stating when to use the skill and its trigger phrases. | The description is the routing key; without it the skill either never loads or loads by accident. |
| S-04 `skill-frontmatter-invalid` | Frontmatter fails to parse, `name` mismatches directory, or description over 1,024 characters. | Parse result. | medium | Fix YAML; keep description under the platform limit. | Malformed metadata makes the skill invisible or truncates its description. |
| S-05 `instruction-broken-path` | An instruction file references a repo path (backticked or `@path`) that does not exist. | Regex over instruction text, `stat` result. | low | Update or delete the reference. | The model trusts instructions; a dead path costs a failed tool call and a wrong assumption per session. |
| S-06 `no-rules-scoping` | Project `CLAUDE.md` over 1,500 est. tokens and no `.claude/rules/*.md` with `paths:` frontmatter (Claude); or one root `AGENTS.md` over 1,500 tokens and no nested `AGENTS.md` (Codex). | File inventory. | medium | Create `.claude/rules/` (Claude) or nested `AGENTS.md` (Codex) so guidance loads only where relevant. | Global instructions load for every task; scoped ones load only when the model touches those files. |
| S-07 `stale-instructions` | Instruction file not modified in 180 days while more than 50 commits touched source under its scope. | `git log` counts, file mtime. | low | Review the file against current structure; delete outdated sections. | Stale rules produce confidently wrong behaviour and cost the same tokens as correct ones. |
| S-08 `mcp-schema-bloat` | An MCP server exposing more than 15 tools, or all servers combined more than 40 tool schemas, in the startup set. | Tool names from `preCompactDiscoveredTools`, `mcp__*` tool_use names, `.mcp.json`. | medium | Claude: disable the server per project (`claude mcp remove` or move it to user scope) or rely on deferred tool loading; Codex: `[mcp_servers.<name>] enabled = false` in `config.toml`. | Every tool schema is prompt text on every request; a 40-tool server can cost more than the entire CLAUDE.md. |
| S-09 `mcp-server-unused` | An MCP server configured for the repo with zero invocations across the last 30 days of indexed sessions. | Config presence, tool_use name counts. | medium | Disable it for this project; re-enable on demand. | Pure schema cost with no observed benefit. |
| S-10 `memory-missing` | No auto-memory directory or an empty `MEMORY.md` for the project, while the repo has more than 5 sessions. | Directory stat. | low | Claude: let auto-memory run, or seed `MEMORY.md` with durable facts; Codex: add durable facts to `AGENTS.md`. | Without memory, each session re-discovers the same facts through tool calls. |
| S-11 `hook-large-stdout` | A hook whose stdout exceeds 1,500 est. tokens in more than 20% of its runs. | `hook_success.stdout` sizes by `hookName`. | medium | Make the hook print only on failure or cap output (`| tail -20`). | Hook stdout is injected into context every time it fires. |
| S-12 `vendor-without-instructions` | Sessions of a vendor exist for the repo but that vendor's instruction file is absent (`AGENTS.md` for Codex, `CLAUDE.md` for Claude). | Session inventory, file inventory. | medium | Create the file with conventions, build/test commands, and layout. | Evidence shows repository instructions reduce runtime and output tokens for comparable completion. |
| B-01 `fat-tool-result` | Any single tool result over 8,000 est. tokens. | Block ref, tool name, size, request index. | high | Claude: `Read` with `offset`/`limit`; `Grep` with `head_limit`/`-l`; `Bash ... | head -c 8000`; or delegate to a subagent. Codex: pipe through `head`/`rg -l`; lower `truncation_policy.limit` in `config.toml` if the version supports it. | One oversized result can occupy a tenth of the window until compaction and pushes the task instructions toward the "lost in the middle" zone. |
| B-02 `repeated-fat-results` | Five or more results from the same tool kind over 3,000 tokens in one session. | List of block refs. | high | Same as B-01, plus a rule in `CLAUDE.md`/`AGENTS.md`: "prefer targeted reads; never cat whole files". | Repetition is a habit signal, not an accident; fix it in instructions once. |
| B-03 `huge-file-read` | A `Read`/`cat` result over 20,000 tokens from a single file. | Block ref, file path (relative). | high | Read the sections needed (`offset`/`limit`, `sed -n`), or add the file to an ignore rule. | Large generated files (lockfiles, fixtures, bundles) are the most common cause of a single-turn window jump. |
| B-04 `repeated-identical-tool-call` | The same tool with identical arguments executed 3+ times in one scope. | Hash of `(name, input)`, request indices. | medium | Note the result in memory or the task plan; on Claude, ask for a `Monitor`/wait instead of polling with Bash. | Identical calls resend identical results; each is a fresh block in the window. |
| B-05 `fat-subagent-handoff` | Handoff over 4,000 tokens, or handoff larger than 40% of the child's private peak. | Handoff block ref, child peak. | high | Claude: in `.claude/agents/<name>.md` (or the `Agent` prompt) require "return findings only: paths, line refs, decisions; under 600 words". Codex: instruct the child to return a summary, not transcripts. | A subagent exists to isolate context; a fat handoff moves the child's context into the parent and defeats the purpose. |
| B-06 `subagent-rereads-parent-files` | A child reads (Read/cat) 3+ files the parent had already read in full before launching it. | Path sets by scope. | medium | Pass the relevant excerpts or exact file:line targets in the delegation prompt; keep the child's task narrow. | Duplicate reads cost the child's window and time without adding information the parent lacked. |
| B-07 `frequent-compaction` | More than one compaction per hour of wall time, or 3+ per session. | `compact_boundary` timestamps and metadata. | high | Start a fresh session per task (`/clear`), delegate exploration to subagents, and fix B-01/B-03 causes first. Codex: same, and reduce startup mass (S-01). | Each compaction discards state that later turns may need; theory and practice agree there is no lossless summary. |
| B-08 `running-hot` | Occupancy above 80% of the window for 10+ consecutive requests. | Request refs and window size (with provenance). | high | Compact deliberately with `/compact <focus>` before the auto trigger, or split the task. | Quality degrades with length before the hard limit; the last 20% of the window is the most expensive and least reliable. |
| B-09 `cache-churn` | After the fifth request, `cache_creation` exceeds 20% of the total in 30%+ of requests while `delta_check` shows little new content. | Per-request usage, residuals. | medium | Claude: avoid changing content early in the prompt each turn (dynamic system-reminders, timestamps in hooks, MCP servers that mutate schemas). Codex: check for per-turn `user_instructions` changes. | Cache misses cost more per token and signal that something upstream is invalidating the prefix every turn. |
| B-10 `system-share-high` | Hidden base `H` over 25% of the window on the first request. | `H`, window size. | medium | Remove unused MCP servers (S-09), trim instructions (S-01), reduce skills with long descriptions. | A quarter of the window gone before the first user message leaves less room for the task and pushes compaction earlier. |
| B-11 `turn-overhead` | 10+ requests where the new user content is under 50 tokens while the request total is over 100,000. | Request refs. | low | Batch small follow-ups; use a fresh session for unrelated questions; on Claude, use `/compact` between task phases. | Each tiny follow-up resends the entire window; that is where most "idle" cost comes from. |
| B-12 `tool-results-dominate` | `tool_result.*` categories exceed 60% of occupancy at the session peak. | Reconciled composition at peak. | medium | Delegate exploration to subagents; prefer search with limits; clear results by starting a new phase. | The window should hold the task and decisions, not raw output; results are the most compressible content. |
| B-13 `session-too-long` | More than 3M processed input tokens or 2+ compactions with a session longer than 4 hours. | Session totals. | medium | Split work into sessions per task; write a handoff note to memory before ending. | Long sessions accumulate stale context and compaction loss; a fresh session with a good note is cheaper and more accurate. |
| B-14 `search-flood` | A search-style result (Grep/Glob/rg/find) over 4,000 tokens. | Block ref. | medium | Claude: `Grep` with `head_limit`, `output_mode: files_with_matches`; Codex: `rg -l`, `rg --max-count`. | Search results are lists; the model needs the top hits, not all hits. |
| B-15 `parallel-duplicate-work` | Two subagents under the same parent read 3+ identical files or run identical commands. | Path/command sets by scope. | low | Give each subagent a disjoint scope in the delegation prompt. | Parallel agents that duplicate work double cost without adding coverage. |

Rules deferred (need runtime hooks or an evaluator): semantic contradictions between instruction files, handoff sufficiency, compaction fidelity, instruction adherence. They stay in the research doc, not in cycle 1.

## 5. Tech architecture decision

### 5.1 UI: Preact + TypeScript, prebuilt with esbuild into `packages/cli/ui/`, served by the existing loopback server

Decision: build a real SPA in `packages/ui` (Preact 10, `@preact/signals`, TypeScript, esbuild). The build output (`index.html`, `app.js`, `app.css`, about 60-90 KB gzipped) is committed to `packages/cli/ui/` and included in the npm `files` list. `npx contextscope` never builds anything; it serves static files plus JSON.

Why Preact over React: same component model and hooks, 4 KB instead of 140 KB, no runtime dependency added to the CLI (the CLI still ships zero runtime deps; the UI is a static asset). Why not vanilla: the session view has coordinated state across five panels (hover request, pinned request, selected scope, filters); doing that without a component model produces the string-rendering mess we are replacing. Why not Vue/Svelte: no reason strong enough to justify a second toolchain in a team that already writes React at the root site.

Charts: hand-rolled SVG in `packages/ui/src/charts/` (linear scale, stacked area, bar strip, lane layout, brush). Three chart types do not justify a charting library, and hand-rolled SVG gives us keyboard focus on requests, exact tooltips, and theme tokens for free. Virtualised ledger table is ~120 lines of code; no table library.

Routing: hash router (own, under 50 lines). Theme: CSS custom properties; light palette on `:root`, dark under `prefers-color-scheme` and `[data-theme=dark]`; toggle persisted in `localStorage`. Keyboard: `j/k` move through requests or table rows, `Enter` opens, `[`/`]` jump between compaction boundaries, `g o / g s / g f` switch screens, `/` filters, `?` shows the map, `c` copies the focused fix. Responsive: panels stack under 900 px; charts scroll horizontally inside their own container.

Server: keep `contextscope.mjs` (loopback, per-launch token, consent page, `Origin`/`Host` checks). Add static serving from `packages/cli/ui/` and the JSON routes below. The consent page becomes the SPA's first screen, fed by `GET /api/v1/discovery`; the old `dashboard.mjs` is deleted once the SPA renders the same information.

### 5.2 Data pipeline: streaming adapters, Context IR, incremental index

```
vendor files ──> adapters/{claude,codex}.mjs (line-streaming, never load a file whole)
             ──> Context IR (Run → AgentScope → Request → Block)
             ──> reconcile.mjs (section 3.1)  ──> rules/*.mjs (section 4)
             ──> index writer: ~/.contextscope/index/v1/<vendor>/<sha1(absolutePath)>.json
                                ~/.contextscope/index/v1/manifest.json  { path, size, mtimeMs, adapterVersion, runId }
```

- Incremental: on launch, `stat` every candidate file (cheap; 1,000 stats take milliseconds), compare `(size, mtimeMs, adapterVersion)` with the manifest, and re-parse only changed files. Files that grew (live sessions) are re-parsed from byte 0 in cycle 1 (append-resume is a later optimisation; it needs per-line offsets stored in the index). Per-file work runs in a small worker pool (`node:worker_threads`, 4 workers), and the server streams progress over `GET /api/v1/index/events` (SSE) so the UI shows "indexed 212/218" instead of a spinner.
- Index content is metadata only: sizes, hashes, categories, tool names, relative paths, token numbers, timestamps. No message text, no tool output, no absolute paths outside the user's home. The ~/.contextscope directory is created `0700`. A `contextscope index --clear` command deletes it.
- Overview is built from per-file summaries in the manifest (peak, totals, compactions, findings), so it renders without opening any session index.
- Session JSON is loaded on demand and cached in memory with an LRU of 20 sessions.
- Unknown record types are counted per adapter (`coverage.unparsedRecords`) and shown in the session rail. An adapter version bump invalidates its files in the manifest.

### 5.3 Context IR (TypeScript, `packages/ir/src/types.ts`; the CLI imports the JSON shape, the UI imports the types)

```ts
type Provenance = 'observed.vendor' | 'observed.artifact' | 'derived.exact' | 'estimated.local' | 'unknown';
type Vendor = 'claude' | 'codex';
type Category =
  | 'system' | 'instructions' | 'skills' | 'user' | 'assistant_text' | 'assistant_thinking'
  | 'tool_call' | 'tool_result.file' | 'tool_result.shell' | 'tool_result.search'
  | 'tool_result.web' | 'tool_result.other' | 'subagent_handoff' | 'compaction_summary'
  | 'attachments' | 'memory' | 'other';

interface Measured { value: number; provenance: Provenance }

interface Run {                       // one main session file plus its subagent files
  id: string;                         // `${vendor}:${sessionId}`
  vendor: Vendor;
  project: { key: string; displayName: string; cwdHash: string };   // no absolute path
  startedAt: string; endedAt: string;
  cliVersion?: string; gitBranch?: string;
  window: Measured;                   // Codex: model_context_window (observed.vendor); Claude: by model table (estimated.local)
  scopes: AgentScope[];               // scopes[0] is the parent
  summary: RunSummary;                // precomputed for the overview
  coverage: { records: number; unparsedRecords: number; requests: number; estimatorErrorMedian: number; estimatorErrorP95: number; adapterVersion: string };
}

interface AgentScope {
  id: string;                         // 'main' or agentId
  kind: 'main' | 'subagent';
  agentType?: string;                 // attributionAgent / subagent_type
  parentScopeId?: string;
  launchedAtRequest?: number;         // parent request index
  deliveredAtRequest?: number;        // parent request index where the handoff landed
  handoff?: { blockId: string; tokens: Measured; compressionRatio: Measured };   // ratio = child peak / handoff
  models: string[];
  requests: Request[];
  blocks: Block[];                    // every block ever emitted in this scope, in order
  compactions: Compaction[];
  peak: Measured;
}

interface Request {
  index: number;
  id?: string;                        // Claude requestId; Codex: synthetic `t<turn>-r<n>`
  at: string;
  model: string;
  usage: {                            // observed.vendor
    input: number; cacheCreation: number; cacheRead: number;
    output: number; thinking?: number; total: number;   // total = input + cacheCreation + cacheRead
  };
  visibleBlockIds: string[];          // V_i
  hiddenBase: Measured;               // H (estimated.local)
  scale: number;                      // k_i
  composition: Partial<Record<Category, number>>;   // reconciled; sums to usage.total
  deltaCheck?: number;                // Claude only
  newBlockIds: string[];
}

interface Block {
  id: string;                         // `${scopeId}:${seq}`
  seq: number;
  at: string;
  category: Category;
  bytes: number;                      // observed.artifact
  estTokens: number;                  // estimated.local
  tool?: { name: string; kind: 'file' | 'shell' | 'search' | 'web' | 'other' | 'agent' | 'skill'; argsHash: string; target?: string /* repo-relative path when known */ };
  toolUseId?: string;                 // links tool_call <-> tool_result
  agentId?: string;                   // for subagent_handoff and Agent calls
  firstRequest: number; lastRequest?: number;   // presence window; undefined = still present at end
  droppedBy?: string;                 // compaction id
  hash: string;                       // sha1 of content, for duplicate detection; content itself is never stored
}

interface Compaction {
  id: string; at: string; atRequest: number;
  trigger: 'auto' | 'manual' | 'unknown';
  preTokens: Measured; postTokens: Measured; droppedTokens: Measured;   // observed.vendor on Claude
  summaryBlockId?: string;
  durationMs?: number;
}

interface RunSummary {
  requests: number; processedInputTokens: number; cacheReadShare: number;
  peak: Measured; peakShareOfWindow: number; compactions: number; subagents: number;
  topBlocks: Array<Pick<Block, 'id' | 'category' | 'estTokens' | 'firstRequest'> & { tool?: string }>;
  findingIds: string[];
}

interface Finding {
  id: string; ruleId: string; severity: 'high' | 'medium' | 'low';
  scope: 'setup' | 'session' | 'subagent'; vendor?: Vendor;
  title: string; whyItMatters: string;
  evidence: Array<{ kind: 'file' | 'request' | 'block' | 'scope' | 'metric'; ref: string; label: string; value?: number; provenance: Provenance }>;
  fix: { platform: Vendor | 'both'; summary: string; snippet?: string; path?: string };
  thresholdKeys: string[];            // which editable thresholds this depends on
}

interface SetupInventory {            // Context Bill of Materials
  repo: { name: string; root: 'cwd' };
  instructionFiles: Array<{ path: string; scope: 'user' | 'project' | 'local' | 'nested' | 'rules'; vendors: Vendor[]; bytes: number; estTokens: number; precedence: number; mtime: string; loadState: 'discoverable' | 'expected.load' | 'observed.loaded'; brokenRefs: string[]; pathsFrontmatter?: string[] }>;
  skills: Array<{ name: string; path: string; hasDescription: boolean; descriptionChars: number; bodyEstTokens: number; invocations30d: number }>;
  agents: Array<{ name: string; path: string; model?: string; tools?: string[]; runs30d: number }>;
  hooks: Array<{ event: string; command: string; runs30d: number; stdoutP50: number; stdoutP95: number }>;
  mcpServers: Array<{ name: string; scope: 'user' | 'project'; toolsObserved: string[]; invocations30d: number }>;
  memory: { present: boolean; bytes: number };
  startupBudget: Record<Vendor, { instructions: Measured; skills: Measured; agents: Measured; mcpTools: Measured; total: Measured }>;
}
```

### 5.4 JSON API (all under the existing token guard)

- `GET /api/v1/overview` → `{ runs: RunSummary-with-ids[], totals, trends, topOffenders, firstFinding, index: { total, done, lastRunAt } }`
- `GET /api/v1/runs/:vendor/:id` → `Run` (scopes with requests, blocks, compactions) plus `findings: Finding[]`
- `GET /api/v1/setup` → `SetupInventory` plus `findings: Finding[]`
- `GET /api/v1/findings?scope=&vendor=` → `Finding[]`
- `GET /api/v1/thresholds` / `PUT /api/v1/thresholds` (writes only `~/.contextscope/thresholds.json`; never the repo)
- `GET /api/v1/index/events` (SSE progress), `POST /api/v1/index/refresh`
- Keep `GET /api/v1/discovery` for the consent screen. Existing evaluator/experiment/agent-analyze routes stay mounted but are not linked from the cycle-1 UI.

### 5.5 Context window sizes for Claude (`estimated.local` until a vendor field exists)

Claude transcripts do not record the window. Cycle 1 ships a table in `packages/cli/src/adapters/claude-models.json` keyed by model id prefix, with 200,000 as the default and the 1M entries for models documented with the extended window; the value is badged `estimated.local` and the badge tooltip names the table. A `total_tokens_reminder` attachment or a `compact_boundary.preTokens` larger than the table value overrides it upward (evidence beats table). When the runtime hook capture exists, the observed value replaces it.

### 5.6 Security invariants for the new server pieces

- Static files are served only from `packages/cli/ui/` with a path-normalisation check; no directory listing; `cache-control: no-store` for `index.html`.
- All `/api/v1/*` routes keep the per-launch token, `Host` and `Origin` checks that `contextscope.mjs` already has; the SSE route is no exception.
- `PUT /api/v1/thresholds` is the only write route; it writes one JSON file under `~/.contextscope/` and validates the schema (numbers only, known keys).
- Index workers receive absolute paths from the manifest but write only hashed identifiers; the UI never sees a path outside `~` and repo paths are always relative to the launched repo root.
- Blocks store a content hash for duplicate detection and never the content; the grep test in task 5 is a release gate.

### 5.7 Alternatives considered and rejected

| Option | Rejected because |
|---|---|
| Keep server-rendered HTML strings and add `<script>` islands | The session view needs shared interactive state across five panels; string templating cannot express it without becoming a framework. |
| Full React + Vite in `packages/cli` | 140 KB runtime and a build toolchain that leaks into the published package; Preact gives the same model at 4 KB. |
| A charting library (Chart.js, Recharts, Plotly) | Three chart types, one of them (lanes with arrows) unsupported by any of them; libraries fight keyboard focus and theme tokens. |
| SQLite index via a native module | Native builds break `npx` on some machines; JSON-per-file plus a manifest handles 1,000 sessions comfortably and stays dependency-free. |
| Parse at every launch, no index | 900 MB at ~100 MB/s is nine seconds of pure parse before the first screen, on every launch; unacceptable for "10 seconds to answer". |
| Codex via app-server only | app-server availability depends on Codex auth state; rollout files are always there and give exact token counts. Keep app-server for thread listing. |
| Real tokenizer in cycle 1 | Anthropic has no offline tokenizer; Codex's tokenizer would add a large dependency; the reconciliation step makes chars/token adequate and measurable. |
| Health score with "hypothesis" caveats | Users read the number and ignore the caveat; the research doc is explicit that no calibrated score exists yet. |

## 6. UX principles

1. Honesty labels: every number shows its provenance badge; estimated and exact are never summed into one figure without the "reconciled" badge; "not observed" is a legitimate value rendered as an em dash with a tooltip.
2. Progressive disclosure: three answers above the fold; ledger rows, block lists, and raw usage behind expansion; no tabs inside tabs.
3. No scores without calibration: no 0-100, no letter grades, no "health". Severity and tokens-affected are the only ranking signals.
4. Every finding has "Show evidence" (jumps to the ledger row, lane, or file row that fired it) and "Copy fix" (copies the platform snippet; nothing is ever written to the repo by the UI in cycle 1).
5. Empty states teach: "No Codex sessions for this repo. Codex writes rollouts to `~/.codex/sessions` when you run `codex` here." Each empty panel names the vendor path and the command that would populate it.
6. Thresholds are hypotheses: shown next to each finding as "fires above 8,000 tokens (edit)", and editing re-runs rules locally.
7. Private by construction: the UI never receives message text, tool output, or absolute paths outside the home directory; the network tab shows only loopback JSON.

## 7. Build plan for cycle 1 (this week; 3-4 engineers)

Order is by dependency; tasks 1-3 are the critical path and start on day 1. Paths are absolute under the repo root `/Users/pat-lewczuk/projects/context-viewer/`.

1. **IR types and fixtures** (eng A, day 1): `packages/ir/src/types.ts` (section 5.3), `packages/ir/package.json`, and `packages/cli/test/fixtures/{claude,codex}/` with three synthetic sessions each (one with compaction, one with two subagents including an async one, one plain), generated by a script that produces the exact record shapes verified in section 0 (no real transcripts committed). Acceptance: `tsc --noEmit` passes; fixtures parse with `JSON.parse` line by line; a README in the fixtures dir lists which record shapes each file exercises.

2. **Claude adapter** (eng A, days 1-3): `packages/cli/src/adapters/claude.mjs`. Streams a file with `readline`; dedupes usage by `requestId`; builds blocks per section 3 using `tool_use.name` and `toolUseResult`; detects `compact_boundary` and `isCompactSummary`; loads `subagents/agent-*.jsonl` as child scopes; links handoffs by `agentId` (sync and async); counts `attachment` and `<system-reminder>` blocks; records `coverage`. Acceptance: on fixtures, request count equals distinct `requestId`s; `sum(usage.total)` equals the hand-computed value; every subagent scope has `parentScopeId` and a handoff block; on a real 20 MB session the parse takes under 2 s and peak RSS stays under 200 MB; `unparsedRecords` is 0 on fixtures.

3. **Codex adapter** (eng B, days 1-3): `packages/cli/src/adapters/codex.mjs`. One Request per `token_count` with non-null `info`; `window` from `model_context_window`; blocks from `response_item` (`message`, `function_call`, `function_call_output`, `reasoning`) with tool kind from `exec_command` argv classification; `instructions` from `turn_context.user_instructions` length (`observed.artifact`); compaction from `compacted`/`context_compacted`. Acceptance: fixtures produce the expected requests; `usage.total` equals `last_token_usage.input_tokens`; window provenance is `observed.vendor`; unknown payload types are counted, not thrown.

4. **Reconciliation and estimator** (eng B, day 3-4): `packages/cli/src/ir/reconcile.mjs`, `packages/cli/src/ir/estimate.mjs`. Implements section 3.1 including `H` recomputation after compaction and `deltaCheck`. Acceptance: `sum(composition) === usage.total` for every request (exact integer after rounding correction assigned to the largest category); p95 estimator error under 15% on the three real sessions of each vendor that the team checks locally (numbers only in the PR description, never content).

5. **Index and manifest** (eng C, days 1-3): `packages/cli/src/index/{manifest,writer,reader,worker}.mjs`, root `~/.contextscope/index/v1/`. Stat-based change detection, 4-worker pool, SSE progress, LRU session cache, `contextscope index --clear`. Acceptance: first run over 900 MB completes without loading any file whole (verified by a test that feeds a 300 MB synthetic file with 1 GB heap cap); second run with no changes finishes under 1 s and re-parses 0 files; touching one file re-parses exactly one; index files contain no key named `content`, `text`, `stdout`, `prompt`, or any absolute path (grep test).

6. **Rules engine** (eng C, days 3-5): `packages/cli/src/rules/{index,thresholds.json,S-01..S-12,B-01..B-15}.mjs`, each rule a file exporting `{ id, scope, evaluate(ir, thresholds) }`. Replace `analyzer.mjs` finding generation with the new engine (keep its evidence-graph builder for now). Acceptance: every rule has a fixture that fires it and one that does not; a finding without `evidence.length > 0` fails a shared test; `fix.snippet` present for both platforms where the table says so; thresholds are read from `~/.contextscope/thresholds.json` when present.

7. **Setup inventory (CBOM)** (eng D, days 1-3): `packages/cli/src/setup/inventory.mjs`, extending `scanner.mjs`'s repository walk with: precedence order per vendor, frontmatter parsing for skills/agents/rules, `.mcp.json` and settings hooks parsing, memory dir stat, broken-reference detection, startup budget, 30-day observed counts joined from the index. Acceptance: on this repo and on two fixture repos the inventory matches a hand-written expected JSON; no file outside the allowlist is opened (assert via an fs spy in tests).

8. **UI shell, router, theme, API client** (eng D, days 2-4): `packages/ui/{package.json,tsconfig.json,build.mjs}`, `packages/ui/src/{main.tsx,router.ts,api.ts,theme.css,components/{Badge,StatTile,Table,Sparkline}.tsx}`; esbuild output to `packages/cli/ui/`; static serving added to `packages/cli/src/contextscope.mjs`; consent screen ported. Acceptance: `npm run build -w packages/ui` produces `packages/cli/ui/{index.html,app.js,app.css}` under 120 KB gzipped total; `npx contextscope start` serves it with no build step; dark/light both pass a contrast check; `?` shows the keyboard map; all four routes render an empty state with the teaching copy.

9. **Session view** (eng A + D, days 4-6): `packages/ui/src/screens/Session.tsx`, `packages/ui/src/charts/{scale,StackedArea,CacheStrip,Lanes,Brush}.tsx`, `packages/ui/src/components/Ledger.tsx` (virtualised). Acceptance: 1,400-request session renders in under 300 ms after data arrives; hover and keyboard focus stay in sync across chart, cache strip, lanes and ledger; compaction markers show `pre -> post`; each subagent lane shows peak, handoff and ratio with badges; clicking a lane opens the child scope with a breadcrumb.

10. **Overview and Findings screens** (eng B, days 5-6): `packages/ui/src/screens/{Overview,Findings}.tsx`. Acceptance: overview loads from `/api/v1/overview` without opening session files; top offenders deep-link to the exact request; findings list supports filter by scope/vendor, "Show evidence" navigates, "Copy fix" copies the snippet and shows a toast.

11. **Setup screen** (eng C, day 6): `packages/ui/src/screens/Setup.tsx`. Acceptance: renders the CBOM tables and startup budget bars with provenance badges; the Codex bar shows the observed chain size when a session exists; broken references are listed inline.

12. **Cut over and ship** (all, day 7): delete `dashboard.mjs` and its test, bump `@contextscope/cli` to 0.9.0 with `ui/` in `files`, update `packages/cli/README.md` (routes, index location, privacy statement for the index), add a `packages/cli/test/e2e.test.mjs` that starts the server against fixtures and fetches every route. Acceptance: `node --test` green in `packages/cli`; `npx -y ./packages/cli start --yes --no-open` prints a URL and `GET /api/v1/overview` returns runs.

Not building in cycle 1: Gemini adapter (keep the existing discovery-only listing); Codex app-server ingestion into the IR (rollout files are enough for this week; keep app-server for thread listing); real tokenizer; append-resume parsing; applying fixes to files from the UI; LLM audits and evaluator UI (routes stay mounted, unlinked); experiment runner UI; hook installation; a health score of any kind; shareable exports; cloud anything; a Vite dev server with HMR (esbuild `--watch` is enough); CSV export; per-project settings UI beyond thresholds.

## 8. Consequences

- We accept one build-time toolchain (esbuild + TypeScript in `packages/ui`) in exchange for zero runtime dependencies in the CLI and no `npx`-time build.
- The composition stack is honest but approximate; the exact line and the cache strip are the ground truth, and the estimator error is on screen. If p95 error proves higher than 15% on real sessions, the fallback (hide the stack, keep the total) is already specified.
- The index directory is a new on-disk artifact under the user's home; it is metadata-only, documented, and clearable. Any future field that could carry content must be reviewed against the grep test in task 5.
- Codex handoffs stay `unknown` until app-server ingestion; the UI must render that state rather than zero.

## 9. Open questions to resolve during the week (owner in brackets)

1. Codex compaction: which of `compacted` / `context_compacted` / `compaction` carries before/after sizes, if any? If none, `preTokens` comes from the last `token_count` before the event and is `derived.exact`. [eng B]
2. Whether `.claude/rules/*.md` `paths:` frontmatter is honoured by the installed Claude Code version on this machine; S-06's fix text must not recommend an unsupported field. [eng C]
3. Codex `truncation_policy` config key name for B-01's Codex fix; verify against the config reference before shipping the snippet. [eng C]
