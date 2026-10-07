# ContextScope build log

One entry per cycle. Each cycle = analysis → evaluation → implementation → review.

## Cycle 1 — 2026-09-02

### Analysis
- Baseline: the web app in `app/` held an unrelated attention explainer; the real product was `packages/cli` (v0.8, 3.2k lines) with a server-rendered dashboard that estimated tokens from bytes/4 on at most 12 sessions and never read vendor usage fields. 23 tests passed. See `docs/review-cycle1-existing-cli.md`.
- Format forensics on this machine (218 Claude Code sessions + 701 subagent transcripts, 80 Codex rollouts): exact per-request context occupancy is available in both vendors' artifacts (`docs/format-claude-code.md`, `docs/format-codex.md`).
- Architect proposal accepted as `docs/adr-001-product-architecture.md`.

### Evaluation (what was worth building now)
- Exact occupancy per request, subagent windows linked to parents, compaction boundaries, tool-result attribution: yes (data exists, deterministic).
- A health score: no (uncalibrated). Gemini adapter, apply-fix, LLM audits: deferred.
- UI as a prebuilt Preact SPA served by the zero-dependency CLI: yes.

### Implementation (7 parallel streams)
- IR core (`src/ir`): streaming JSONL, estimator, reconciliation, finalize.
- Claude adapter, Codex adapter, incremental index + server + SSE, setup inventory + S-01..S-12, rules engine + B-01..B-15, UI shell + Overview/Findings/Setup, Session view with SVG charts.
- Result on this machine: 165 runs, 554 subagents, 45k requests, 11.1B processed input tokens indexed in 2 s (incremental pass 0.16 s); 167 tests green.

### Review (3 parallel reviewers)
- `docs/review-cycle1-backend.md` (40 findings), `docs/review-cycle1-ui.md` (40 findings), `docs/adr-002-cycle1-review.md` (architect decisions A–H).
- Verified defects: encoded absolute cwd leaked as `project.key`; in-flight blocks survived compaction; negative categories when total < H; hook stats keyed inconsistently; Codex handoffs never populated; wheel scroll dead on the session screen (SVG overflow); 378 finding cards rendered per session; y-domain 2× too tall; `11097M` formatting; conflated network/render errors.

### Fix wave (4 parallel streams) — done
- Reconciliation v2 (`unlogged` category, clamped scale, split hidden base, per-scope error, sweep-line), privacy project key, Claude in-flight drop, Codex handoffs, calibration.json.
- Payload split (`/runs/:v/:id` shell + `/scopes/:id`), gzip, overview trimming, hardening, legacy cutover, `scan` command, README.
- Findings aggregation per (rule, run, scope), severity recalibration, B-16 unlogged-context.
- UI: all confirmed bugs, grouped findings, unlogged series, child-scope lazy load.

### Cycle 1 result (verified on this machine, 2026-09-02 03:10)
- 211 tests green; UI typecheck clean; bundle 27.6 KB app.js + 39.9 KB css initial, session chunk on demand.
- Index: 250 files parsed in 1.7 s, incremental pass 0.16 s; largest run payload 23 MB → 3 MB raw / 422 KB gzip.
- Reconciliation v2: resumed session estimator error 29%/90% → 3%/11% with 184k tokens honestly labelled "not in transcript".
- Findings: 193 flat → 78 aggregated in 14 rule groups; first change = B-02 (CLAUDE.md rule for shell output), setup rules exclude lazily loaded nested files from the startup chain.
- Legacy modules deleted; CLI surface = `start`, `scan`, `index`, `help`; README rewritten.
- Known open items carried to cycle 2: `scan` totals are machine-wide even with `--repo` (session findings are repo-scoped); rule-code changes do not invalidate stored findings (needs a rules version hash in the manifest); Codex `cacheCreation` unreported; per-request envelope bias (+11%) on one Claude session; 5 of 16 subagents in the sample session show "no handoff yet" (verify against transcripts whether the parent really never received them).

## Cycle 2 — 2026-09-02 (started ~03:30)

