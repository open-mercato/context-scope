# Codex CLI session rollout format — evidence-based reference

Scope: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. Corpus analysed: **80 files, 123 MB,
21,036 JSONL records**, CLI versions 0.128.0 → 0.150.1, dates 2026-05-04 → 2026-09-02. All numbers below are
aggregates over this corpus. No message text, prompts or tool contents are reproduced; only keys, types, enum
values, counts and placeholder shapes.

## 0. `~/.codex/` layout (what a local analyser may touch)

| Path | What it is |
|---|---|
| `sessions/YYYY/MM/DD/rollout-*.jsonl` | Thread rollouts (this doc). One file per thread, incl. subagent threads. File uuid == first `session_meta.id` (107/167 metas; the rest are copied parent metas, see §7). |
| `config.toml` | Top-level keys: `notify`, `sandbox_mode`, `approval_policy`, `approvals_reviewer`, `service_tier`, `model`, `model_reasoning_effort`; tables `[projects."<abs path>"].trust_level`, `[tui.*]`, `[marketplaces.*]`, `[plugins."<name>@<marketplace>"].enabled`, `[features]`, `[mcp_servers.<name>]` (+ `.env`), `[shell_environment_policy.set]`, `[desktop.*]`. Contains env values -> treat as secret-bearing, never render values. |
| `AGENTS.md`, `AGENTS.override.md` | Absent on this machine (global instruction files are optional). |
| `skills/.system/<skill>/SKILL.md` | Bundled system skills (review-agent, skill-creator, plugin-creator, skill-installer, openai-docs, imagegen). User `skills/` otherwise empty. |
| `memories/` | Empty dir. `memories_1.sqlite` exists (memory feature stores in sqlite, not files). |
| `session_index.jsonl` | `{id, thread_name, updated_at}` per named thread (10 rows). |
| `history.jsonl` | `{session_id, ts, text}` — user prompt history (66 rows). Text is user content: private. |
| `auth.json` | Credentials. Never read. |
| `logs_2.sqlite`, `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`, `sqlite/*.db` | Desktop/app state DBs. Not needed for context analysis. |
| `models_cache.json`, `version.json`, `installation_id`, `.codex-global-state.json` | Metadata. `version.json` = `{latest_version, last_checked_at, dismissed_version}`. |
| `shell_snapshots/<thread>.<ns>.sh`, `thread-writer-locks/<thread>.lock`, `plugins/`, `cache/`, `attachments/`, `generated_images/`, `computer-use/`, `node_repl/`, `dictation-history/`, `ipc/`, `log/`(empty), `tmp/`, `.tmp/` | Runtime artefacts. `archived_sessions/` does **not** exist here. |

## 1. Record envelope and top-level `type` inventory

Every line: `{"timestamp": "<ISO-8601 Z, ms>", "type": <string>, "payload": <object>, "ordinal"?: <int>}`.
`ordinal` is present on 11,003/21,034 records — only in files whose `session_meta.history_mode == "paginated"`
(CLI ≥ 0.150) and on some 0.147 records; absent in `legacy` files.

| type | records | bytes | share of bytes | payload keys (count) |
|---|---|---|---|---|
| `event_msg` | 10,236 | 66.8 MB | 53 % | `type` + per-subtype keys (§4) |
| `response_item` | 9,403 | 44.9 MB | 36 % | `type`, `id`, `internal_chat_message_metadata_passthrough`, + per-subtype (§5) |
| `turn_context` | 514 | 1.85 MB | 1.5 % | §3 |
| `world_state` | 461 | 2.15 MB | 1.7 % | `full: bool`, `state: object` (§8) |
| `session_meta` | 167 | 4.9 MB | 3.9 % | §2 |
| `inter_agent_communication_metadata` | 226 | 29 KB | — | `trigger_turn: bool` (always immediately precedes a `response_item.type=="agent_message"`) |
| `compacted` | 27 | 4.47 MB | 3.6 % | `message: string(always "")`, `replacement_history: array`, `window_number`, `window_id`, `first_window_id`, `previous_window_id` (§6) |

