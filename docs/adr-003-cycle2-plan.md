# ADR-003: Cycle 2 plan — one repo, its habits, the live session, and a public face

Status: Proposed for cycle 2 · Date: 2026-09-02 · Owner: architecture
Inputs: `docs/cycle-log.md`, ADR-002 G/H, ADR-001 §1–2, `docs/context-engineering-research.md`
("Recommended pivot", "Technical product architecture"), `packages/cli/README.md`, `src/ir/types.ts`,
`server/routes.mjs`, `index/{overview,entry,reader,writer}.mjs`, `packages/ui/src/{main.tsx,api.ts,router.ts,store.ts}`,
`screens/Overview.tsx`, root `app/`, `vite.config.ts`, `worker/index.ts`, `.openai/hosting.json`.
Two facts verified by command (numbers only, no content).

## 0. Where cycle 1 left us, and two verified facts

Cycle 1 shipped a profiler that is honest per request (211 tests, 250 files indexed in 1.7 s, the 23 MB run
served as 422 KB gzip, resumed-session error 29%/90% → 3%/11%). What it does not do is the thing the research
thesis calls the product: reason about *one repository over time* and feed that back into the setup (Context CI).
Cycle 2 is that turn, plus the two adoption surfaces (a public demo, a CI check) and the one evidence source
transcripts cannot give us (`InstructionsLoaded`).

Fact 1, repo scoping. `scan --repo ~/projects/herodot` prints
`Sessions 165 (claude 158 · codex 7) · subagents 562 · requests 45,588 · Processed input 11.16B`;
`scan --repo ~/projects/context-viewer` prints the identical line. Only the "one change first" differs
(S-01 for herodot). Cause, read from the code: `buildOverviewFromEntries` filters by `since` only; `repoRoot`
feeds finding heads and recurrence, never rows, totals, trends or offenders; the overview `all=1` flag means
"show nested Codex children", not "all projects". The `#/` header says "All projects, all vendors, last 30 days":
true, and the wrong thing to be true.

Fact 2, hooks. `~/.claude/settings.json` has keys `permissions, model, tui, skipWorkflowUsageWarning, theme,
remoteControlAtStartup, agentPushNotifEnabled, skipAutoPermissionPrompt, autoMode`: no `hooks`, no `statusLine`.
Six project files (`eleven-labs-prm, ergo-hestia, herodot, need-termin, om-hackathon-starter, twilio-int`) carry
`hooks.PostToolUse` only. Nothing on this machine uses `InstructionsLoaded` or `SessionStart`, so the installer
starts clean but must merge next to an existing `PostToolUse` array without touching it. `~/.claude/projects`
holds 83 project directories, several named `-private-var-folders-…-cez-root-isolation-*`: temp dirs whose
encoded names cannot be decoded back to a path. The project-key matching problem in §1 is real.

## 1. Repo scoping model

Rationale (3 sentences). A profiler that says "165 sessions" to every repo is not a repo profiler, and the
research framing ("which part of *my* setup is hurting") needs a stable population before a trend or habit
can exist. The launched repo is the only population for which the setup inventory, fixes and CI check mean
anything, so it is the default everywhere and "all projects" is a view, not a mode. One route (`#/` with a
scope toggle) beats a `#/project/:key` screen because the server owns exactly one `repoRoot`; a per-project
screen would need per-project setup, which waits for runtime `--repo` switching in cycle 3.

Population rule.
- A session belongs to the repo when its cwd is the repo root or a descendant, for both vendors.
  Claude worktrees under `<repo>/.claude/worktrees/*` therefore count.
- Matching order in `entryMatchesRepo` (`index/reader.mjs`):
  1. `realpath(entry.cwd)` equal to or under `realpath(repoRoot)` (symlinked homes on macOS);
  2. `entry.projectKey === projectKeyFor(repoRoot)`;
  3. `entry.discoveryKey === projectKeyFor(repoRoot)`, only when `entry.cwd` is null.
- cwd null and the encoded dir not reversible → `unattributed`. Temp isolation dirs
  (`/private/var/folders/…`, `/tmp/…`) are `cwdKind: "temp"` and never attributed to a repo.
- Manifest entry (already stores `cwd`, `projectKey`, `discoveryKey`) gains `cwdReversible: boolean` and
  `cwdKind: "repo" | "temp" | "unknown"`. `cwd` stays manifest-only; nothing new is served.

API and CLI.
- `GET /api/v1/overview?scope=repo|all&since=30d&limit=200&nested=1`. `scope` defaults to `repo`.
  `nested=1` replaces today's `all=1` (kept as a deprecated alias for one release).
