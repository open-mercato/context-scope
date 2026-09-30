# ADR-005: Cycle 3 plan — prove that a change moved something

Status: accepted (architect, 2026-09-02, after the cycle-2 fix wave). Inputs: `docs/cycle-log.md` (cycle 2 result),
`docs/adr-004-cycle2-review.md` §8–9, `docs/context-engineering-research.md` (pivot, product loop, north star,
provenance table, validation plan), ADR-001 §1, `packages/cli/README.md`, the current IR (`src/ir/types.ts`),
`index/{overview,reader,entry}.mjs`, `adapters/{discover,claude,claude-tools,codex-tools}.mjs`, `rules/{habits,H-05}.mjs`,
and metadata-only probes over this machine's index (numbers in §2). Version target: `contextscope` 0.11.0.

## 0. Verdict in one paragraph

Cycle 2 finished the evidence sources (repo scoping, habits, live mode, hooks, export, check). ADR-004 said the next
cycle "stops adding evidence sources and starts proving that a recommendation changed something". Cycle 3 does exactly
that, observationally: one metric engine (`index/changes.mjs`) that pairs the sessions before and after an
instruction-file edit, one route, two panels, one `scan` line, and an `experiment` command that reuses the same engine
for a named baseline/candidate pair. Two of ADR-004's candidates change shape after measurement: the 59 "unattributed"
sessions are not the user's work (they are one-request SDK harness calls with zero tool use), so cycle 3 classifies
them instead of building a four-signal attribution machine; and the experiment flow ships without a task runner or
graders, because the honest prerequisite — a metric table with N, confounds and an interval — does not exist yet.
Everything below carries provenance labels; nothing says "improved", only "moved", until Study 3 exists.

## 1. Before/after view per instruction-file edit (stream A)

Rationale. The north star is the validated improvement rate; the cheapest honest step is to show, per edit of an
instruction file, what the sessions after it did differently from the sessions before it. `trends.instructionEdits`
and H-05 already compute half of this (edit anchors, startup H0 windows, the model/CLI confound); the rest is the same
manifest arithmetic applied to six more metrics. It turns the landing page's "fix one thing, then re-scan" into a
screen.

Data model (manifest-only; no run file is opened; the `index.test.mjs` spy stays green).

- Anchors, per instruction file of the launched repo (`setup.instructionFiles`, fixtures excluded): every commit that
  touched the file (`git log --format=%cI --follow -- <path>`, capped at 10, `anchor: "commit"`, `observed.artifact`)
  when the repo is git and the file is tracked; else the file mtime (`anchor: "mtime"`, one anchor). Anchor times are
  read by `setup/git.mjs` (one process per file, cached with the setup inventory, 60 s).
- Windows: `before` = repo sessions (top-level runs, ADR-004 §2) whose `startedAt` lies in `[previous anchor of the
  same file, anchor)`, `after` = `[anchor, next anchor)`; without neighbours the window is open. A session with
  `instructionFilesObserved` containing the file (hook `InstructionsLoaded`, `observed.artifact`) counts toward
  `n.afterObserved`; the rest of `after` is `expected.load`. Codex sessions count when `stats.codexInstructionChars`
  equals the anchor's file size within 2 % (`derived`), else they are listed as unverified.
- Metrics per side, each `{ value, n, provenance }`; medians unless stated:
  | Metric | Source (entry) | Provenance |
  |---|---|---|
  | startup H0 | `habits.startup.h0` | `estimated.local` |
  | peak share of window | `summary.peakShareOfWindow` | `derived.exact` (peak observed, window per `run.window`) |
  | compactions per active hour | `summary.compactions / (activeMs / 3.6e6)`, sum over root + descendants | `derived.exact` |
  | processed input tokens per session | `summary.processedInputTokens` (root + descendants) | `observed.vendor` |
  | findings per session, by rule | share of sessions whose `findingHeads` (root + descendants) carry the rule; every rule that fired on either side | `derived.exact` (over stored findings) |
  | fat results per session | Σ `habits.fat[].n` | `estimated.local` |
  | subagent handoff ratio | median of `habits.agents[].ratioP50` weighted by `n` | `estimated.local` |
