# ADR-002: Cycle 1 review and cycle 2 decisions

Status: Accepted for cycle 2 · Date: 2026-09-02 · Owner: architecture
Inputs: ADR-001, `docs/cycle1-contracts.md`, `packages/cli/src/ir/{types.ts,reconcile.mjs,finalize.mjs}`, adapter headers, `index/{overview,entry,index}.mjs`, `server/routes.mjs`, `rules/{index,util,B-01,B-05,B-08,B-09}.mjs`, the three UI screens, and a numbers-only session against the live index on this machine (no message content was read; every number below came from `/api/v1/*` JSON or the manifest).

## 0. What the real data says

| Measurement | Value | What it means |
|---|---|---|
| Corpus (30 days) | 165 runs (158 Claude, 7 Codex), 557 subagents, 45,355 requests, 11.10B processed input tokens, 98.0% cache-read, 22 compactions | The profiler works on a real machine. Cache-read share this high means the composition stack, not the totals, is where the information is. |
| Findings served | 210 findings; 141 are B-01 (104 session, 37 subagent) on 7 runs; B-01 by tool: `exec` 98, `Bash` 28, `Read` 13; B-01 `tokensAffected` p50 10.0k, p95 18.5k, max 25.9k | The list is a log, not a diagnosis. On a 1M window a 10k block is 1%; calling that `high` is fake precision. |
| Ranking | `recurrence` is `undefined` on every served finding; B-08 emitted 9 findings on 4 runs, three with the identical `tokensAffected` 5,350,118 | The third ranking key is dead (the worker never passes `runs` to `evaluateRun`), and B-08 reports overlapping streaks as separate findings. |
| Run `cc87cfe5` (18 MB, 17 scopes) | payload 3.78 MB (main requests 0.82 MB, main blocks 1.93 MB, findings 0.10 MB); main k p5/p50/p95/max = 1.02/1.16/1.22/1.36; H per segment 58.9k / 48.3k / 53.4k; 268 main requests above 80% of the 1M window | Estimator bias is a steady +16%: the calibration constants are still ~0.85 of truth on this session, but the shape is right (no clamps needed). |
| Run `5ca0d315` (168 scopes, 13,332 requests) | payload 23.3 MB (all requests 7.3 MB, all blocks 15.3 MB, findings 0.61 MB, main alone 2.5 MB); request 0 total 209,037 with 0 new blocks → H = 209k labelled `system`; main k p5 0.50, 134 requests with k < 0.6, 36 with k > 1.5; 3 model switches; 21 of 167 subagents show a median 33k unexplained residual at request 1; subagent k p95 1.93; run-level error median 29% / p95 90% but main-only 11% / 56% | Hidden mass is not constant within a segment: it steps up (injections) and down (something left the prefix after a switch). One H per segment cannot express that, and the run-level error number is dominated by 11,759 subagent requests. |
| Overview | 465 KB for 165 runs; 1,332 `topBlocks` entries in rows; `index: {total: 3, done: 3}` while 250 files are indexed | Rows carry data no panel uses; `index.total` means "files touched in the last pass" but reads as corpus size. |
| Manifest / index | 250 entries, 1.07 MB (4.3 KB/entry: `summary` 1.8 KB, `topFinding` 0.8 KB); run files 118 MB, largest 23.3 MB; run LRU is 20 by count | 2,000 files would mean a 9 MB manifest rewritten every 10 files, and a 20-entry LRU of 23 MB runs is ~1.5 GB of parsed objects. |
| Window table | 93 runs at 1M `estimated.local`, 64 at 200k, 7 Codex `observed.vendor`, 2 entries at 2,000,000 `derived.exact` with peaks 998,998 and 997,401 | `roundWindow` invents 2M because the model table maps `claude-opus-5` / `claude-opus-4-8` to 200k; a guessed step is not `derived.exact`. |

Verdict: the data model, adapters, index and honesty labels hold. Reconciliation, findings aggregation, payload size and four UI defects are what stop this from being a tool someone uses twice. Everything below is scoped so the fix ships in one go.

## A. Reconciliation v2: attribute unlogged mass honestly