- Rows, totals, trends and `topOffenders` obey `scope`; `firstFinding` is always repo-scoped.
- Response gains `scope: { mode, repo: { name, key }, sessions, machineSessions, unattributed }`.
- `scan [--all]` header: `ContextScope · context-viewer · 23 sessions (of 165 on this machine) · last 30 days`.
  `--all` prints the machine totals with the repo line under it; `--json` carries `overview.scope`.

UI (`screens/Overview.tsx`).
- Segmented control `This repo · All projects` replaces the "All projects, all vendors" subtitle; state in the
  hash query (`#/?scope=all`) and remembered in `localStorage`.
- Repo mode hides the Project column and the project chips; all mode shows both.
- `unattributed > 0` renders "N sessions could not be attributed to a project" with a hover that explains the
  encoded-directory limitation. The session screen is unaffected: any run opens from either mode.

Tests and acceptance.
- Fixture home with three repos: one nested worktree, one temp dir, one unreversible encoded dir; assert row
  counts per scope, `unattributed`, and `scan` totals that differ between two `--repo` values.
- Acceptance on this machine: `scan --repo herodot` and `scan --repo context-viewer` print different session
  counts whose sum is ≤ 165; the overview payload in repo mode is smaller than in all mode.

## 2. Cross-session habits and per-repo trends

Rationale. B-02 already says "you have a habit" from one session; the leverage is saying it across sessions
with the path attached ("the same lockfile read whole in 9 sessions"), which is what a CLAUDE.md line can
actually prevent. The aggregation must come from the manifest alone (165 entries, 1 MB) so it costs nothing
at read time and never opens a run file. Trends are per repo or they are noise.

Per-run `habits` record (manifest entry, ≤ 1.5 KB, written by `buildEntry` in `index/entry.mjs`):
```
habits: { v: 1,
  fat:        [{ tool, kind, label?, tokens, n }],  // blocks ≥ fatToolResultTokens by (tool.name, label), top 8 by Σ tokens
  fullReads:  [{ label, tokens, n }],              // tool.kind === "file" && !tool.partial, top 8 by Σ tokens
  agents:     [{ type, n, handoffP50, handoffMax, ratioP50, peakP50 }],
  compaction: { n, auto, firstAt, requests },      // firstAt = request index of the first boundary
  startup:    { h0, cliVersion, model, instructionHashes? },  // h0 = hiddenBase at request 0 of segment 0
  mcp:        { invoked: string[] },
  peakShare, window }
```
`Block.tool` gains `partial?: boolean` (Claude `Read` with `offset`/`limit`; Codex `read_file` with a range),
so a full read is a fact, not a guess.

Rules `rules/H-01..H-06.mjs`, scope `"habit"`, evaluated at read time by
`rules/habits.mjs: evaluateHabits(entries, { thresholds, setup })` over the repo's entries; nothing is stored.
Minimum population `habitMinSessions = 3`. Evidence: `kind: "run"` per session (≤ 5) plus one `metric`;
every habit finding carries `sessions`.
- H-01 Recurring fat result: same `(tool, label)` in ≥ 3 sessions, Σ tokens ≥ 3 × `repeatedFatResultTokens`.
  Fix per tool (Bash → `| head -c 8000`, Read → `offset/limit`, Grep → `head_limit`); `fix.path` = CLAUDE.md / AGENTS.md.
- H-02 File read whole repeatedly: `fullReads.label` in ≥ 3 sessions, Σ tokens ≥ `habitFullReadTokens` (2,000 per read).
- H-03 Subagent type with fat handoffs: `agents.type` with n ≥ 3 and `handoffP50 ≥ fatHandoffTokens` or
  `ratioP50 < 3`; `fix.path = .claude/agents/<type>.md`.
- H-04 Compaction frequency rising: compactions per 1k requests, last 10 sessions vs previous 10; ratio ≥ 1.5
  and ≥ 3 compactions in the recent set; medium.
- H-05 Startup cost changed after an instruction edit: split sessions at each instruction file mtime from the
  setup inventory; median `startup.h0` before vs after with identical `cliVersion` and `model`;
  |Δ| ≥ max(1,000, 15%) fires with direction. Mixed CLI versions → suppressed with "confounded by a CLI upgrade".
  This is `estimated.local` and the card says so.
- H-06 MCP server configured but never invoked in ≥ 5 sessions: carries the session list; the existing setup
  rule "MCP server unused" keeps firing and is shown as H-06's evidence when both exist.