Line length: p50 806 chars, p90 6.5 KB, p99 76 KB, max 2.2 MB (a single `custom_tool_call_output`).

**Parser gotcha:** one file contains a raw U+2028 inside a JSON string. Node `readline` splits on U+2028 and
yields 2 unparseable fragments. Split on `\n` bytes only (`fs` stream + manual `\n` scan, or `split('\n')`).

## 2. `session_meta`

Keys (of 167): `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model_provider` (always `"openai"`),
`base_instructions` (167); `git` {`branch`, `commit_hash`?, `repository_url`?} (159); `thread_source` (159),
`session_id` (158), `history_mode` (158), `context_window` {`window_id`} (158); `dynamic_tools` (63);
`memory_mode` (51); `parent_thread_id`, `multi_agent_version` (62); `forked_from_id`, `agent_nickname`,
`agent_path` (37); `subagent_history_start_ordinal` (32).

- `base_instructions`: object `{text: string, provenance?: {type, model}}` (provenance in 88). Older (≤0.132) still object with `text`.
  **Size of hidden system prompt: 17,730 chars (p50), 18,446 (p90), max 21,335 chars** (≈4.5–5.5k tokens). Contains `# Personality` / `# Rules for getting work done` sections (markdown headers, no XML wrappers).
- `source` enum: `"cli"` (45), `"vscode"` (60 — also used by Codex Desktop), `{"subagent":{"other":"guardian"}}` (25),
  `{"subagent":{"thread_spawn":{parent_thread_id, depth, agent_path, agent_nickname, agent_role:null}}}` (37; depth 1 or 2).
- `originator` enum: `codex-tui` 98, `Codex Desktop` 66, `codex_work_desktop` 1, custom string 2 (settable by embedders).
- `thread_source` enum: `"user"` 97, `"guardian_review"` 21, `"subagent"` 41, absent 8.
- `history_mode`: `"legacy"` 91, `"paginated"` 67, absent 9. `memory_mode`: `"enabled"` 51.
- `session_id`: equals `id` in 96, differs in 62 (= copied parent metas, §7).
- `cli_version` seen: 0.128.0 (6), 0.132.0 (3), 0.146.0-alpha.3.1 (5), 0.146.0 (3), 0.147.0-alpha.6.5 (62), 0.150.1 (88).
- `dynamic_tools`: array of `{type:"namespace", name, description, tools:[…]}` (1, 16 or 17 tools) — the collaboration tool namespace.
- **Repeats:** 39 files hold ≥2 `session_meta`. Two patterns: (a) forked subagent files carry child meta then parent meta (different ids, §7); (b) `vscode`/`legacy` files re-emit the *same* meta on every reconnect/resume (up to 19×, e.g. after `event_msg.user_message`). Treat first record as canonical; later same-id copies are no-ops.

## 3. `turn_context` (514 records; one per turn start, occasionally re-emitted)

Keys: `turn_id`, `cwd`, `current_date`, `timezone`, `approval_policy`, `sandbox_policy`, `permission_profile`, `model`,
`personality`, `collaboration_mode`, `realtime_active`, `summary` (all 514); `file_system_sandbox_policy` (473);
`workspace_roots[]`, `approvals_reviewer`, `comp_hash`, `multi_agent_version` (497); `effort` (373);
`user_instructions` (14); `truncation_policy` (17); `multi_agent_mode` (5).