Decision: adopt the clamp with a new `unlogged` category, split H into `system` / `instructions` / `unlogged`, and re-derive the base when residuals show a persistent step in either direction. Rationale: the current scheme has one free parameter per segment (H) and forces every other discrepancy into k, so a 209k resumed history reads as "system prompt" and a 33k subagent injection inflates every later block by a third. A clamped k turns "the estimator is off" (bounded, reported) and "the transcript does not contain this input" (unbounded, named) into two different numbers the UI can show separately. Symmetric step detection is required because the big session shows hidden mass shrinking (134 requests at k < 0.6), not only growing.

Spec (`packages/cli/src/ir/reconcile.mjs`, replaces the per-request loop; thresholds in `thresholds.json`):

```
K_MIN = 0.6; K_MAX = 1.5                      // reconcileScaleMin / reconcileScaleMax
STEP_MIN = max(10_000, 0.05 * window)         // reconcileStepMinTokens / reconcileStepWindowShare
STEP_RUN = 3; STEP_SPREAD = 0.25              // consecutive residuals; (max-min)/|median|
systemBaseline = vendor table: claude 25_000; codex 0 when a `base_instructions` system block exists, else 8_000
instructionsEstimate = setup chain estimate (main scope only; 0 for subagents)

reconcileScope(scope, { vendor, window, systemBaseline, instructionsEstimate }):
  { est, estByCat, addAt } = sweep(scope)                        // section D
  for each segment (request 0 and every compaction.atRequest):
    i0 = first index of the segment
    H0 = max(0, T[i0] - est[i0])
    system = min(H0, systemBaseline)
    instr  = min(H0 - system, instructionsEstimate)
    U      = H0 - system - instr                                  // persistent unlogged mass, this segment
    recent = []                                                   // last STEP_RUN residuals
    for i in segment:
      base = system + instr + U
      kRaw = est[i] > 0 ? (T[i] - base) / est[i] : 1
      k    = clamp(kRaw, K_MIN, K_MAX)
      r    = T[i] - base - k * est[i]                             // 0 when kRaw is inside the band
      recent.push(r); if recent.length > STEP_RUN: recent.shift()
      if recent.length == STEP_RUN
         and every |x| >= STEP_MIN and sign(x) == sign(r)
         and (max(recent) - min(recent)) / |median(recent)| <= STEP_SPREAD:
        step = median(recent)
        if U + step < 0: system = max(0, system + U + step); U = 0   // hidden mass fell below the baseline
        else: U = U + step
        requests[i - STEP_RUN + 1].baseChange = { tokens: step, provenance: "derived.exact" }
        recent = []; i = i - STEP_RUN + 1; continue                // recompute the three requests with the new base
      unlogged_i = max(0, U + r); system_i = system
      if U + r < 0: system_i = max(0, system + U + r)              // one-off shortfall: shrink system for this request only
      composition = { system: system_i, instructions: instr, unlogged: unlogged_i,
                      ...round(k * estByCat[i][c]) for each visible category c }
      push rounding correction into the largest visible category (as today)
      request.scale = k; request.scaleRaw = round4(kRaw)
      request.hiddenBase = { value: system_i + instr + unlogged_i, provenance: "estimated.local" }
      if K_MIN <= kRaw <= K_MAX: errors.push(|1 - kRaw|) else clamped += 1
  scope.coverage = { estimatorErrorMedian, estimatorErrorP95 (over unclamped requests only),
                     clampedRequests, unloggedShare: Σ unlogged_i / Σ T_i, baseChanges: count,
                     resumed: U at request 0 of segment 0 > 0.5 * T[0] }
```