Routes, terminal, UI.
- `GET /api/v1/habits` → `{ findings, sessions, since }`; `GET /findings` includes habit findings in `groups`
  (filter `scope=habit`); `rankFirstChange` accepts them (leverage uses `sessions`).
- `scan` prints `Habits (23 sessions)` after the first change: one line per H finding with sessions and tokens.
- `overview.trends` (repo mode) gains `sessions[]`, `peakShareMedian[]`, `startupH0Median[]` and
  `instructionEdits: [{ path, at }]`. New `components/TrendsPanel.tsx` on the overview: four sparklines
  (sessions/day, median peak share, compactions per session, startup h0 with edit markers). Existing tiles stay.

Tests and acceptance.
- `habits.test.mjs`: synthetic 12-entry manifest; `evaluateHabits` never calls `readRun` (spy); H-01 names
  tool + label + session count; H-05 suppressed on a CLI-version change; H-04 exact ratio on a fixture.
- Acceptance on this machine: the context-viewer repo yields ≥ 1 H-01 or H-02 with ≥ 3 sessions; the
  overview grows by < 5 KB; `/habits` answers in < 50 ms from the manifest.

## 3. Live session mode and the compaction forecast

Rationale. The session you are in is the only one you can still change; today the index sees it two minutes
late and the UI never. Append-resume parsing (stored byte offsets + adapter state) is the right long-term
design, but the measured numbers say it is not worth it yet: a full re-parse of the largest file (18 MB) takes
~0.2 s in a worker and the incremental pass over 250 files 0.16 s, so "re-parse the changed file after a 2 s
debounce" delivers the same user-visible latency (~2.5 s) at a tenth of the complexity and with no adapter
state to corrupt. Honest verdict: no append-resume in cycle 2; revisit when a live file's re-parse exceeds
1 s (≈ 80 MB), which the `parseMs` field on the live event will tell us.

Watcher and index.
- `index/watch.mjs`: `createWatcher({ roots, onChange })` with `fs.watch(dir, { recursive: true })` on
  `~/.claude/projects` and `~/.codex/sessions/<today>` (re-armed at midnight); `*.jsonl` only; a subagent file
  maps to its parent main file; 2 s debounce per main file; `onChange(mainPath)` → `index.ensure({ only: [mainPath] })`.
- Fallback when `fs.watch` throws (`EMFILE`, `ENOSPC`, network home): poll `stat` of the active set every 5 s.
- `writer.mjs` gains `ensure({ only })`: skip discovery, task the listed files, keep the manifest save rules.
- Active set: entries whose file mtime is within 120 s get `entry.live = { at }`; `OverviewRun.live?: { at }`.
- Events on the existing SSE hub: after each live re-parse
  `{ type: "live", runId, at, requests, peak, last: { index, total, at, model }, rebased, parseMs }`;
  after 120 s of silence `{ type: "live-idle", runId }`.

Tail route. `GET /api/v1/runs/:vendor/:id/tail?after=<n>&scope=main` →
`{ requests (index > after), blocks (firstRequest > after), closed: [{ id, lastRequest, droppedBy? }],
compactions (atRequest > after), summary, peak, forecast, rebased }`.
Reconciliation re-derives the base per scope, so older compositions can move when a base step is detected:
the UI refetches the full scope when `rebased` is true or every 20th live event, and appends otherwise.

Forecast (`ir/finalize.mjs`, per scope).
- `forecast?: { threshold: Measured, perRequest, perMinute, requestsLeft, minutesLeft,
  basis: { requests: 20, from, to }, provenance: "derived.exact" }`.
- Least-squares slope of `usage.total` over the last 20 requests of the current segment, by index and by time;
  emitted only when the segment has ≥ 8 requests, slope > 0 and current < threshold.
- Threshold, Claude: median `preTokens` of `trigger:"auto"` compactions for that window in the corpus, stored
  as `calibration.json` `autoCompact.claude["1000000"] = { share, events }` by `scripts/calibrate.mjs`
  (observed here 940,027–1,001,760 on 1M → ≈ 0.97 × window); provenance `observed.vendor` when ≥ 3 events,
  else `estimated.local` at 0.95 × window. Codex: 0.9 × `model_context_window`, `estimated.local`, until a
  Codex auto-compaction is observed. The forecast line inherits the threshold's provenance badge.

UI.
- `store.ts` folds `live`/`live-idle` into a `liveRuns` signal; `components/LiveBadge.tsx` ("Live · 12 s ago",
  pulsing) mounted in the overview row and the session header; live rows sort first by default.
