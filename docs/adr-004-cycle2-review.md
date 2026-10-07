# ADR-004: Cycle 2 review — what shipped, what is wrong, the fix wave, and cycle 3

Status: Accepted for the cycle-2 fix wave · Date: 2026-09-02 · Owner: architecture
Inputs: `docs/cycle-log.md`, ADR-003 (the plan), ADR-001 §1/§6, `docs/context-engineering-research.md`
("Recommended pivot", "Product validation plan"), both READMEs, `index/{overview,reader,entry}.mjs`,
`rules/{habits,H-01,H-03}.mjs`, `ir/finalize.mjs`, `capture/join.mjs`, `commands/check.mjs`.
Everything below was verified by running the product on this machine (numbers only, never content):
`scan` on two repos and `--all`, `check`, `hooks install --dry-run`, `export --redact-labels`, the companion
in Chrome (overview repo/all, two sessions incl. the live one, findings, setup, `#/open`), the demo served
from `public/` as static files. 283 tests green. The companion idled at 0.0 % CPU after four minutes.

## 0. Verdict in one paragraph

Cycle 2 delivered the plan's surface: repo scoping, six habit rules, live mode with a forecast, export + open,
a hook installer, `check`, the landing and the demo. The session screen now answers questions (a) and (b) in
under ten seconds, and the findings screen answers (c). Three things stop me from calling the cycle done:
the same repository is reported with four different session counts because Codex `thread_spawn` child rollouts
are counted as sessions in some code paths and as subagents in others; `--redact-labels` leaks plain file paths
in findings prose; and the public face sells an `npx` command that is not published. None of these needs new
architecture. All of them need one rule applied consistently, then a release.

## 1. Scorecard against the three questions (ADR-001 §1), ten-seconds rule

| Question | Verdict | Screen evidence (this machine) |
|---|---|---|
| (a) Where did my context go? | **Yes** | Session `cc87cfe5`: stacked occupancy over 1,817 requests, two compaction boundaries labelled `967k → 12.0k` / `967k → 20.7k`, the resumed history as a hatched band with a rail note ("33.3k tokens of earlier context are not in this transcript"), heavy hitters with "dropped by compaction before 1140". Provenance badges on every figure. |
| (b) What did my subagents cost and return? | **Yes** on the session screen, **partly** on the overview | Lanes read `peak 231k → 2.0k · 116.3× · estimated` per subagent, 20 of 32 drawn with "show all". The overview's "Fattest subagent handoffs" shows the handoff size only (no peak, no ratio) and names Codex children by raw id (`codex:01a059dd-5bdf-73e…`). |
| (c) What is wrong with my setup, which change first? | **Partly** | Findings screen: the top card is the leverage-ranked first change with fix + snippet + editable threshold — answered in ten seconds. Overview: "One change to make first" sits **below** a 9-row session table (two screens down at 1440×1000), its `Evidence:` label renders empty, and it says `7 sessions` for a repository the header says has `3`. Setup: "0 instruction files · No instruction files found · Nothing is sent to the model before your first message" directly under a startup budget of 883 (claude) and 757 (codex) tokens, with codex "Instruction files 607 observed·artifact". |

Decorative or confusing on first sight: the four sparkline tiles and the Trends panel on a 3-session repo (a single
spike each; "context-viewer · 30 days · 3 sessions" while the range selector says `all`); the project-chip wall in
All-projects mode (60+ `cez-root-isolation-*` chips); sessions named by model (`claude-fable-5-1`, `gpt-5.6-sol`)
so two rows are indistinguishable; the ledger owns the wheel so the session findings below it are hard to reach;
`End` on the session page scrolls into a blank region with the header at the bottom; `#/?scope=all` typed into the
URL bar does not switch scope (only the toggle does — the screen reads the hash once on mount).

Honesty labels are consistently present and correct: `observed · vendor`, `derived`, `estimated`, "composition
approximate · p95 17%", "6 % not in transcript". This is the part of the product I would not touch.

## 2. Population semantics: one rule