- Confounds, as H-05 does them: dominant `habits.startup.model` per side, the set of `cliVersion` per side;
  `confounded: true` when the CLI version sets differ or the dominant models differ, and the row still renders with the
  reason. Deltas are `after − before` (and a ratio for token metrics).
- Interval: when `n ≥ 5` on both sides, a seeded bootstrap (1,000 resamples, xorshift seeded from the anchor time) of
  the difference of medians, 90 % interval, `provenance: "derived.exact"`, `claim: "observational"`. Below 5 no
  interval, and the row says `n small`.
- Caveats array on every change, verbatim in the UI and `scan`: "observational: sessions are different tasks", "N
  before / M after", "model/CLI confound: none|<reason>", "startup H0 is a local estimate".

Route. `GET /api/v1/changes?since=all|30d|…&file=<repo-relative>` →
`{ changes: Change[], notes: [{ file, at, reason }] }`, `Change = { file, at, anchor, n: { before, after, afterObserved },
before: Record<metric, Measured & { n }>, after: …, delta: Record<metric, number>, ci?: Record<metric, { low, high, level: 0.9 }>,
findingsByRule: Array<{ ruleId, title, before: { sessions, of }, after: { sessions, of } }>, confounds: { models, cliVersions, confounded, reason? },
caveats: string[] }`, newest anchor first, at most 20; anchors with an empty side go to `notes` ("`CLAUDE.md` edited Sep 2:
no session since"). Served from `analysis.changes()` with the setup/habits cache window; `< 30 ms` on 250 entries.

UI. Setup screen: each instruction-file row gains a "since this edit" expander (`#/setup?file=<path>` already
anchors the row) rendering `ChangePanel`: the paired table (metric · before · after · delta · n), the rule rows, the
caveats line, the confound badge; H-05's finding links here. Findings screen: one card under the first-change card,
"Did the last change help?", for the newest change with `n ≥ 2` per side; otherwise one muted line with the note. No
colour on deltas below the interval; a delta with an interval that excludes zero is bold, never green.

`scan`. One block after Habits: `Since CLAUDE.md (Sep 2, commit): 4 sessions vs 9 before · startup 12.1k → 10.9k ·
B-02 in 0/4 (was 7/9) · compactions/h 1.2 → 0.9 · n small, observational`. Present in `scan --json` as `changes`.

Rules. H-05 is rewritten to consume `changes.mjs` windows (one definition of before/after in the product); its
thresholds and findings text stay, its tests must pass unchanged.

Tests (`test/changes.test.mjs`): windows from a synthetic manifest with two anchors; hook-observed count; confound
detection; bootstrap determinism (same seed, same interval) and the `n ≥ 5` gate; route shape; the manifest-only spy.

Acceptance: on this machine `scan --repo context-viewer` prints the block for `AGENTS.md`/`CLAUDE.md` with honest
`n`; H-05 output identical to cycle 2 on `test/habits.test.mjs`; no run file opened by the route.

## 2. Temp-isolation sessions: classify, do not attribute (stream B)

Feasibility, measured (metadata only, `probe.mjs`/`probe2.mjs` in the session scratchpad, never printed content).
The manifest's 59 unattributed entries are 42 `cez-root-isolation-*` + 14 `cez-root-lease-*` (Claude), 2 Codex temp
probes (`codex-probe`, `codex-multi`, 0 requests) and 1 Claude entry with an undecodable directory name (0 requests).
The 56 `cez-*` sessions: `entrypoint: sdk-cli`, `userType: external`, model `claude-haiku-4-5`, **1 request each, 0
tool calls, 0 subagents**, 2 assistant records (thinking + text), attachments limited to `deferred_tools_delta`,
`agent_listing_delta`, `skill_listing` (and 7 `total_tokens_reminder`); `gitBranch` is `main` or `HEAD`; every temp
cwd is gone from disk; a further 46 files in the same directories are a single 90-byte `ai-title` record and never
index. Signals by count: hook `cwdKey` 0 (no capture records exist, and a hook run inside the temp cwd keys the temp
dir, so it is exact for the wrong thing); `nested_memory` naming an instruction file 0 (the attachment type never
occurs in these 56); branch + path overlap 0 (no tool targets at all); request-0 instruction-block hash 0 — and
structurally unavailable for Claude, because the root `CLAUDE.md` lives in the unlogged system prompt
(`docs/format-claude-code.md` §"Root CLAUDE.md / MEMORY.md are not logged"). The one signal that would "work" is the
directory prefix `cez-root-*` → the `cezar` repo basename (56 of 59), and it would attach 56 one-request Haiku calls
to that repo's habits and trends. ADR-004's premise ("the bulk of one user's work") was wrong; these are harness calls.

Decision. Cycle 3 ships (a) a session `kind` and (b) a minimal attribution for temp copies that carry evidence, tested
on fixtures, since the real corpus has none.

- Entry fields (index time, `entry.mjs`; `adapterVersion` bump → one full re-index, 1.9 s here):
  `kind: "interactive" | "harness"` — harness when `run.entrypoint === "sdk-cli"`, or when `cwdKind === "temp"` and
  `summary.toolCalls === 0` and `summary.requests ≤ 2`; `targets: string[]` (≤ 32 distinct repo-relative
  `tool.target` values, main + subagents; relative paths only, never absolute); `nestedHashes: string[]` (≤ 8 content
  hashes of `nested_memory` blocks whose label looks like an instruction file); `instructionHash?` (Codex: hash of the
  request-0 `instructions` block). `Run.entrypoint` already exists; the entry copies it.
- Read time (`reader.mjs`), only for `cwdKind === "temp"` entries and only against the launched repo (the server has one
  root): `attributionOf(entry, { repoRoot, repoFiles, chainHashes })` in priority order —
  `nested-hash` (an entry hash equals the hash of a nested `CLAUDE.md`/`AGENTS.md` of the repo; `observed.artifact`,
  confidence `exact`), `instructions-hash` (Codex; equals the repo's `AGENTS.md` hash; `exact`), `path-overlap`
  (≥ 5 distinct targets and ≥ 80 % of them exist in `repoFiles`; `derived`). `repoFiles` = `git ls-files` of the
  launched repo cached in `analysis.mjs` (60 s; bounded walk without git, 20k files). `chainHashes` come from the setup
  inventory, which gains `InstructionFile.hash` (sha1 of content, `observed.artifact`).
- Manifest/API: `attribution: { key, method: "cwd" | "nested-hash" | "instructions-hash" | "path-overlap", confidence:
  "exact" | "derived", files?: number }` on the overview row; `scope` line gains `attributed` and `harness` counts:
  "3 sessions in this repo (1 attributed by file-path overlap) · 189 on this machine · 56 harness runs · 3 unattributed".
  `repoSessions()` includes attributed entries in `roots`; harness entries are excluded from repo and machine
  populations, habits, trends and offenders, and listed only under `scope=all&kind=harness`.
- UI: row badge "attributed · file-path overlap (12 files)" with the tooltip naming the method; the population line
  as above; the unattributed tooltip rewritten (harness = SDK-driven runs with no tool use).
- `scan` header: `Sessions 3 (claude 3; 1 attributed by path overlap) · … · 56 harness runs and 3 unattributed on this machine`.

Tests (`test/attribution.test.mjs`, fixtures under `test/fixtures/repos` + a temp-cwd Claude session generated by
`make-fixtures.mjs`): six Read targets present → attributed `path-overlap`; two → not; a `nested_memory` hash match →
`exact`; `sdk-cli` one-request session → `harness`, absent from habits and trends; nothing absolute in `targets`.

Acceptance: this machine's overview reads `56 harness runs · 3 unattributed`; `repoSessions` for `context-viewer`
unchanged (3); attribution never fires for a `kind: "repo"` cwd.

## 3. Experiment flow: baseline vs candidate, observational (stream A)

Rationale. Study 3 needs a task manifest, headless vendor drivers and graders; none exists and building them before
the metric table would produce a runner that spends the user's API budget to print cost numbers without a quality
gate. Cycle 3 ships the bookkeeping and the comparison over the user's real sessions, labelled observational, so that
the runner in cycle 4 has a report format and a metric engine to plug into.

CLI (`commands/experiment.mjs`; storage `~/.contextscope/experiments/<name>.json`, 0600):

```
contextscope experiment start <name>            # snapshot: instruction chain {path, hash, bytes}, rulesHash, thresholds hash, repo key, vendor list, at
contextscope experiment candidate <name>        # second snapshot after the user edited files; refuses when the chain is identical (nothing changed)
contextscope experiment compare <name> [--md|--json] [--min-sessions 2]
contextscope experiment list | show <name> | delete <name>
```

Assignment of sessions: repo sessions started in `[baseline.at, candidate.at)` are `baseline`, in `[candidate.at, now)`
are `candidate`; `verified` counts sessions whose observed hashes match the snapshot (Codex `instructionHash`; Claude
`nestedHashes`; hook `InstructionsLoaded` file names as `expected.load` only, since the hook carries no hash). "Same
task" has no definition here and the report says so in its first line: the sessions are the user's own work, each a
different task; "comparable" in cycle 3 means same repo, same vendor, same dominant model and CLI version — sessions
that differ are excluded and counted in `excluded: { model, cliVersion }`. The report is the §1 table (same
`changes.mjs` engine, `anchor: "experiment"`), N per side, the interval when `n ≥ 5`, the confound line, and the
sentence "observational comparison; no causal claim". Markdown via `export/compare-markdown.mjs`; JSON is the `Change`
shape plus `experiment: { name, baseline, candidate, verified, excluded }`. No task runner, no grader, no model call.

Tests (`test/experiment.test.mjs`): snapshot fields and refusal on an unchanged chain; assignment by time; `verified`
from a Codex fixture whose instructions hash matches; markdown contains the observational sentence; nothing absolute
in the stored file.

Acceptance: `experiment start x`, edit `AGENTS.md`, `experiment candidate x`, run one session, `experiment compare x`
prints a table with `n = {baseline: k, candidate: 1}` and no interval.

## 4. Claude `Bash` `tool.target` (stream B)

Rationale. Claude `Bash` results are `tool_result.shell` with no target, so a `cat src/big.ts` never reaches H-01's
(kind, target) key, H-02's whole-file reads or H-07's re-reads, while the same command in Codex `exec` does; the parser
already exists (`codex-tools.mjs` `classifyCommand`) and `claude-tools.mjs` imports it for `partialReadOf`.

Spec. In `adapters/claude.mjs` tool_use handling, when `name === "Bash"` and `input.command` is a string:
`classifyCommand(command, { cwd: this.cwd, home: this.shared.home })` → `{ kind, target, partial }`. Set
`tool.target` when present (already repo-relative or `~`-relative by `relativeTarget`); set `tool.kind` to the
classified kind when it is `file`, `search`, `edit` or `web` (else keep `shell`); keep `tool.name: "Bash"` and the
block category `tool_result.shell` (the chart category says what the model saw; the kind says what the fix family is —
the H-01 comment already assumes this). `tool.partial` keeps coming from `partialReadOf`. Heredocs and multi-segment
commands follow the Codex rules (`mergeKinds`). B-01's fix text for Bash-with-file-kind uses the `sed -n` snippet;
`util.mjs` `isWholeFileRead` now matches Bash reads with a target, so B-03 and H-02/H-07 see them; the `shell` helper
in `util.mjs` keeps matching by `tool.name === "Bash"` so B-04 does not lose Bash.

Tests: extend `test/adapter-claude.test.mjs` with `cat path`, `sed -n '1,40p' path` (partial), `rg foo src`,
`cat a | head`, a heredoc write, and `git status`; assert kind/target/partial and that no absolute path survives.
Acceptance: on the reference session `claude:cc87cfe5…` the habits record's `fullReads` gains Bash reads; H-01 groups
by target where the label was empty before; adapter version bump documented in CHANGELOG.

## 5. Per-tool cost breakdown (stream C)

Rationale. "Which tool's results cost the most across this session" is the question behind H-01, B-01 and B-04, and
the presence windows (`firstRequest`, `lastRequest`, `scale`) already exist; it is one pass over blocks, no new data.

Formula (per scope, `ir/finalize.mjs`, after reconciliation). For a block `b` with presence `[first_b, last_b]`
(`last_b` = last request of the scope when undefined; never-entered blocks skipped):
`tokenRequests(b) = Σ_{i=first_b}^{last_b} estTokens_b × k_i` and
`uncached(b) = Σ_i estTokens_b × k_i × (1 − cacheRead_i / total_i)`. Group `tool_call` + `tool_result.*` blocks by
`tool.name` (an MCP tool by `server/tool`), `subagent_handoff` blocks as `Agent handoffs`, `attachments` by
attachment type; `share = tokenRequests / Σ_i total_i` (denominator `observed.vendor`). Stored as
`scope.toolCost: Array<{ name, kind, blocks, tokenRequests, uncached, share }>` (top 8 + `other`) and
`summary.toolCost` (main + subagents merged, top 8); `provenance: "estimated.local"`, `unit: "token-requests"`.
Caveats printed with the number: presence is not attention; a cached token costs roughly a tenth of a fresh one on
Claude, so `uncached` sits next to `tokenRequests` and the row shows the cache-read share; residue of dropped blocks
inside a compaction summary is attributed to the summary, not to the tool; clamped requests use the clamped `k`.

Surfaces. Session screen: "What cost the most" panel (from the loaded scope: all groups, sortable, `estimated.local`
badge, the cache-read share column). Overview: "Costliest tools across sessions" panel summing `summary.toolCost`
over the population (`server/routes/cost.mjs`, `GET /api/v1/cost?scope=&since=`, manifest-only). `scan`:
`Cost by tool: Bash 41% (cache-read 78%) · Read 22% · Agent handoffs 9% — token-requests, estimated`. Export carries
`toolCost` unchanged (names follow §7).

Tests (`test/toolcost.test.mjs`): a three-request fixture with known `k_i` and cache reads gives the hand-computed
numbers; a block dropped at a compaction stops accruing; shares sum to ≤ 1; the route opens no run file.
Acceptance: the two reference sessions show a top tool with a share, the panel loads with the scope, and the
overview panel is under 5 ms on 250 entries.

## 6. First run and `contextscope status` (stream D)

Rationale. A new user runs `npx contextscope` with no index and sees a consent page, then an empty overview for a few
seconds; the terminal says nothing after the URL. The product must say what it found and answer the three questions
in the terminal on the first pass, and a diagnostic command must exist before we ask anyone to debug hooks or watchers.

Spec.
- `start`: after consent (or `--yes`) the terminal prints the pass progress (`progressPrinter`, already used by
  `scan`) and, when the first pass ends, a "what we found" block: `250 files · 189 sessions on this machine · 3 in
  context-viewer (claude 3) · 45 subagents · 1.9 s`, then the three questions as three lines with numbers
  (composition at peak of the repo's sessions by top category; fattest handoff with ratio; the first change with its
  file), then `hooks: not installed (contextscope hooks install --scope user)` when applicable. `start --json` prints
  one line `{ url, repo, repoKey }` and then NDJSON index events (`start`, `progress`, `done`, `live`) for tooling.
- `contextscope status [--json] [--repo]` (new command, does not merge into `scan`: `scan` reads and evaluates
  sessions, `status` must answer in < 300 ms without a pass): vendors detected with file counts (`vendorsPresent`),
  the repo's instruction files with sizes and load state, index location, entries, bytes, last pass and its timing,
  `adapterVersion`/`rulesHash`, hooks per scope with record counts (reusing `hooksStatus`), watcher: `fs.watch`
  available or polling expected (`watch.mjs` capability probe), and whether a companion is running — read from
  `~/.contextscope/server.json` `{ pid, port, repoRoot, startedAt }` (0600, written by `start`, removed on close;
  the token is never written). Exit 0 always; `--json` mirrors the lines.
- The consent page keeps its text; the UI's empty overview during the first pass shows the SSE progress and the
  "needs 3 sessions" habit note (exists) — no new UI beyond a `FirstRun` card mounted by stream B in `Overview.tsx`
  when `index.state === "indexing"` and `totals.runs === 0`.

Tests: `test/status.test.mjs` on the fixture home (vendors, hooks, server.json present/absent); `start --json` first
line parses; `server.json` mode and removal on close.
Acceptance: `time contextscope status` < 300 ms here; a fresh `~/.contextscope` gives a readable "what we found" block.

## 7. Redacted export: names policy (stream C)

Rationale. `--redact-labels` hashes paths and the project but leaves MCP server names, custom agent types, custom
skill names and branch-derived labels readable; internal service names in an MCP server list identify a company as
surely as a path does.

Policy under `--redact-labels` (`export/redact.mjs`, `redaction.names: "vendor-only"`):
| Name class | Plain export | Redacted |
|---|---|---|
| Built-in tool names (`Read`, `Bash`, `exec`, …), vendor model names, `Explore`/`Plan`/`general-purpose`/`Bash`/`claude-code-guide`/`statusline-setup` agent types, event names | readable | readable (vendor vocabulary) |
| MCP server names and `mcp__<server>__<tool>` names, `tool.server` | readable | `mcp__h:xxxx__h:yyyy`; equal names stay equal |
| Custom agent types (`.claude/agents/*.md`), skill names, hook matchers | readable | hashed |
| Branch names, `scope.description` | readable | hashed (already) |
Vendor vocabulary is a fixed list in `redact.mjs` (`BUILTIN_AGENT_TYPES`, `BUILTIN_TOOLS`) — anything else is
user-authored and hashed. The Open screen shows a banner for a `redaction.labels === "sha1-10"` document: "Redacted
export: paths, MCP servers, custom agents and skills are salted hashes; token counts, vendor tool and model names are
as recorded." README table updated. Tests: `test/export.test.mjs` asserts no MCP server or custom agent name from the
fixture survives, and that `Read`/`Explore`/model names do.

## 8. Status line: deferred again

The watcher makes a live number available to the companion, not to a status-line script: the forecast's threshold
basis lives in the server, a 64 KB tail read would re-derive a weaker number, and the native status line already
shows occupancy. It would also be a third write into Claude settings (`statusLine`) in two cycles; the hook installer
spent that trust budget. `server.json` (§6) gives a future `contextscope statusline` a stable way to ask the running
companion instead of re-parsing, so the deferral costs nothing. Condition to revisit: an experiment report (§3) has
been produced by someone other than us, and the forecast card has a measured hit rate over ≥ 20 auto-compactions.

## 9. Risks and what not to build

Risks.
- **Reading "moved" as "improved".** Every `Change` row carries the caveats array and the confound line; the UI
  never colours a delta green; `scan` prints "observational". A reviewer checks the copy, not the arithmetic.
- **Harness classification hiding real work.** A user's own SDK app is `sdk-cli` too. Harness runs stay listed under
  `scope=all&kind=harness`, the count is on the header, and a temp-cwd session with tool calls is never harness.
- **Manifest growth.** `targets` (≤ 32 short strings) and `toolCost` (≤ 9 rows) add ≈ 1.5 KB per entry: 250 → +0.4 MB
  on a 1.08 MB manifest; ADR-004's split-by-month risk moves closer and is measured in the cycle log.
- **Adapter-version bump.** §2 and §4 change parsed output; one full re-index (1.9 s here, minutes on a 10 GB home).
  `start` prints the reason (the existing estimator-changed line pattern).
- **Bash classification drift.** A wrong kind moves a finding between fix families; the fixture list in §4 is the
  contract, and `tool.name` stays `Bash` so nothing is lost, only re-keyed.
- **`git log` per instruction file.** Ten files × one process ≈ 100 ms once per 60 s; fixtures excluded; no git → mtime.

Not built in cycle 3, with reasons: the four-signal attribution machine (0 of 59 attributable here, and the sole
signal that fires would mislabel harness calls); the task runner and graders (no manifest, no quality gate, spends
API budget); LLM graders of any kind; apply-fix (still a text editor without §3's runner); a health score; a status
line; Gemini adapter (no corpus); team reports (population still thin); `#/change/:path` as its own screen (the
Setup row expander is the same information where the file already is).

## 10. Streams and file ownership

PR 0 (architect, sequential, day 1): `types.ts` additions (`Change`, `ToolCost`, `Attribution`, `InstructionFile.hash`,
`Run.kind`), `commands/index.mjs` and `server/routes/index.mjs` registry lines for `changes`, `cost`, `experiment`,
`status` (empty modules), `adapterVersion` and `HABITS_VERSION` bumps. Every stream branches from PR 0. A file is owned
by exactly one stream; a cross-stream need is a one-line mount by the owner.

| Stream | Owns (under `packages/cli/src` unless noted) | Tasks | Acceptance |
|---|---|---|---|
| A Changes + experiment | `index/changes.mjs` (new), `server/routes/changes.mjs`, `server/analysis.mjs` (`changes()`, `repoFiles()`), `setup/git.mjs` (log anchors), `rules/H-05.mjs`, `commands/experiment.mjs`, `export/compare-markdown.mjs`, `packages/ui/src/components/ChangePanel.tsx`, `screens/Setup.tsx`, `screens/Findings.tsx`, `test/{changes,experiment,habits}.test.mjs` | §1 engine, route, panels, `renderChangesLines()`; §3 command, storage, compare | Manifest-only spy; H-05 tests unchanged; bootstrap deterministic; compare prints the observational sentence |
| B Evidence | `adapters/claude.mjs`, `adapters/claude-tools.mjs`, `adapters/codex-tools.mjs`, `adapters/discover.mjs`, `index/entry.mjs`, `index/reader.mjs`, `index/overview.mjs`, `setup/instructions.mjs` (`hash`), `rules/util.mjs`, `rules/B-01.mjs`, `packages/ui/src/screens/Overview.tsx` (population line, badges; mounts C's `CostPanel` and D's `FirstRun`), `test/{adapter-claude,attribution,overview-scope,discover}.test.mjs` | §2 `kind`, `targets`, `nestedHashes`, attribution, population counts; §4 Bash target | Header reads `56 harness runs · 3 unattributed` here; fixture attribution cases; Bash fixtures; no absolute path in new fields |
| C Cost + export | `ir/finalize.mjs`, `server/routes/cost.mjs`, `export/{redact,schema,markdown}.mjs`, `commands/export.mjs`, `packages/ui/src/components/CostPanel.tsx`, `screens/Session.tsx`, `screens/Open.tsx`, `test/{toolcost,export,privacy-gate}.test.mjs` | §5 formula, panels, `renderCostLines()`; §7 names policy and Open banner | Hand-computed fixture matches; no MCP/custom agent name survives redaction; reference sessions show the panel |
| D First run + status + docs | `commands/{start,status,scan,help,shared}.mjs`, `index/scan.mjs` (mounts A's and C's lines), `server/consent.mjs`, `server/app.mjs` (`server.json`), `index/watch.mjs` (capability probe), `packages/ui/src/components/FirstRun.tsx`, `packages/cli/README.md`, `CHANGELOG.md`, `docs/cycle-log.md`, `test/status.test.mjs` | §6 first-run block, `--json`, `status`, `server.json`; §8 wording; README/CHANGELOG for every stream (each PR names its README line) | `status` < 300 ms; fresh-home run prints "what we found"; README matches every new flag |

Order: PR 0 → A–D in parallel (B's `entry.mjs` fields land day 1 because A reads `kind` and C's `summary.toolCost`
passes through `buildEntry` untouched) → integration PR by D (registry lines already in PR 0, version 0.11.0, README) →
cycle-log entry with numbers: changes rows and their `n` for this repo, harness/unattributed counts, Bash targets
gained on the reference session, top tool share, `status` timing, manifest size delta.

## Consequences

- The product's first sentence about a change is a paired table with `n` and caveats, not a verdict. That is the
  correct shape until Study 3 exists, and the experiment command makes the same shape reusable for it.
- "Unattributed" shrinks to what is genuinely unknown (3 here); SDK harness runs stop inflating the machine count
  and never enter habits.
- Claude `Bash` reads join the same fix families as Codex `exec` reads; some H-01/H-02 findings will change text after
  the re-index, and the cycle log records which.
- Two new numbers carry `estimated.local` (token-requests, uncached token-requests) and are always shown with the
  cache-read share; nothing in cycle 3 adds a blended score.