- `model`: `gpt-5.6-sol` 223, `codex-auto-review` 251 (guardian reviewer threads), `gpt-5.6-terra` 23, `gpt-5.5` 16, `gpt-5.4-mini` 1.
- `approval_policy`: `"on-request"` 260, `"never"` 254. `approvals_reviewer`: `"auto_review"` 482, `"user"` 15.
- `sandbox_policy.type`: `"workspace-write"` 263 (with `network_access`, `exclude_slash_tmp`, `exclude_tmpdir_env_var`, `writable_roots[]`?), `"read-only"` 251.
- `permission_profile`: `{type:"managed", network:"restricted", file_system:{type:"restricted", entries:[{access, path:{type,value}}]}}` (all).
- `effort`: `low` 293, `high` 74, `medium` 6, absent 141. `summary`: `auto` 497, `none` 17. `personality`: `pragmatic` 394, `friendly` 120.
- `collaboration_mode`: `{mode:"default", settings:{model, reasoning_effort|null, developer_instructions: string|null}}`; `developer_instructions` is 925 chars when present (212/514) — a hidden developer prompt.
- `user_instructions` (only 14 records, all ≤0.132): raw AGENTS.md concatenation, 27–33 KB. In current versions AGENTS.md is **not** in `turn_context`; it appears as a user-message part (§8) and in `world_state.state.agents_md`.
- `truncation_policy`: `{mode:"tokens", limit:10000}` (17, old versions only).
- Nothing in `turn_context` names loaded skills/plugins — see `world_state` and developer messages (§8).

## 4. `event_msg` (10,236)

| payload.type | n | keys |
|---|---|---|
| `token_count` | 3,450 | `info` (null in 6), `rate_limits` |
| `item_completed` | 3,043 | `thread_id`, `turn_id`, `item{type,id,…}`, `started_at_ms`, `completed_at_ms` (0.147+ only) |
| `agent_reasoning` | 746 | `text` |
| `agent_message` | 577 | `message`, `phase` (`final_answer` 342 / `commentary` 235), `memory_citation` |
| `task_started` | 494 | `turn_id`, `started_at` (unix **seconds**), `model_context_window`, `collaboration_mode_kind` |
| `task_complete` | 465 | `turn_id`, `last_agent_message`, `started_at`?, `completed_at`, `duration_ms`, `time_to_first_token_ms` |
| `thread_settings_applied` | 363 | `thread_settings{model, model_provider_id, cwd, approval_policy, approvals_reviewer, permission_profile, active_permission_profile, collaboration_mode, personality, reasoning_effort, reasoning_summary, service_tier}` |
| `user_message` | 347 | `message`, `images[]`, `local_images[]`, `text_elements[]`, `audio[]`?, `local_audio[]`?, `client_id`? |
| `patch_apply_end` | 310 | `call_id`, `turn_id`, `stdout`, `stderr`, `success`, `changes{<abs path>:{type, content|unified_diff, move_path}}`, `status` |
| `exec_command_end` | 219 | `call_id`, `process_id`, `turn_id`, `command[]`, `cwd`, `parsed_cmd[]`, `source` (`unified_exec_startup`), `stdout`, `stderr`, `aggregated_output`, `formatted_output`, `exit_code`, `duration{secs,nanos}`, `status` (`completed` 204 / `failed` 15) |
| `web_search_end` | 152 | `call_id`, `query`, `action{type,query,queries[]}`, `results`? |
| `sub_agent_activity` | 29 | `event_id`, `occurred_at_ms`, `agent_thread_id`, `agent_path`, `kind` (`started` / `interacted` / `interrupted`) |
| `mcp_tool_call_end` | 17 | `call_id`, `invocation{server,tool,arguments}`, `duration`, `result{Ok{content[],isError,structuredContent}}`, `read_only_hint`, connector fields |
| `context_compacted` | 11 | (no other keys) |
| `image_generation_end` | 7 | `call_id`, `status`, `revised_prompt`, `result`, `saved_path` |
| `turn_aborted` | 4 | `turn_id`, `reason` (`interrupted`), `started_at`, `completed_at`, `duration_ms` |
| `error` 1, `thread_rolled_back` 1 (`num_turns`) | | |