Observed for `--repo context-viewer`: header `3 sessions in this repo`; sessions table `3 sessions shown of 9`;
`scan` "One change first … `7 sessions`"; `Habits (11 sessions)`; findings groups `B-13 · 7 sessions`. The
manifest holds 11 entries with cwd under the repo: 1 Claude run, 2 top-level Codex rollouts, 8 Codex child
rollouts (`parentThreadId` set), two of them grandchildren. `overview.mjs` nests one level of children and hides
grandchildren; `recurrenceByRule` and `sessionCount` count every entry; `rules/habits.mjs` counts every entry
with a habits record (`sessions: list.length`); H-01's `5 sessions` are 2 roots + 3 children on two days.

Decision. **A session is a top-level run. A Codex `thread_spawn` child rollout is a subagent of its parent
(the nearest ancestor without `parentThreadId`, resolved transitively), exactly as a Claude subagent transcript
is.** Every count labelled "sessions", every recurrence, every habit population and every `sessions/day` point
uses the root run. Children contribute their blocks, findings, handoffs and habits records to the root. Rows
show the root; a child opens from the parent's lanes (as Claude subagents do), not as a session row.

Everything that must change (owner files):
- `index/reader.mjs`: add `rootRunIdOf(entry, byRunId)` (transitive, same vendor, falls back to self when the
  parent is not indexed) and `isChildEntry`; `entryMatchesRepo` unchanged.
- `index/overview.mjs`: `recurrenceByRule` counts distinct roots; `sessionCount` = roots; `mostCompacted`,
  `largestBlocks`, `fattestHandoffs` attribute to the root (`runId: root, scopeId: child`); `totals.subagents`
  and the row's `summary.subagents` for a Codex parent = its descendants; grandchildren no longer vanish;
  `trends.sessions` already skips children — keep. The `nested=1` row mode stays as a debug view only.
- `index/entry.mjs`: nothing structural; `findingHeadsOf` unchanged. Store `rootRunId` on the entry at write
  time when the parent is known (`index/writer.mjs`), so the reader never walks the manifest for it.
- `rules/habits.mjs`: `habitRecordOf` carries `rootRunId`; `makeHabitFinding.sessions` = distinct roots;
  `evaluateHabitsDetailed` groups child records into the root record (concatenate `fat`, `fullReads`, `agents`;
  sum `compaction.n`; root's `startup`); `sessions` in the result = roots. H-01…H-06 then need no edits except
  H-04's ordered window (already per record) and H-06's `records.length` (now roots).
- `server/analysis.mjs`: `repoRecurrence().sessionCount` and `habits().sessions` from roots.
- `commands/scan.mjs`: `Habits (N sessions)` and the `N sessions` column follow.
- `packages/ui/src/screens/Overview.tsx`: drop "3 shown of 9"; Subagents column for Codex parents; child rows
  become the parent's lane list on the session screen (`Session.tsx` already renders Codex children as scopes
  when they are joined — verify with `codex:01a05762`).
- `packages/ui/src/screens/Findings.tsx`: "N sessions" labels; the first-change card's empty `Evidence:` line.
- Tests: `test/overview-scope.test.mjs` and `test/habits.test.mjs` get a fixture with one Codex parent, one
  child and one grandchild, asserting `sessions === 1` in the header, the groups, `/habits` and `scan`.
- `packages/cli/README.md` "Scope and time range": define session = top-level run; children = subagents.

Second population defect, same family: `scan --all` run from `packages/cli` printed `repo cli: 0`. The repo
root is `cwd`, not the git top level. Resolve `--repo`/cwd to `git rev-parse --show-toplevel` when inside a
work tree (`commands/shared.mjs`), keep the raw path as a fallback.

## 3. Habit rules H-01…H-06: true and actionable on this machine?

Population reality first: 191 of 250 entries have a repo cwd, 58 are temp isolation dirs (`cez-root-isolation-*`,
`cez-root-lease-*`), one is unknown. `herodot` has **1** attributable session; `context-viewer` 3. The habit
rules need ≥ 3 sessions (H-04: 6, H-06: 5), so on this machine they are inert almost everywhere by design, and
the one place they fire is inflated by child rollouts. That is not a rule bug; it is the population bug plus an
attribution gap (below).

