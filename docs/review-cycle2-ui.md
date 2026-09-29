# ContextScope UI review, cycle 2

Scope: `packages/ui/src/**`, `packages/ui/dev/*`, `scripts/sync-ui.mjs`, root `app/`, `tests/*.mjs`, `README.md`,
checked against ADR-003 §1–5, ADR-001 §2/§6, `docs/review-cycle1-ui.md` (regressions) and `packages/cli/src/ir/types.ts`.
Method: full source read; `tsc --noEmit` (clean) and `npm run build` in `packages/ui`; root `npm run sync-ui`, `npm run build`,
`node --test tests/*.test.mjs` (5/5 green); live reproduction in Chrome against (1) the fixture dev server (`npm run dev`, port 4177),
(2) the hosted demo served statically from `public/` (`python3 -m http.server 4190 -d public`, `/app/index.html?demo=1#/`),
(3) the built site (`vinext start`, port 4310), and (4) a scratchpad harness that replays the companion's live protocol
(`r2-live-server.mjs`: run truncated to 300 requests, `live` SSE every 4 s, `/tail?after=&sig=`, a forced `rebased: true` on
event 6, `live-idle` after 9; the dev server has no live routes, see #39). The export under test is the real
`claude:cc87cfe5…` main scope (`contextscope export --scopes main --redact-labels`, 2.6 MB, 1,365 requests, 5,384 blocks,
17 scopes in the shell, forecast present). No repository files were modified; `packages/cli/ui` was rebuilt by `npm run build`
(same sources, same output).

Paths below are relative to `packages/ui/src/` unless they start with `app/`, `tests/`, `scripts/`, `dev/` or `packages/cli/`.
Severity: **High** = wrong or broken for a real user path; **Medium** = wrong output, ADR deviation or a11y failure;
**Low** = polish / hygiene.

Measured facts. Bundle: `app.js` 42.8 KB (14.2 KB gz) + shared `chunk-3HCH52YS` 62.0 KB (22.2 gz) + `chunk-Q6G3SCYU` (Table) 5.5 KB +
`chunk-5PNYMJFE` 2.1 KB load on first paint = **112 KB raw / 40 KB gz**; `chunk-GUHQGECL` (Session) 60.5 KB (19.9 gz) and
`chunk-P2FV3EOQ` (Setup) 15.5 KB (4.4 gz) load on demand; `app.css` 46.6 KB (9.6 gz). Total 188 KB raw / 64 KB gz against
cycle 1's 136 KB / 43 KB single file; first paint is 18 % smaller than cycle 1 because Session and Setup are split.
Demo dataset 4.9 MB (13 runs, largest run file 967 KB). `documentElement.scrollWidth == clientWidth` on every screen at 1440 px;
Session at 800 px overflows by 8 px (see #4). "Render" (the app's own figure) 983 ms on the 400-request fixture, 1,005 ms on the
1,365-request export in the automation tab. No console errors on any flow except the deliberate crash in #1.

Live harness timeline (all verified in the DOM, not the log): 300 → 315 → 325 requests appended in place (`main · N req`, ledger
"N of N", chart domain and tiles updated), "Following" kept the keyboard cursor on the newest row and scrolled the ledger,
`p` pinned request 324 and turned the toggle to "Follow newest", the forced `rebased: true` reloaded the run (330) with the pin
intact, appends resumed (345), `live-idle` removed the badge and the toggle and switched the forecast card to "not live".
Exactly one `/tail` per event with the right `after` and a matching signature (`8c8e56cdec3b7f2f` on both sides); a tail carrying
458 `closed` blocks and 1 compaction applied without error. Killing the harness turned the pill to "companion offline" within 5 s;
restarting it reconnected (retry 2 s), the pill went back to idle and appends continued with no error toast.

---

## Top 10

### 1. High — a schema-valid but hollow export passes the importer and crashes the session screen
**Where:** `api.ts:240-280` (`validateExportDocument`), `screens/Session.tsx:198-200` (`scopeStats` reads `run.coverage.estimatorErrorMedian`), `screens/Open.tsx:41-55`.
**Scenario (reproduced):** drop `{ schema: "contextscope.export/1", …, run: { id, vendor, project, scopes: [{id:"main",kind:"main"}], summary:{requests,peak}, window, findings: [] }, scopes: { main: { id, requests: [], blocks: [] } }, thresholds: {}, markdown: "" }`.
The validator accepts it (no `coverage`, `startedAt`, `summary.models`, `scopes[].peak/compactions`, `activeMs`, `source`), the toast says
"Opened … 1 requests · peak 1 tokens", the route switches to the session and the error boundary shows "Something broke in the UI:
Cannot read properties of undefined (reading 'estimatorErrorMedian')" (console: `ContextScope UI error TypeError … at chunk-GUHQGECL.js`). The only way out is
"Back to the overview", which then shows a one-row overview for the broken document.
**Fix:** mirror `packages/cli/src/export/schema.mjs` fully: require `run.coverage` (with the two estimator numbers), `startedAt`/`endedAt`,
`activeMs`, `source`, `summary.models[]`, `summary.compositionAtPeak`, and for every full scope `peak`, `compactions[]`, `models[]`,
`processedInputTokens`; check `scopes[0].kind === "main"` *and* that the main scope in `scopes` carries ≥ 1 request or say so.
Defensively, `scopeStats` should read `run.coverage?.…` and the Open screen should validate by rendering nothing until a smoke render
succeeds (try/catch around `overviewFromExport`).

### 2. High — switching backends never re-subscribes the index events; Refresh sticks on "indexing" for 120 s
**Where:** `api.ts:488-502` (`loadExport` / `unloadExport` replace `active` only), `store.ts:84-112` (`startIndexEvents` runs once from `main.tsx:237`),
`api.ts:159-175` (`localEvents` is a per-backend-instance listener list), `store.ts:128-145` (`refreshIndex` relies on a `done` event, 120 s timeout).
**Scenario (reproduced twice):** open an export in the demo, press the refresh icon: pill → "indexing", button disabled, toast
"Re-indexing sessions"; nothing ever arrives because the `done` is emitted to the *old* static backend's listeners. Click "Back to the demo"
and refresh again: same, because `unloadExport` creates a *new* static backend whose `localEvents` has no subscriber. After 120 s a
"No completion event from the companion" error toast appears. The same happens from a companion start after opening and closing an export.
**Fix:** make `loadExport`/`unloadExport` call `startIndexEvents()` (export it from store or emit a `backendChanged` signal that `App`
effects on), or keep one shared `localEvents` hub for all file-backed backends; while at it, let `noteIndexFromOverview` reset `files`.

### 3. High — the error boundary sends users to the Claude Code issue tracker
**Where:** `main.tsx:209` (`href="https://github.com/anthropics/claude-code/issues"`).
**Scenario:** every UI crash (including #1) shows "File an issue" pointing at an unrelated project; `tests/rendered-html.test.mjs:54`
forbids invented repository URLs on the landing, but the app ships one.
**Fix:** link to a ContextScope address once one exists; until then drop the link and keep the "Details" stack (already present).

### 4. Medium-High — Session overflows horizontally below ~900 px again (cycle-1 #1, partial regression)
**Where:** `theme.css:120` (`.panel-actions` never wraps), `charts/Lanes.tsx:133-136` + `theme.css:429` (`.cs-lane-text` is `position:absolute; white-space:nowrap`, its `maxWidth` is set but nothing clips the badges and the `open ›` link), `screens/Session.tsx:276-279` (the overflow assertion is `DEV`-only).
**Scenario (measured at 800 px in an iframe; `resize_window` was ignored by the OS):** `scrollWidth 793 > clientWidth 785`; the widest
offenders are `.panel-actions` of the occupancy panel (764 px, right edge 793) and lane labels reaching x = 917. Because `body { overflow-x: hidden }`
is gone (cycle-1 fix) the wheel still scrolls, but the page gets a horizontal scrollbar and the right edge of the panel header is cut.
The Overview and Findings stay within width (their tables scroll inside `.table-wrap`).
**Fix:** `.panel-actions { flex-wrap: wrap; min-width: 0; justify-content: flex-end }`; give `.cs-lane-text` `overflow: hidden; text-overflow: ellipsis`
(the `<a>` stays reachable) or hide badges under `dense`; keep the `scrollWidth <= clientWidth` check as a `console.warn` in production too.

### 5. Medium — Overview keeps showing "live" after `live-idle` (and live rows do not sort first)
**Where:** `screens/Overview.tsx:170` (`live.get(r.id) ?? r.live`), `store.ts:165-168` (idle deletes the map entry), `components/LiveBadge.tsx:9,23` (5-minute stale guard), `screens/Overview.tsx:314` (`defaultSort started desc`).
**Scenario (reproduced with the harness, `IDLE_AFTER=2`):** the row's badge appears from the payload's `live` marker; the watcher's `live-idle`
arrives 6 s later, the map entry is removed, and the badge stays because the fallback is the marker fetched at load time. It clears only after
`STALE_MS` (5 min) or an index-driven refetch. ADR-003 §3 also says "live rows sort first by default"; they sort by start time.
**Fix:** keep a `liveIdle: Set<runId>` (or a `liveSeen` map with idle timestamps) in the store and let `liveDot` prefer it over `r.live`;
or bump a `liveVersion` on `live-idle` that the overview uses to refetch. Add `live` as the first key of the default comparator.

### 6. Medium — the cycle-2 surfaces have no fixture or demo coverage; `excluded` is never rendered
**Where:** `dev/make-fixtures.mjs:318-349` (overview without `scope`, `live`, `sessions/peakShareMedian/startupH0Median/instructionEdits`), `:353-398` (setup without `excluded`), `:588` (demo findings: no `scope: "habit"`), `dev/demo-runs.mjs` (no `forecast`, no `tool.partial`), `dev/validate-fixtures.mjs:22` (`SCOPES` rejects `"habit"`), `screens/Setup.tsx` (no reference to `excluded`; `types.ts:298`), `dev/server.mjs` (no `/tail`, `/habits`, no `live` events).
**Scenario:** the habit chip (`Findings.tsx:14`) yields "No findings match" on both datasets; the overview `LiveBadge`, the follow toggle,
the forecast card and threshold line cannot be seen without a real companion; the demo's Trends panel works only because `--demo` adds the
series; the Setup screen silently drops the `excluded` list the inventory now produces (the reviewer asked to check it: there is nothing to check).
**Fix:** generate one `live` row + `forecast` on the newest run, three H-0x findings with `sessions`, and `excluded: [{ path, reason: "fixture" }]`
in both datasets; render "Excluded from the budget: N fixture files" (collapsible list) under Instruction files; extend the validator
(`SCOPES` + `habit`, `live`, `forecast`, `excluded`, `trends.sessions[]`); add `--live` to `dev/server.mjs` (the scratchpad harness is ~120 lines).

### 7. Medium — the demo's "All projects" is a fiction
**Where:** `api.ts:438-442` (`answerLocally` only flips `scope.mode`), `screens/Overview.tsx:112-115,213,300-304,346-350`.
**Scenario (reproduced):** on the demo, "All projects" shows the *same 13 rows* and totals, hides the Trends panel, switches the range to
"last 30 days", and the population line still says "13 sessions in this repo · 166 on this machine · 4 unattributed" — the reader is told
153 other sessions exist and sees none of them.
**Fix:** in static/memory mode either disable the toggle with a title ("the demo carries one repository") or ship `overview-all.json`
from `make-fixtures --demo` and serve it from `createStaticBackend` when `scope === "all"`.

### 8. Medium — the range selector silently changes when the scope toggles
**Where:** `screens/Overview.tsx:43-46,363` (`null` = "the companion's default", which is `all` for repo and `30d` for all-projects).
**Scenario (reproduced):** pick "30d" in All projects (stored as `null` because it is the default there), click "This repo": the pressed
button jumps to "all" and the table widens to all time without a click on the range control; the reverse loses "all" when going to All projects.
**Fix:** store the explicit choice (`RangeMode | null` where `null` only means "never chosen") and re-derive the query per scope; or always
send `since` and stop treating the default as absence.

### 9. Medium — Trends draws four flat zero lines when the companion sends no cycle-2 series
**Where:** `components/TrendsPanel.tsx:104,112,114` (`?? days.map(() => 0)`), `:48` (only `n < 2` shows "Not enough days yet").
**Scenario (reproduced on the fixture server, which mirrors a cycle-1 companion):** "Trends · 30 days · 0 sessions" with headline values
"0", "0%", "0.0", "0 tok" and `observed · vendor` badges on numbers that were never observed.
**Fix:** when `trends.sessions`/`peakShareMedian`/`startupH0Median` are absent render one line "This companion does not report per-repo
trends yet (update with `npx contextscope@latest`)"; when present but all zero say "No sessions ended in this range".

### 10. Medium — static/memory-mode copy claims things that did not happen
**Where:** `api.ts:161` + `store.ts:104` (pill "indexed · just now · 166 files" on a static file), `store.ts:132` ("Re-indexing sessions"),
`screens/Findings.tsx:178,160` ("Saving writes `~/.contextscope/thresholds.json` and re-runs the rules", toast "rules re-run") vs `api.ts:177-190`
(`localThresholds.save` patches memory; ADR-003 §4: no client-side rule engine), `main.tsx:191` ("Back to the demo" also when the page started
in companion mode; `api.ts:498-502` restores the companion).
**Fix:** read `backend.value.mode` in those four places: pill "demo dataset" / "export · <file>", refresh → "Reloaded the demo files",
drawer subtitle "In the demo, thresholds only change the 'fires above' line; rules do not re-run", banner button "Back to your sessions".

---

## Remaining findings (11–40)

### 11. Medium — Findings instances are labelled with eight hex characters
**Where:** `screens/Findings.tsx:106` (no `runLabel`), `components/FindingGroup.tsx:27-31`. Overview passes project names; Findings shows
"00000007", "00000003" (verified on both datasets). **Fix:** fetch `/overview?limit=…` once per screen (or have `/findings` attach
`project.displayName`/`startedAt` per instance) and pass `runLabel`; include the start date.

### 12. Medium — two fetches bypass `fetchJson`: no 30 s timeout, no gzip/JSON error mapping
**Where:** `screens/Overview.tsx:91-107` (`fetchOverview`), `store.ts:214-228` (`fetchTail`). A hung companion leaves the overview on
"Loading overview" forever (cycle-1 #36 regressed for the most-visited screen). **Fix:** add `scope` to `OverviewParams` (the companion
already takes it, `api.ts:123-129`) and a `tail()` method on `Backend`; route both through `fetchJson`.

### 13. Medium — type drift between `types.ts`, the API and the UI
**Where:** `packages/cli/src/ir/types.ts:322` (`Overview.index` has no `files/indexed/runsInRange/lastPass`), `screens/Overview.tsx:23-26,122,145,339`
(`IndexInfo` cast), `api.ts:353` (`as Overview["index"]`), `dev/validate-fixtures.mjs:114-117` (validates the undeclared shape),
`findings.ts:28` (casts `sessions` although `Finding.sessions` exists), `screens/Session.tsx:72` (re-declares `RunTail` inline instead of importing it),
`api.ts:397` (`as unknown as AgentScope` for summaries), `api.ts:340` (`s.handoff!`), `components/FindingCard.tsx:107` (`current!`),
`main.tsx:22-23` (`ComponentType<any>`). **Fix:** update `Overview.index` and make `AgentScope.requests/blocks` optional on summaries
(ADR-002 C), then delete the casts; `tsc` is clean so this is hygiene, but the cast in Overview hides real shape errors.

### 14. Medium — TrendsPanel a11y: chattering tooltip, hover-only data
**Where:** `components/TrendsPanel.tsx:85` (`role="status"` on the hover tooltip announces every mouse move — the pattern cycle-1 #31 removed
from `charts/Tooltip.tsx`), `:67` (`onMouseMove` only: no touch, no keyboard), `:67-68` (the accessible text carries only the latest value).
**Fix:** `role="tooltip" aria-hidden`; add a visually-hidden `<table>` (day, value) per chart or arrow-key navigation over days.

### 15. Medium — landing footer dead links
**Where:** `app/page.tsx:147-148` (`<a href="#" aria-disabled="true">`), `app/globals.css:82` (`pointer-events: none`). Still keyboard
focusable, activate to `#`, and announced as links. **Fix:** `<span>` with the "coming soon" tag; keep the test's "labelled, not faked" intent.

### 16. Medium-Low — the landing is not static and the OG URL trusts the Host header
**Where:** `app/layout.tsx:13-16` (`headers()` → `x-forwarded-host`/`host` → `og:image`; vinext reports "Some routes could not be classified").
ADR-003 §4 calls the landing "server-rendered, static"; the rendered `og:image` on a local run is `https://127.0.0.1:4310/og.png`.
**Fix:** `metadataBase: new URL(process.env.SITE_URL ?? "https://…")` in a static `metadata` export; drop `next/headers`.

### 17. Low-Medium — rail stat tiles wrap their value
**Where:** `theme.css:494` (`.cs-stats` two columns in a 300 px rail), `:132` (30 px value). "1,817 / 23" and "463 / 55" render on two lines
(seen on the export and the harness). **Fix:** `font-size: clamp(20px, 2vw, 30px)` in the rail or a single column when the value is > 6 characters.

### 18. Low-Medium — the demo banner costs 113 px on narrow screens
**Where:** `styles/open.css:2-10`. At 800 px the banner wraps to three lines above every screen. **Fix:** below 900 px show only
"Demo data · nothing leaves the browser" with the command in a `title`.

### 19. Low-Medium — repo-mode "Session" column is labelled by model name
**Where:** `screens/Overview.tsx:174,177`. Twelve rows read "claude-sonnet-4-5" with the id underneath; sorting the column sorts by time.
**Fix:** primary label = `formatDate(startedAt)` + branch (`gitBranch` is in the run, not the row: add it to `OverviewRun`), model in the sub-line.

### 20. Low-Medium — Export scope choice is a silent heuristic
**Where:** `screens/Session.tsx:463` (`run.scopes.length <= 8 ? "all" : "main"`). Only the button's `title` reveals which scopes the file
will hold. **Fix:** a small `<select>` (main / all scopes / this scope) next to "redact".

### 21. Low-Medium — dropping a file anywhere but `#/open` navigates the tab away
**Where:** `screens/Open.tsx:63-70` (window handlers mount only on the Open screen); `main.tsx` has no `dragover`/`drop` guard.
Dropping an export on the overview opens the JSON in the tab and loses the `?token=` URL. **Fix:** a global guard in `App` that
`preventDefault`s and navigates to `#/open` (then hands the file over via a signal).

### 22. Low — the privacy reason is hidden behind structural errors
**Where:** `api.ts:242` (12-message cap), `:275-278` (forbidden keys / absolute paths are checked last). For a pasted transcript the message lists
twelve shape errors and never says "carries content keys" (verified). **Fix:** run the privacy checks first and always keep them in the list.

### 23. Low — `ABSOLUTE_PATH` misses single-segment paths
**Where:** `api.ts:25` (`^(?:\/(?:[A-Za-z0-9._@-]+\/)+|[A-Za-z]:\\)/m`). `/tmp`, `/etc`, `/Users` without a trailing slash pass; the `m` flag
also fires on any line of a multi-line `fix.snippet` (`sed -n 1,120p /…`). **Fix:** `^\/[A-Za-z0-9._@-]+(?:\/|$)` per string, without `m`,
matching `packages/cli/src/export/schema.mjs`.

### 24. Low — IndexPill in static/memory mode says "indexed · just now"
**Where:** `main.tsx:99-108`, `api.ts:161`, `store.ts:104`. See #10; listed separately because it is visible on every screen of the hosted demo.

### 25. Low — "Nothing matches" tells the user to press Esc when no text filter is set
**Where:** `screens/Findings.tsx:100`. With `?scope=habit` and an empty query the copy is "Clear the filter (Esc) or pick another scope".
**Fix:** branch on `query` vs `scope`/`vendor`; for `habit` explain the minimum population (`habitMinSessions = 3`, ADR-003 §2).

### 26. Low — `rangeText` ignores `since` when `range` is absent
**Where:** `screens/Overview.tsx:70-76`, `dev/make-fixtures.mjs:572` (`since` set, `range` not). The demo says "all time" while `since` is 30 days ago.
**Fix:** derive from `since` when `range` is missing; make the companion always send `range`.

### 27. Low — the live badge lives inside the `<h1>`
**Where:** `screens/Session.tsx:458`. The heading's accessible name becomes "contextscope · claude · … live · updated 3 s ago" and changes every
5 s (`useTick(5_000)`). **Fix:** render the badge as a sibling of the `h1` (same row, `aria-live="off"` already).

### 28. Low — every 20th live event drops the child-scope cache
**Where:** `screens/Session.tsx:145,154` (`cache.current = new Map()` before `reload()`). A user on a child scope re-downloads it on every
forced reload although only the main scope grew. **Fix:** invalidate only the scope named by the event (or all scopes only on `rebased`).

### 29. Low — the tail signature has no cross-package test
**Where:** `store.ts:185-208` vs `packages/cli/src/server/routes/runs.mjs:16-32` ("keep in sync"). The harness confirmed they agree today
on `run-sample.json`; a drift (e.g. rounding of `composition`) would turn every tail into a `rebased` reload silently. **Fix:** a test in
`packages/ui/test/` that runs both over the fixture and compares (`crypto.subtle` exists in Node 20).

### 30. Low — bundle growth is in the shared chunk
**Where:** `build.mjs` (splitting on), `api.ts` (memory backend + validator + client export ≈ 9 KB minified in the shared chunk, needed only on
`#/open`). First paint is smaller than cycle 1 (112 vs 136 KB raw) but total shipped grew 38 %. **Fix (optional):** lazy-load `createMemoryBackend`,
`validateExportDocument`, `overviewFromExport` and `buildClientExport` from the Open screen; keep `Backend` and `loadExport` in the core.

### 31. Low — `LiveBadge` stale guard (5 min) vs watcher idle (3 min)
**Where:** `components/LiveBadge.tsx:9` (`STALE_MS = 5 * 60_000`), `packages/cli/src/index/watch.mjs:42` (`idleMs: 3 * 60_000`). After a dropped
stream a session header can claim "live · updated 4 min ago" for two minutes beyond the watcher's own definition. **Fix:** `STALE_MS = 3 min`
and expose it from one constant the CLI also serves (e.g. in the `state` SSE event).

### 32. Low — landing screenshots exceed the ADR budget
**Where:** `tests/demo-assets.test.mjs:15` (400 KB), `public/screens/*.png` (226–304 KB; ADR-003 §4 says ≤ 200 KB each). The images are current
(the demo's 768-request run, the 13-session overview, the grouped findings) and the captions' numbers match the dataset. **Fix:** re-encode
at 1280 px wide / 80 % or WebP with a PNG fallback; tighten the test to 200 KB.

### 33. Low — `FollowToggle` drops the user's zoom
**Where:** `session-state.ts:90-95` (`resumeFollow` clears `brushRange`), `screens/Session.tsx:509`. "Follow newest" is documented as "jump to the
newest request and keep following"; losing a manual zoom is a surprise. **Fix:** keep the range and extend its upper bound as the tail grows.

### 34. Low — Open screen parses on the main thread
**Where:** `screens/Open.tsx:19-26,44-46`, `api.ts:302-310`. 2.6 MB parsed and rendered in ≈ 1 s; a 50 MB file (the accepted maximum) will freeze the
tab for several seconds with the "Reading …" label frozen too. **Fix:** parse in a `Worker` or at least `await` a frame between read and parse.

### 35. Low — the keyboard map does not mention live mode
**Where:** `components/KeyboardMap.tsx:5-19`, `screens/Session.tsx:506-513`. The Follow toggle is mouse-only (no key); `Esc` unpins but does not
resume following. **Fix:** `f` = follow newest (and document it), `Esc` after unpin resumes following when the run is live.

### 36. Low — `ExportControl` / `downloadJson` in static mode
**Where:** `api.ts:228-233,395-403`. The client-side export (used by the demo) writes `generator: { name: "@contextscope/ui", version: "browser" }`
and `markdown: ""`; when such a file is reopened `describe()` and the banner work, but `--md`-style consumers get an empty summary.
The button is hidden in the demo (`isCompanion()`, `Session.tsx:463`) so the path is dead today. **Fix:** delete `buildClientExport` and
`exportRun` from the static backend, or show the Export button in the demo too (it is the one flow that proves "the demo is the same UI").

### 37. Low — `answerLocally` swallows `AbortError` inconsistently
**Where:** `api.ts:459-462` (rethrows aborts, maps everything else to 502). A real `TypeError` inside a backend (like #1) becomes a 502 JSON body for
`fetch()` callers but an exception for `api.*` callers. Fine for now; note it when adding backends.

### 38. Low — `OverviewRun.live` marker is applied only after fetch
**Where:** `screens/Overview.tsx:116,170`. A `live` SSE event for a run outside the current `limit=200` page is invisible; the ADR's "row goes Live"
holds only for listed rows. Acceptable; document it.

### 39. Low — the dev server cannot exercise live mode
**Where:** `dev/server.mjs:6-15` (routes list). No `/tail`, `/habits`, no `live`/`live-idle` events, no `rebased` path — the most delicate cycle-2
code (`Session.tsx:133-176`, `store.ts:147-228`) has no reproducible bench. **Fix:** port the scratchpad harness (`--live` flag: truncate the sample,
emit `live` every N s, serve `/tail` with signature check, force one `rebased`, send `live-idle`).

### 40. Info — what was verified and did not regress
Wheel scrolling and `scrollWidth == clientWidth` on Overview, Session, Findings, Setup, Open at 1440 px (fixture, demo, export);
grouped findings everywhere (fixture 14 groups / 20 findings client-side; demo 12 / 38 from the API `groups`, `firstChange.removes` rendered);
the error boundary is keyed per route, shows the message, a `Details` stack and Reload (#1 exercised it); hover/pin/focus reads stay at the leaves
(`SessionBody` reads none of them); `j`×5 + `p` pins request 4, `?` opens the map, `Esc` closes it without unpinning, `t` toggles theme and the
dark palette holds on every new component (banner, dropzone, trends, live badge, forecast card, threshold line); the thresholds drawer sets `inert`
on `#app` and closes on `Esc`; `Escape` precedence, `c` without focus toasts; export button present in companion mode and hidden in the demo;
`/open` refuses non-JSON, wrong schema, arrays, content keys and absolute paths with readable messages and `role="alert"`; the real export opens
with the forecast card marked "not live", the observed threshold line and 17 scopes; landing copy is honest (no scores, no invented numbers,
demo and export links resolve, "coming soon" labelled), `og:image` and the three screenshots exist and are current.

---

## Notes for the fix stream

1. #1 and #2 are one afternoon and both are on the public demo path ("Open an export"); #3 is a one-line delete.
2. #6 unblocks review of the habit chip, `excluded` and live UI next cycle; without it those features stay unverifiable.
3. The `Backend` interface (`api.ts:66-77`) is the right seam: give it `tail()` and `overview({ scope })`, and #12, #7 and #10 become
   mode-aware in one place.
4. Screenshots from this review (scratchpad, not committed): `r2-shots/session-live-harness.jpg`, `r2-shots/demo-overview.jpg`,
   `r2-shots/export-opened-memory-mode.jpg`, `r2-shots/open-error-state.jpg`, `r2-shots/session-800px-overflow.jpg`, `r2-shots/landing.jpg`
   under `/private/tmp/claude-501/-Users-pat-lewczuk-projects-context-viewer/bc832fa8-7fef-4b4c-9969-29559e2fa929/scratchpad/`;
   the live harness is `r2-live-server.mjs` in the same directory.