### Analysis / evaluation
- Plan: `docs/adr-003-cycle2-plan.md`. Ranked: repo scoping (the overview was machine-wide for every repo), cross-session habits + trends, live mode + compaction forecast (re-parse on change, no append-resume), hosted demo + landing on the root app + privacy-safe export, hook installer for runtime evidence, `check` for CI, housekeeping (rules hash invalidation, Codex cache writes, envelope calibration, handoff-in-tool_result fallback, `tool.partial`). Deferred: status line, Gemini adapter, apply-fix, append-resume.
- Verified before planning: the five "no handoff yet" subagents in the sample session did deliver. Corrected after S5's corpus check (216 sessions, 584 agent handoffs): the notifications arrived as `attachment` records of type `queued_command` with `commandMode: "task-notification"` (absorbed mid-turn while the parent was busy) — 106 of 584 handoffs take this path, 478 are standalone `user` records, and **0** arrive inside a `tool_result`. The adapter now reads both paths (`Block.via: "attachment"`); the tool-result split exists only for a synthetic fixture. See `docs/format-claude-code.md` §5.

### Implementation
- PR 0 (sequential): PR-0 types, `server/routes/*` registry, `commands/*` registry, `ensure({ only })`; 212 tests green. UI build now appends `src/styles/*.css` so streams do not edit `theme.css` concurrently.
- Streams S1–S5 launched in parallel with the ownership table from ADR-003 §11.

### Cycle 2 streams — done (integration pass included)
- S1 repo scoping + habits + trends; S2 live mode (2.3 s latency, 18 MB re-parse ≈ 250 ms) + compaction forecast; S3 landing page + hosted demo (`public/app`, static/memory backends, `#/open`) + `export`; S4 `hooks install/status/uninstall` + capture join + `check` (exit codes, `--github`); S5 rules-hash invalidation, handoff-via-attachment fallback (all 16 subagents in the sample session now `completed`), `tool.partial`, Codex cache writes, envelope fit (kept). Integration: types, live badge, export button, fixture-dir exclusion, repo default range all-time, docs. 283 CLI tests; root site builds.

### Cycle 2 review (3 reviewers; first attempt lost to the 7am session limit, rerun)
- `docs/adr-004-cycle2-review.md`: scorecard yes / yes / partly; decision: a session is a top-level run and Codex thread-spawn children are subagents (counts disagreed 3 vs 7 vs 11); 15-item fix list; cycle-3 top 3 = before/after view per instruction edit, attribute temp-isolation sessions, experiment flow.
- `docs/review-cycle2-backend.md` (40): population defined three ways; thresholds PUT never re-evaluates; `observed.loaded` on the wrong file; live re-parse runs full discovery; forecast uses wall-clock gaps; hook backups written inside the repo; export leak check line-anchored + unsalted hashes; H-06 fix inverted; `check` reads home config; trailing-only debounce.
- `docs/review-cycle2-ui.md` (40): hollow export crashes the session screen; index events stick after loading an export; wrong issue link; 800 px overflow; live badge sticks; demo/fixtures lack new fields; copy lies outside companion mode.
- Fix wave W1a/W1b/W2/W3 launched.

