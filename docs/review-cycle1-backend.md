# Review: cycle 1 backend (`packages/cli`)

Scope reviewed: `src/ir/*`, `src/adapters/*`, `src/index/*`, `src/server/*`, `src/rules/{index,util}.mjs` + B-01/B-05/B-07/B-09/S-01/S-08, `src/setup/{inventory,instructions,config,extensions,budget}.mjs`, `src/util/fs.mjs`, `src/contextscope.mjs`, tests under `test/`. Read against `docs/cycle1-contracts.md`, ADR-001 §3.1/§5.2/§5.6, `docs/format-claude-code.md`, `docs/format-codex.md`.

Findings marked **verified** were reproduced with a node probe over `test/fixtures/` (no real transcripts were opened). Line numbers refer to the files as of this review. Severity: **bug** (wrong number / wrong link / leak), **risk** (wrong under plausible real-world input, or security/robustness), **cleanup**.

Overall: the pipeline is well structured, streaming, and the privacy discipline (hash + size only, safe labels, key scrub) is mostly right. The problems below are concentrated in five places: project keys, compaction presence for Claude, reconciliation when totals drop, the index ↔ setup stats contract, and Codex handoff linkage.

---

## Top 10

### 1. `project.key` leaks the absolute cwd for every Claude run — bug (privacy)
`src/adapters/claude.mjs:196` sets `project.key = path.basename(projectDir)`. The Claude project directory name **is** the cwd with `/` and `.` replaced by `-` (format doc §0), e.g. `-Users-<name>-projects-x` or `-opt-client-secret`. That key is written to the run file, copied into the manifest (`src/index/entry.mjs:108-111`), projected into every overview row (`src/index/reader.mjs:48`) and returned by `GET /api/v1/runs/:vendor/:id`. This violates the contract ("no absolute paths outside `~` may enter the IR/index/API") for any cwd outside home, and it is an encoded absolute path even inside home.
Same family: `run.source.file` / `scope.source.file` (`claude.mjs:177,211`) and the SSE progress `file` field (`src/index/writer.mjs:108,180`) are `~/.claude/projects/-Users-…/<id>.jsonl`, i.e. they still carry the encoded cwd in the directory segment.
Also, three key schemes coexist: Claude dir name, Codex `${basename}-${hash8}` (`codex.mjs:658`), discovery `sha1(cwd)[0:16]` (`discover.mjs:25`). `entryMatchesRepo` (`reader.mjs:60-67`) therefore never matches on `entry.projectKey`; only the `discoveryKey`/`cwd` fallbacks work.
**Fix:** both adapters use `projectKeyFor(cwd)` from `discover.mjs` (fallback `projectKeyFor(projectDirName)`), and `displayPath` for session files replaces the project-dir segment with `cwdHash` (`~/.claude/projects/<cwdHash>/<id>.jsonl`). Add a test that the Claude run for a cwd outside `home` contains neither the cwd nor its `-`-encoded form.

