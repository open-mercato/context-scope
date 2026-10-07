# Claude Code session transcript format — evidence-based reference

Scope: local `~/.claude` data as written by Claude Code CLI versions 2.1.209 – 2.1.258
(36 distinct versions observed), sessions dated 2026-07-14 → 2026-09-01.
Corpus: 84 project dirs, 905 MB, **218 main session files + 701 subagent files**
(~109k main records, ~124k subagent records). All numbers below are aggregated over the
whole corpus unless stated. No message content is reproduced; only keys, types, enums, counts.

## 0. Filesystem layout

```
~/.claude/
  projects/<project-dir>/                 # <project-dir> = cwd with "/" and "." -> "-"
    <sessionId>.jsonl                     # main transcript (sessionId is a UUID)
    <sessionId>/subagents/agent-<id>.jsonl      # one file per subagent, <id> = 17 hex chars
    <sessionId>/subagents/agent-<id>.meta.json  # 1:1 with the .jsonl (701/701)
    memory/MEMORY.md, memory/*.md         # auto-memory notes (present in 11/84 dirs, 0-15 files)
  history.jsonl        # one line per typed prompt: {display, pastedContents, timestamp(ms), project, sessionId}
  stats-cache.json     # {version, lastComputedDate, dailyActivity[], dailyModelTokens[], modelUsage{<model>:{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,webSearchRequests,costUSD,contextWindow,maxOutputTokens}}, totalSessions, totalMessages, longestSession, firstSessionDate, hourCounts}
  sessions/<pid>.json  # live-process registry: {pid, sessionId, cwd, startedAt, version, kind:"interactive", entrypoint, status: idle|waiting|busy, name, nameSource:"derived", ...}
  tasks/<sessionId>/*.json  # TaskCreate items: {id, subject, description, activeForm, status, blocks[], blockedBy[]} (+ .lock, .highwatermark)
  file-history/<sessionId>/ # backups referenced by file-history-snapshot/delta records
  plans/, session-env/<sessionId>/, shell-snapshots/, skills/, plugins/
```

Note: `stats-cache.json.modelUsage[*].contextWindow` and `maxOutputTokens` are **0** for every
model in this corpus — not a usable source of the window size.

Parsing caveat: 2 of 701 subagent files contain a JSON string with raw **U+2028** (line
separator) characters. Node `readline` splits on U+2028, producing 3,597 unparseable fragments;
splitting strictly on `\n` parses both files cleanly (12/12 lines). **Split on `\n` only**, and
skip lines that fail `JSON.parse` rather than aborting.

## 1. Top-level record `type` inventory

Every record has `type`. Two families: *conversation records* (chain via `uuid`/`parentUuid`,
carry `timestamp`, `sessionId`, `cwd`, `version`, `gitBranch`, `userType`, `entrypoint`,
`isSidechain`) and *session-state records* (no uuid/parentUuid, usually only `sessionId`).

