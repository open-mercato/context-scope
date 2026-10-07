# Session rule thresholds (`thresholds.json`)

Defaults for B-01..B-17 and the habit rules H-01..H-07. Override any key in `~/.contextscope/thresholds.json`; setup rule keys live in `thresholds.setup.md`.

- `fatToolResultTokens` (8000): B-01 fires for any single tool result whose estimated tokens exceed this.
- `fatBlockWindowShare` (0.05): window-relative severity for the block-size rules B-01, B-03 and B-14. A finding is `high` only when one aggregated block reaches `max(<rule threshold>, fatBlockWindowShare × run.window)`; otherwise it keeps the rule's base severity (`medium`). A 10k result on a 1M window is 1% of the window, not a task-failure risk.
- `repeatedFatResultTokens` (3000): B-02 counts tool results above this size, per tool kind.
- `repeatedFatResultCount` (5): B-02 fires when one tool kind produces at least this many results above `repeatedFatResultTokens` in a session.
- `hugeFileReadTokens` (20000): B-03 fires for a single file-read result above this.
- `repeatedIdenticalCalls` (3): B-04 fires when the same tool with an identical argument hash runs at least this many times in one scope *and the results were identical too* (block `hash`, the sha1 of the result content). A command repeated with results that differ is a re-check (polling, a build after edits), not a cache miss; calls without a logged result are not judged. Tools that re-sample state by name (`/screenshot|wait|sleep|poll|reload|navigate|status|monitor/i`) and shell calls whose target or label says sleep/wait/poll/watch/until are skipped outright.
- `fatHandoffTokens` (4000): B-05 fires when a subagent handoff exceeds this many tokens.
- `fatHandoffShare` (0.4): B-05 also fires when the handoff exceeds this share of the child's own peak context.
- `subagentRereadFiles` (3): B-06 fires when a child reads at least this many files the parent had already read before launching it.
- `compactionsPerHour` (1): B-07 fires when compactions per active hour exceed this (needs at least two compactions).
- `compactionsPerSession` (3): B-07 fires when a session has at least this many compactions regardless of duration.
- `runningHotShare` (0.8): B-08 treats a request as "hot" when its total exceeds this share of the context window.
- `runningHotRequests` (10): B-08 fires after this many consecutive hot requests.
- `cacheChurnShare` (0.2): B-09 treats a request as churning when `cache_creation` exceeds this share of its total.
- `cacheChurnRequestShare` (0.3): B-09 fires when at least this share of eligible requests churn with little new content.
- `cacheChurnMinRequest` (5): B-09 ignores requests with an index below this (the prefix is still being built).
- `systemShareHigh` (0.25): B-10 fires when the hidden base `H` of the first request exceeds this share of the window.
- `turnOverheadUserTokens` (50): B-11 treats a request as a tiny follow-up when it *starts a human turn* (its `turn` differs from the previous request's and its new blocks include a `user` block) with less than this much new user content. Tool-loop steps (tool_use → tool_result → next request) and deliveries without a user block (handoffs, attachments) never count: they are the agent's work, not the user's habit.
- `turnOverheadTotal` (100000): B-11 only counts tiny follow-ups whose request total exceeds this.
- `turnOverheadRequests` (10): B-11 fires after this many tiny-but-expensive turn starts.
- `toolResultsDominateShare` (0.6): B-12 fires when `tool_result.*` categories exceed this share of occupancy at the session peak.
- `sessionTooLongTokens` (3000000): B-13 fires when processed input tokens exceed this *and* the session has at least one active hour. Processed input grows with every request, so a busy 20-minute session can cross the token bar on its own; the rule is about length.
- `sessionTooLongHours` (4): B-13 also fires when active time exceeds this many hours and the session compacted at least twice.
- `searchFloodTokens` (4000): B-14 fires for a search-style result (Grep/Glob/rg/find) above this.
- `parallelDuplicateFiles` (3): B-15 fires when two sibling subagents read at least this many identical files or run this many identical commands.
- `toolArgsDominateShare` (0.35): B-17 fires when the `tool_call` category (Write/Edit/apply_patch payloads, commands with inlined content) is at least this share of occupancy at the session peak.
- `unloggedShareHigh` (0.15): B-16 fires when a scope's `unloggedShare` (input the model saw that is not in the transcript, reconciliation v2) reaches this, or when `baseSteps` holds a positive step of at least 5,000 tokens (constant in the rule). Negative steps are hidden mass leaving the window (a compaction, a swapped instruction file): they are never evidence, never counted and never called an injection. Scopes the IR marks `transcriptIncomplete` (Codex legacy `history_mode` children) are skipped. The non-resumed fix names the request where the hidden input grew and points at `contextscope hooks install --scope user` (runtime evidence of what was loaded) rather than guessing at MCP servers.

## Habit rules (H-01..H-07, ADR-003 section 2)

Habit rules run at read time over the manifest's per-session habit records; a session is a top-level run and a Codex child rollout's record is merged into its root's (ADR-004 section 2). A rule that needs more sessions than the repo has is reported as a note ("H-04 needs 6 sessions, this repo has 3"), not silently skipped.

- `habitMinSessions` (3): H-01, H-02 and H-03 need the same (kind, target) / file / agent type in at least this many sessions; H-04 needs twice as many (a recent window and a previous one).
- `habitFatTotalTokens` (30000): H-01 fires only when the recurring result group has cost at least this many tokens together. Every entry of a habit record's `fat` list is already at or above `fatToolResultTokens` (8,000), so a per-result bar across three sessions would always pass; three results at the floor are 24k and not yet a habit. Groups are keyed by tool *kind* and target, not tool name: Codex `exec` running `tools.web__run` is a web fetch, Claude `Bash` running `cat path` is a file read. Fat tool-call payloads (Write/Edit arguments) form their own `call` groups with a fix on the writing side.
- `fatHandoffTokens` (4000): H-03 fires when an agent type's median handoff reaches this, or when its median compression is below 3x and the median handoff is at least half this (a 1.5k handoff from a 3k peak is not fat). Built-in agent types (`Explore`, `general-purpose`, `Plan`, ...) have no `.claude/agents/<type>.md`; their fix goes to `CLAUDE.md`.
- `habitFullReadTokens` (2000): H-02 fires when a file read whole across sessions averages at least this per read (the fix is a range or a grep).
- `habitRereadSessions` (3), `habitRereadMinTokens` (300): H-07 fires when the same repo-relative file is read whole in at least this many sessions and each read is between `habitRereadMinTokens` and `habitFullReadTokens` (below: cheap to re-read; above: H-02's case). The fix carries the knowledge over (a summary in the instructions or auto-memory, a pointer to the section). Generated files are skipped.
- `habitCompactionRatio` (1.5), `habitCompactionMinRecent` (3): H-04 compares compactions per 1k requests over the last 10 sessions with the previous 10.
- `habitStartupMinSessions` (2), `habitStartupDeltaTokens` (1000), `habitStartupDeltaShare` (0.15): H-05 needs this many sessions on each side of an instruction edit and a median startup-base move of at least max(tokens, share).
- `habitMcpUnusedSessions` (5): H-06 fires for a configured MCP server with no call in at least this many sessions of its vendor. The fix follows the server's scope: a `.mcp.json` (project) server is disabled with `disabledMcpjsonServers` in `.claude/settings.local.json`; a user- or local-scope server is removed with `claude mcp remove -s <scope>`.

## Aggregation and severity (ADR-002 B)

Per-block rules emit one finding per (rule, run, scope) with `count` = occurrences, at most 5 evidence items (the top blocks by tokens; subagent findings keep one slot for the scope itself), `tokensAffected` summed over every occurrence, `scopeId`, and a title that carries the count (`Fat tool result ×14`). The finding id is `ruleId:sha1(runId#scopeId)`, so it does not change as occurrences come and go. Aggregated: B-01, B-03, B-04 (identical-call groups), B-14; B-08 (streaks, at most 3 as evidence); B-15 (sibling pairs, per parent scope); B-05 (per agent type, evidence = fattest child handoffs; `fix.path` is set only when the setup inventory passed as `evaluateRun(run, { setup })` holds that agent file). Scalar rules carry no `count`.

Base severities against ADR-001 (`high` = likely to cause task failure or compaction, `medium` = measurable waste, `low` = hygiene):

| Rule | Severity | Change from ADR-001 |
|---|---|---|
| B-01 fat tool result | medium, window-relative `high` | was `high`; one block is rarely a failure risk on its own, the habit is B-02's job |
| B-02 repeated fat results | high | unchanged: the habit rule |
| B-03 huge file read | medium, window-relative `high` | was `high`; a 25k lockfile read on a 1M window is waste, on a 200k window it is `high` because 25k ≥ max(20k, 10k) |
| B-04, B-06, B-09, B-10, B-12, B-13 | medium | unchanged |
| B-05 fat handoff | high | unchanged (defeats the isolation the subagent exists for) |
| B-07 frequent compaction, B-08 running hot | high | unchanged (compaction is the definition of `high`) |
| B-11 turn overhead, B-15 parallel duplicate work | low | unchanged |
| B-14 search flood | medium, window-relative `high` | base unchanged; the window rule can raise it |
| B-16 unlogged context | medium | new; it is measurable waste, and often a resumed session rather than a defect |
| B-17 tool arguments dominate | medium | new (ADR-004 section 3); arguments are content the agent produced and can shrink |

B-10 `system-share-high` counts `composition.system + composition.instructions` of the first request only; `unlogged` mass (resumed history, hidden injections) belongs to B-16 and never makes a setup finding.

Recurrence across sessions is not computed by the engine; the API layer fills `sessions` at read time from the manifest and `rankFindings` uses it as the third key.

## Scope-aware fixes (util.mjs `platformFix(run, variants, { scope })`)

A finding whose scope is a child (a Claude subagent scope, or any scope of a Codex child thread, `run.kind === "subagent-run"`) never tells the reader to delegate, `/clear`, `/new` or start a fresh session: a child cannot do any of that. With `{ scope }` the helper picks `variants.subagent` (keyed by vendor) when the rule provides one, otherwise `childScopeFix`: fix the agent definition (`.claude/agents/<type>.md`, or the Agent prompt for a built-in type; the Codex spawn prompt) so the child keeps tool output out of the handoff and returns paths and decisions only. Applied in B-01 (the "delegate" fallback; ranged-read and cap-output fixes stay), B-04, B-07, B-08, B-11, B-12, B-13 and B-16. File paths in fixes fall back to the block `label` when `tool.target` is missing (`toolTarget`).