Consequences that must ship with it:
- `Category` gains `unlogged` ("input not present in the transcript: resumed history, hidden injections, tool schemas"); `STACK_ORDER` draws it as a hatched neutral band directly above `system`; `Request` gains `scaleRaw` and optional `baseChange`; `AgentScope` gains `coverage` and `Run.coverage.estimatorError*` become the main scope's numbers (the run-level 90% was an average over 11,759 subagent requests nobody was looking at).
- Estimator error afterwards is `|1 - kRaw|` over unclamped requests only, per scope; clamped requests are counted, not averaged in. The 15% / 40% badge thresholds from ADR-001 apply to the scope on screen.
- B-10 `system-share-high` uses `system + instructions`, never `unlogged`; a resumed session is not a setup defect. B-09 resets its churn baseline at every model switch (`request.model !== previous.model`) and the cache strip draws a marker there.
- Codex legacy `history_mode` children (est ≈ 0 for most requests): when `unloggedShare > 0.8` and fewer than 20% of requests have new blocks, the stack is hidden and the badge reads "transcript incomplete"; these scopes are excluded from calibration and error statistics.
- UI badge text (session header, next to the composition legend): default `composition · estimated, reconciled · p95 error 12%`; when `unloggedShare > 0.05` append `· 18% not in transcript`; when `resumed` the right rail adds a row "Resumed session: 180k tokens of earlier context are not in this transcript" and the chart legend explains the hatched band; every `baseChange` is a dotted vertical marker labelled `+33k unlogged` / `−41k unlogged`.
- Tests: fixture with a 200k request-0 base and 0 blocks (resumed); fixture with a 30k step at request 1 lasting the scope; fixture with a step down after a model switch; assertion that `sum(composition) === usage.total` on every request and that `unlogged` is 0 on the plain fixtures.

## B. Findings noise: aggregation policy

Decision: per-block rules emit one finding per (rule, run, scope) with `count`, up to 5 evidence blocks and summed `tokensAffected`; B-01/B-03/B-14 severity becomes window-relative (`medium` unless one block exceeds `max(threshold, 5% of window)`); B-02 stays `high` as the habit rule; `recurrence` is computed at read time; the "one change first" card is chosen by leverage (sessions × severity), not by the fattest single session. Rationale: 141 B-01 cards on 7 runs say "you have a habit", which is B-02's job; a 10k block on a 1M window is not "likely to cause task failure". A setup edit that removes findings in 7 sessions is worth more than the single hottest session, and the ranking must encode that or the first card is always B-08.

Spec:
- `Finding` gains `count: number` (1 for scalar rules) and `sessions?: number` (filled by the route; replaces `recurrence`, which is removed together with `applyRecurrence` in `rules/index.mjs`, dead code today). Finding id for aggregated rules = `findingId(ruleId, scopeRef(run, scope))`.
- Aggregate per (run, scope): B-01, B-03, B-04, B-14 (evidence = top 5 by `value`, plus `scopeEvidence` for subagents); B-08 (streaks are evidence, max 3, `count` = streaks, `tokensAffected` = sum; one finding per scope fixes the triple report); B-15 (pairs as evidence, max 5). Aggregate per (run, agentType): B-05 (evidence = top 5 child scopes; fix path is the agent file). Unchanged: B-02, B-06, B-07, B-09, B-10, B-11, B-12, B-13, S-*.
- Severity rule for block-size findings: `high` if any aggregated block ≥ `max(thresholdTokens, fatBlockWindowShare(0.05) × run.window.value)`, else the rule's base severity, which becomes `medium` for B-01 and B-03 and stays `medium` for B-14. `thresholds.json` gains `fatBlockWindowShare`.
- Route `GET /api/v1/findings`: after ranking, group by `ruleId`; response `{ groups: [{ ruleId, title, severity, sessions, occurrences, tokensAffected, findings: Finding[] }], findings }` where `sessions` = distinct `runId`s in the repo whose manifest `summary.findingIds` contain that rule (setup findings: `sessions` = repo session count, they apply to every session). Ranking inside and across groups: severity → Σ `tokensAffected` → `sessions` → id.
- Findings screen: one row per group, `B-01 Fat tool result · medium · 7 sessions · 141 occurrences · 1.4M tokens`; expanded row lists per-session findings with `count`, tokens and top evidence; the first group is expanded by default; filters stay.
- "One change to make first" (`rankFirstChange` in `index/entry.mjs`, used by overview and `scan`):
  ```
  key(f) = f.ruleId + "|" + (f.fix.path ?? "")
  for each key: sessions (as above), sev = {high: 3, medium: 2, low: 1}[max severity], tokens = Σ tokensAffected
  leverage = sev × min(sessions, 10)
  pick max by (leverage, fix.path present, tokens)
  ```
  On today's data this yields B-02 (3 × 7 = 21, path `CLAUDE.md`) over B-08 (3 × 4 = 12) and B-01 (2 × 7 = 14); S-01, when it fires, wins outright (3 × 10) because an oversized chain is paid on every request of every session. The card says "removes N findings in M sessions" using the group counts of the rules the fix targets (B-02 → B-01 occurrences).