`item_completed.item.type` values: `Reasoning` 1314, `CommandExecution` 794, `AgentMessage` 274, `FileChange` 236,
`SubAgentActivity` 213, `CollabAgentToolCall` 163, `UserMessage` 42, `McpToolCall` 4, `ContextCompaction` 3.

### 4.1 `token_count` — exact shape

```json
{"type":"token_count",
 "info":{"total_token_usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N,"total_tokens":N},
         "last_token_usage": {"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N,"total_tokens":N},
         "model_context_window":258400},
 "rate_limits":{"limit_id":"<str>","limit_name":null,"plan_type":"<str>",
                "primary":{"used_percent":N,"window_minutes":N,"resets_at":N},"secondary":null,"credits":null,"rate_limit_reached_type":null}}
```

`last_token_usage` and `total_token_usage` additionally carry **`cache_write_input_tokens`** from
**0.146.0** on (0.146.0, 0.146.0-alpha, 0.147.0-alpha, 0.150.1: 71 of 80 local files; absent on 0.128
and 0.132). The value is **0 in all 6,554 records seen locally**, so prompt-cache writes are not
observable on this machine; the adapter maps it to `Usage.cacheCreation` when present (undefined
otherwise) and leaves `Usage.total = input_tokens` unchanged.

Verified invariants (3,444 non-null infos):
- `cached_input_tokens ≤ input_tokens` in **100 %** → `input_tokens` already includes cached tokens.
- `last.total_tokens == last.input_tokens + last.output_tokens` in 99.6 % (15 exceptions).
- `total_token_usage` is cumulative and monotonic (99.85 %); `Δtotal == last.total_tokens` in 97.7 % (exceptions cluster at resume/compaction).
- `model_context_window` = 258,400 in all records (all models seen).
- **One `token_count` per model request**: 1,845 follow a `custom_tool_call_output`, 417 a `function_call_output`, 423 an assistant `message`, 283 another `token_count` (back-to-back requests, `info` differs in 281/283). Six `info:null` records occur at index 7 right after the first `user_message` (session start).
- Duplicates are true separate requests, not echoes.

**Context occupancy per request = `last_token_usage.input_tokens`** (what was sent). After a real compaction the
first `token_count` carries `last_token_usage` all zeros (reset marker), then the next request shows the new baseline.

Series, long Desktop session (583 requests, 5 compactions), `input/cached/output/reasoning | cumulative total`, every ~12th:
`18422/11008/290/68 | 18.7k` → `35011/24320` → `37478/36608` → `41834/40704/7852/89` → `62122/61184` → `68563/66688` →
`113513/108672` → `160030/153856` → `213413/211456` → **compaction** → `52902/49408` → `102684/94464` → `167671/158976` →
`204177/194816` → `221802/221440` → `227299/224512` → **compaction** → `42809/34048`. Cumulative total reaches 23.7 M
(billing-style, includes re-sent cached input each request).

Around every real compaction (n=12): last inputs before = 208,620–235,600 (81–91 % of window); immediately after:
`[0,0]` then 24–27 k (one case 81 k) with `cached` ≈ 11,008 (the cached prefix = base instructions + developer blocks).

Timings: `task_complete.duration_ms` p50 5.8 s, p90 448 s, max 52 min; `time_to_first_token_ms` p50 3.5 s.

## 5. `response_item` (9,403)

| payload.type | n | keys |
|---|---|---|
| `reasoning` | 2,496 | `summary[{type:"summary_text", text}]` (often empty), `encrypted_content` (952–8,036 chars, opaque), `content` (null, 101) |
| `custom_tool_call` | 1,861 | `name` (`exec` 1846, `apply_patch` 15), `input: string` (freeform), `call_id`, `status` |
| `custom_tool_call_output` | 1,859 | `call_id`, `output` |
| `message` | 1,606 | `role` (`assistant` 826, `user` 578, `developer` 202; no `system`), `content[]`, `phase` (assistant only: `final_answer` 471, `commentary` 355) |
| `function_call` | 675 | `name`, `arguments` (JSON string), `call_id`, `namespace`? (`"collaboration"` on all agent tools) |
| `function_call_output` | 675 | `call_id`, `output` (string 656, array 19) |
| `agent_message` | 226 | `author`, `recipient`, `content[{type,text}]` — inter-agent mail, paired with `inter_agent_communication_metadata` |
| `web_search_call` | 5 | `status`, `action{type,query,queries[]}` |