- **H-01** fires once: `exec web__run · 5 sessions · 59 results · 531k`. The results are real (fat outputs of the
  Codex `exec` script calling `tools.web__run`), but the five "sessions" are two Codex roots and three children on
  two consecutive days — one workflow, not a habit; after §2 it drops to 2 sessions and stays quiet, which is
  right. The fix is wrong-tool: the snippet is the shell line ("pipe through head, tail or grep") for what is a
  web fetch; `ruleLine()` in `H-01.mjs` must map `exec`+`web__*` to the web rule and name the target. Verdict:
  true, not actionable as written.
- **H-02** quiet everywhere; correct (`docs/adr-001…md` was read whole three times, but in one session).
- **H-03** quiet; correct — 32 `general-purpose` handoffs in the live session median ~2k at 100×+ compression.
- **H-04, H-05, H-06** quiet for lack of population; H-05 also lacks instruction files here (S-12 fires twice).
  `notes` is empty even when a rule is starved — the UI/scan should say "H-04 needs 6 sessions, this repo has 3".
- Not a habit rule but the most visible false framing: the first change `B-02 · session · claude · 7 sessions`
  for a repo with one Claude session; six of the seven are Codex children, the fix targets `CLAUDE.md`. §2 fixes
  the count; the fix platform must follow the majority vendor of the recurrence, not the head's vendor.
- Missing rule, seen twice today: **tool arguments dominate**. `Tool args` (Write/Edit/Bash payloads) is the
  largest category at the peak of `cc87cfe5` (33 %) and the largest band in the live session; no B-* or H-* rule
  looks at `tool_call` blocks. Add B-17 (per session, ≥ 25 % of peak) and let H-01 group `tool_call` too.
- Missing evidence source: 58 temp-dir sessions are unattributable, yet a Claude transcript carries the hash of
  the instruction block loaded at request 0. Matching that hash against the repo's `CLAUDE.md` (and the observed
  `gitBranch`) would attribute most of them deterministically. Cycle 3 candidate (§8.2).

## 4. Live mode and the forecast: honest and useful?

Live works as specified: the row and the header carry `live · updated just now`, `re-parse 352 ms` is shown, the
tail route appends without reload, idle after 3 min (README) rather than the plan's 120 s — keep 3 min, it is
documented. The watcher cost is fine (7 % CPU while I browsed, 0.0 % idle; RSS 318–382 MB, dominated by the
200 MB run cache).

The forecast card is honest in its labels and wrong in its judgement:
- Live session: "At +2.3k tokens/request you reach the auto-compaction threshold (999k, estimated) in ~227
  requests / **~58h 26m** at +151/min." A 58-hour countdown is fake precision built from a 20-request slope at
  47 % of a 1M window. Rule: when `requestsLeft > 150` or `minutesLeft > 240`, say "not within this session at
  the current pace" and show only the per-request slope; otherwise round minutes to 5 and requests to 10.
- Finished session: the card renders with "As of the last request in this transcript (not live)". ADR-003 said
  "no forecast → no line"; a forecast for a session that ended is noise. Render only when `live`.