## C. Payload architecture

Decision: split into `GET /runs/:vendor/:id` (run metadata, findings, the main scope in full, child scopes as summaries) and `GET /runs/:vendor/:id/scopes/:scopeId` (one scope in full), both gzip-encoded when the client accepts it; trim the overview. Rationale: the 23 MB run is 65% blocks and 31% requests of 167 subagents the session screen only draws as lanes, and lanes need eleven fields per child; the main scope alone is 2.5 MB, ~350 KB gzipped. Two resources with two shapes is clearer than one URL whose shape depends on a query string, and it lets the UI cache scopes independently as the user clicks lanes.

Spec:
- `GET /api/v1/runs/:vendor/:id` → `Run & { findings: Finding[], scopes: [AgentScope (main, full), ...ScopeSummary[]] }`; `ScopeSummary` = `AgentScope` minus `requests`, `blocks`, `compactions` plus `{ requestCount, blockCount, compactions: number, coverage }`. Every field the lanes, the scope selector and the subagent rail read is on the summary (`launchedAtRequest`, `deliveredAtRequest`, `peak`, `handoff`, `status`, `agentType`, `description`, `depth`, `parentScopeId`).
- `GET /api/v1/runs/:vendor/:id/scopes/:scopeId` → full `AgentScope`; 404 when unknown. The UI fetches it when a lane is opened and keeps up to 10 scopes in memory.
- Requests drop `newBlockIds` (the ledger derives "blocks added" from `blocks[].firstRequest` with one pass) and never carry `visibleBlockIds`. Expected main-scope payload for the big run: ~2.0 MB raw.
- `sendJson` gains gzip (`node:zlib`, level 6) when `accept-encoding` contains `gzip` and the body exceeds 8 KB; the run cache stores the serialised gzipped main payload, not the parsed object (section H.4).
- Overview: manifest `summary.topBlocks` capped at 5; `OverviewRun.summary` omits `topBlocks` and `findingIds` (offenders live in `topOffenders`); `GET /overview?since=30d&limit=200` (default 200, newest first; `runs.length < index.runsInRange` tells the UI there is more); `index` becomes `{ files, runsInRange, state, lastPass: { total, done, failed, at } }` and the old `total/done` keys are removed with the UI updated in the same change. Target: ≤ 150 KB for 165 runs before gzip.

## D. Performance: reconcile sweep-line

Decision: replace the O(requests × blocks) visibility scan with an event sweep keyed by request index. Rationale: the main scope of the big run visits 7.2M (request, block) pairs today and every subagent scope repeats the pattern; the sweep is O(blocks + requests × categories), which is ~30k operations for 1,573 × 4,599 and removes the CPU spike from the index workers as well.

Spec (`sweep(scope)` in `reconcile.mjs`, used by A):

```
n = requests.length; assert requests[j].index === j for all j (adapters guarantee dense indices; throw otherwise)
addAt = Array.from({ length: n + 1 }, () => []); removeAt = same
for b in blocks:
  if b.category === "assistant_thinking": continue
  f = b.firstRequest; if f >= n: continue                 // arrives after the last request
  l = b.lastRequest ?? n - 1; if l < f: continue          // empty presence window (in flight at a compaction)
  addAt[f].push(b); removeAt[l + 1].push(b)
cat = new Float64Array(CATEGORIES.length); total = 0    // CATEGORY_INDEX: Map<Category, number>
for i in 0..n-1:
  for b in addAt[i]:    cat[ci(b)] += b.estTokens; total += b.estTokens
  for b in removeAt[i]: cat[ci(b)] -= b.estTokens; total -= b.estTokens
  est[i] = total; estByCat[i] = cat.slice()               // 17 floats per request
return { est, estByCat, addAt }                           // addAt doubles as the "new blocks at i" bucket
```