Not seen: `local_shell_call`, `ghost_snapshot`, `system` role, `multi_tool_use.parallel`, `read_file`, `spawn_agent` as custom tool.

`id` prefixes: `msg_`, `rs_`, `fc_`, `fco_`, `ctc_`, `ctco_`, `amsg_`. `internal_chat_message_metadata_passthrough` keys:
`turn_id` (8,617), `create_time` (4,293), `content_item_kinds[]` (1,073).

Content part types: user `input_text` 6,400 + `input_image` 18; developer `input_text` 413; assistant `output_text` 826.
Text sizes (chars): user parts p50 1,820 / p90 22 k / max 57 k; assistant p50 269 / max 12 k; developer p50 312 / max 29 k.

`function_call.name` distribution: `exec_command` 224, `wait_agent` 176, `send_message` 137, `spawn_agent` 36,
`write_stdin` 36, `list_agents` 29, `wait` 22, `followup_task` 12, `interrupt_agent` 3.
Argument keys: `exec_command{cmd, workdir, max_output_tokens, yield_time_ms}` (max_output_tokens 2k–40k, mode 12,000;
yield_time_ms 1000/30000), `write_stdin{session_id, chars, max_output_tokens, yield_time_ms}`, `wait{cell_id, max_tokens, yield_time_ms}`,
`spawn_agent{task_name, message, fork_turns}`, `wait_agent{timeout_ms}`, `send_message{target, message}`, `followup_task{target, message}`, `interrupt_agent{target}`, `list_agents{}`.

### 5.1 Tool output sizes and truncation markers

- `function_call_output.output` (675): p50 47 chars, p90 8.2 KB, p99 40 KB, max 94.5 KB. Total 1.7 MB.
- `custom_tool_call_output.output` (1,859): p50 730, p90 34 KB, p99 41 KB, **max 2.17 MB**. Total 22.7 MB (= 50 % of all response_item bytes).
- `custom_tool_call_output.output` is an **array** in 1,825 cases: `[{type:"input_text", text}, …]` (3,711 parts) plus `{type:"input_image", image_url, detail}` (6); a plain string in 35 (running-cell notices); `apply_patch` returns an object `{output, metadata:{exit_code, duration_seconds}}` (15).
- `exec` (custom) text layout: line1 `Script completed` | `Script failed` | `Script running with cell ID N`, line2 `Wall time N.N seconds`, line3 `Output:`, then body.
- `exec_command` (function) output layout: `Chunk ID: <hex>` ⏎ `Wall time: N.N seconds` ⏎ `Process exited with code N` | `Process running with session ID N` ⏎ `Original token count: N` ⏎ `Output:` ⏎ body. Collaboration tools return JSON objects (`{task_name}`, `{message, timed_out}`, `{agents}`, `{previous_status}`).
- Truncation markers emitted by Codex (exact, digits generalised):
  - `Warning: truncated output (original token count: N)` ⏎ `Total output lines: N` — head of a truncated body (131 in custom outputs, 13 in function outputs).
  - inline `…N tokens truncated…` (U+2026 ellipses) splicing head and tail (124).
  - `<truncated omitted_approx_tokens=N>` (no closing tag; 306 occurrences, only inside guardian history-injection parts).
  - `Original token count: N` on every `exec_command` output (compare with body length to detect truncation).

## 6. Compaction