| type | main | subagent | bytes (sum / p50 / max) | keys and meaning |
|---|---|---|---|---|
| `assistant` | 37,199 | 74,977 | 275 MB / 1.7 KB / 157 KB | conversation record; `message{model,id,type,role,content[],stop_reason,stop_sequence,stop_details,usage,diagnostics,container?,context_management?}`, `requestId`, `effort` ("high" only), `slug`, `attributionSkill`/`attributionMcpServer`/`attributionMcpTool`/`attributionAgent` (which skill/MCP server/agent type this call is attributed to), `isApiErrorMessage`, `error`, `apiErrorStatus`, `apiBlockIndex` (0–8: index of a content block when streamed as separate records), `truncatedAfterOutput`, `session_id`, `sessionKind`, `agentId` (subagent only) |
| `user` | 21,919 | 47,703 | 524 MB / 3.1 KB / 1.2 MB | `message{role,content}`; `promptId` (UUID, present 99.8%), `toolUseResult` (93%), `sourceToolAssistantUUID` (uuid of the assistant record that issued the tool_use; 96%), `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly`, `promptSource`, `origin{kind,...}`, `permissionMode`, `toolDenialKind`, `classifierMetaLines`, `imagePasteIds[]`, `sourceToolUseID`, `interruptedMessageId`, `queueOrigin`, `queuePriority`, `queueSkipAttachments`, `turnCompanion`, `mcpMeta`, `userFeedback`, `slug`, `sessionKind`, `agentId` (subagent only) |
| `attachment` | 13,449 | 1,425 | 44.5 MB / 565 B / 477 KB | injected context (system-reminder payloads); `attachment{type,...}` — see §6 |
| `system` | 3,318 | 0 | 2.2 MB / 597 B / 3.4 KB | `subtype`, optional `level`, `content`, `isMeta`, subtype-specific fields — see §7 |
| `last-prompt` | 5,700 | 0 | | `{lastPrompt?, leafUuid, sessionId}` — cursor to latest leaf |
| `ai-title` | 5,584 | 0 | | `{aiTitle (≤65 chars), sessionId}` |
| `mode` | 5,575 | 0 | | `{mode:"normal", sessionId}` |
| `permission-mode` | 3,295 | 0 | | `{permissionMode: auto (3,291) \| plan (5), sessionId}` |
| `queue-operation` | 3,341 | 0 | 14.9 MB | `{operation: enqueue(1,681) \| dequeue(911) \| remove(748) \| popAll(1), timestamp, sessionId, content?, reason?}` — queued user prompts |
| `bridge-session` | 2,825 | 0 | | `{sessionId, bridgeSessionId, lastSequenceNum, ownerAccountUuid?, ownerOrganizationUuid?}` (remote/bridge link) |
| `pr-link` | 2,276 | 0 | | `{sessionId, prNumber, prUrl, prRepository, timestamp}` |
| `atis-latch` | 1,559 | 0 | | `{atis:"", sessionId}` |
| `file-history-delta` | 1,041 | 0 | | `{messageId, snapshotMessageId, trackingPath, backup{backupFileName,version,backupTime,realParentDir}, timestamp}` |
| `file-history-snapshot` | 930 | 0 | 4.9 MB | `{messageId, snapshot{messageId, trackedFileBackups{<path>:...}, timestamp}, isSnapshotUpdate}` |
| `agent-name` | 522 | 0 | | `{agentName, sessionId}` |
| `relocated` | 202 | 0 | | `{sessionId, relocatedCwd}` |
| `worktree-state` | 202 | 0 | | `{worktreeSession{originalCwd,preEnterOriginalCwd,worktreePath,worktreeName,worktreeBranch,sessionId,enteredExisting}, sessionId}` |
| `artifact-autoreact-ledger` | 188 | 0 | | `{v, sessionId, accountUuid, artifacts{<uuid>:{savedAt,stampHighWater,everBaselined,everHadThreads,turnTimestamps[],threads[]}}}` |
| `frame-link` | 87 | 0 | | `{sessionId, path?, frameUrl?, title?, timestamp, artifactCount?}` |
| `artifact-comment-monitor` | 29 | 0 | | `{v, sessionId, artifacts{<uuid>:{state,writtenAtMs,title}}}` |
| `cost-state` | 20 | 0 | | `{sessionId, totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration, totalLinesAdded, totalLinesRemoved, totalDuration, startTime, modelUsage{<model>:{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,webSearchRequests,costUSD}}, hasUnknownModelCost}` |
| `fork-context-ref` | 0 | 7 | | first record of a *forked* subagent: `{agentId, parentSessionId, parentLastUuid, contextLength}` |

Not observed anywhere: `summary`, `progress`, `type:"compact"`, `leafUuid`-based summary records.
First record of a main file is a state record (`queue-operation` 63, `last-prompt` 57, `mode` 49,
`ai-title` 49) — never assume line 1 is a user message. Subagent files start with `user` (694) or
`fork-context-ref` (7).

Common conversation-record fields: `uuid` (UUID), `parentUuid` (UUID or null; null on 183 main
records = 1 per session start + after compaction, and on the first record of every subagent
file), `timestamp` (ISO-8601 with ms, `Z`; 100% of 206,855 timestamps), `sessionId` (== file
name in 100% of files), `session_id` (snake case; present on a subset; in 45/218 files it
differs from `sessionId` and in 20,558 records points to another existing main file — a
resume/fork origin), `cwd`, `version`, `gitBranch` (never empty), `userType` ("external" only),
`entrypoint` (`cli` 198,994 / `sdk-cli` 996), `isSidechain`, `slug` (human-readable session slug,
52,869 records), `sessionKind` ("bg" only, 15,525 user records — background/scheduled sessions).

## 2. Assistant records, `message.usage`, dedupe

`message.model` values: `claude-opus-5` 82,605; `claude-sonnet-5` 13,552; `claude-fable-5`
8,503; `claude-opus-4-8` 7,239; `claude-haiku-4-5-20251001` 120; `claude-fable-5-1` 101;
`<synthetic>` 56. No `[1m]` suffix anywhere. `<synthetic>` records are client-generated error
placeholders: `isApiErrorMessage:true` (52), `error` ∈ {server_error 51, rate_limit 1},
`apiErrorStatus` ∈ {429, 500, 529}, usage all zeros, `stop_reason:"stop_sequence"`.