`applyCompactionPresence` stays (compactions × blocks; 22 × 5k is nothing). Acceptance: `test/reconcile.bench.test.mjs` builds a synthetic scope of 1,573 requests × 4,599 blocks with 2 compactions and asserts `reconcileScope` completes in under 50 ms (target under 5 ms) and a 168-scope synthetic run finalises in under 50 ms; an equivalence test asserts identical `composition` between the old loop and the sweep on all fixtures before the old loop is deleted.

## E. Cutover: deletions, `scan`, command surface

Decision: delete the legacy modules, routes, commands and tests in one PR; `scan` becomes a terminal rendering of the index and the grouped findings; 0.9.0 ships four commands. Rationale: `contextscope.mjs` still imports `scanner`, `evaluator`, `experiment`, `instruction-audit-agent` and `runtime-capture`, mounts six legacy routes and documents seven commands the SPA never links; every one of them is a second code path that can leak content or paths. Cutting them is also the only way the privacy grep test covers the whole CLI.

Delete (source, and the test of the same name): `src/dashboard.mjs`, `evaluator.mjs`, `experiment.mjs`, `runtime-capture.mjs`, `context-agent.mjs`, `instruction-audit-agent.mjs` (`setup/references.mjs` already holds the deterministic path/import helpers and only mentions the old file in a comment), `codex-app-server.mjs`, `analyzer.mjs`, `scanner.mjs`. Condition on `scanner.mjs`: move the Gemini store presence check (path list, counts only) into `adapters/discover.mjs` as `vendorsPresent()` in the same PR; if that slips, `scanner.mjs` survives one cycle and nothing else does. Remove `createLegacyRoutes` and `/api/discovery`, `/api/v1/discovery`, `/evidence-graph`, `/sources`, `/context-activity`, `/runtime-evidence`, `/instrumentation`, the e2e `"/api/v1/legacy"` case, the `--no-codex-app-server` flag, the commands `agent`, `instrument`, `capture-status`, `capture-event`, `evaluate`, `experiment`, `compare`, and the README sections "Context activity visualizations", "Runtime evidence capture", "Agentic file-by-file instruction audit", "Optional semantic evaluation", "Prove a recommendation". The consent screen already reads roots from `util/fs.resolveRoots`, so nothing user-facing depends on `discover()`.

`contextscope scan [--repo <path>] [--since 30d] [--json]` (runs `ensureIndex` first, prints progress to stderr):

```
ContextScope · context-viewer · last 30 days · index up to date (250 files, 0 changed)
Sessions 165 (claude 158 · codex 7) · subagents 557 · requests 45,355
Processed input 11.10B tokens · cache-read 98% · compactions 22 · sessions above 80% of window: 10

One change to make first
  [HIGH] B-02 Repeated fat results · 7 sessions · 141 fat results · 1.4M tokens
  Fix (claude) → CLAUDE.md: "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000."

Findings by leverage
  B-08  Running hot            high    4 sessions   18.6M tokens
  B-07  Frequent compaction    high    3 sessions    2.9M tokens
  B-01  Fat tool result        medium  7 sessions    1.4M tokens (141)
  S-01  Instruction file oversized  high  setup  CLAUDE.md 3,400 tokens

Open the evidence: contextscope start
```

Number formatting rule for the terminal and the UI: counts are exact integers with thousands separators; tokens pick the unit so the mantissa is below 1,000 (`k` one decimal below 100k, `M` one decimal below 100M, `B` two decimals) so 11,100,812,908 renders as `11.10B`, never `11097M`. `--json` emits `{ overview, groups, setup }` with the same shapes as the API. Exit code 0 always (`check`, section G, is the one that fails).

Command surface for 0.9.0: `contextscope` (alias of `start`), `contextscope start [--repo] [--port] [--no-open] [--yes]`, `contextscope scan [--repo] [--since] [--json]`, `contextscope index [--clear | --refresh] [--json] [--concurrency]`, `contextscope help`. `package.json` `files` stays `["src", "ui", "README.md"]`; the README gains the index location, the privacy statement for `~/.contextscope`, and the route list from ADR-001 5.4 as amended here.