- Session screen: on `live` for the open run, fetch `tail`, append requests/blocks, extend the chart domain,
  keep the pinned request; forecast line under the chart title:
  "At the current rate (+12.4k tokens/request), auto-compaction (~970k, observed) in ~9 requests / ~14 min".
  No forecast → no line. Never a countdown animation.

Tests and acceptance.
- Fixture file appended with 5 requests → `live` event within 3 s; `tail?after=` returns exactly 5 requests.
- Watcher fallback test with `fs.watch` stubbed to throw; forecast exact on a synthetic linear ramp;
  `parseMs` on the 18 MB fixture < 400 ms; no full-scope refetch when `rebased` is false (fetch spy).
- Acceptance: run `claude` in a repo while `contextscope` is open; the row goes Live and the chart grows
  without a reload; `contextscope index` (no server) is unaffected.

## 4. Hosted demo and landing page on the root app

Rationale. The npm one-liner is the product, but nobody runs it before seeing what it shows, and the root
vinext app currently shows an unrelated attention explainer in Polish. The same Preact bundle the CLI serves
can run in the browser against a bundled synthetic dataset with no server, which makes the demo *the* UI,
not a mock, and gives privacy-safe exports (§5) a place to be opened. Everything is static: no Worker code
paths, no D1/R2 (`hosting.json` keeps `d1: null, r2: null`), no sign-in helpers.

Deletions and rewrites.
- Delete the explainer: contents of `app/page.tsx` and `app/globals.css`, `public/attention-lab-og.png`,
  `public/classroom-attention-og.png`, `public/og.png` (replaced).
- Rewrite root `README.md` (monorepo map: `app/` site, `packages/cli`, `packages/ui`; the npm package;
  dev commands) and `tests/rendered-html.test.mjs`. Root `package.json` name becomes `contextscope-site`.

Build and file map.
- `scripts/sync-ui.mjs` copies `packages/cli/ui/*` → `public/app/` and the demo dataset → `public/demo/`;
  wired as `"prebuild"` in the root `package.json`. `public/` is served by the platform `ASSETS` binding, so
  `/app/index.html` and `/demo/*.json` need no route; hash routes work unchanged (`/app/#/session/claude/<id>`).
- Demo dataset from `packages/ui/dev/make-fixtures.mjs --demo`: `overview.json`, `findings.json`, `habits.json`,
  `setup.json`, `thresholds.json`, `runs/<vendor>--<id>.json` + `.scopes.json` for 12 synthetic sessions
  (2 vendors, ~40 subagents, 3 compactions, one resumed session), deterministic seed, every label synthetic.
  Validated by `dev/validate-fixtures.mjs` and the privacy grep.