`message.usage` keys (present on 100% of 112,176 assistant records):

```
input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
cache_creation{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens},
service_tier ("standard"), inference_geo ("not_available"),
server_tool_use{web_search_requests, web_fetch_requests}   (65%)
iterations[{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation{}, type:"message"}]  (65%)
speed ("standard")                                          (65%)
output_tokens_details{thinking_tokens}                      (32%)
```

Other message fields: `stop_reason` ∈ {tool_use 69,897; end_turn 2,776; stop_sequence 56;
max_tokens 1; null 39,446 (intermediate stream chunks)}; `stop_details` always null;
`diagnostics{cache_miss_reason{type}}`; `context_management{applied_edits[]}` (65 records);
`container` (56, null).

**Streaming split:** one API response is written as several `assistant` records sharing
`message.id` and `requestId` (112,127 records with `requestId` → 58,279 distinct requestIds;
58,328 distinct `message.id`; 53,848 records are repeats). Typical split: thinking / text /
tool_use each in its own record (`apiBlockIndex` 0..8), content arrays contain exactly one block
per record in practice (`thinking` 32,034, `text` 13,435, `tool_use` 66,715 blocks).

**Usage across chunks is NOT cumulative and NOT identical:** among repeats, 30,780 have byte-
identical usage and 23,068 differ. In every observed diff the `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens` are identical; only `output_tokens`
grows (the first chunk carries a preliminary 1–5 and lacks `iterations`/`server_tool_use`/`speed`;
the final chunk carries the real total). **Dedupe rule: group by `message.id` (fallback
`requestId`), take the record with the largest `output_tokens` (= last record); use its input
fields.** Skip `<synthetic>`/`isApiErrorMessage` records (usage all 0) and 2 opus-4-8 records with
zero usage.

## 3. Context-window occupancy and compaction