## F. Estimator and calibration

Decision: keep the chars-based estimator as `estimated.local` through cycle 2, move every calibration constant out of the adapters into `packages/cli/src/ir/calibration.json` with the corpus statistics that produced it, bump `ESTIMATOR_VERSION` to `chars-v2`, and make the index invalidate on it. No tokenizer in cycle 2. Rationale: the reconciliation step, once clamped, bounds what the estimator can get wrong and reports it; a tokenizer would add a dependency for Codex and does not exist offline for Claude. The constants are currently split across two adapters with different mechanisms (Claude scales bytes/token and adds an envelope, Codex scales the result by category), which is invisible to anyone reading `estimate.mjs`, and the index does not know they changed.

Spec:
- `estimateTokens(text, kind, { vendor, category })` reads `calibration.json`:
  ```
  { "estimatorVersion": "chars-v2",
    "vendors": {
      "claude": { "bytesPerToken": { "code": 2.25, "prose": 2.4 }, "envelopeTokens": 80,
                  "envelopeCategories": ["tool_call","tool_result.*","attachments","subagent_handoff","skills","user"],
                  "imageTokens": 1500,
                  "measured": { "at": "2026-09-01", "method": "deltaCheck slope: (input + cacheCreation) vs bytes of new blocks",
                                "sessions": 3, "requests": 16800, "observations": 6672,
                                "slopeByCategory": { "tool_result.shell": 2.2, "tool_result.file": 2.35, "...": 0 },
                                "resultingError": { "median": 0.10, "p95": 0.20 } } },
      "codex":  { "bytesPerToken": { "code": 3.2, "prose": 3.6 }, "categoryScale": { "toolResult": 0.9, "toolCall": 1.0, "other": 0.95 },
                  "imageTokens": 1000,
                  "measured": { "at": "2026-09-01", "method": "reconcile k p50 per category", "rollouts": 76, "requests": 3119,
                                "kP50": { "before": 0.90, "after": 0.99 }, "resultingError": { "median": 0.045, "p95": 0.11 } } } } }
  ```
- Adapters call the shared function and carry no numbers. The manifest entry gains `estimatorVersion`; change detection becomes `(size, mtimeMs, adapterVersion, estimatorVersion)`. A test pins `sha1(calibration.json)` next to `ESTIMATOR_VERSION` so a constant change without a version bump fails CI.
- `scripts/calibrate.mjs` recomputes the constants from the index alone: blocks carry `bytes` and requests carry `input + cacheCreation`, so the per-category slope regression needs no transcript content. Its output is the `measured` object above; that is what "documented" means here.
- Revisit a tokenizer only if main-scope p95 error is still above 15% after A ships; the `cc87cfe5` numbers (k p50 1.16 with p5–p95 spread of 0.20) say the remaining error is mostly bias, which `calibrate.mjs` fixes for free.

## G. Cycle 2 build list (ranked)

1. Reconciliation v2, payload split, sweep, and the four UI defects (A, C, D; wheel scroll, blank height, y-domain, formatting): the 168-scope session opens in under a second, scrolls, and the stack names what part of the input is not in the transcript.
2. Findings aggregation, leverage-ranked first change, `contextscope scan` (B, E): a dozen grouped findings replace 210 cards, and the first card is the CLAUDE.md edit that removes findings in seven sessions.
3. Project view `#/project/:key` with cross-session habits: for the launched repo, sessions over time, recurring offenders by tool and repo-relative path ("the same lockfile read whole in 9 sessions"), and finding counts before and after an instruction change.
4. Live session mode (append-resume parsing from stored byte offsets, active-file tailing, SSE) with a forecast line: the session you are in updates per request and says "at this rate, compaction in ~N requests".
5. Hook install for `InstructionsLoaded` evidence on Claude (`contextscope hooks install`, one settings entry, prints the diff first): `instructions` becomes `observed.artifact`, and S-01 reports the exact loaded chain.
6. Export: `contextscope export <run> --md|--json` rendered from the index only: a session profile you can paste into a PR or send to a teammate with no content in it by construction.
7. Claude Code status-line integration (depends on 4): current occupancy and share of window in the status line.
8. `contextscope check --budget <file>` for CI: fails when the instruction chain exceeds a token budget or a high-severity setup finding exists; exit code 1 with the same terminal rendering as `scan`.