- Threshold provenance: the plan promised `observed.vendor` when ≥ 3 corpus events; shipped `compactionThreshold`
  uses the run's own auto compactions (their provenance — correct, `cc87cfe5` shows `967k observed`) else the
  calibrated share labelled `estimated.local` (correct: a corpus median is not this run's observation). Keep the
  shipped labels, but say where the number comes from: "calibrated on 5 auto-compactions on this machine
  (`calibration.json`)". Note the calibration share is 0.999 from five events with min 0.967 — the card should
  show the range, not the point.
- Slope basis is stated ("requests 105–124, 20 requests, current segment") — good; keep.

Copy for the card: **"Auto-compaction at ~999k (calibrated from 5 local compactions; range 967k–1.0M).
Now 471k. Last 20 requests: +2.3k per request. Not within this session at the current pace."** When close:
"…+12.4k per request → ~9 requests, about 15 min."

## 5. Hooks, `check`, export: adoption friction and what could scare a user

**Hooks.** `hooks install --scope project --dry-run` prints the events, the fail-open command, a clean unified
diff and "(dry run) … not written". Good. Friction and fear:
- Project scope creates `.claude/settings.json` (70 lines, six matcher-less groups) in a file that is normally
  committed; teammates without `~/.contextscope/bin/capture.mjs` run a no-op every event. Default is `user`
  (right); for `project`/`local` print one line before the diff: "this file is usually committed; teammates will
  run a fail-open no-op until they install ContextScope". The backup `settings.json.bak-<ts>` lands next to a
  committed file — name it `.contextscope-bak` as planned and mention `.gitignore`.
- Lead the output with the guarantee, not the diff: "Nothing is written without `--yes` or your confirmation;
  `hooks uninstall` removes only these entries." The README says it; the command should too.
- Not verified end to end: `hooks status` shows 0 records on this machine, and the capture whitelist's field
  names were checked against docs, not against CLI 2.1.258 — an install-and-run test is part of the fix wave.
- `capture/join.mjs` is sound (nearest compaction within 15 min, Pre/Post share one boundary, unmatched counted);
  capture files are per session with no pruning — cap at N files or 30 days.

**`check`.** Runs in well under a second, exit codes right, `--github` annotations fine. Two honesty defects:
- One fact reported three times on `herodot`: `AGENTS.md 10,486 > 3,000 FAIL` (violation) + `S-01 Instruction
  file oversized · AGENTS.md` + `S-01 Instruction chain oversized · AGENTS.md` **twice** (claude and codex, no
  vendor tag). Dedupe per (file, cause) and tag findings with the vendor.
- Codex startup budget is `1,500` in `check` and `757` on the Setup screen for the same repo (check has no
  sessions, so `setup/budget.mjs` cannot substitute the observed chars). Both are defensible; the UI must show
  the disk-based number next to the observed one, and `check` must say "estimated from disk".
- CI story: the README's Action runs `npx @contextscope/cli@latest`, which does not exist on npm; this repo has
  no `.github/workflows`. We should be the first consumer of our own gate.

**Export.** 2.58 MB for the main scope of an 1,817-request session; the markdown is the best artefact in the
product (facts row, composition at peak, compactions, subagent table, findings with fixes, an honest footer).
Defects:
- **Redaction leak.** With `--scopes main --redact-labels`, B-15's evidence labels and fix snippets carry plain
  paths (`src/modules/treatment_plans/…`) because `redact.mjs` only learns labels from exported scopes; the
  paths came from child scopes that were not exported. `--redact-labels` must collect labels from every scope
  of the run (not only the exported ones) and additionally hash any path-like token (`/`, `.ext`) in `metric`
  labels and snippets. The privacy gate test must include a run with subagents and B-15/B-06 findings.
- Over-redaction: `fix.path` `CLAUDE.md` becomes `h:2d5d10cfc5` and the summary reads "Add a standing rule to
  h:2d5d10cfc5" — the fix is now unusable. Never hash instruction-file names (`CLAUDE.md`, `AGENTS.md`,
  `.claude/agents/*.md`, `.claude/rules/*.md`); they are the product's vocabulary, not secrets.
- The header says "1,817 requests" for an export of the 1,365-request main scope; say "main scope exported
  (1,365 of 1,817 requests)".

## 6. Landing page and demo: does it sell the truth?

Mostly. The three questions, the provenance paragraph, "No scores", the privacy grid and the export note are
accurate. The demo runs from static files with the banner "DEMO DATA · Synthetic sessions" and shows the product
at its best (13 sessions, three instruction-edit markers on the startup-base sparkline). Copy fixes:
- The hero command is `npx contextscope`; the README and the CI snippet say `npx @contextscope/cli@latest`;
  neither is published (footer: "coming soon"). One name everywhere, and do not show a command that fails —
  until publish, the hero's primary CTA is the demo and the command reads `npx @contextscope/cli` with
  "publishing with 0.10".
- Q02 body: "shows that window's peak next to the size of the handoff" — true on the session screen, not on the
  overview the screenshot shows. Either add peak/ratio to the overview card (fix wave) or caption the lanes.
- Q02 caption "sessions over 30 days" → "all time" (the repo default).
- Q01 caption promises "the ledger names the block that filled each step" — true; keep.
- Setup empty state "Nothing is sent to the model before your first message" contradicts the budget above it;
  say "No instruction files. Skill descriptions and MCP schemas still cost N tokens per request."