### Fix wave W2 (export privacy, hooks trust, publishing) — done
- Export: substring leak gate over the whole document (`/Users/`, `/home/`, `C:\`, `-Users-`, `~/` outside vendor config dirs), salted `sha1-10` labels (`redaction.salt`), labels collected from every scope, path-like tokens hashed in finding prose and evidence labels, instruction-file names never hashed, 50 MB cap enforced by the exporter. Real check: `claude:cc87cfe5…` (1,817 requests, 16 subagents, 29 findings) and `claude:5ca0d315…` (13,332 requests, 167 subagents, 272 findings) redact to 0 path-like tokens at 2.52 MB / 2.92 MB (`--scopes main`); before the fix 21 / 22 path-like tokens survived.
- Hooks: backups to `~/.contextscope/backups/<scope>-settings-<ts>.json` (0600, last 10), node pinned from `process.execPath` with PATH fallback, guarantee line first, project-scope warning, `hooks status` shows node / counts / last record, capture pruning (90 d / 500 files), `CLAUDE_CONFIG_DIR` honoured. Real verification in `test/hooks.test.mjs`: install into a temp `CLAUDE_CONFIG_DIR`, run the installed command through `sh` with an `InstructionsLoaded` payload, record read back (file, loadReason, memoryType; no prompt text, no absolute path).
- Publishing: package renamed to `contextscope` (both `contextscope` and `@contextscope/cli` were 404 on the registry), one command `npx contextscope` everywhere, `.github/workflows/check.yml` + `publish.yml` (provenance), `docs/publishing.md`, `CHANGELOG.md`; `npm pack --dry-run`: 128 files, 295.8 kB packed / 982.5 kB unpacked, no tests or fixtures.

### Cycle 2 fix wave — done (W1a population/habits/check, W1b live/forecast/capture, W2 privacy/publishing, W3 UI)
- One population rule (`repoSessions()`): a session is a top-level run; Codex thread-spawn children roll up to their root. Overview, findings recurrence, habits and `scan` agree (context-viewer: 3 sessions, 45 subagents; was 3 / 7 / 11).
- Live passes no longer run discovery or spawn pools (130–195 ms per pass on the 18 MB session; append → SSE 154–225 ms); forecast uses active time, window-keyed thresholds, `flat` state, live-only.
- Export: substring leak gate + salted label hashes; the two reference exports redact to 0 path-like tokens (was 21/22). Hooks: backups under `~/.contextscope/backups`, pinned node, end-to-end verified install. Package name `contextscope` (free on npm), `npm pack` 128 files / 296 kB, CI + publish workflows, CHANGELOG, LICENSE, `docs/publishing.md` checklist.
- New rules: H-07 same-file-reread, B-17 tool-args-dominate; H-01/H-03/H-06 corrected; `check` dedupes per file, ignores home config by default, exit codes 0/1/2/3.
- UI: hollow-export refusal, honest copy outside companion mode, first-change card above the table with evidence, 3-significant-digit numbers, 800 px layout, live badge clears on idle, forecast card copy; initial bundle 111 KB raw / 41 KB gz.
- Landing: no placeholder links (plain "coming soon" until the repo/npm exist).

### Cycle 2 result (verified 2026-09-02 ~09:00)
- CLI 314/314, root site 5/5, UI typecheck/build clean; full re-index 250 files in 1.9 s.
- `scan --repo context-viewer`: 3 sessions (189 on this machine), 422M processed tokens, 10 compactions, first change B-02 → AGENTS.md.
- Carried to cycle 3 (from ADR-004): before/after view per instruction-file edit; attribute the 59 temp-isolation sessions; experiment flow; Claude Bash results lack `tool.target`; redacted exports keep MCP server names and agent types readable.

## Cycle 3 — 2026-09-02 (started ~09:40)

### Analysis / evaluation
- Plan: `docs/adr-005-cycle3-plan.md`. Ranked: before/after per instruction-file edit (the first observational step toward "validated improvement rate"), harness-run classification + minimal session attribution, observational experiment flow (`experiment start|candidate|compare`), Claude Bash `tool.target`, per-tool cost attribution (token-requests + uncached), first-run experience + `status`, redaction hardening. Deferred again: status line, task-runner experiments with graders.
- Measured before planning: the 59 unattributed sessions are 56 sdk-cli harness runs in temp isolation dirs (1 request, 0 tool calls each) plus 3 probes; no signal (hook capture, nested memory, path overlap, instruction hash) can attribute them, so the decision is to classify them as harness runs rather than guess by directory name.

### Implementation
- Streams A (changes + experiment), B (harness classification, attribution, Bash targets), C (per-tool cost, redaction), D (first run, `status`, docs) launched in parallel with explicit file ownership.

### Cycle 3 result (2026-09-02 ~11:00) — implementation landed, review still owed
- Streams A (changes + experiment), B (harness classification, attribution, Bash targets), C (per-tool cost, redaction policy), D (first run, `status`, docs) all landed their code. A, C and D were cut off by exhausted API credits during their final verification passes; B finished cleanly. The main session finished their work: fixed the redaction name policy (convention paths keep `.claude/agents/` and hash the user's file name; Codex developer tags added to the vendor vocabulary), dropped derivable `newBlockIds`/`visibleBlockIds` from exports (largest run back under 3 MiB), and removed causal wording plus a stale number format from the experiment report.
- Verified: CLI 353/353, UI typecheck + build clean, root site 5/5, full re-index 250 files in 2.2 s, `status` in 90 ms, `/api/v1/{cost,changes,habits}` answer on the live companion.
- `scan --repo context-viewer`: 3 sessions (124 on this machine), 50 subagents, 471M processed tokens, 65 harness runs and 1 unattributed (was 59 unattributed), cost by tool Bash 29% · exec 14% · Read 14%.
- Command surface: `start, scan, index, export, hooks, check, status, experiment, help`.
- NOT done this cycle: the cycle-3 review wave (backend/UI/architect) and its fix wave; `changes` has nothing to show for this repo yet (no instruction files with git history here); the ADR's "56 harness · 3 unattributed" became 65 · 1 because Codex temp probes classify as harness too.

## UI pass for daily use — 2026-10-07

Looked at every screen against this machine's real sessions (218 on the machine, 8 in this repo, two live) and asked what a developer opens the tool for during a working day. Shipped in `packages/ui` (0.11.0, unreleased):
- **Live now** hero on the overview + a **live** link in the top bar: the session the developer is sitting in, how full its window is, one click to the live view. Before this the live session was one table row with a small pill.
- **Command palette** (⌘K): any session, screen or action from the keyboard; sessions come from one machine-wide overview call cached per index version, live ones first.
- **Provenance badges** shrunk to a dot plus one word; per-lane badges dropped; ledger header no longer clips. Same information, a third of the ink.
- Session header: scope selector + Export popover only; hints under the title. Footer: version (baked in by `build.mjs` from the package), locality promise, provenance legend, ⌘K / ? entry points. Favicon, theme-color.
- Bug found on the way: `useFocusTrap` made `#app` inert, which includes every dialog rendered inside it; the thresholds drawer could not be typed into. Fixed by making only the dialog's siblings inert.
- Verified in Chrome on the live companion (dark and light), CLI e2e + export tests, root site tests, typecheck and build; `public/app` re-synced.

## Release prep — 2026-10-07 (evening)

Three blockers from the pre-release review, done on branch `release-prep`:
- **Links**: `open-mercato/context-scope` everywhere; landing footer links to GitHub and npm; fixes read "Suggested fix" with a hypothesis note (UI, README, landing).
- **Rules precision** (two agents in parallel, file ownership per rule family): B-11, B-04, B-13, B-16, S-05 tightened; scope-aware fixes via `platformFix(run, variants, { scope })` + `childScopeFix`; `references.mjs` negation / template / placeholder / ignored-dir filters. Before → after on real repos (`scan --json`): context-viewer 141 → 122 findings (B-11 8 → 0, B-04 10 → 2, B-13 7 → 4); ai_techleaders_project 152 → 131 (B-11 13 → 0, B-04 3 → 1, B-13 9 → 3). First change unchanged in both. B-16 is still 20 on the second repo: those are resumed sessions, the finding is true, the volume is a follow-up.
- **Token estimates**: `estimateByVendor` in `ir/estimate.mjs` is the single source; inventory rows carry `estTokensBy` + `estBasis`; budget, `check`, S-01 and `tokens` agree per vendor (test proves equality); binary reads get `kind: "binary"` with a 40 B/token ratio; calibration `cal-2026-10-07a`.
- Verified: CLI 377 pass / 1 skipped, UI typecheck + build, site tests. The evaluation in `docs/evaluation-findings.md` should be re-run on the same five repositories before the first publish; the numbers there are pre-change.