Two different things use `type:"compacted"`:
1. **Real context compaction** (12 records in 5 threads): sequence `token_count(in≈210–235k)` → `compacted` → `world_state` → `turn_context` → `token_count(last=0)` → `event_msg.context_compacted`. (In 2 threads the order is `task_started` → `compacted` → `token_count` → `context_compacted`, i.e. compaction at turn start.) `event_msg.context_compacted` (11) and `item_completed.item.type=ContextCompaction` (3) are the explicit markers.
2. **Fork bootstrap** for `spawn_agent(fork_turns)` subagents (15 records at index 2, right after the two `session_meta`s; `window_number:1`).

`payload.message` is always `""`. `payload.replacement_history` (9–33 items, p50 9) is the new history: user `message`s
(instruction/env/prompt parts), developer `message`s, and exactly one item `{type:"compaction", encrypted_content, id, internal_chat_message_metadata_passthrough}` —
**the summary itself is encrypted/opaque**; only its size is observable. `window_number` increments per compaction
(max 5); `first_window_id`/`previous_window_id`/`window_id` chain windows. 20/80 threads contain a `compacted` record; 7 threads exceeded 200 k input.

## 7. Subagents / multi-agent

- Orchestration is via `function_call` tools with `namespace:"collaboration"` (§5), 194 calls in one CLI orchestrator thread, 20 in a Desktop thread.
- Each spawned agent is its **own rollout file**. Layout of the 36 `thread_spawn` files: record 0 = child `session_meta` (`source.subagent.thread_spawn{parent_thread_id, depth, agent_path:"/root/<task_name>[/<sub>]", agent_nickname}`, plus top-level `parent_thread_id`, `forked_from_id`, `agent_nickname`, `agent_path`, `subagent_history_start_ordinal` (0.150 only), `thread_source:"subagent"`); record 1 = a copy of the **parent's** `session_meta` (`id == parent_thread_id`, `forked_from_id == that id`, `source` cli/vscode); record 2 = `compacted` with the forked history (`replacement_history` = 9 items); then `world_state`, `turn_context`, and the child's own turns. 1/36 files has no parent copy.
- **Linkage keys:** child→parent = `session_meta.parent_thread_id` (== `source.subagent.thread_spawn.parent_thread_id`), `forked_from_id`; parent→child = `event_msg.sub_agent_activity.agent_thread_id` (29) and `item_completed.item{type:SubAgentActivity|CollabAgentToolCall, sender_thread_id, receiver_thread_ids[]}` (376). Depth 2 exists (subagent spawning subagent).
- Role prompts are injected as **developer** messages without XML wrappers: worker threads get a part starting `You are an agent in a team of agents…` (36, ≈2.2 k chars); orchestrator gets `You are \`<path>\` the primary agent…` (11); both may be followed by `<multi_agent_mode>` parts.
- Guardian (approval reviewer) threads: 25 files, `source:{subagent:{other:"guardian"}}`, `thread_source:"guardian_review"`, model `codex-auto-review`, no tools; each turn's user message = `The following is the Codex agent history…` header part + N transcript parts (11–76 parts, 251 msgs), developer part `Use prior reviews as context…` (279 chars). One guardian thread reached 233 k and compacted.
- `inter_agent_communication_metadata{trigger_turn}` + `response_item.agent_message{author, recipient}` (226 pairs) record cross-thread messages.

## 8. Instruction loading — wrappers a parser can key on

Blocks are delivered as **separate `content[]` parts** of a single `message`; classify per part by first line.

Developer-role parts (202 msgs, 413 parts), exact open/close tags on their own lines:
`<permissions instructions>…</permissions instructions>` (72; p50 4.2 k chars), `<skills_instructions>…</skills_instructions>` (52; 4.5–22 k chars, contains `## Skills` header — this is the skills catalogue injection),
`<collaboration_mode>…</collaboration_mode>` (76; 966 chars), `<apps_instructions>` (39; 646), `<plugins_instructions>` (38; 1.0–1.6 k),
`<app-context>` (12; 4.4–8.1 k), `<multi_agent_mode>` (50; 271), `<turn_aborted>` (3), `<model_switch>` (1; 13 k).
Typical combined developer message: `[app_context] > skills_instructions > permissions_instructions > collaboration_mode > apps_instructions > plugins_instructions` (33) or `collaboration_mode > multi_agent_mode` (32).