- The first real week will look emptier than the demo (no trends, no habits); the empty states, not the demo,
  must say so: "Habits need 3 sessions of this repo; you have 1."

## 7. Fix wave (ranked; cycle 2 is not done before these land)

1. One population rule (§2): root-run counting in overview, recurrence, habits, scan, UI — `index/reader.mjs`,
   `index/overview.mjs`, `rules/habits.mjs`, `server/analysis.mjs`, `commands/scan.mjs`, `Overview.tsx`.
2. Redaction: collect labels from all scopes, hash path-like tokens in metric labels/snippets, never hash
   instruction-file names; privacy test with subagent findings — `export/redact.mjs`, `test/export.test.mjs`.
3. Publish `@contextscope/cli@0.10.x` with provenance and make every command string identical (landing, README,
   `#/open` panel) — `packages/cli/package.json`, `app/page.tsx`, `packages/ui/src/screens/Open.tsx`.
4. Forecast only when live; cap far-off forecasts ("not within this session"); show calibration provenance and
   range — `packages/ui/src/screens/Session.tsx`, `ir/finalize.mjs` (add `threshold.basis`).
5. Overview: move "One change to make first" above the sessions table; fix the empty `Evidence:`; fix platform
   follows the majority vendor of the recurrence — `Overview.tsx`, `index/entry.mjs` `rankFirstChange`.
6. Repo root = git top level when inside a work tree — `commands/shared.mjs`.
7. `check` dedupe per (file, cause), vendor tag on findings, "estimated from disk" wording — `commands/check.mjs`.
8. Setup screen: show disk-estimated and observed startup budgets side by side; fix the contradictory empty state
   — `packages/ui/src/screens/Setup.tsx`, `setup/budget.mjs`.
9. Number formatting: three significant digits everywhere (`~1,739,210 tok` → `~1.7M`), drop `LEVERAGE 21` from
   the card (ADR-001 §6.3: no scores) — `packages/ui/src/format.ts`, `Findings.tsx`.
10. Session names: `<repo> · <first user turn size>… ` is not available (no text), so use `<started> · <model> ·
    <short id>` and the branch when present; Codex children named `<agentType> child of <parent short id>` —
    `Overview.tsx`, `index/reader.mjs` `toOverviewRun`.