### 2. Claude blocks in flight at a `compact_boundary` survive the compaction — bug (wrong numbers), verified
`src/adapters/claude.mjs:507-537` records the boundary with `atRequest = nextRequestIndex` but never closes the blocks that were emitted since the previous request (the last assistant's `tool_use`/text get `firstRequest = index + 1 == atRequest` at `claude.mjs:383`, and the tool_result/attachments that follow get `firstRequest = nextRequestIndex == atRequest`). `applyCompactionPresence` (`src/ir/reconcile.mjs:25`) only drops `firstRequest < atRequest`. On fixture 2, `main:26 tool_call`, `main:27 tool_result.shell`, `main:28 attachments` remain visible with `lastRequest` undefined for the rest of the session. Effects: the post-compaction hidden base `H` is under-estimated by their size, the composition after compaction is inflated, `deltaCheck` for the first post-boundary request is off, and B-rules attribute those blocks as still present. The Codex adapter handles exactly this case (`codex.mjs:415-424 dropInFlight`); Claude does not.
**Fix:** in `handleSystem(compact_boundary)`, for every block with `firstRequest >= atRequest` (there is no `pending` list, so scan the tail) set `lastRequest = atRequest - 1, droppedBy = id`, unless the block's source record uuid is in `compactMetadata.preservedMessages.uuids`/`allUuids` (track `uuid → blockIds` per record; the format doc §3 says Claude preserves a tail segment). Extend `adapter-claude.test.mjs` "compaction session" to assert the pre-boundary tool_result is not visible at `atRequest`.

### 3. Reconciliation produces negative category values when the vendor total drops below `H` — bug, verified
`src/ir/reconcile.mjs:66-88`: `H` is fixed at the segment start; when a later request's `total < H + est(visible)` the code sets `scale = 1` (line 68) and then applies the rounding correction `total - assigned` (a large negative) to the largest category (line 84-88). Probe: total 5000 → 4000 with 900 tokens of new blocks gives `tool_result.file: -1600`. This is not exotic in real Claude data: mid-session model switch (`cache_read` → 0, ctx 209k → 53k, format doc §3), server-side context editing (`message.context_management.applied_edits`, 65 records in the corpus), and retries. Those requests are also silently excluded from the estimator-error series (line 99), so the p95 badge never reflects them.
**Fix:** when `remainder <= 0` treat the request as a new segment (`H = max(0, total - visibleEstimate)`, `scale = 1`) and flag it (`request.reconciled = "rebased"`); clamp every category at 0 and put any residual into `system`; add a unit test for "total drops below hidden base" and one for "composition never negative".

### 4. Hook observations never reach the setup inventory (key and unit mismatch) — bug, verified
`src/index/entry.mjs:86-91` keys hook runs by the block label `hook_success:<hookName>` and pushes `block.estTokens` into `stdoutSizes`. `src/setup/config.mjs:45-58 hookRunStats` looks for `<event>:<matcher>` / `<event>` / a substring of the command, and treats the sizes as **bytes** (`estimateTokensFromBytes`, line 58, dividing by 3.6 a second time). Probe: `hookRunStats({event:"UserPromptSubmit", command:"npx eslint --fix"}, statsOf(run).hookRuns)` → `runs: 0`. Every hook in the setup view shows `runs30d 0, stdoutP50 0`, so S-10/S-11 can never fire from real sessions; the only test (`setup-inventory.test.mjs:177`) feeds hand-written keys.
**Fix:** in `statsOf`, key by the event part of `hookName` (Claude's `hookName` looks like `SessionStart:compact`, i.e. `event[:matcher]`) and push `block.bytes`; or make `hookRunStats` accept the `hook_*:` prefix and token units. Add a round-trip test `statsOf(run) → attachObservations`.

### 5. Codex handoffs are never linked to the child run — bug (missing links)
The Codex adapter emits `subagent_handoff` blocks with `agentId` = child thread id (`src/adapters/codex.mjs:600-609`) but never sets `scope.handoff`, `launchedAtRequest` or `deliveredAtRequest` (a rollout is a single `main` scope; the child is a separate run). `handoffsOf(run)` (`src/index/entry.mjs:40-53`) therefore returns `[]` for every Codex run: B-05 (fat handoff) cannot fire for Codex, `topOffenders.fattestHandoffs` never lists Codex, and the nested child rows in the overview carry no handoff size or compression ratio. `docs/cycle1-contracts.md` and ADR §2.1 promise both.
**Fix:** in `buildEntry`, store `handoffBlocks: [{ agentId, blockId, estTokens, firstRequest }]` from the parent's `subagent_handoff` blocks; in `buildOverviewFromEntries` (where `byRunId` already resolves `codex:<agentId>`) compute `handoffTokens`, `childPeak = child.summary.peak.value`, `ratio`, and attach them to both `fattestHandoffs` and the child row. For B-05, pass `runs` (sibling entries) so the rule can read the child's peak, or evaluate B-05 for Codex in a post-index pass.

### 6. `reconcileScope` is O(requests × blocks) and allocates a `visible` id array per request — risk (performance), verified
`src/ir/reconcile.mjs:51-64` rescans every block for every request and builds `visible` even when `keepVisibleIds` is false. Measured: 1,573 requests × 4,599 blocks = 60 ms per scope; a 168-scope run with several large subagents lands around 5-10 s of pure reconciliation per parse, inside the worker.
**Fix (sweep line, O(R + B + C)):** after `applyCompactionPresence`, bucket blocks by `firstRequest` (exists: `byFirst`) and by `lastRequest + 1` (`byExpire`). Keep `visibleEstimate` and `perCategory` as running sums: at request `i` add `byFirst.get(i)`, subtract `byExpire.get(i)`; reset both at segment starts only if the compaction dropped everything (it does, except the summary — handle by subtracting normally). Only push ids when `keepVisibleIds`. `applyCompactionPresence` can be folded into the same pass (it is O(C × B) today). The three tests in `reconcile.test.mjs` should pass unchanged; add a property test comparing the sweep against the brute force on random scopes.

### 7. Per-run JSON (23 MB) and overview (369 KB) are larger than they need to be, and the run cache can pin ~460 MB — risk
- `src/index/worker.mjs:82-83` writes findings into the run file **and** the `.findings.json`; `routes.mjs:167` already falls back to `readFindings`.
- Every block carries two 40-hex hashes (`hash`, `tool.argsHash`), `seq` (derivable from `id`), `kind`, `bytes`; every request carries `newBlockIds` (derivable from `firstRequest`) and a 17-key `composition`.
- `src/index/reader.mjs:7` caches 20 runs by count, not bytes: 20 × 23 MB parsed objects ≈ 460 MB resident. `routes.mjs:167` re-stringifies the whole run per request.
- Overview rows include `summary.findingIds` (every id), `topBlocks` (10 × label), `models`, `compositionAtPeak`, and nested children rows in full (`overview.mjs:49-51`).
**Fix:** (a) split storage into a run shell (`runs/<v>/<sha>.json`: run fields + per-scope metadata without `requests`/`blocks`) and per-scope files (`runs/<v>/<sha>/<scopeId>.json`), served by `GET /api/v1/runs/:v/:id` (shell) and `GET /api/v1/runs/:v/:id/scopes/:scope`; the session view already navigates by `?scope=`. (b) Drop `findings` from the run file, `newBlockIds` from requests, truncate hashes to 16 hex, drop `seq`/`kind`. (c) LRU by bytes (e.g. 64 MB). (d) Overview rows: `findingsCount/findingsHigh` only (drop `findingIds`), cap `topBlocks` at 3, and return children as `{ id, agentType, peak, requests }` stubs.

### 8. Ctrl+C during indexing cannot stop the process — risk (robustness)
`src/server/app.mjs:134-135` `close()` awaits the in-flight `ensure()`; `src/contextscope.mjs:270-272` calls `close()` on SIGINT/SIGTERM. With 1,000 changed files this blocks exit for minutes; a second Ctrl+C re-enters `close()` and waits again. The worker pool is only closed in `runEnsure`'s `finally` (`writer.mjs:205-208`).
**Fix:** an `abort()` on the index that flips a flag checked by the lanes (`writer.mjs:187-193`), closes the pool, and saves the manifest with what finished; `close()` calls `abort()`; the CLI force-exits on the second signal.

### 9. Session stats miscount skills and never carry the fields the setup rules read — bug, verified
`src/index/entry.mjs:78` counts `tool.kind === "skill"` blocks by `tool.target ?? block.label ?? tool.name`: for the Skill tool_call/tool_result the label is the tool name, so the result is `{"Skill": 2, "lorem-skill": 1}` — a bogus key and a double count per invocation. `S-01`/`budget.mjs:26` read `sessionStats.codexInstructionChars` and `instructions.mjs:82-96` reads `sessionStats.instructionFilesObserved`, but neither `statsOf` nor `aggregateStats` ever emits them (the Codex run's `instructionsObserved` is dropped), so the Codex chain is never `observed.artifact` and no instruction file is ever `observed.loaded`. Also `sessionStatsForRepo` aggregates all time, while the inventory fields are named `*30d`.
**Fix:** count skills only from `category === "skills"` blocks (or capture `input.skill` into `tool.target` for the Skill call and count only calls); add `codexInstructionChars` (max of `run.instructionsObserved.chars`) and `instructionFilesObserved` (labels of `instructions` blocks, e.g. `AGENTS.md`, `packages/api/AGENTS.md`, `nested_memory` attachment labels) to `statsOf`/`aggregateStats`; apply the 30-day `since` in `repoEntries` when called for stats.

### 10. Estimator-error series is biased toward zero and pooled across scopes — risk (wrong badge / wrong gating)
`src/ir/reconcile.mjs:66-68,99`: at every segment start `H` is defined as `total - est(visible)`, so `k = 1` and the error is exactly 0 by construction; those zeros are pushed. `finalizeRun` (`src/ir/finalize.mjs:11-35`) pools every scope's errors into one median/p95, so a run with 160 short subagents (1-3 requests each, first request error = 0) reports a good median even when `main` is 50% off (fixture 3: main scales 1.8-0.8, p95 1.56 comes from a subagent). The ADR §3.1 amber/hide thresholds, the "composition approximate" text and the Codex `history_mode: legacy` guard all hinge on these numbers.
**Fix:** do not push errors for segment-start requests; store `scope.estimatorError{median,p95,n}` per scope; compute the run-level numbers from `main` only (or weight by request count). Note the calibration gate itself (`claude.mjs:79-88`, `codex.mjs:79`) is fine: it collapses to identity when `ESTIMATOR_VERSION` changes.

---

## 11-40

### Correctness

11. **Claude window is chosen from the first request's model only** — risk. `claude.mjs:186-189`: a session that starts on Sonnet and switches to Opus 4.8 (1M) keeps a 200k window; subagents on a different model are ignored; `[1m]` is only checked on that one id. `finalize.mjs:36` raises the window from `main.peak` only, so subagent `peakShareOfWindow` can exceed 1. Fix: `max(claudeWindowFor(m) for m in all scopes' models)`; raise on the max peak across scopes.
12. **Slash-command echo records are counted as user prompt text** — risk. `claude.mjs:453-459`: `<command-name>`, `<command-message>`, `<local-command-stdout>` records (format doc §8, not `isMeta`) become `user` blocks labelled `prompt`; `/cost`, `/context`, `/status` output inflates the `user` category and each record is a turn unless `promptId` dedupes. Fix: apply the same leading-tag classification used for `isMeta` (`claude.mjs:434`) → `attachments` with `attachmentType: "command_stdout"` etc., and only count `origin.kind === "human"`/typed prompts as turns.
13. **Codex `onContextCompacted` guard is order-dependent** — risk. `codex.mjs:384-388`: for the documented alternative order `task_started → compacted → token_count → context_compacted` (format doc §6), if that `token_count` is a real request (not the all-zero reset marker) the guard `latest.atRequest === requests.length` fails, a second compaction is recorded and `dropInFlight` empties the model blocks of the request in between. Add a fixture for that ordering; guard on "no *real* request since the last compaction" via a flag set in `finalizeCompaction` and cleared by the next `onResponseItem`/`user_message`.
14. **Codex self-authored `agent_message` lands in `user`** — risk. `codex.mjs:605-612`: an `agent_message` whose `author === selfPath` (the thread's own outgoing mail, if Codex logs it in the sender's rollout) is neither `fromChild` nor from the parent, so it becomes a `user` block and, with a preceding `trigger_turn`, a turn. Classify `author === selfPath` as `assistant_text`; verify against a real child rollout.
15. **`Usage.cacheCreation` is `undefined` for Codex** — cleanup. `codex.mjs:322` deliberately leaves it undefined to skip `deltaCheck` (`reconcile.mjs:96`); `types.ts:104` declares it a number, and the UI's cache split will read `NaN`. Set `0` and gate `deltaCheck` on `scope.vendor === "claude"` / an explicit `supportsDeltaCheck` option.
16. **Codex compaction post/dropped provenance overstated** — cleanup. `codex.mjs:329-334`: `postTokens` is the next request's total (it includes the new turn's prompt) but is labelled `derived.exact`; `trigger: "auto"` at `codex.mjs:366,397` is a ≥75%-of-window heuristic presented as an observed enum. Use `estimated.local` for post/dropped and `"unknown"` (or a separate `triggerInferred: true`) for the trigger.
17. **Recurrence is never computed** — bug. `src/rules/index.mjs:204-217` needs `runs`; the index calls `evaluateRun(run, { thresholds })` (`worker.mjs:73`) with no `runs`, so `finding.recurrence` is always undefined, `rankFindings` never tie-breaks on it, and the "recurs in N sessions" affordance in ADR §2.5 cannot work. Fix: pass lightweight siblings (`{ id, summary: { findingIds } }` from manifest entries with the same cwd/projectKey) — `firedRuleIds` only needs `summary.findingIds`.
18. **Overview trends bucket by `startedAt` but the window filters by `endedAt`** — cleanup. `overview.mjs:26,89-95`: a session that started before `since` and ended inside it counts in totals but not in trends; `dayCount = Math.round(...)` can drop the first day when `since` is an arbitrary `Date`. Bucket by `endedAt` (the same key as the filter) and use `Math.ceil`.
19. **Duplicate run ids collapse** — risk. `writer.mjs:244-247,253` resolves `runId → entry` by first match: the same Claude session id in two project dirs (moved repo) or two Codex rollouts sharing a thread id (resumed threads; verify) yield one readable run and two overview rows with the same `id`. Prefer the newest `mtimeMs`, or include a short path hash in the id when a collision is detected.
20. **`turn` for Codex subagents mixes two counters** — cleanup. `codex.mjs:313` `this.turns || this.turnContexts` switches source mid-scope the moment the first `user_message` or `trigger_turn` arrives (turns 3,3,1,1,2… is possible if `turnContexts` was 3 and `turns` becomes 1). Pick one source per scope up front (prefer `user_message`/`trigger_turn`; fall back to `turn_context` only if none appear by the end) or record both.

### Privacy

21. **`?token=` accepted everywhere and left in the SPA URL** — risk. `src/server/http.mjs:21-29` accepts the query token on every route (only `EventSource` needs it), `consent.mjs:43` and `app.mjs:130` load the SPA at `/?token=…`; no `referrer-policy` header is set by `static.mjs`/`sendJson`. The token lives in browser history and would leak through `Referer` to any external link/resource the UI ever adds. Fix: accept the query token only for `/`, `/index.html` and `/api/v1/index/events`; send `referrer-policy: no-referrer` on every response; have the UI `history.replaceState` the token out after reading it (confirm in `packages/ui`).
22. **Hook `command` strings enter the API verbatim** — risk. `src/setup/config.mjs:23-26,72`: the first 120 chars of each hook command may carry absolute paths outside home or inline secrets (`API_KEY=… ./notify.sh`). Redact `NAME=value` prefixes and replace absolute paths with `[path]` unless under repo/home.
23. **`brokenRefs` and `pathsFrontmatter` are raw strings from instruction-file text** — risk (low). `instructions.mjs:122-123,139`: a CLAUDE.md that mentions `/Volumes/client/…` puts that absolute path into the inventory. Run them through `displayPath`/basename.
24. **Legacy routes return unscrubbed `error.message`** — risk. `src/contextscope.mjs:124,137,211,231` (`sendJson(400, { error: error.message })`) can echo absolute paths; `publicError` exists two lines away. Same guard for `/api/v1/discovery`'s payload (`includePaths` defaults false — keep it that way and add a test that the discovery JSON contains no `/Users/`).
25. **`publicError`/`publicMessage` only redact POSIX segments matching `[\w. @-]`** — cleanup. `http.mjs:47`, `worker.mjs:46,50`, `routes.mjs:19`: Windows paths (`C:\…`) and segments with parentheses/unicode survive. Use one helper that strips `[A-Za-z]:\\…` and any segment after `/`, or better, never put `error.message` in a response at all — map to fixed strings.
26. **Key scrub cannot see content that reached a `label`** — cleanup/test gap. `entry.mjs:11-30` deletes keys named `content/text/stdout/stderr/prompt` anywhere (it will also delete harmless counters such as `unparsedTypes.text`). It is a net, not a gate: `index.test.mjs:97` and `e2e.test.mjs` run only the fake adapters, so no test proves the **real** adapters' `label`/`description`/`target` fields never carry content. Add a release-gate test that indexes `test/fixtures/{claude,codex}` through `createIndex` with the real adapters and asserts neither `LOREMSENTINEL`, the fixture `HOME`, nor the `-`-encoded cwd appears in any file under the index root or in any API response.
27. **Claude `tool.target`/`label` length is unbounded** — cleanup. `claude.mjs:247-258` returns any relative `file_path` verbatim; Codex caps at 120 (`codex-tools.mjs:36,237`). Apply the same cap; also cap `skill` label (`claude.mjs:404`, model-supplied string).

### Security / server

28. **IPv6 loopback Host is rejected** — bug (minor). `http.mjs:10` splits `[::1]:port` on `:` → `"["` → 403. Parse with `new URL("http://" + host).hostname`.
29. **PUT thresholds validation diverges from the loader** — cleanup. `routes.mjs:118-126` re-implements `validateThresholds` (`rules/index.mjs:120-131`) without the `< 0` check: `-1` is accepted and persisted, then rejected with a warning on the next `loadThresholds`, and the PUT response already shows the default. Use `validateThresholds`; reject `null`; also validate the existing file before merging (`routes.mjs:130-136`) so stale unknown keys do not persist forever.
30. **SSE responses have no `error` listener; clients are unbounded** — risk. `sse.mjs:10-16,30-50`: add `response.on("error", drop)`, cap concurrent subscribers (e.g. 16), and `socket.setNoDelay/ setTimeout(0)`.
31. **Consent page is served without the token** — cleanup. `app.mjs:69-74` shows the repo basename and store paths to anyone who can reach loopback (another local user on a shared machine). Require `?token=` for the consent page too (it already reads it from the URL).

### Robustness

32. **`ensure()` while in flight silently drops `force`/`onProgress`** — bug. `writer.mjs:219-223`: `contextscope index --refresh` (or `POST /index/refresh`) during a running ensure returns the running promise; the refresh never happens and the CLI reports "unchanged". Queue a follow-up run when `force` is requested; document that `onProgress` is per-call.
33. **`getIndex` pins the first options per home** — cleanup. `index.mjs:15-19`: later callers with different `roots`/`adapters` get the cached instance. Key the cache by `home + JSON(roots)` or make `createIndex` the only public constructor.
34. **A poison file is re-parsed on every launch and a single worker crash degrades all remaining work to the main thread** — risk. `writer.mjs:117` treats `previous.error` as "changed"; `pool.mjs:35-46` marks the whole pool broken on one `error`/non-zero exit. Record `size/mtimeMs` on error entries and skip until they change (or retry with backoff); respawn a worker instead of breaking the pool; run the poison task in-process once and then mark it.
35. **Codex discovery reads only the first 256 KB and requires the meta on line 1** — risk. `discover.mjs:185-200`: a `session_meta` line above 256 KB (large `base_instructions` + `dynamic_tools`) → `meta = null` → `projectKey = codex:<id>`, `cwd = null`, so the run is excluded from repo findings/setup stats even though the adapter later parses it fine. Read until the first `\n` (bounded at, say, 4 MB) and, in `buildEntry`, fall back to the run's own `cwdHash` for repo matching. The Claude fallback regex (`discover.mjs:139-142`) can also match a `"cwd"` inside a pasted JSON payload on a >64 KB line; prefer only lines that parse.
36. **Claude `toolUses` retains every tool input for the whole scope** — risk (memory). `claude.mjs:402` stores `input: item.input` (Write/Edit contents, base64 images) although only `name/argsHash/target/kind` are read later. Drop `input`.
37. **Worker warnings are silenced** — cleanup. `worker.mjs:95` loads deps with `warn: () => {}`; a broken rules module in worker mode yields empty findings with no message (the in-process fallback does warn). Post warnings back to the parent once.
38. **Three `displayPath` implementations, one Windows-unsafe** — cleanup. `util/fs.mjs:9-13` (`path.join("~", …)` → backslashes on Windows), `claude.mjs:240`, `codex.mjs:719`. Keep the posix one in `util/fs.mjs` and import it. Also `reader.mjs:65` compares `entry.cwd` with `/`-joined prefixes only.
39. **`activeMs`/`startedAt` fallbacks and `endedAt === ""`** — cleanup. `finalize.mjs:28-29` only fill empty strings; `reader.mjs:70-72` `entryTime` uses `endedAt ?? startedAt`, so an empty-string `endedAt` (never nullish) yields `NaN → 0` and the run disappears from every `since` window. Use `||`.

### Test gaps (40)

No test covers: negative/rebased composition (3); Claude in-flight blocks at a boundary and `preservedMessages` (2); Codex handoff → child peak linkage (5); `statsOf → attachObservations` round trip and skill counting (4, 9); `CLAUDE_CONFIG_DIR`/`CODEX_HOME` via `env` (`resolveRoots` is only exercised with `roots`); concurrent `ensure()` and `--refresh` while running (32); manifest corruption → empty manifest → full re-index; poison-file retry (34); worker crash fallback (`pool.broken` path); `?token=` scope, IPv6 Host, negative threshold PUT, referrer policy (21, 28, 29); a >256 KB `session_meta` line (35); duplicate run ids (19); Windows path handling; SIGINT during indexing (8); real-adapter end-to-end privacy gate (26); recurrence with `runs` (17); the alternative Codex compaction ordering (13); Claude model switch / window inference across models (11); `reconcileScope` sweep vs brute-force equivalence (6).

---

## Appendix A: sweep-line reconciliation (sketch)

```js
// after applyCompactionPresence (or folded in): O(R + B + C)
const byFirst = new Map(), byExpire = new Map();
for (const b of blocks) {
  if (EXCLUDED.has(b.category)) continue;
  push(byFirst, b.firstRequest, b);
  if (b.lastRequest !== undefined) push(byExpire, b.lastRequest + 1, b);
}
let visibleEstimate = 0; const perCategory = new Map(); const live = keepVisibleIds ? new Set() : null;
for (const request of requests) {
  const i = request.index;
  for (const b of byFirst.get(i) ?? []) { visibleEstimate += b.estTokens; add(perCategory, b.category, b.estTokens); live?.add(b.id); }
  for (const b of byExpire.get(i) ?? []) { visibleEstimate -= b.estTokens; add(perCategory, b.category, -b.estTokens); live?.delete(b.id); }
  // ... same H / scale / composition logic as today, reading perCategory ...
}
```
Blocks whose `firstRequest > lastRequest` (Codex in-flight drops) must be skipped in both maps. Requests are already in index order; if an adapter can emit a block with `firstRequest` beyond the last request, guard with `if (i in byFirst)` only.

## Appendix B: per-scope payloads (sketch)

- `runs/<vendor>/<sha>.json` — Run without `scopes[].requests/blocks`, plus per-scope `{ id, kind, agentType, description, depth, parentScopeId, launchedAtRequest, deliveredAtRequest, status, handoff, models, peak, processedInputTokens, outputTokens, toolCalls, requests: n, blocks: n, compactions }` and `summary`.
- `runs/<vendor>/<sha>/<scopeId>.json` — `{ requests, blocks, compactions }` for one scope.
- `GET /api/v1/runs/:v/:id` returns the shell; `GET /api/v1/runs/:v/:id/scopes/:scope` returns one scope; the UI's `#/session/:vendor/:id?scope=` already selects one lane at a time.
- Keep the manifest entry shape; `readRun` becomes `readRunShell` + `readScope` with a byte-bounded LRU.

## Appendix C: probe results used above (fixtures only)

- Claude fixture 2: `compactions [{atRequest:7, pre 180000, post 9000}]`; blocks `main:26 tool_call`, `main:27 tool_result.shell`, `main:28 attachments` have `firstRequest 7` and no `lastRequest`.
- Reconcile probe: totals `[5000, 4000]`, blocks `user 100 @0`, `tool_result.file 300 / tool_call 300 / assistant_text 300 @1` → request 1 composition `{ system 4900, user 100, tool_result.file -1600, tool_call 300, assistant_text 300 }`, errors `[0]`.
- `statsOf(claude fixture 1)`: `hookRuns {"hook_success:UserPromptSubmit": { runs 1, stdoutSizes [164] }}` (164 is `estTokens`; `bytes` is 200); `hookRunStats({event:"UserPromptSubmit", command:"npx eslint --fix"})` → `{ runs: 0 }`; `skillInvocations {"Skill": 2, "lorem-skill": 1}`.
- `reconcileScope` with 1,573 requests × 4,599 blocks × 2 compactions: 60 ms.
- Claude fixture 3: `coverage.estimatorErrorP95 1.5581` originates in subagent `a…3` (scales 1, 3.73, 2.56); main scales 1, 1.80, 1.42, 1.15, 0.90, 0.89, 0.87, 0.80.
