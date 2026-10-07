# ContextScope UI review, cycle 1

Scope: `packages/ui/src/**`, `packages/ui/dev/*`, checked against ADR-001 sections 2 and 6 and `packages/cli/src/ir/types.ts`.
Method: full source read; `tsc --noEmit` (clean); esbuild metafile; and a live reproduction in Chrome against
(1) the 400-request dev fixture and (2) the real 23 MB run `claude:5ca0d315…` (168 scopes, 1,573 main requests,
13,332 requests / 39,717 blocks in total, peak 989,929 vs window 1.0M, estimator p95 0.899) served read-only through a
scratchpad copy of `dev/server.mjs`. No repository files were modified; the built bundle in `packages/cli/ui` was not touched.

Severity scale: **Critical** = screen unusable on real data; **High** = core interaction broken or a11y blocker;
**Medium** = wrong output, regression risk, or WCAG AA failure; **Low** = polish / hygiene.

Measured facts on the real run (single-column layout, 760 px viewport): document height **211,360 px**, of which the
"Session findings" panel is **201,158 px** (378 `FindingCard`s: B-01 x236, B-15 x81, B-03 x42, B-05 x8, B-04 x4, B-02 x3,
B-08 x2, B-11, B-13), the occupancy panel is 7,669 px (167 lanes = 6,688 px), 18,880 DOM nodes, first render 902 ms
(the app's own `Render` figure), y-axis ticks `0 / 500k / 1.0M / 1.5M / 2.0M`, root `scrollWidth` 750 vs `clientWidth` 745.

---

## Ranked findings

### 1. Critical — mouse wheel does not scroll the session page (bug a, part 1)
**Where:** `charts/hooks.ts:4-16` (`useWidth`), `screens/Session.tsx:92,166` (measures `.cs-main`), `screens/Session.tsx:198-214`
(every chart gets `width={width}`), `theme.css:103` (`.panel-body { padding: 14px 16px }`), `theme.css:45` (`body { overflow-x: hidden }`).
**Root cause (confirmed, not a wheel handler — there is no `wheel` listener anywhere in the bundle):** the SVGs are sized to
the width of `.cs-main`, but they are rendered inside `Panel` whose body has 16 px of horizontal padding, so each chart
overflows its panel by 32 px. In the single-column layout this pushes the document's `scrollWidth` past `clientWidth`
(750 vs 745). With `body { overflow-x: hidden }` propagated to the viewport, Chrome's compositor refuses gesture
(wheel/trackpad) scrolling of the root scroller while programmatic and keyboard scrolling still work — exactly the
"wheel dead everywhere, `End` still jumps" asymmetry reported. Reproduced on the fixture: wheel scrolls Findings but not
Session; hiding all five chart SVGs or clamping their `width` to the panel's inner width restores wheel scrolling
immediately; so does `body { overflow-x: visible }`. A plain 721 px `<div>` in the panel body re-breaks it, proving it is
purely the horizontal overflow. Any other source of horizontal overflow (a long `<option>` in the scope `<select>`, a
compaction label near the right edge with `overflow: visible` on the SVG at `session-styles.ts:46`) triggers the same failure at any width.
**Fix:** (1) remove `overflow-x: hidden` from `body` (`theme.css:45`) — it hides layout bugs and disables compositor scrolling;
(2) measure the chart container, not the column: put the `useWidth` ref on a `div.cs-charts` that wraps the charts inside
the panel body (or subtract the padding), so `width` is the true inner width; (3) give `.cs-chart svg` `max-width: 100%`
as a belt-and-braces guard; (4) add a dev-only assertion that `document.documentElement.scrollWidth <= clientWidth` after render.

### 2. Critical — "Session findings" renders every finding as a full card: 378 cards, 201,158 px (bug a, part 2; bug e)
**Where:** `screens/Session.tsx:247-256` (`findings.map(f => <FindingCard/>)`), `screens/Findings.tsx:46-49,89-93`
(one card per finding under each severity header), `components/FindingCard.tsx:96` (an effect per card).
**Scenario:** the real run carries 378 session findings; the panel becomes 200k px of 385 px cards, so `End` lands the
user in a wall of near-identical "Running hot" / "Repeated fat results" cards far below the charts — the "huge blank area".
The Findings screen will do the same with the 131 B-01 findings for the machine (131 cards + 131 `loadThresholds` effects).
**Fix (both screens):** group by `ruleId`, then by `runId`; render one `RuleGroup` card per rule: severity badge, title,
"236 instances across 1 session", sum of `tokensAffected`, the threshold line with `(edit)`, one `Copy fix` (the fix is
per rule), and the top three instances by `tokensAffected` as compact evidence rows with `Show evidence`; "Show all 236"
expands a virtualised list. Ordering: severity, then Σ `tokensAffected`, then recurrence (ADR 2.4). Keep `FindingCard`
for the single "one change to make first" card. Cap the session panel at the top N groups with a link to
`#/findings?run=` for the rest. Move `loadThresholds()` out of the card into the screen (see #14).

### 3. High — every hover re-renders the whole session tree
**Where:** `screens/Session.tsx:97-99` (`SessionBody` reads `hoveredRequest.value`, `pinnedRequest.value`, `focusedRequest.value`),
`components/Ledger.tsx:81-83` (same), `session-state.ts:66-73` (one signal write per animation frame).
**Scenario:** with signals, reading `.value` inside `SessionBody` subscribes the *root* component; each hover frame re-runs
`SessionBody` and diffs everything under it — 378 finding cards, 167 lanes, heavy-hitters table, rail — 18,880 DOM nodes.
`legendEntries` (`Session.tsx:162`, 16 × `requests.some`) and the StackedArea `aria-label` (`charts/StackedArea.tsx:111`,
`Math.max(...requests.map())`) are recomputed on every frame as well. (A hover timing could not be measured reliably in
the automation tab because it is `visibilityState: hidden`, where rAF is suspended; the code path is unambiguous.)
**Fix:** never read hover/focus/pin signals in `SessionBody`; pass the signals themselves to `StackedArea`, `CacheStrip`,
`Ledger` and the rail's "Pinned request" panel and read `.value` there (or use `useSignal`/`useComputed`); wrap
`Panel` children that do not depend on hover (`Lanes`, heavy hitters, findings, rail facts) in `memo`. Memoise
`legendEntries` on `requests`, and compute peak once (`useMemo`) rather than in the `aria-label`.

### 4. High — the screen fetches and holds the entire 23 MB run; no `?scope=`, no progressive render (bug f)
**Where:** `api.ts:35`, `screens/Session.tsx:52-64`, `packages/cli/src/server/routes.mjs:155-168` (no `scope` query today),
`charts/Lanes.tsx:35` (`child.requests.length`), `screens/Session.tsx:157` (heavy hitters from `scope.blocks`),
`screens/Session.tsx:341-346` (`resolveEvidence` scans every scope's `blocks`).
**Scenario:** 23 MB of JSON parsed on the main thread before anything paints; all 168 scopes' `requests`/`blocks` stay
resident; switching scope re-renders synchronously.
**Fix:**
- API: `GET /api/v1/runs/:vendor/:id?scope=<id>` returns the run with only the selected scope hydrated
  (`requests`, `blocks`, `compactions`); other scopes carry a summary shape. Make `AgentScope.requests` / `blocks` /
  `compactions` optional in `ir/types.ts` and add `requestCount: number` (Lanes needs it for nested mapping) and
  `topBlocks` per scope (heavy hitters). Keep `run.summary`, `coverage`, `window`, `findings`.
- Client: `api.run(vendor, id, scope)`; cache hydrated scopes in a `Map<`${runId}/${scope}`, AgentScope>` so going back to
  `main` is free; `resolveEvidence` for `block` evidence uses the scope prefix in the block id (`main:412`) instead of scanning.
- Progressive render: phase 0 paints header + occupancy + cache strip from `requests`; phase 1 (next idle callback / `setTimeout(0)`)
  mounts Lanes and Ledger; phase 2 mounts findings (grouped, #2). Show a thin "loading lanes…" placeholder per phase.
- Cancel in-flight fetches on navigation (`AbortController` in `api.request`, `useResource`, and the session effect).

### 5. High — subagent lanes are unusable at 167 lanes
**Where:** `charts/Lanes.tsx:64` (`height = rows.length * LANE_H + 8`), `:99` (launch line from `y1={0}` — every lane's
launch line is drawn from the top of the *whole* SVG down to its fill, so 167 vertical lines cross every lane above it),
`:114` (text overlays overlap; right-anchored labels are clipped at the left edge, seen as "d · vendor 4 req · open"),
`:92` (`tabIndex={0}` on 167 `<g>`), `:107` + `:121` (`aria-hidden="true"` list containing focusable `<a>` links).
**Scenario:** 6,688 px of orange vertical lines with overlapping labels; 334 tab stops before the ledger; focusable content
hidden from assistive tech (WCAG 4.1.2 / 1.3.1 violation).
**Fix:** draw the launch tick only within the lane (`y1 = top`); virtualise lanes by `scrollY` (render only the ~30 in view,
same spacer technique as the ledger) or cap at the top 20 by peak with "show all"; collapse depth ≥ 2 by default;
give the lane text a fixed column instead of flowing from `x0` when lanes are dense; move the `open ›` link out of the
`aria-hidden` overlay or drop `aria-hidden` and make the `<g>` non-focusable (one tab stop per lane, on the link).

### 6. High — the brush cannot create a selection by dragging when there is no range
**Where:** `charts/Brush.tsx:38,79` (`shown = preview ?? range ?? [0, n-1]`; the `.cs-brush-sel` rect spanning the full width is
drawn on top of the background rect and carries `onPointerDown={onDown("move")}`).
**Scenario (reproduced on the real run):** dragging from x=200 to x=450 across the brush leaves "1573 of 1573 requests",
no range label — the drag is interpreted as *moving* the full-width selection, which clamps to `[0, n-1]` and emits `null`.
Only the 8 px handles at the extreme edges start a resize. ADR 2.2 "drag to select a request range" is not achievable.
**Fix:** when `range === null && !preview`, render the selection rect with `pointer-events: none` (or not at all) so the
background's `onDown("new")` receives the pointer; keep the handles. Also add a keyboard path (#26).

### 7. High — session `Enter` binding blocks every button and link on the screen
**Where:** `screens/Session.tsx:131` (`case "Enter": … e.preventDefault()`), `:114-142` (handler ignores `e.defaultPrevented`
and open dialogs).
**Scenario (reproduced):** with any request focused/pinned/hovered (`cur !== null`), Tab to "Copy fix" and press Enter:
the button does not fire (no toast) and ledger row 0 expands instead. Same for legend buttons, `Show evidence`, rail
buttons, lane links (whose own `onKeyDown` runs, then the window handler expands a row on top).
**Fix:** only handle `Enter` when the focus is on the body / the ledger wrapper (`document.activeElement === document.body
|| activeElement.closest(".cs-ledger")`); return early when `e.defaultPrevented` or `keyboardMapOpen.value ||
thresholdsDrawerOpen.value`; mirror the same guards in `Table.tsx:123-126`.

### 8. Medium-High — occupancy y-domain rounds up to 2.0M when peak ≈ window (bug b)
**Where:** `charts/StackedArea.tsx:62-66` (`niceMax(Math.max(m, win.value) * 1.04)`), `charts/scale.ts:49-55` (`niceMax` steps 1/2/2.5/5/10),
same pattern in `charts/CacheStrip.tsx:35` and `charts/Brush.tsx:23`.
**Scenario (reproduced):** peak 989,929, window 1.0M → 1.04M → mantissa 1.04 → rounds to 2 → ticks `0…2.0M`; the whole
session lives in the bottom half and the window line sits mid-chart.
**Fix:** `yMax = Math.max(peak, window) * 1.08` with no rounding; let `ticks(0, yMax, …)` (`scale.ts:22-32`, already 1/2/2.5/5
steps) pick nice *tick values* below the top. If a rounded top is wanted, use a finer `niceMax` ladder
(1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10). Apply to CacheStrip and Brush.

### 9. Medium — render exceptions are reported as "Companion not reachable" (bug d)
**Where:** `components/Status.tsx:9` (`unreachable = !(error instanceof ApiError)`), `main.tsx:141-156` (ErrorBoundary reuses
`ErrorNotice`), `main.tsx:150` (`retry` re-renders the same tree → throws again), `main.tsx:189` (`key={current.name}` — the
boundary and `SessionScreen` are *not* remounted when moving from session A to session B).
**Fix:** in `api.ts` wrap `fetch` failures in a `NetworkError` class and make `ErrorNotice` test `instanceof NetworkError`
(default branch = generic error, no `npx contextscope` advice); give the boundary its own panel ("Something broke while
rendering this screen", message, `Reload` button, link to file an issue) and key `<main>` by the full route path so the
boundary resets on every navigation; expose `error.stack` behind a `<details>`.

### 10. Medium — `formatTokens` has no billions unit (bug c)
**Where:** `categories.ts:45-50`.
**Scenario:** `formatTokens(11_094_145_187)` → `"11094M"` (verified); Overview stat tile, "most compacted" list and the
rail show it. `formatTokens(totals.requests)` (`Overview.tsx:120`) also renders counts as "1.4k".
**Fix:** add `>= 1e9 → ${(v/1e9).toFixed(v >= 1e10 ? 0 : v >= 1e9 ? 2 : 1)}B` (11.09B); use `formatNumber` for counts.

### 11. Medium — the first `Table` on a screen hijacks page keys globally
**Where:** `components/Table.tsx:122-151` (window `keydown`; when nothing is focused the *first* `[data-kbd-table]` claims
`j/k/ArrowUp/ArrowDown/Home/End/Space/Enter/Left/Right`) — `:144-145` prevent default on Home/End; `:138-139` on arrows.
**Scenario:** on Overview and Setup, `ArrowDown`/`ArrowUp`/`Home`/`End` no longer scroll the page even with focus on the
body; the effect has no deps (`:151`) so the listener is re-registered on every render.
**Fix:** only react to arrows/Home/End/Space/Enter when the wrapper (or a descendant) has focus; keep `j/k` global for the
first table if desired; add `[focused]`/`[flat]` deps or keep handlers in refs.

### 12. Medium — `useWidth` measures on the wrong dependency and keeps a stale width
**Where:** `charts/hooks.ts:10` (compares against the `width` captured at effect time), `:15` (deps `[ref.current]` — `null`
on the first render, so measurement only happens after some *other* re-render), `:4` (`fallback = 900` → first paint
draws 900 px SVGs on a 375 px screen).
**Scenario:** shrink the window then restore it to the original width: the ResizeObserver sees `w === stale width` and skips
`setWidth`, leaving charts at the narrow width.
**Fix:** callback ref or `useLayoutEffect(() => …, [])` with functional `setWidth(prev => Math.abs(prev - w) > 0.5 ? w : prev)`;
initial width 0 with a "measuring" guard (render nothing until measured) instead of 900.

### 13. Medium — stale run stays on screen when navigating session → session
**Where:** `screens/Session.tsx:45-47,71` (`run` state persists; `loading && !run` is false once any run is loaded), `:74`
(`scope` looked up in the *old* run), `main.tsx:189` (no remount).
**Scenario:** from the Overview open run A, then open run B from "Fattest handoffs": for the duration of B's fetch the
screen shows A's charts and ledger under B's URL, breadcrumbs and `hrefs` (`Session.tsx:170-177` use `props`), and any
pin/scroll targets A's data. With a 23 MB run that is many seconds.
**Fix:** clear `run` (`setRun(null)`) when the key changes, or key `SessionScreen` by `${vendor}/${id}`; show B's loading
state; abort A's fetch.

### 14. Medium — `loadThresholds` has no in-flight de-duplication
**Where:** `store.ts:102-108`, called from `components/FindingCard.tsx:96` in every card's mount effect.
**Scenario:** the first paint of the session screen mounts 378 cards while `thresholds.value` is still `null` → 378 parallel
`GET /api/v1/thresholds`. Findings screen with 131 cards: 131 requests.
**Fix:** cache the promise (`let inflight: Promise<Thresholds|null> | null`); load once from the screen, not the card.

### 15. Medium — companion death is never surfaced; refresh can get stuck
**Where:** `store.ts:69-79` (`api.indexEvents` only handles JSON messages; `EventSource.onerror` is never wired — the `"error"`
branch is a *message* type), `store.ts:82-91` (`refreshIndex` sets `indexing` and relies on a `done` event that never
comes if the stream is broken; the refresh button stays disabled).
**Fix:** `source.onerror = () => indexStatus.value = { …, state: "offline" }` and `onopen` → back to `idle`; add a timeout
that returns `refreshIndex` to `idle` and toasts if no `done` arrives.

### 16. Medium — saving thresholds re-runs rules but other screens keep stale findings
**Where:** `screens/Findings.tsx:143-148` (`onSaved` reloads only the Findings resource); Overview (`firstFinding`),
Setup (`setup.findings`) and Session (`run.findings`) key their `useResource` on `indexVersion` only.
**Fix:** bump `indexVersion` (or a new `rulesVersion`) after a successful save; include it in the Session load effect deps.

### 17. Medium — dialogs are not modal for the keyboard
**Where:** `components/KeyboardMap.tsx:24-40`, `screens/Findings.tsx:158-201` (`aria-modal="true"` with no focus trap, no
`inert` on the page, no focus restore on close).
**Fix:** use `<dialog>` + `showModal()` (native trap, Esc, restore) or add a small trap (first/last focusable + `inert` on
`#app` while open); restore focus to the opener on close.

### 18. Medium — ledger ARIA is invalid and rows are not reachable by keyboard
**Where:** `components/Ledger.tsx:110` (`role="table"` + `aria-rowcount`), `:112,131,144,155` (`role="row"` divs with no
`role="cell"`/`columnheader` children, no `aria-rowindex` on virtualised rows), `:155` (`aria-expanded` is not permitted on
`row`), `:143-157` (rows are clickable `div`s without `tabIndex`; the only keyboard path is the global `j/k`).
**Fix:** `role="grid"`, header cells `role="columnheader"`, body cells `role="gridcell"`, `aria-rowindex={r.index+2}`, put
`aria-expanded` on a real expander button in the first cell, make the scroll container `tabIndex={0}` with
`aria-activedescendant` pointing at the focused row id; announce the focused request via a visually-hidden live region.

### 19. Medium — text contrast below AA in both themes
**Where:** `theme.css:6,20,32` (`--faint` #8a8a84 on white = 3.47:1; #7d7d76 on #1a1b19 = 4.17:1) used for 11–12 px text at
`theme.css:229` (`.finding-rule`), `:211` (offender numbering), `:155` (placeholders); `session-styles.ts:10` (`--cs-amber`
#b7791f on white = 3.64:1) used by `.cs-note-amber`, `.cs-presence-dropped`, `.cs-badge-warn` (`:41,43,117,129`).
Palette fills: `tool_result.other` #c3dcef on white 1.42:1 (`categories.ts:22`) and `--series-4` #eda100 on white 2.17:1
(`theme.css:10`) fail the 3:1 graphics threshold where used as sole indicators (legend swatch, sparkline dot).
**Fix:** darken `--faint` to ≥ #767670 (light) / lighten to ≥ #8f8f88 (dark); use `--warn` (#7a4a00 / #f0c060, both ≥ 6.7:1)
instead of `--cs-amber`; give swatches a 1 px `--border-strong` outline.

### 20. Medium — colours hard-coded outside the token sheet
**Where:** `categories.ts:11-27` (17 hex fills, identical in dark mode), `charts/CacheStrip.tsx:13` (`CACHE_COLORS` hex — while
`session-styles.ts:10` *also* defines `--cs-cache-*` tokens that nothing reads), `charts/session-styles.ts:10-12` (a second
token block living in JS), `:66` (`rgba(0,0,0,.14)` shadow), `:184` (`.cs-sev { color: #fff }` — 2.09:1 on dark `--medium`,
dead class), `theme.css:287` (`rgba(0,0,0,0.35)` backdrop), `Sparkline.tsx:35` inline `--spark-accent`.
**Fix:** move all series/cache/category colours to `theme.css` as `--cat-<name>` / `--cache-<kind>` tokens with dark
overrides, and have `CATEGORY_META.color = "var(--cat-system)"`; SVG `fill` accepts `var()`.

### 21. Medium — `session-styles.ts` should be CSS, not a 16.6 KB string in the bundle
**Where:** `charts/session-styles.ts` (16,166 bytes in output = 11.6% of `app.js`, unminified, re-shipped with every JS
change, injected as a side effect *during render* at `screens/Session.tsx:44`); 24 selectors are dead
(`.cs-panel*`, `.cs-badge-obs/der/est/unk`, `.cs-sev*`, `.cs-finding-*`, `.cs-evidence`, `.cs-fix`, `.cs-empty`, `.cs-stat-*`);
`.cs-ledger` layout duplicates `.table`; the file's header comment ("esbuild does not emit CSS from JS imports") is
inaccurate — esbuild bundles `import "./session.css"` into `app.css`.
**Fix:** move the live rules into `theme.css` (or `session.css` imported from `main.tsx` with `build.mjs` emitting one
`app.css` instead of copying `theme.css` at `build.mjs:29-31`), delete the dead rules and the injector.

### 22. Medium — provenance badges disagree with the ADR and with each other
**Where:** `screens/Overview.tsx:158` (handoff tokens badged `estimated.local`; ADR 2.2 says handoff is `observed.artifact`,
and `charts/Lanes.tsx:120` badges the same number with `handoff.tokens.provenance`); `Overview.tsx:101-105` (the *Peak* cell
shows the *window's* provenance next to the peak value, so a vendor-observed peak reads "estimated"); `Session.tsx:278`
(compactions badged `observed.artifact`, ADR: `observed.vendor`); `Session.tsx:293` (Coverage badged `derived.exact`; it is
`observed.artifact`); `Setup.tsx:94-95,102` (hook stdout p50/p95 and MCP tool counts carry no badge); `Session.tsx:232`
(a fabricated evidence row with `derived.exact`).
**Fix:** badge the number that is shown (peak → `summary.peak.provenance`, window → `window.provenance` on the % or in
the title); use the `Measured.provenance` from the payload wherever one exists; add a unit test that every numeric cell in
Overview/Setup renders with a badge.

### 23. Medium — the ErrorBoundary retry loops and `Loading`/error states are inconsistent on Session
**Where:** `main.tsx:150` (retry = re-render the throwing tree), `screens/Session.tsx:71-72` (`cs-loading`/`cs-error` plain
strings instead of `Loading`/`ErrorNotice`; a 401 shows "Could not load session …: 401 Unauthorized" with no token hint;
network failure shows "failed to load").
**Fix:** reuse `ErrorNotice` with the `retry` = reload the resource; see #9 for the boundary.

### 24. Low-Medium — hover throttle can wedge and never cleans up
**Where:** `session-state.ts:66-73` (`if (hoverFrame) return;` — if the pending frame never fires (hidden tab, throttled
iframe) every later hover is dropped until it does; no `cancelAnimationFrame` on unmount; `hoverNext` outlives the screen
so the first frame after remount can apply a stale index), `charts/Lanes.tsx:94` (`onHoverLane` also calls `setHovered`).
**Fix:** cancel the pending frame in `resetSessionState` and on `SessionBody` unmount; apply the latest value on
`visibilitychange`; or replace rAF throttling with a plain `hoveredRequest.value = i` guarded by `peek()` (signals batch).

### 25. Low-Medium — O(n) spreads on hot paths and a `RangeError` waiting for large scopes
**Where:** `charts/StackedArea.tsx:111` (`Math.max(...requests.map(...))` in the `aria-label`, every render),
`charts/Brush.tsx:23` (`Math.max(1, ...requests.map(...))`), `charts/Lanes.tsx:63`, `components/Sparkline.tsx:20-21`.
**Scenario:** spread-call argument limits (~65k–500k) throw `RangeError: Maximum call stack size exceeded` for a scope with
that many requests; below that, it is O(n) allocation per hover frame.
**Fix:** loop or `reduce`; memoise peak on `requests`.

### 26. Low-Medium — keyboard map incomplete; brush has no keyboard equivalent
**Where:** `components/KeyboardMap.tsx:4-15` (no `ArrowUp/Down`, `Home/End`, `Space`, `Left/Right` that `Table.tsx:138-145`
implements; `Esc` says "close rail" but the session handler also unpins first, `Session.tsx:132-137`), `charts/Brush.tsx:75`
(`role="group"` with no keyboard handling — zoom is pointer-only, ADR 2.5 lists none).
**Fix:** document the table keys; add `z`/`Z` (zoom to ±50 around focus / reset) or `Shift+[`/`]` to move the range; make the
handles focusable with arrow-key nudges.

### 27. Low-Medium — `Escape` and `c` have surprising side effects
**Where:** `main.tsx:31-41` and `screens/Session.tsx:132-137` (both listeners run on the same `Escape`: closing the keyboard
map also unpins the request / clears the brush), `main.tsx:63-68` (`c` with no focused finding copies the *first* finding on
the page, which on the session screen is whichever card is first in DOM order, silently).
**Fix:** in the session handler, ignore `Escape` when `e.defaultPrevented` (the global handler already prevents it); make
`c` a no-op without focus, or toast "Focus a finding first".

### 28. Low-Medium — `Table` behaviour with nested rows and sort
**Where:** `components/Table.tsx:27,220` (`children` prop shadows Preact's `children`; works only because no JSX children are
passed — rename `childRows`), `:65` (`defaultExpanded` computed once from the initial `rows`; after an index refresh new
parents arrive collapsed), `:64,95` (focus is a *flat index*, so re-sorting moves the highlight to a different row),
`:86-90` (child rows are never sorted), `:169-171` (`role="group"` cannot own `aria-activedescendant`; use `role="grid"` with
`role="row"`/`gridcell` and `aria-selected`), `:180,186` (`sort!`), `:203-208` (row click opens even when the click was on
selectable text).
**Fix:** as noted per line; key focus by `rowKey`, sort children with the same comparator, sync `expanded` when `rows` change.

### 29. Low — ledger virtualisation nits
**Where:** `components/Ledger.tsx:107` (`rows.filter(...)` count every render), `:52-67` (`blocks` resolved for every request even
with an empty filter, on every `expanded` change), `:87-97` (`lastScrolled` guard: re-pinning the same request after
scrolling away does not scroll back; a filter change that hides the pinned row is ignored), `:84` (`rowIndexOf` linear
scan on each pin), `:96` (scroll maths use `ROW_H` but the header is 46 px tall — fine because the header is outside the
scroller, but `first/last` do not account for the `cs-row-compaction` 2 px border which pushes rows by 2 px each).
**Fix:** memoise the request count with `rows`; build a `Map<index, rowIdx>` alongside `rows`; key the guard on
`(target, rows)`; use `box-shadow` for the compaction rule instead of a border.

### 30. Low — empty states that do not teach (ADR 6.5) and a silent scope fallback
**Where:** `screens/Session.tsx:213` (plain `<p>` for "no subagents"), `:219` (`EmptyState` with no path/command), `:249`,
`screens/Overview.tsx:144,164,184` (offender panels: no path/command), `screens/Session.tsx:74` (`?scope=` not found → silently
shows `main`; `?request=abc` → `NaN` pin), `router.ts:18` (`decodeURIComponent` can throw at module init on a malformed hash).
**Fix:** add `path`/`command` per vendor to each; show "Scope `x` is not in this run — showing main" notice; validate
`request` with `Number.isInteger`; try/catch the decode.

### 31. Low — `aria-live` regions that chatter
**Where:** `charts/Tooltip.tsx:10` (`role="status"` on the hover tooltip → a screen reader announces every hovered request),
`main.tsx:88` (`IndexPill` is `aria-live="polite"` and its text changes every 15 s tick via `useTick`).
**Fix:** tooltip `role="tooltip"` + `aria-hidden` (the chart already has an `aria-label`); announce only state *changes* of
the pill (a separate visually-hidden live region updated on `state` transitions).

### 32. Low — Findings filter chips are links with `aria-pressed`
**Where:** `screens/Findings.tsx:70-75` (`<a aria-pressed>` — `aria-pressed` is only valid on buttons).
**Fix:** `aria-current="true"` on the active chip, or `<button>` + `navigate()` like Overview's chips.

### 33. Low — TypeScript strictness escapes
**Where:** `screens/Session.tsx:232` (`{ evidence: [...] } as unknown as Finding` — fabricates a Finding to reuse
`showEvidence`; extract `pinRequestInScope(scopeId, index)`), `screens/Session.tsx:166` and `components/Ledger.tsx:106`
(`ref={… as any}` — type `useWidth<T>` to return `RefObject<T>` and `filterRef` as `RefObject<HTMLInputElement>`),
non-null assertions at `main.tsx:199`, `components/FindingCard.tsx:101`, `components/Table.tsx:180,186`,
`screens/Findings.tsx:127,175`, `screens/Setup.tsx:132`. `tsc --noEmit` is clean otherwise.

### 34. Low — responsiveness under 900 px
**Where:** `theme.css:69-76` (`.topbar-inner` never wraps: wordmark + 4 links + pill + 3 icon buttons overflow below ~560 px),
`session-styles.ts:23` + `Session.tsx:179` (keyboard hints in the header waste a row on phones), `charts/hooks.ts:4`
(first paint at 900 px), `session-styles.ts:66` (`min-width: 220px` tooltip can exceed the plot on 375 px),
`theme.css:96` (`.grid-3` collapses, but `.offender-*` rows keep `white-space: nowrap`).
**Fix:** hide the hints below 900 px; allow the nav to wrap or collapse icons; tooltip `max-width: min(320px, 90vw)`.

### 35. Low — global `scrollTo(0)` on every route object, including same-hash `navigate()`
**Where:** `main.tsx:179-184` (`[current]` — `navigate(sameHash)` creates a new object and scrolls to top), `router.ts:29`,
`screens/Setup.tsx:35-40` (its `scrollIntoView` races the App `scrollTo`).
**Fix:** scroll to top only when `name`/`id`/`file` change; skip when the route carries an anchor (`request`, `file`).

### 36. Low — `useResource` and `api` cannot cancel or time out
**Where:** `hooks.ts:16-30` (late results are ignored, but the request keeps downloading — 23 MB per abandoned session),
`api.ts:23-31` (no `AbortSignal`, no timeout; a hung companion shows "Loading" forever).
**Fix:** thread an `AbortController` through `request()`; abort in the effect cleanup; 30 s timeout → `NetworkError`.

### 37. Low — theme toggle does not track the OS
**Where:** `main.tsx:94-96` (`effectiveTheme()` reads `matchMedia` at render; no `change` listener) — in "system" mode the
icon and `title` go stale after an OS theme switch until something re-renders.
**Fix:** subscribe to `matchMedia("(prefers-color-scheme: dark)").addEventListener("change", …)` in `store.ts` and mirror
into a signal.

### 38. Low — dev fixtures and validator gaps
**Where:** `dev/make-run-fixture.mjs:3` (4 subagents, 400 requests — none of #2/#3/#5 reproduce on it; add a "stress" mode
with ≥150 scopes and ≥300 findings), `dev/validate-fixtures.mjs` (validates overview/setup/findings but not
`run-sample.json` — no check that `composition` sums to `usage.total`, that `newBlockIds` resolve, or that
`launchedAtRequest < requests.length`), `dev/server.mjs:41` (PUT thresholds echoes the body unparsed).
**Fix:** extend the validator to the run fixture; add `node dev/make-run-fixture.mjs --stress`.

### 39. Low — minor a11y and semantics
**Where:** `components/Ledger.tsx:106` (`type="search"` input without `<label>` but with `aria-label` — fine; the hint
"Enter expands…" at `:108` is not associated → `aria-describedby`), `screens/Session.tsx:192` (disabled "Exact total" legend
button reads as a control), `components/StatTile.tsx:29` (30 px value without `aria-label` when `display` is compacted —
the full number is only in `title`), `charts/Axis.tsx:15` (`role="img"` with an `aria-label` that omits the domain),
`components/Sparkline.tsx:35` (good), `session-styles.ts:96` (`.cs-lane:focus { outline: none }` relies on the hit rect
fill for focus — 3:1 not guaranteed).

### 40. Info — bundle composition (136.1 KB minified, 43.1 KB gzip)
`esbuild --metafile` share of `app.js`: `screens/Session.tsx` 12.2% (17.0 KB), `charts/session-styles.ts` 11.6% (16.2 KB),
`screens/Setup.tsx` 10.6% (14.7 KB), `screens/Overview.tsx` 7.5%, `preact` 7.5% (10.5 KB), `Ledger.tsx` 4.6%, `main.tsx` 4.4%,
`Findings.tsx` 4.3%, `FindingCard.tsx` 3.4%, `@preact/signals(+core)` 5.7% (7.9 KB), `Table.tsx` 3.3%, `StackedArea.tsx` 3.2%.
Size is not the problem (43 KB over loopback); the wins are moving the CSS string out (#21, −11.6%), and code-splitting
`Setup`/`Session` behind `import()` if a first-paint budget is ever set. Runtime work (#2–#5) dominates the experience.

---

## Cross-cutting recommendations

1. **State**: keep signal reads at the leaf that needs them; wrap static panels in `memo`; reset *all* session signals
   (`hiddenCategories`, `railOpen`, `requestCount` are never reset — a hidden category persists into the next session)
   or scope them per run with a `createSessionState()` factory stored in context.
2. **Budgets**: add a Playwright smoke that loads the stress fixture and asserts `documentElement.scrollWidth <=
   clientWidth`, `scrollHeight < 30,000`, first render < 500 ms, and hover frame < 16 ms.
3. **Data contract**: `?scope=` + summary scopes (#4) is the single change that makes the rest tractable; ship it with
   `AgentScope.requestCount` and per-scope `topBlocks`.
4. **Findings**: group by rule everywhere a list of findings is shown (#2); one card per rule, instances inside.