User-role parts (578 msgs):
- AGENTS.md: part beginning `# AGENTS.md instructions for <abs path>` ⏎ blank ⏎ `<INSTRUCTIONS>` … `</INSTRUCTIONS>` (55 parts, 11.3–32.8 k chars). Concatenates all AGENTS.md on the cwd path (nested headers inside are repo content).
- `<environment_context>` … `</environment_context>` (84; 144–1,464 chars) with inner tags `<cwd>`, `<shell>`, `<current_date>`, `<timezone>`, `<filesystem>`, optional `<subagents>`. Canonical first-turn user message = `agents_md > environment_context` (54) or `environment_context` alone (18); later turns = single `plain` part (197).
- `<recommended_plugins>` (12), `<in-app-browser-context source="…">` … `</in-app-browser-context>` (25; Desktop browser capture), `<image name=[Image #N] path="…">` ref parts next to `input_image` (18), `<skill>` (2), `<turn_aborted>` (1).
- No `<user_instructions>` tag, no `<memory>` tag, no system-role messages in this corpus.

`world_state` (461; `full:true` 85): `state` keys when full: `agents_md{directory, text}` (the loaded AGENTS.md text and its dir), `environments{current_date, timezone, filesystem, environments.local{cwd,shell,status}, subagents}`,
`permissions`, `skills{includeInstructions}`, `host_skills{body, includeInstructions}`, `orchestrator_skills`, `apps_instructions`, `plugins_instructions`, `environments_instructions`, `git_attribution` (bools), `model`, `personality`, `collaboration_mode`, `multi_agent_mode`, `multi_agent_usage_hint`, `managed_developer_instructions`, `realtime{active}`.
Delta records (`full:false`, 376) carry only changed keys (`environments` 369, `collaboration_mode` 35, `multi_agent_mode` 32…). Emitted after the first user message of a turn and before `turn_context` (73) or after `compacted` (22). Present in 71/80 files (0.146+).

## 9. Timestamps, turns, sessions, versions

- Record `timestamp`: ISO-8601 UTC with ms (`2026-…T…Z`), all records. `session_meta.timestamp` same format. `task_started.started_at` = unix seconds (10 digits); `item_completed.*_ms`, `sub_agent_activity.occurred_at_ms` = unix ms.
- Turn boundary = `turn_context` (514) ≈ `task_started` (494; `turn_context ≥ task_started` in 79/80 files). `turn_id` (uuid) links `task_started`, `task_complete`, `exec_command_end`, `patch_apply_end`, `item_completed` and `internal_chat_message_passthrough.turn_id` on response items. Turn ends at `task_complete` or `turn_aborted`. Real user turns = `event_msg.user_message` (347); the `response_item` user message is the API-side copy (578, includes injected parts).
- Session duration = last − first `timestamp`: p50 4 min, 10 sessions > 1 h, max 2,633 min (multi-day, resumed) — subtract idle gaps > N min between `task_complete` and next `user_message` for "active" time.
- Models: `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.6-terra`, `gpt-5.6-sol`, `codex-auto-review`. Model can change mid-thread (`thread_settings_applied`, 363, mostly after `task_complete`).

## 10. Size stats by record type