11. H-01 tool mapping (`exec`+`web__*` → web rule, `tool_call` groups) and starved-rule notes ("needs 6 sessions,
    you have 3") in `/habits`, scan and the Findings habit chip — `rules/H-01.mjs`, `rules/habits.mjs`.
12. Hooks: guarantee line first, project-scope warning, `.contextscope-bak` name, capture pruning, one
    install-and-run verification on CLI 2.1.258 recorded in the cycle log — `commands/hooks.mjs`,
    `capture/install.mjs`, `capture/template.mjs`.
13. Overview "Fattest handoffs": peak and ratio next to the handoff — `Overview.tsx`, `index/overview.mjs`.
14. Session page scroll: ledger must not trap the wheel when at its end; remove the blank tail region on `End` —
    `Session.tsx`, `styles/*.css`.
15. Add `.github/workflows/contextscope-check.yml` running `check --github` on this repo; scope from the URL
    re-read on `hashchange` — root repo, `Overview.tsx`.

## 8. Cycle 3 candidates (ranked)

1. **Before/after for an applied fix.** The research north star is the validated improvement rate, and the
   cheapest honest step toward it is observational: anchor on `trends.instructionEdits` (already computed) and
   show, per instruction-file edit, findings per session and startup H0 before vs after with the CLI-version and
   model confound H-05 already applies. One screen (`#/change/:path`) and one `scan --since-edit` line:
   "after `CLAUDE.md` (Sep 2): B-02 in 0 of 4 sessions (was 7 of 9); startup base −1.2k". This turns "Fix one
   thing, then re-scan" on the landing into something the product actually shows.
2. **Attribution of temp-dir sessions by instruction-block hash + branch.** 58 of 250 entries here are unattributable
   and they are the bulk of one user's work; matching the request-0 instruction hash to the repo's file hash is
   deterministic and unlocks habits and trends where they are starved today.
3. **Experiment flow (baseline vs candidate on a repeatable task).** `contextscope experiment --task <manifest>
   --baseline <ref> --candidate <ref> --runs 3` drives the vendor CLI headless, records both sets under a tag,
   and reports processed tokens, peak, compactions, findings and a deterministic grader (tests pass/fail) with
   the delta and repetitions. This is Study 3 of the validation plan; it needs 1 and a task manifest schema
   first, and it is the only feature that can retire a rule family on evidence.
4. **Per-tool cost breakdown.** Processed tokens attributable per tool via block presence windows (the sweep line
   already exists): "Bash results cost 41 % of processed input in this repo". Feeds H-01 and the experiment
   report; no new data.
5. **Apply-fix with preview and rollback** for instruction-file snippets only (append a line, show the diff,
   keep a `.bak`, `contextscope undo`); the hook installer's diff/backup/confirm machinery is reusable. Paired
   with 1 it closes the loop; without 1 it is a text editor.
6. **npm publish with provenance + GitHub Action** as a first-class deliverable (the fix wave publishes; cycle 3
   adds the `uses: contextscope/check-action@v1` wrapper, a badge, and `check --baseline` to fail only on
   regressions against a committed report).
7. **First-run onboarding**: after the consent screen, a one-card state machine — "indexing 250 files… 3 sessions
   in this repo; habits need 3; hooks not installed (why/how)" — and the `hooks install` offer in-product.
8. **Status line** (`contextscope statusline`, 64 KB tail read) — only after the forecast has been used live for
   a cycle; it duplicates a native number until then.

Deferred again, with reasons: Gemini adapter (no local corpus; `detected: false` here), shareable team reports
(export + `#/open` already cover the PR case; team reports need a population we cannot attribute yet), model-switch
analytics (the cache split already marks switches; no decision attached), "explain this request" drill-down (the
ledger row expansion is that; polish, not a feature).

## 9. Risks

- **Index growth.** 109 MB for 250 files (1.1 GB of transcripts); the manifest is 1.08 MB and is read on every
  request. Per-scope JSON and the 200 MB run cache are fine, but the manifest will cross the point where the
  overview's "manifest only" promise costs >100 ms around 2,000 entries. Split the manifest by vendor/month or
  keep an in-memory projection refreshed on pass end.
- **Watcher.** `fs.watch` recursive on `~/.claude/projects` (984 MB, 83 dirs) is cheap here; on Linux the
  fallback polls every 5 s over the active set. Measured idle CPU 0.0 %; the risk is EMFILE on homes with
  thousands of project dirs — log the fallback and expose it in the rail.
- **Hook trust.** We ask users to let a script run on six Claude events. Fail-open, whitelist and 0600 files are
  right; the residual risk is a vendor field rename that silently drops coverage, and a project-scope install
  that commits our hook into someone else's repo. Both are wording and defaults (fix wave 12).
- **Export leakage.** Proven today: paths in findings prose survive `--redact-labels`. Until fix wave 2 lands,
  the README must not call the redacted export safe to leave the team.
- **Docs drift.** Already visible: `npx contextscope` vs `npx @contextscope/cli@latest`; capture per-session vs
  per-day; backup name; 120 s vs 3 min idle; `observed.vendor` threshold promised vs `estimated.local` shipped;
  the landing claims about the overview. ADR-003 was a good plan; the README is now the contract, and each
  fix-wave PR must touch the README line it changes or state that none exists.
- **Thin populations.** The product's leverage (habits, trends, before/after) needs ≥ 3–10 sessions per repo and
  most repos on this machine have 1–3. Without candidate 2 (attribution) and honest starved-rule notes, a new
  user sees an empty habits chip and a decorative trends panel and concludes the product has nothing to say.

## Consequences

- "Session" means top-level run everywhere; every number that says "sessions" will drop for Codex-heavy repos.
  That is the correction. The README and the scan header say so.
- Redacted exports are not shareable outside the team until fix wave 2 ships; the README's sentence is softened
  until then.
- The forecast becomes a live-only affordance with a bounded claim; the calibration's five events are visible.
- The next cycle stops adding evidence sources and starts proving that a recommendation changed something —
  observationally first (before/after per edit), experimentally second.