UI backend abstraction (`packages/ui/src/api.ts`).
- `Backend` interface; `companionApi` (today's fetch client) and `staticApi({ base: "/demo" } | { export })`.
- `staticApi` maps the same calls to JSON files or the in-memory export, answers `indexEvents` with one
  `done` event, keeps `PUT thresholds` in memory (findings come pre-grouped; no client-side rule engine).
- Selection: `?demo=1`, or no token and `location.pathname.startsWith("/app")` → demo; an opened export → memory.
- Banner: "Demo data · synthetic sessions · nothing you do here leaves the browser".
- New route `#/open` (`screens/Open.tsx`): drop zone + file picker for `contextscope.export/1`; validates
  schema, size ≤ 50 MB, forbidden keys; then navigates to the session. Available in the companion too.

Landing (`app/page.tsx`, server-rendered, static).
- Hero with the one command (`npx @contextscope/cli@latest`) and the sentence "See what filled your coding
  agent's context window, request by request. Runs locally; nothing leaves your machine."
- Three screenshots of the real UI on the demo dataset (`public/shots/*.png`, ≤ 200 KB each, captured from
  the dev server, committed), "What it reads / what it never stores" (from the CLI README privacy statement),
  "How it works" in three steps, CTA "Open the demo" → `/app/?demo=1#/`, secondary "Open an export" →
  `/app/?demo=1#/open`, footer linking the repo and the ADRs. No analytics.
- Metadata: title `ContextScope`; description "See what filled your coding agent's context window —
  request by request, locally."; OG image `public/og.png` 1200×630: the session occupancy chart from the
  demo dataset on the dark theme, wordmark, tagline. `layout.tsx` keeps the host-aware absolute image URL.

Tests and acceptance.
- `tests/rendered-html.test.mjs` asserts `<title>ContextScope</title>`, the npx command and the demo link.
- `tests/demo-assets.test.mjs` asserts `public/app/index.html` and `public/demo/overview.json` exist after
  `prebuild` and contain none of `content, text, stdout, stderr, prompt`.
- Acceptance: `npm run build && npm test` green at the root; the demo opens the stress session in < 1 s from
  static files; Lighthouse accessibility ≥ 90 on the landing.

## 5. Privacy-safe export

Rationale. "Paste this in the PR" is how a finding reaches the person who can change the setup, and it has to
be safe by construction, not by review. The export is the run shell plus chosen scopes, exactly what the API
already serves, with an optional label hash for people who consider repo-relative paths sensitive; the hosted
demo opens it, so one schema serves both.

Surface.
- `contextscope export --run <vendor:id> [--scopes main|all|<id,id>] [--redact-labels] [--md] --out <file.json>`;
  `--md` also writes `<file>.md`.
- UI "Export…" in the session header → `GET /api/v1/runs/:vendor/:id/export?scopes=main&redact=1`
  with `content-disposition: attachment`.

Schema `contextscope.export/1`:
```
{ schema: "contextscope.export/1", exportedAt, generator: { name: "@contextscope/cli", version },
  redaction: { labels: "plain" | "sha1-10", project: "basename" | "hashed" },
  run: RunResponse,                       // shell + findings; child scopes as summaries
  scopes: { [scopeId]: AgentScope },      // main always present
  thresholds: Thresholds, markdown: string }
```
- `--redact-labels` rewrites `block.label`, `tool.target`, `file` evidence `ref`/`label` and
  `project.displayName` to `h:` + 10 hex of sha1; ids and hashes are untouched.
- Markdown (`src/export/markdown.mjs`): facts row, peak and window share, composition at peak (top 5 with
  provenance), compactions, subagents table (type, peak, handoff, ratio), findings grouped by rule with the
  fix, and the "N tokens not in transcript" line when `unloggedShare > 0.05`.
- Privacy: the exporter runs `scrubForbiddenKeys` and asserts no absolute path (`^/`, `^[A-Za-z]:\\`)
  survives; the privacy-gate test extends to exports. The importer accepts schema/1 only and never uploads.
- Acceptance: the largest run with `--scopes main` exports < 3 MB raw; opened in the hosted demo it shows the
  same request count and peak as the companion.

## 6. Hook install for runtime evidence (Claude)

Rationale. Instruction loading on Claude is the one thing the transcript does not contain, and CLAUDE.md
rules are the fixes we most often propose; `InstructionsLoaded` turns `expected.load` into `observed.loaded`
and lets S-01 report the exact loaded chain. Compaction and subagent events are already in the transcript for
Claude, so the hook adds cross-checks there, not new facts. The installer must be previewed, reversible and
fail-open, and the hook must never write prompt text.

Commands.
- `contextscope hooks install [--scope user|project|local] [--events instructions,session,subagent,compaction]
  [--dry-run] [--yes]`, `hooks uninstall [--scope …]`, `hooks status`.
- Scope `user` (default) = `~/.claude/settings.json`; `project` = `<repo>/.claude/settings.json`;
  `local` = `<repo>/.claude/settings.local.json`.
- `--dry-run` prints a unified diff and exits 0; without `--yes` the diff is shown and confirmed on stdin.
- Backup `settings.json.contextscope-bak-<ts>` before the first change; existing groups (this machine:
  `PostToolUse` in six projects) are left byte-for-byte; our entries are recognised by the command containing
  `.contextscope/bin/capture.mjs`, so uninstall is exact and install is idempotent.

Hook entry (fail-open recipe kept), appended as a matcher-less group under `hooks.InstructionsLoaded`,
`SessionStart`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`:
```json
{ "type": "command", "command": "sh -c 'node \"$HOME/.contextscope/bin/capture.mjs\" 2>/dev/null || true'", "timeout": 5 }
```

Installed script `~/.contextscope/bin/capture.mjs` (zero deps, ~60 lines, mode 0700):
```
read stdin (≤ 256 KB, 500 ms self-timeout) → JSON.parse in try/catch
keep = WHITELIST[hook_event_name] ?? []           // unknown event → write nothing
record = { v: 1, at, event, sessionId, cwdKey: projectKeyFor(cwd), transcript: display(transcript_path) }
for each key in keep: record[key] = relativize(value) // paths: ~/… under home, repo-relative under cwd, else basename
append JSON line to ~/.contextscope/capture/<YYYY-MM-DD>.jsonl (0600); exit 0 on every path
```
Record schema (`capture/v1`): base fields plus per event `InstructionsLoaded { file, memoryType, loadReason }`,
`SessionStart { source }`, `SubagentStart { agentId, agentType }`, `SubagentStop { agentId, agentType, transcript }`,
`PreCompact { trigger }`, `PostCompact { trigger }`. Dropped on purpose: `custom_instructions`, any summary or
prompt text, environment. Field names are checked against the installed Claude Code hook reference on the
stream's first day; an unknown field is dropped by the whitelist, so a vendor rename costs coverage, never privacy.

Join (`capture/join.mjs`, called from `index/worker.mjs` before `finalizeRun`).
- Capture lines are read once per pass for the candidate session ids; the run gains `capture: { records }`.
- `SubagentStart/Stop` fill `launchedAt`/`deliveredAt` where the transcript lacks them.
- `PreCompact/PostCompact` set `compaction.hookObserved = true`; a mismatch is counted in coverage.
- `InstructionsLoaded` feeds `sessionStats.instructionFilesObserved` with provenance `observed.vendor`;
  `setup/inventory.mjs` sets `InstructionFile.loadState = "observed.loaded"` for files seen in ≥ 1 session of
  the repo; the startup budget `instructions` becomes `observed.artifact` (sizes from disk, membership from
  the hook). S-01 and S-04 use the observed chain when present.

Tests and acceptance.
- Merge test on a settings fixture with an existing `PostToolUse` group (unchanged); idempotent double install;
  uninstall restores the original; dry-run writes nothing.
- Capture script test piping a synthetic `InstructionsLoaded` payload with an absolute path and a
  `custom_instructions` field: path relativized, field absent, exit 0 on malformed input.
- Acceptance: after install and one Claude session, `#/setup` shows CLAUDE.md as `observed.loaded` and
  `hooks status` lists the six events with record counts.

## 7. CI check (setup only)

Rationale. The research thesis ends in "enforce": a repository check that fails when the setup regresses.
Setup rules need no sessions, so this is cheap and complete now; session budgets in CI are cycle 3.

Spec.
- `contextscope check [--repo <path>] [--budget startup=6000] [--max-instruction-file 3000] [--no-broken-refs]
  [--fail-on high|medium] [--json] [--github]`.
- `<repo>/.contextscope.json`: `{ "check": { "budget": { "startup": 6000 }, "maxInstructionFile": 3000,
  "brokenRefs": false, "failOn": "high" } }`; flags override the file.
- Evaluates the setup inventory and S-* rules only: no index, no `~/.contextscope` access, no prompt.
- Output in the `scan` layout:
  ```
  ContextScope check · context-viewer
  claude  startup 7,410 / 6,000 tokens   over by 1,410        FAIL
  codex   startup 4,120 / 6,000 tokens                        ok
  CLAUDE.md  3,400 tokens > 3,000                              FAIL
  [HIGH] S-06 Instruction references a missing path · docs/old.md
  2 violations, 1 high finding → exit 1
  ```
- `--github` prints `::error file=CLAUDE.md,line=1::…` annotations. Exit codes: 0 pass, 1 violations,
  2 error (unreadable repo, bad flag). `--json` → `{ ok, violations, budget, findings }`.
- README snippet:
  ```yaml
  - uses: actions/setup-node@v4
    with: { node-version: 22 }
  - run: npx @contextscope/cli@latest check --budget startup=6000 --no-broken-refs --fail-on high --github
  ```
- Tests: fixture repos for pass, budget fail, broken-ref fail, high-severity fail; exit codes; `--github` format.
- Acceptance: `check` on this repo completes in < 1 s and exits 0 or explains exactly why not.

## 8. Status line: deferred to cycle 3

Rationale. Current Claude Code already reports context usage to a `statusLine` command in its stdin JSON, so an
occupancy-only status line duplicates a native number; our differentiator is the forecast, which needs §3's
live index, and the "< 100 ms, no index" constraint forces a tail-read parser that would be a third parsing
path. Decision: not in cycle 2. Cycle 3 ships `contextscope statusline` as a 64 KB tail read of the newest
transcript (last usage record + forecast from the last 20 requests) once live mode has proven the forecast.

## 9. Housekeeping

- Rules version: `rules/index.mjs` exports `rulesHash` = sha1 of every `[SBH]-NN.mjs` source plus
  `thresholds*.json`; manifest and entries store it; a mismatch schedules `reevaluate` (existing path), so a
  rule edit invalidates findings without re-parsing. `scan`/`start` print "rules changed, re-evaluating N runs".
- Codex `cacheCreation`: read `cache_write_input_tokens` when present (0.150+), else leave undefined;
  `Usage.total` unchanged; the cache strip shows the third colour for Codex when available.
- Envelope calibration: `scripts/calibrate.mjs` gains a per-session bias table (`k p50` per run) and fits
  `envelopeTokens` jointly with `bytesPerToken`; the +11% session becomes a row in `calibration.json.measured`;
  constants change only if the corpus median bias exceeds 5%, with `CALIBRATION_VERSION` bumped.
- "No handoff yet" verification: for the sample session's 5 of 16 subagents, check the parent transcript for
  task-notification or tool_result records carrying those agent ids (numbers only). If the parent did receive
  them, the Claude adapter matches handoffs by `toolUseId` as a fallback; otherwise the label stays and a
  fixture documents the case. The verdict goes into the cycle log.
- Strays: `packages/finalize.mjs` and `packages/reconcile.mjs` at the packages root are copies outside the
  package; delete. `packages/ui/src/api.ts` `FindingsResponse` gains `groups`.

Types (diff against `src/ir/types.ts`, landed first as PR 0):
```ts
interface Block { tool?: { /* existing */ partial?: boolean } }
interface Forecast { threshold: Measured; perRequest: number; perMinute: number; requestsLeft: number; minutesLeft: number;
                     basis: { requests: number; from: number; to: number }; provenance: "derived.exact" }
interface AgentScope { forecast?: Forecast; capture?: { records: number } }
interface Compaction { hookObserved?: boolean }
interface Finding { scope: "setup" | "session" | "subagent" | "habit"; sessions?: number }
interface OverviewRun { live?: { at: string } }
interface Overview {
  scope: { mode: "repo" | "all"; repo: { name: string; key: string }; sessions: number; machineSessions: number; unattributed: number };
  trends: { /* existing */ sessions: number[]; peakShareMedian: number[]; startupH0Median: number[]; instructionEdits: Array<{ path: string; at: string }> };
}
interface RunTail { requests: Request[]; blocks: Block[]; closed: Array<{ id: string; lastRequest: number; droppedBy?: string }>;
                    compactions: Compaction[]; summary: RunSummary; peak: Measured; forecast?: Forecast; rebased: boolean }
interface Export { schema: "contextscope.export/1"; exportedAt: string; generator: { name: string; version: string };
                   redaction: { labels: "plain" | "sha1-10"; project: "basename" | "hashed" };
                   run: RunResponse; scopes: Record<string, AgentScope>; thresholds: Thresholds; markdown: string }
interface CaptureRecord { v: 1; at: string; event: string; sessionId: string; cwdKey: string; transcript: string;
                          file?: string; memoryType?: string; loadReason?: string; source?: string; agentId?: string; agentType?: string; trigger?: string }
interface Coverage { rulesHash?: string }
```

## 10. Ranking, scope of cycle 2, and what is deferred

| Rank | Item | Cycle 2 | Why this rank |
|---|---|---|---|
| 1 | §1 Repo scoping | yes | The overview is wrong for every repo today; every other item builds on the population it defines. |
| 2 | §2 Habits + trends | yes | The product's leverage: a fix that removes findings in N sessions, named by path. |
| 3 | §3 Live mode + forecast | yes (re-parse; no append-resume) | The only session you can still change; the forecast is the first number users act on mid-session. |
| 4 | §4 Hosted demo + landing, §5 Export | yes | Adoption surface; export makes findings shareable and the demo opens them. |
| 5 | §6 Hook install | yes (`InstructionsLoaded` first) | The one fact transcripts lack; makes S-01 exact. |
| 6 | §7 CI check | yes | Cheap, setup-only, closes the "enforce" loop. |
| 7 | §9 Housekeeping | yes | Rules hash and Codex cache are correctness debts; small. |
| 8 | §8 Status line | deferred | Duplicates a native number; needs §3 first. |
| — | Append-resume parsing, Gemini adapter, apply-fix with rollback, `#/project/:key` | deferred | Not justified by measured latency; no Gemini corpus; no trust model; the server has one repo root. |

## 11. Parallel streams and file ownership

PR 0 (architect, day 1, sequential): the type additions from §9, `server/routes.mjs` split into
`server/routes/*.mjs` with a static handler list, a `commands/*.mjs` registry in `contextscope.mjs`, and
`writer.mjs` `ensure({ only })`. Every stream branches from PR 0. A file is owned by exactly one stream;
a cross-stream need is a one-line mount done by the owner, never a shared edit.

| Stream | Owns (under `packages/cli/src` unless noted) | Tasks | Acceptance |
|---|---|---|---|
| S1 Scope + habits | `index/overview.mjs`, `index/reader.mjs`, `index/entry.mjs`, `index/scan.mjs`, `server/analysis.mjs`, `server/routes/overview.mjs`, `server/routes/habits.mjs`, `rules/H-*.mjs`, `rules/habits.mjs`, `rules/thresholds.json` (habit keys), `packages/ui/src/screens/Overview.tsx`, `components/TrendsPanel.tsx`, `test/{overview-scope,habits}.test.mjs` | §1 population rule, `scope` param, `scan --all`, header toggle; `habits` record, H-01..H-06, `/habits`, trends series and panel; mounts S2's `LiveBadge` | Two repos give different `scan` totals; habit findings from manifest only (spy); overview < 155 KB |
| S2 Live | `index/watch.mjs`, `ir/finalize.mjs` (forecast), `ir/calibration.json` (`autoCompact`), `server/routes/runs.mjs` (tail), `server/sse.mjs`, `packages/ui/src/{store.ts,session-state.ts}`, `screens/Session.tsx`, `components/LiveBadge.tsx`, `charts/*`, `test/{watch,forecast,tail}.test.mjs` | Watcher + fallback, `live`/`live-idle` events, tail route, forecast, live session view | `live` ≤ 3 s after append; tail returns exactly the new requests; forecast exact on a linear fixture; 18 MB parse < 400 ms |
| S3 Public face + export | root `app/**`, `public/**`, `scripts/sync-ui.mjs`, root `README.md`, root `package.json`, `tests/**`; `packages/ui/src/api.ts`, `router.ts` (`#/open`), `screens/Open.tsx`, `packages/ui/dev/make-fixtures.mjs`; `commands/export.mjs`, `export/{schema,markdown,redact}.mjs`, `server/routes/export.mjs`, `test/export.test.mjs` | Delete explainer, landing, OG, prebuild copy, static/in-memory backend, drop zone; export CLI + route + markdown + redaction | Root build and tests green; demo loads from static files; export < 3 MB for the largest run and opens in the demo; privacy gate covers exports |
| S4 Hooks + CI + CLI surface | `contextscope.mjs` (registry lines for every stream), `commands/{hooks,check}.mjs`, `capture/{template,reader,join}.mjs`, `setup/{inventory,config,budget}.mjs`, `rules/S-01.mjs`, `rules/S-04.mjs`, `index/worker.mjs` (join mount), `packages/cli/README.md`, `.contextscope.json` schema, `test/{hooks,capture,check}.test.mjs` | Installer with diff/backup/uninstall, capture script, join, `observed.loaded`, `check` with exit codes and `--github`, README + Action snippet | Merge leaves `PostToolUse` untouched; capture never stores absolute paths or prompt fields; `check` exit codes on four fixture repos |
| S5 Housekeeping + verification | `index/writer.mjs` (rulesHash), `index/manifest.mjs`, `rules/index.mjs` (`rulesHash`), `adapters/codex.mjs`, `adapters/claude.mjs` (handoff fallback, `tool.partial`), `adapters/claude-tools.mjs`, `scripts/calibrate.mjs`, `test/{rules-hash,adapter-*}.test.mjs`, delete `packages/{finalize,reconcile}.mjs` | Rules hash invalidation, Codex `cacheCreation`, envelope fit, no-handoff verification, `partial` flag for S1 | Rule edit re-evaluates without re-parse (`lastPass.reevaluated`); Codex cache strip shows creation; handoff verdict in the cycle log |

Order: PR 0 → S1..S5 in parallel (S5's `tool.partial` and PR 0's `ensure({ only })` land on day 1 because
S1 and S2 consume them) → integration PR by S4 (registry lines, README, version 0.10.0) → cycle-log entry
with numbers (repo session counts, habit findings, live latency, demo size, hook record counts, check timing).

## Consequences

- The overview changes meaning: repo by default, all projects on request. Anyone reading `scan` output after
  this release sees smaller numbers; that is the correction, and the header says so.
- Two new evidence sources (`habit` findings, hook capture) enter the same Finding shape; no score, no blended
  confidence, provenance on every number as before.
- Live mode adds a watcher and a re-parse per change, not adapter state. We accept ~2.5 s latency and revisit
  append-resume on measured cost, not on principle.
- The root app stops being a starter and becomes the public face of the same bundle the CLI ships; a UI change
  is visible in the demo on the next deploy without a second codebase.
- The hook installer is the first thing ContextScope writes outside `~/.contextscope`; it is previewed,
  backed up, reversible and fail-open, and the capture record carries no text by construction.