| type | n | total bytes | mean | notes |
|---|---|---|---|---|
| event_msg | 10,236 | 66.8 MB | 6.5 KB | dominated by `item_completed` (duplicates tool output) and `exec_command_end` (stdout+aggregated+formatted, 3 copies) |
| response_item | 9,403 | 44.9 MB | 4.8 KB | 22.7 MB custom_tool_call_output; 4.5 MB encrypted reasoning; 4.2 MB user text |
| session_meta | 167 | 4.9 MB | 29 KB | 18 KB base_instructions each |
| compacted | 27 | 4.5 MB | 166 KB | replacement_history |
| world_state | 461 | 2.2 MB | 4.7 KB | full snapshots ~25 KB |
| turn_context | 514 | 1.9 MB | 3.6 KB | |

## Recommended parser algorithm

1. **Read**: stream bytes, split on `\n` only, `JSON.parse` each; tolerate a trailing partial line (live files). Keep `ordinal` if present.
2. **Identity**: first `session_meta` = thread; ignore later same-`id` metas; if a second meta with a different `id` appears at index 1 and `first.parent_thread_id == second.id`, mark the thread as a forked subagent and use `second` as `parent`. Kind = `source` (cli/vscode/subagent.thread_spawn/subagent.other=guardian).
3. **Hidden baseline**: `base_instructions.text.length` + `turn_context.collaboration_mode.settings.developer_instructions.length` + developer-part sizes by tag (§8) = fixed prefix; matches `cached_input_tokens ≈ 11,008` after compaction.
4. **Turns**: open on `turn_context` (fallback `task_started`), attach records until `task_complete`/`turn_aborted` with matching `turn_id`; `event_msg.user_message` = human input, `response_item.message/user` parts classified via §8 first-line rules (`agents_md`, `environment_context`, `plain`, …).
5. **Requests**: each `token_count` with non-null `info` = one model request. Occupancy = `last_token_usage.input_tokens`; fraction = `/ model_context_window`. Skip the all-zero record after compaction (reset marker). Attribute the request to the response items emitted since the previous `token_count` (reasoning + message/tool call) and to the preceding tool output (its size ≈ Δinput).
6. **Compaction boundaries**: `compacted` record with `event_msg.context_compacted` within ±8 records (or preceded by a `token_count` with input > 150 k) = real; `compacted` at index ≤3 after two metas = fork bootstrap. Window id = `payload.window_id`.
7. **Tool sizing**: `custom_tool_call_output.output` → join `input_text` parts; `function_call_output.output` string; parse headers (§5.1) for exit code/wall time; detect truncation by `Warning: truncated output`, `…N tokens truncated…`, `<truncated omitted_approx_tokens=N>`, and `Original token count` vs body. Prefer response_item over `item_completed`/`exec_command_end` (same data, 2–3 copies).
8. **Multi-agent graph**: edges from `parent_thread_id`, `sub_agent_activity.agent_thread_id`, `CollabAgentToolCall.receiver_thread_ids`, and `function_call.name ∈ {spawn_agent, …}` with `namespace:"collaboration"`.
9. **Privacy**: never render `base_instructions.text`, `<permissions instructions>`, `rate_limits.plan_type`, `history.jsonl`, or `config.toml` env values; a naive secret regex hit 10 records in tool outputs — redact tool bodies by default.

## Known unknowns

- Compaction summary content is `encrypted_content` — cannot measure what survived, only replacement_history sizes.
- Exact request→token mapping for reasoning: `reasoning_output_tokens` is reported but `encrypted_content` length is not a token count.
- `total_token_usage` non-monotonic in 5 records and `Δtotal ≠ last` in 79 — likely resume/re-emit; not fully explained.
- `world_state.full:false` semantics (merge vs replace) inferred, not documented.
- `ordinal` gaps in paginated mode (whether records were dropped/paged out) unverified; `subagent_history_start_ordinal` meaning inferred.
- `history_mode:"paginated"` threads may store more history in `thread_history_1.sqlite`; not inspected.
- No `system` role, `local_shell_call`, `ghost_snapshot`, or `<user_instructions>` seen — may exist in other Codex versions/configs.
- Only one `model_context_window` value (258,400) observed; per-model windows for other models unknown.