`ctx = input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (per deduped request)
is a stable "prompt size at this request" figure. Evidence: for all 12 `compact_boundary`
records, `compactMetadata.preTokens` equals the `ctx` of the last request before the boundary
within 0.1–0.3% (e.g. 940,027 vs 939,132; 1,001,760 vs 998,998; 999,992 vs 999,159).
Typical shape: `input_tokens` is 1–2 (everything is cached) and growth appears as
`cache_creation_input_tokens`; when the model switches mid-session `cache_read` drops to 0 and
`cache_creation` jumps (5ca0d315: 209,037 → 53,614 → 56,351 with cr=0), so **do not treat a
drop as compaction unless a `compact_boundary` record exists**.

Series (every ~28th request) for a compacted session (2d546eed, 1,140 requests, manual compact):
```
47079 119670 169613 250746 332691 395891 423906 457061 510864 555789 622264 666837 697154
730215 783548 839746 897464 | 55666 109306 163801 183972 218714 238305 270617 310633 ...
```
Auto-compaction fires at ~1,000,000 (observed pre: 967,050–1,001,760 for `trigger:"auto"`),
manual at 898k–955k → the effective window for `claude-opus-5` sessions is **1M tokens**.
`postTokens` is 6,295–20,656 but the first request after the boundary shows ctx 50k–70k
(system prompt + tool schemas + re-injected attachments are not in `postTokens`).

Compaction representation (12 occurrences, all 3 elements always present, in this order):
1. `{type:"system", subtype:"compact_boundary", level:"info", parentUuid:null, logicalParentUuid:<uuid of last pre-compact record>, content:<string>, compactMetadata:{trigger:"manual"|"auto", preTokens, postTokens, cumulativeDroppedTokens, durationMs, preCompactDiscoveredTools?[], preservedSegment{headUuid,anchorUuid,tailUuid}, preservedMessages{anchorUuid,uuids[],allUuids[]}}}`
2. `{type:"user", isCompactSummary:true, isVisibleInTranscriptOnly:true, message.content:<string starting "This session is being continued from a previous conversation">}` (12/12; 13 records contain that phrase — one is a resumed-session copy)
3. `attachment` records re-injecting context: `compact_file_reference{filename,displayPath}`, `file{filename,content,displayPath}`, `invoked_skills{skills[{name,path,content}]}`, then `deferred_tools_delta`, `agent_listing_delta`, `mcp_instructions_delta`, `hook_success` (SessionStart:compact hook, 6 seen).

No `type:"summary"` records exist in this corpus.

## 4. Tool use / tool result structure

`assistant.message.content[]` item: `{type:"tool_use", id:"toolu_…", name, input{…}}`.
The matching result is the **next `user` record**: `message.content:[{type:"tool_result",
tool_use_id, content: string (64,897) | [{type:"text"|"image"|"document"|"tool_reference"}] (1,813),
is_error: false 45,612 / true 1,137 / absent 19,961}]`, plus top-level `toolUseResult` (structured
payload; missing on 1,863 of 66,751 tool_result users) and `sourceToolAssistantUUID` (99.99% resolve
to an earlier assistant uuid in the same file). Image blocks in tool_result: 276 (Chrome
`computer` 122, `Read` 84 on image files, `browser_batch` 47). `toolDenialKind` ∈
{automode-blocked 48, automode-unavailable 23, user-rejected 11, permission-rule 8}.

`toolUseResult` shape by tool (object 63,017 / string 1,138 = error text when `is_error` /
array 692 = MCP tools, `[{type:"text",text}]`):

| tool | toolUseResult keys |
|---|---|
| Bash | `stdout, stderr, interrupted, isImage, noOutputExpected` + optional `persistedOutputPath, persistedOutputSize, backgroundTaskId, returnCodeInterpretation, gitOperation, timedOutAfterMs, dangerouslyDisableSandbox, ghRateLimitHint, staleReadFileStateHint, backgroundCwdHint` |
| Read | `type:"text", file{filePath, content, numLines, startLine, totalLines}` |
| Write | `type, filePath, content, structuredPatch[], originalFile, userModified, memdirStamped?` |
| Edit | `filePath, oldString, newString, originalFile, structuredPatch[], userModified, replaceAll, staleRecovered?` |
| Grep | `mode, numFiles, filenames[], content?, numLines?, totalLines?, totalFiles?, numMatches?, appliedLimit?` |
| Glob | `filenames[], durationMs, numFiles, truncated, totalMatches, countIsComplete` |
| Agent | `isAsync:true, status:"async_launched", agentId (17 hex), description, resolvedModel, prompt, outputFile, canReadOutputFile` |
| Skill | `success, commandName` |
| WebFetch | `bytes, code, codeText, result, durationMs, url, artifactRead?` |
| WebSearch | `query, results[], durationSeconds, searchCount` |
| ToolSearch | `matches[], query, total_deferred_tools` |
| AskUserQuestion | `questions[], answers{<question>:<answer>}, annotations{}` |
| TaskCreate/TaskUpdate/TaskList | `task{id,subject}` / `success, taskId, updatedFields[], statusChange{from,to}` / `tasks[]` |
| SendMessage | `success, message, resumedAgentId?, pin{id,name,ref}` |
| Monitor / ScheduleWakeup / TaskStop | `taskId, timeoutMs, persistent` / `scheduledFor, clampedDelaySeconds, wasClamped, stopped?, cancelledWakeups?` / `message, task_id, task_type, command` |
| Artifact | `url, path, title, updated, version, liveSubscription, artifact_id?, audience?, contract?` |
| EnterWorktree / ExitPlanMode | `worktreePath, worktreeBranch, message` / `plan, isAgent, filePath` |

Tool-name distribution (66,715 tool_use blocks, main+sub): Bash 46,518 (69.7%), Edit 7,186,
Read 6,751, Write 2,392, Agent 734, WebFetch 624, WebSearch 291, TaskUpdate 264, ToolSearch 187,
mcp__claude-in-chrome__computer 185, TaskCreate 168, Grep 143, mcp__claude-in-chrome__javascript_tool
117, AskUserQuestion 110, Monitor 90, mcp__claude-in-chrome__navigate 90, Glob 88, ScheduleWakeup 86,
Skill 74, mcp__playwright__* (≈330 total), ListAgents 49, SendMessage 43, Artifact 39, TaskStop 21,
SendUserFile 20, others ≤5. Note `Task` (older name) does not occur; `Agent` is the spawn tool.

`tool_use.input` keys: Bash `{command, description?, timeout?, run_in_background?,
dangerouslyDisableSandbox?}`; Read `{file_path, offset?, limit?, pages?}`; Edit `{file_path,
old_string, new_string, replace_all}`; Write `{file_path, content}`; Agent `{description, prompt,
subagent_type?, model?, isolation?}`; Skill `{skill, args?}`; Grep `{pattern, path, output_mode,
-n, -i, -C, -A, glob, head_limit}`; Glob `{pattern, path?}`. `__unparsedToolInput` appears (17) when
the model emitted malformed JSON.

## 5. Subagent linkage

Layout in this corpus is **100% separate files**: 0 of 75,885 main-file records have
`isSidechain:true`; all 124,105 subagent records have `isSidechain:true`, `agentId` (17-hex,
== file suffix), and `sessionId` == parent session id (124,198/124,198). No older in-file
sidechain layout was observed (all versions ≥ 2.1.209).

Link chain (692 of 734 Agent calls resolve; the other 42 are errors/denials with string results):
- parent `assistant.tool_use{name:"Agent", id:T}` → next parent `user` record with
  `toolUseResult.agentId = A` and `content[0].tool_use_id = T`. The tool_result text is a fixed
  ~1,088-char "launched" placeholder (p50 = p90 = max = 1,120 bytes) — **it is not the result**.
- `subagents/agent-A.meta.json` = `{agentType, description, toolUseId:T, spawnDepth, parentAgentId?
  (163 = nested spawns from inside another subagent), model?, isFork?, worktreePath?,
  spawnedWithWorktree?, worktreeBranch?, worktreeCleanlyRemoved?, stoppedByUser?}`.
  `agentType` seen: general-purpose 535, Explore 145, fork 8, audit-* 12, statusline-setup 1.
- `subagents/agent-A.jsonl`: first record `user` (parentUuid null, plain prompt text) or
  `fork-context-ref` for forks; then normal assistant/user/attachment records with own
  `message.usage` (74,977 assistant records) → **each subagent has its own context window**.
  Subagent attachments: `deferred_tools_delta` 681, `skill_listing` 681, `read_truncation_notice`
  59. No `system` records in subagent files. 184 Agent calls originate inside subagent files.
- The actual result reaches the parent later as a **`user` record with string content starting
  `<task-notification>`** (760 records; `origin.kind:"task-notification"`, `promptSource:"system"`,
  not `isMeta`). Tags inside: `task-id` (== agentId for 488; the other 261 are Monitor/background
  Bash tasks), `tool-use-id`, `output-file`, `status`, `summary`, `result`, `note`, `event`,
  `task-type`, and `usage` = `<subagent_tokens>N</subagent_tokens><tool_uses>N</tool_uses>
  <duration_ms>N</duration_ms>`. `output-file` points to
  `/private/tmp/claude-501/<project-dir>/<sessionId>/tasks/<agentId>.output`.
- **Second delivery path — `queued_command` attachment** (verified on 216 sessions, 584 agent
  handoffs): when the agent finishes while the parent is busy mid-turn, the same
  `<task-notification>` text arrives as an `attachment` record with
  `attachment.type:"queued_command"`, `commandMode:"task-notification"` (the neighbouring
  `queue-operation` records say `absorbed_mid_turn`), not as a standalone `user` record.
  Counts: 478 standalone `user` records, **106 attachments** (18 %), 4 agents delivered both.
  **0 notifications arrive inside a `tool_result`** (a blocking TaskOutput/Bash result never
  carried one in this corpus); the adapter still splits such a payload out as a
  `subagent_handoff` block with `via:"tool_result"`, covered by a synthetic fixture only.
  A parser that only scans `user` records reports 18 % of subagents as "no handoff yet".

Size asymmetry (692 linked agents): subagent file bytes p50 625 KB / p90 1.58 MB / max 8.3 MB;
API requests per agent p50 34 / p90 127 / max 458; peak ctx p50 146k / p90 303k / max 717k;
output tokens p50 28.7k / p90 87.8k / max 566k. What the parent absorbs: 1,120 B placeholder +
task-notification p50 3.4 KB / p90 13.2 KB / max 54 KB.

## 6. Instruction and context-loading evidence

**`<system-reminder>` inside user text is effectively gone** in these versions: 1 record out of
69,622. Injected context is instead written as `type:"attachment"` records (`attachment.type`
below; 14,791 chain to the previous record via `parentUuid`, 93 have null). Enumerated types
(main+sub count → payload keys):

| attachment.type | n | keys |
|---|---|---|
| total_tokens_reminder | 7,693 | `text` = `<total_tokens>N tokens left</total_tokens>` — **direct remaining-context signal** |
| hook_success | 2,203 | `hookName, toolUseID, hookEvent (SessionStart 99 / UserPromptSubmit 1,088 / Stop 1,016), content, stdout, stderr, exitCode, command, durationMs`; hookName ∈ {SessionStart:startup, SessionStart:clear, SessionStart:compact, UserPromptSubmit, Stop} |
| task_reminder | 1,656 | `content[], itemCount` (TaskCreate todo list echo) |
| deferred_tools_delta | 883 | `addedNames[], addedLines[], removedNames[], readdedNames[], pendingMcpServers?, failedMcpServers?, needsAuthMcpServers?, wireHiddenNames?` |
| skill_listing | 873 | `content, skillCount, isInitial, names[]` (up to 73 names) |
| queued_command | 381 | `prompt, commandMode, timestamp, origin?, imagePasteIds?, source_uuid?` |
| edited_text_file | 288 | `filename, snippet` |
| agent_listing_delta | 181 | `addedTypes[], addedLines[], removedTypes[], isInitial, showConcurrencyNote` |
| nested_memory | 176 | `path, content, displayPath` — basename is `CLAUDE.md` (92) or `AGENTS.md` (84): nested-directory instruction files loaded on demand |
| mcp_instructions_delta | 120 | `addedNames[], addedBlocks[], removedNames[]` |
| date_change | 103 | `newDate` |
| command_permissions | 74 | `allowedTools[]` (follows a Skill invocation) |
| read_truncation_notice | 67 | `banner, toolUseID` |
| file | 52 | `filename, content, displayPath` (`@file` mentions and post-compaction re-reads) |
| auto_mode | 38 | `autoModeConsentFlow, bashFirst, steerOnly, bypass` |
| compact_file_reference | 21 | `filename, displayPath` |
| batching_reminder_sent | 17 | `text, model` |
| bash_output_audience_note | 15 | `toolUseID` |
| directory | 12 | `path, content, displayPath` |
| hook_system_message / hook_cancelled | 5 / 1 | `content, hookName, toolUseID, hookEvent` |
| invoked_skills | 5 | `skills[{name, path, content}]` (post-compaction re-injection) |
| remote_session_change | 5 | `url, commit, pr, sendUserFileHint` |
| silent_turn_reminder 2, plan_mode 1 (`reminderType,isSubAgent,planFilePath,planExists`), plan_mode_exit 1, pdf_reference 1 | | |

**Skill tool flow** (74 invocations): `assistant tool_use{Skill}` → `user tool_result` (tiny, p50
32 chars; `toolUseResult{success, commandName}`) → **`user` record with `isMeta:true` and plain
string content = the SKILL.md body** (70/72 cases) → `attachment/command_permissions`. So skill
text sizing must read the isMeta user record, not the tool_result.

**`isMeta` user records** (396): 67 start with `<local-command-caveat>` (slash-command echoes),
331 plain (skill bodies, resume banners). Other tagged string prompts (not isMeta):
`<task-notification>` 760, `<command-name>` 67 (+`<command-message>`, `<local-command-stdout>`
17 — slash commands like /clear, /compact), `<bash-input>`/`<bash-stdout>`/`<bash-stderr>` 28
(user-run `!` shell), `<fork-boilerplate>` text block 8.

**Root CLAUDE.md / MEMORY.md are not logged.** No attachment or record carries the project-root
CLAUDE.md or `memory/MEMORY.md` content (they live in the unlogged system prompt). `MEMORY.md`
appears only in tool_use/tool_result records of explicit `Read`/`Write`/`Edit` on
`~/.claude/projects/<dir>/memory/*.md` (28 calls; `Write.toolUseResult.memdirStamped` 7) and in
file-history snapshot paths. `CLAUDE.md` string occurs in 94 user records (mostly tool results).

## 7. `type:"system"` records (3,318, main files only)

| subtype | n | level | fields |
|---|---|---|---|
| turn_duration | 1,596 | — | `durationMs, messageCount, isMeta:false, pendingBackgroundAgentCount?` — written at end of each turn |
| stop_hook_summary | 1,016 | suggestion | `hookCount, hookInfos[{command,durationMs}], hookErrors[], hookAdditionalContext[], preventedContinuation, stopReason, hasOutput, toolUseID, session_id` |
| away_summary | 529 | — | `content, isMeta` (summary shown after user was away) |
| local_command | 88 | info | `content, isMeta` |
| scheduled_task_fire | 42 | — | `content, cronKind, noOpStreak?, streakStartedAt?, foldedUuids[]?` |
| bridge_status | 25 | — | `content, url, isMeta` |
| compact_boundary | 12 | info | see §3 |
| informational | 8 | notice 6 / warning 2 | `content, isMeta` |
| api_error | 1 | error | `error{message, formatted, connection{code,message,isSSLError}, isNetworkDown, rateLimits}, retryInMs, retryAttempt, maxRetries, source` |
| agents_killed | 1 | — | |

`level` values overall: absent 2,193, suggestion 1,016, info 100, notice 6, warning 2, error 1.
No `hookEvent` on system records (hooks are `attachment/hook_success` + `stop_hook_summary`).

## 8. Time, identity, turns

- `timestamp`: ISO-8601 ms UTC on every conversation record. State records (`queue-operation`,
  `pr-link`, `frame-link`, `file-history-*`) also have one; `mode`/`ai-title`/`last-prompt` do not.
- `version`: 2.1.209 … 2.1.258 (36 values); `entrypoint`: cli / sdk-cli; `userType`: external.
- `cwd` present on 75,910 main records (all conversation records); `gitBranch` always non-empty.
- Session wall-clock (first→last timestamp, 171 main files with ≥2 timestamps): p50 10 min,
  p90 96 h, max 48 days — sessions are resumed across days; compute *active* duration by
  summing gaps below a threshold (e.g. 30 min) or from `system/turn_duration.durationMs`.
- **Turn** = a `user` record that is not a tool_result, not `isMeta`, and not a
  `<task-notification>`/`origin.kind!="human"` message, followed by everything until the next such
  record. Corpus: 1,812 prompt records; turns/session p50 1, p90 16, max 275; tool calls/turn
  p50 4, p90 28, max 303. `promptId` (UUID) is stable across a turn: tool_result records carry
  the prompt's promptId in 19,649 cases vs 118 mismatches. `promptSource` ∈ {system 803, typed 726,
  sdk 64, suggestion_accepted 60, queued 45}; `origin.kind` ∈ {human 835, task-notification 785,
  coordinator 28, peer 3} (coordinator/peer carry `from, senderTaskId, name, body`).
- Turn end marker: `system/turn_duration` (1,596). `messageCount` there is large (p50 960) —
  appears cumulative, not per-turn.

## 9. Size statistics (what fills the context)

Per-record bytes: `user` 524 MB total (60% of corpus; p50 3.1 KB, p90 13.4 KB, p99 73 KB, max
1.23 MB), `assistant` 275 MB (p50 1.7 KB, p90 3.8 KB, max 157 KB), `attachment` 44.5 MB (p90
6.4 KB, max 477 KB), `queue-operation` 14.9 MB (max 108 KB — full queued prompts).

tool_result content length (chars; text only, base64 images counted):

| tool | n | total chars | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|
| Bash | 46,517 | 85.2 M | 827 | 4,592 | 14,309 | 29,969 (hard cap ~30k) |
| Read | 6,747 | 78.2 M | 5,136 | 27,194 | 111,468 | 615,328 |
| mcp__claude-in-chrome__computer | 185 | 9.8 M | 53,935 | 115,605 | | 150,079 |
| mcp__claude-in-chrome__browser_batch | 60 | 6.3 M | 67,463 | 301,905 | | 523,047 |
| Edit | 7,186 | 1.8 M | 237 | 303 | | 5,463 |
| WebFetch | 624 | 1.3 M | 1,140 | 2,275 | 38,222 | 50,000 (cap) |
| WebSearch | 291 | 0.8 M | 2,766 | 3,291 | | 6,767 |
| Agent (placeholder) | 734 | 0.8 M | 1,088 | 1,088 | | 1,088 |
| Write | 2,392 | 0.6 M | 232 | 287 | | 344 |
| ListAgents | 49 | 0.16 M | 3,623 | | | 3,765 |
| Grep / Glob | 143 / 88 | 0.12 / 0.08 M | 212 / 141 | 2,682 / 2,464 | | 12,121 / 6,750 |

Bash and Read together are 89% of all tool-result characters; browser screenshot tools are the
largest single results. `Read.toolUseResult.file.content` duplicates the tool_result text (count
once). Assistant `thinking` blocks carry `signature` (32,034; 0 redacted_thinking).

## 10. Usage on user records / context-window indicators

- `message.usage` on user records: **0** of 69,622. No per-message limit field.
- Window-size indicators: (a) `attachment/total_tokens_reminder.text` =
  `<total_tokens>N tokens left</total_tokens>` (7,693 records; remaining budget, so window ≈ ctx
  at previous request + N); (b) `compactMetadata.preTokens` ≈ 1,000,000 at auto-compaction →
  1M window for claude-opus-5; (c) model name has no `[1m]` suffix; (d) `stats-cache.json`
  `contextWindow` is 0. `cost-state.modelUsage` gives per-model token totals, not limits.

## 11. Memory directory

`~/.claude/projects/<project-dir>/memory/` exists in 11/84 dirs; contents are `MEMORY.md` plus
topic files (`feedback_*.md`, `project_*.md`, `reference_*.md`, `user_*.md` or kebab-case names),
1–15 files, 0.2–13 KB each. Transcripts link to it **only** through ordinary Read/Write/Edit
tool calls whose `file_path` is under `/memory/` (`Write.toolUseResult.memdirStamped:true` marks
memory writes). Loading of MEMORY.md at session start is not recorded.

## 12. Recommended parser algorithm

1. **Discover**: glob `~/.claude/projects/*/*.jsonl` (main) and `*/<sid>/subagents/agent-*.jsonl`
   + `.meta.json`. Session id = file basename. Project dir name → cwd is lossy; prefer `cwd`
   from the first conversation record.
2. **Read**: stream, split on `\n` only (never `readline`), `JSON.parse` per line, skip failures
   (count them). Ignore lines without `type`.
3. **Classify**: conversation records = `type ∈ {user, assistant, system, attachment}`;
   everything else is session state (keep `ai-title`, `last-prompt`, `cost-state`, `pr-link`,
   `worktree-state`, `agent-name` for metadata; ignore the rest).
4. **API requests**: iterate `assistant` records; group by `message.id` (fallback `requestId`,
   fallback `uuid`); keep max-`output_tokens` record; drop `message.model == "<synthetic>"` or
   `isApiErrorMessage`. Request record = `{ts, model, ctx = in+cr+cc, in, cr, cc, out,
   thinking_tokens, stop_reason, content blocks merged from all chunks}`.
5. **Context occupancy**: `ctx` series per request; model-switch discontinuities are not
   compactions. Delta between consecutive ctx values ≈ tokens added by the intervening
   tool results/attachments/user text (attribute the delta to records between the two
   assistant records, weighting by char length).
6. **Compaction boundaries**: `system.subtype == "compact_boundary"`; use `compactMetadata`
   (`trigger`, `preTokens`, `postTokens`, `cumulativeDroppedTokens`) and treat the following
   `user.isCompactSummary` + attachments as the new context base. Use `logicalParentUuid` to
   connect segments; `parentUuid` is null there.
7. **Turns**: prompt records as defined in §8; `promptId` groups the turn's tool_results;
   `system/turn_duration.durationMs` gives elapsed time; end-of-turn assistant has
   `stop_reason == "end_turn"`.
8. **Tool calls**: map `tool_use.id` → `{name, input}`; resolve results by `tool_use_id` in the
   next user record; size = tool_result text length (string or concatenated text blocks; count
   image `source.data` separately); flag `is_error` and `toolDenialKind`. Use `toolUseResult`
   for structure (Read `file.numLines`, Bash `stdout/stderr` split, Grep `numFiles`, etc.).
9. **Subagent tree**: for `Agent` tool_use → `toolUseResult.agentId` → `subagents/agent-<id>.jsonl`
   + meta (`spawnDepth`, `parentAgentId` for nesting). Parse subagent files with steps 4–8
   (own usage/ctx series). Match completion via the parent's `<task-notification>` user record
   (`<task-id>` == agentId; parse `<usage>` numbers). Report parent-absorbed bytes (placeholder +
   notification) vs subagent peak ctx and output tokens.
10. **Instruction-load evidence**: from `attachment` records — `nested_memory` (CLAUDE.md/AGENTS.md
    with `path`, `content.length`), `skill_listing` (`names`, `content.length`), `invoked_skills`,
    `file`, `directory`, `mcp_instructions_delta`, `deferred_tools_delta`, `agent_listing_delta`,
    `hook_success` (hook stdout injected), `total_tokens_reminder`; from `user.isMeta` records
    following a `Skill` tool_result (skill body size); from `attributionSkill`/`attributionMcpServer`
    on assistant records (which skill/MCP was active per call).
11. **Remaining budget**: parse `total_tokens_reminder.text` N; window estimate = last ctx + N.

## 13. Known unknowns

- The system prompt (root CLAUDE.md, global memory, tool schemas, agent listing) is never
  logged; its size can only be inferred as the first request's ctx (typically 20k–70k
  `cache_creation` on request 1, or the ctx floor right after compaction).
- Whether `attachment` payloads are sent verbatim to the model, and their exact wrapping
  (`<system-reminder>`), cannot be confirmed from the transcript; ctx deltas suggest they are.
- `session_id` (snake) vs `sessionId`: semantics of the mismatch (resume/fork origin?) is
  inferred, not documented; 8,172 mismatching records reference sessions not on disk.
- `system/turn_duration.messageCount` semantics (cumulative vs per-turn) unverified.
- `atis-latch`, `bridge-session`, `artifact-*-ledger`, `frame-link` purposes are opaque.
- Context window per model is inferred (1M for opus-5 from compaction thresholds); no explicit
  field. Haiku/sonnet/fable sessions had no compaction events to calibrate against.
- `cache_creation.ephemeral_1h_input_tokens` was always 0 here; billing split not exercised.
- Whether older CLI versions (< 2.1.209) used in-file `isSidechain:true` sidechains or
  `type:"summary"` records cannot be confirmed from this corpus (none present); parsers should
  still tolerate `isSidechain:true` records inside main files and unknown `type` values.
- Two subagent files with raw U+2028 inside JSON strings: writer bug or content passthrough —
  unknown; strict-`\n` splitting handles it.