Deferred, with reasons: Gemini adapter (no Gemini sessions on the calibration machine; needs a format doc first, see ADR-001 section 0 for the bar); "apply fix" with preview/rollback (the UI writing into the repo needs a trust model we have not designed; "Copy fix" and the hook installer's print-first diff are the cycle 2 limit).

Cycle 1 defects to fix inside item 1, with the cause as read from the code: no wheel scroll (a non-passive wheel handler on the chart container calls `preventDefault`; scope it to modifier-key zoom, make plain wheel passive); huge blank height (`Lanes` allocates one row per child scope, 167 on the big run, and `Ledger` sizes its container to `rows × ROW_H` including expanded rows; cap lanes at 20 by peak with a "show all" table, give the ledger `max-height: 60vh` with internal scrolling); y-domain twice too tall (`niceMax(max(peak, window) × 1.04)` rounds 1.04M up to 2M; use `max(peak × 1.05, window × 1.02)` as the domain and keep `nice` for ticks only); `11097M` (`formatTokens` has no `B` unit; apply the rule in section E).

## H. Architectural risks and what to do about them

1. Index invalidation on calibration change (highest): the manifest keys on `adapterVersion` only, so today's index mixes runs parsed before and after the Claude 1.42/1.5 factors were introduced. Fix in F; ship `chars-v2` with a forced re-index and print "estimator changed, re-parsing N files" in `scan`/`start`.
2. Window mislabelling: two runs with a 2,000,000 `derived.exact` window for peaks under 1M. `roundWindow` must yield `{ value: nextStep(peak), provenance: "estimated.local", lowerBound: peak }`, and `claude-models.json` must map `claude-opus-5` and `claude-opus-4-8` to 1M (their observed peaks prove it). B-08 depends on this value; an invented window is an invented finding.
3. Manifest growth: 4.3 KB per entry means 8.5 MB at 2,000 files, rewritten every 10 files. Trim `topFinding` to `{ id, ruleId, severity, tokensAffected, title, fix.path }`, `topBlocks` to 5, and save the manifest at most every 2 s plus once at the end of a pass.
4. Server and worker memory: a count-based LRU of 20 runs can hold 20 × 23 MB of JSON, roughly 1.5 GB parsed. Switch to a byte-budget cache (64 MB) of gzipped payloads keyed by `(runId, scopeId)`; the worker never holds more than one run and the sweep removes its CPU spike.
5. Subagent scale: one run has 167 subagents and 81 B-15 findings. Aggregation (B) and lane capping (G.1) handle the display; the index should also store per-scope summaries in the run file's header so the run route does not parse 23 MB to serve 11 fields per child.
6. Codex legacy `history_mode` children (4 of 80 files) have no logged input; without A's "transcript incomplete" state they will poison both calibration and the error badge, so exclude them before running `calibrate.mjs`.
7. `thresholds` PUT re-evaluates every run by re-reading run files (`reevaluate` tasks); with aggregation this stays cheap, but the route should answer before re-evaluation finishes and the SSE channel should report it, or editing a threshold looks like a hang on 250 files.
8. `index.total` semantics (3 vs 250) will be misread by anyone building on the API; C renames it, and the change is breaking on purpose.

## I. Type changes (diff against `packages/cli/src/ir/types.ts`)

```ts
type Category = /* existing */ | "unlogged";             // input not present in the transcript

interface Request {
  // removed: visibleBlockIds, newBlockIds (derive from blocks[].firstRequest)
  scale: number;                                          // k after clamping
  scaleRaw: number;                                       // k before clamping; estimator error uses this
  baseChange?: { tokens: number; provenance: "derived.exact" };   // persistent step in unlogged mass detected here
}

interface ScopeCoverage {
  requests: number; estimatorErrorMedian: number; estimatorErrorP95: number;   // over unclamped requests
  clampedRequests: number; unloggedShare: number; baseChanges: number;
  resumed: boolean; transcriptIncomplete: boolean;
}
interface AgentScope { /* existing */ coverage: ScopeCoverage }
interface Coverage   { /* existing; estimatorError* now equal scopes[0].coverage.* */ estimatorVersion: string }

type ScopeSummary = Omit<AgentScope, "requests" | "blocks" | "compactions">
  & { requestCount: number; blockCount: number; compactions: number };
interface RunResponse extends Omit<Run, "scopes"> { scopes: [AgentScope, ...ScopeSummary[]]; findings: Finding[] }

interface Finding {
  // removed: recurrence
  count: number;                                          // occurrences aggregated into this finding
  sessions?: number;                                      // distinct runs in the repo where the rule fired (route-filled)
}
interface FindingGroup { ruleId: string; title: string; severity: Severity; sessions: number; occurrences: number; tokensAffected: number; findings: Finding[] }
interface FindingsResponse { groups: FindingGroup[]; findings: Finding[]; firstChange?: Finding & { removes: { findings: number; sessions: number } } }

interface Run { window: Measured & { lowerBound?: number } }   // set when the table value was raised to cover an observed peak
interface Overview { index: { files: number; runsInRange: number; state: "idle" | "indexing"; lastPass: { total: number; done: number; failed: number; at?: string } } }
interface OverviewRun { summary: Omit<RunSummary, "topBlocks" | "findingIds"> }
```

## J. Delivery order and acceptance

| PR | Contents | Acceptance (numbers only in the PR description) |
|---|---|---|
| 1 | D sweep + equivalence test; A reconcile v2; F `calibration.json`, `chars-v2`, manifest key, `scripts/calibrate.mjs`; forced re-index | `reconcile.bench` under 50 ms; `5ca0d315` main scope: p95 error under 25% over unclamped requests, `unloggedShare` reported, request 0 shows `unlogged` ≈ 180k; at least 15 of the 21 injected subagents get a `baseChange` at request 1 and their k p95 falls under 1.3; `cc87cfe5` main k p50 within 1.00 ± 0.05 after `calibrate.mjs` |
| 2 | C run split + gzip + scope route + overview trim + `index` rename; UI: session screen on the new shapes, lanes cap, ledger height, wheel, y-domain, `formatTokens` | `GET /runs/claude/5ca0d315…` under 400 KB gzipped and first paint under 1 s; overview under 150 KB raw; `scopes/:id` under 100 ms for the largest child |
| 3 | B aggregation in B-01/03/04/05/08/14/15, severity by window share, `count`, route grouping, `firstChange`, Findings screen groups, `recurrence` removal | `GET /findings` on this machine returns at most 40 findings in at most 15 groups; B-08 yields exactly one finding per hot scope; `firstChange` is B-02 with `removes.sessions ≥ 7` |
| 4 | E deletions, `scan`, command surface, README, e2e for every remaining route, privacy grep across all of `src/` | `node --test` green with 9 fewer test files; `git grep -l "scanner.mjs\|dashboard.mjs"` is empty; `scan` output matches the section E layout on the fixture index |
| 5 | G.3 project view and habits | Project screen renders from manifest entries only (spy on `readRun`), habit list names tool + repo-relative path + session count |
| 6 | G.4 live mode, then G.7 status line | A growing fixture file re-parses from its stored offset (bytes read < bytes appended + 64 KB); SSE delivers a new request within 2 s of the write |

PRs 1–4 are cycle 2's first week and are sequential (each changes shapes the next consumes); 5 and 6 can start once PR 2 lands. Items G.5, G.6, G.8 are scheduled after 6 and need no ADR change.

## Consequences

- We accept a small loss of stack fidelity inside the ±40/50% band in exchange for never showing a resumed history as "system prompt" and never inflating tool results by a hidden injection.
- Findings become fewer and the severity of block-size rules drops on 1M-window sessions; that is the intended correction, and B-02 plus the leverage rule carry the habit signal.
- Two API shapes change (`runs` split, `overview.index`); the UI is updated in the same PRs and no external consumer exists yet.
- The legacy surface is gone; anything from it that someone misses is re-proposed as a cycle 3 item with the ADR-001 evidence bar, not restored.
