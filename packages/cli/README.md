# ContextScope

ContextScope is a local context-window profiler for coding-agent sessions. It
reads the session transcripts Claude Code and Codex already keep on your
machine, reconstructs what occupied the model's context window request by
request (system prompt, instruction files, tool results, subagent handoffs,
compactions), and turns that into findings with a concrete fix: the file to
edit and the line to add.

**What leaves the machine: nothing.** There is no account, no model call, no
upload, no analytics. The only file that ever travels is an export you write
on purpose (`contextscope export`), and it carries sizes, hashes and counts.

Version 0.11.0 (cycle 3): a before/after table for every instruction-file
edit (observational, with `n` and caveats), harness runs classified out of the
population, Claude `Bash` reads joined to the same fix families as `Read`,
cost by tool in token-requests, a first-run "what we found" block,
`contextscope status`, `start --json`, and `contextscope experiment`.
Cycle 2 (0.10.0) brought repository scoping, cross-session habits, live mode
with a compaction forecast, privacy-safe export, the hook installer and `check`.

## One command

```bash
npx contextscope
```

`contextscope` (an alias of `contextscope start`) binds a random loopback
port, prints `ContextScope is ready: http://127.0.0.1:<port>/?token=…`, opens
the browser, and indexes your sessions in the background. The first page is a
consent screen that lists exactly which directories will be read; the index
starts only after you approve it. Use `start --yes` for trusted automation,
`--no-open` to print the URL only, `--repo <path>` to analyse a repository
other than the current one (the git top level when you are inside a work
tree), `--port <n>` to pin a port.

```bash
contextscope start           # serve the UI (alias: contextscope); --repo, --port, --no-open, --yes, --json, --concurrency
contextscope start --json --yes --no-open   # machine mode: { url, repo, repoKey } then one JSON line per index event
contextscope scan            # terminal summary for this repository, all time
contextscope scan --all      # the machine-wide population (last 30 days); findings stay repo-scoped
contextscope scan --since 90d --json   # the same numbers as JSON ({ overview, groups, findings, firstChange, habits, setup, changes?, cost? })
contextscope status          # diagnostics in under 300 ms, no index pass: vendors, index, hooks, watcher, running companion
contextscope index           # build or update the index without starting the server
contextscope index --refresh # re-parse every session file
contextscope index --clear   # delete ~/.contextscope/index
contextscope export --run claude:<id> --out session.json   # shareable export of one session (sizes, hashes, counts)
contextscope hooks install   # capture Claude Code runtime events (diff preview, backup outside the repo, reversible)
contextscope check           # CI gate over the setup: budgets, file sizes, broken refs, S-* rules
contextscope experiment start <name>   # snapshot the instruction chain; then edit, `candidate <name>`, run sessions, `compare <name>`
contextscope help            # every command with its options
```

Requires Node 20 or newer. No runtime dependencies. The published package is
`contextscope` on npm (`packages/cli` of the repository); the UI bundle ships
inside it.

## First run

With no index yet, `contextscope` prints the pass progress on stderr
(`Indexing 250 changed session file(s), 0 up to date`, then one line every
250 ms) and, when the first pass ends, a "what we found" block on stdout:

```
What we found: 250 session files · 189 sessions on this machine · 3 in context-viewer (claude 1, codex 2) · 45 subagents · 1.9 s
  Where the context went: at peak, file reads 52% · system prompt 18% · instructions 9% (3 sessions, all time)
  What subagents cost: fattest handoff Explore 38.2k tokens back from a 120k-token peak, ratio 0.31 (session Sep 1, 10:03)
  Change first: [HIGH] B-02 Repeated fat results · 3 sessions
    Fix (codex) → AGENTS.md: Add a standing rule to AGENTS.md so web results stay small.
  hooks: not installed (contextscope hooks install --scope user) · runtime evidence for the Setup screen
  Open: http://127.0.0.1:<port>/?token=…
```

The three lines are the three questions the product answers (where the
context went, what subagents cost and returned, which setup change to make
first), each with a number from the same index the UI serves. A repository
with no session yet says so and names the command that creates one. In the
browser, the overview shows a first-run card during that pass: which stores
are being read (`~/.claude/projects`, `~/.codex/sessions`, Gemini detected
only), what populates them, and that habit rules need 3 sessions of the
repository. With consent (the default) the pass starts after you approve the
scan in the browser; `--yes` starts it at once.

`start --json` is the machine mode for tooling: the first stdout line is
`{ "url", "repo", "repoKey", "consent" }`, then one JSON line per index
event (`start`, `progress`, `done`, `found` with the block's numbers, and
`live` / `live-idle` from the watcher). The browser is not opened; the token
is only in that first line.

## `contextscope status`

A diagnostic that answers in well under 300 ms and never runs an index pass
(`scan` reads and evaluates sessions; `status` reads what already exists):

```
ContextScope status · repo context-viewer (~/projects/context-viewer) · 105 ms
  vendors   claude ~/.claude/projects: 170 files · codex ~/.codex/sessions: 80 files · gemini not found
  sessions  3 in this repo (claude 1, codex 2) · 8 subagents · 124 on this machine
  setup     CLAUDE.md 4.2 KB (expected.load) · AGENTS.md 1.1 KB (observed.loaded)
  index     ~/.contextscope/index/v1 · 250 entries · 118.2 MB in 1,490 files · adapters claude-v4, codex-v3 · rules f43a48204dd98bda
  last pass 2 min ago (2026-09-02T06:41:07.688Z) · 250 changed: 170 parsed, 80 re-evaluated, 0 unchanged, 0 failed in 2.1 s
  hooks     user not installed · project no settings file · local no settings file
            0 records in 0 capture files · last record never
  watcher   fs.watch available (~/.claude/projects)
  companion not running (~/.contextscope/server.json absent) · start with: contextscope
```

Vendors come from a listing of the session directories (a head is read only
for a file the index has never seen); the repo's sessions from the manifest;
the instruction files with sizes and load state from the repository (fixture
directories excluded); index entries, bytes on disk, adapter versions and the
rules hash from `~/.contextscope/index/v1`; hooks per scope and record counts
from the Claude settings files and `~/.contextscope/capture`; the watcher line
from a one-shot `fs.watch` probe (it says when the companion would poll
instead); the companion line from `~/.contextscope/server.json`. That file
(`{ pid, port, url, repoRoot, startedAt, version }`, mode 0600, never the
token) is written by `start` once it listens and removed on close; a file
whose pid is dead is reported as stale, never as running. `--json` mirrors
the lines as one object; exit code 0 always, each section degrading to an
`error` string on its own.

## Scope and time range

Every screen and `scan` describe **the repository the companion was launched
from** (`--repo`, default: the current directory). A session belongs to the
repository when its working directory is the repository root or a folder
inside it (worktrees included); a session is a top-level run (Codex
thread-spawn children are subagents of their parent, never sessions). The
`?scope=` parameter switches the overview between that population and the
whole machine:

| | `scope=repo` (default) | `scope=all` |
|---|---|---|
| Sessions | this repository | every indexed session on the machine |
| Default range | **all time** (repo sessions are few; a 30-day window hides a repo last touched in the spring) | **last 30 days** |
| `since=` | `30d`, `90d`, `all`, `12h`, or an ISO date | same |
| Findings, habits, first change, cost by tool, changes | always repo-scoped, all time | same |

The overview header shows the population (`3 sessions in this repo (1
attributed by file-path overlap) · 189 on this machine · 56 harness runs · 3
unattributed`) and the range, with a `30d | 90d | all` selector; `scan`
prints the same counts on its header lines. Two kinds of session never
inflate a repository:

- **Harness runs** (`kind: "harness"`): SDK-driven runs in a temp isolation
  directory with no tool use (an eval harness, a one-shot script). They are
  excluded from the repo and machine populations, habits, trends and
  offenders, counted on the header, and listed under `?scope=all&kind=harness`.
  A user's own SDK app is a harness run too; a temp-cwd session with tool
  calls never is.
- **Unattributed** sessions: top-level runs no project can claim (a temp
  cwd whose tool targets overlap no repository, a Claude project directory
  whose encoded path is ambiguous). A temp-cwd session whose tool targets
  overlap the repository's files, or whose nested instruction blocks hash to
  the repository's instruction files, joins the repository as *attributed*
  with the method and confidence on the row badge.

## What it reads

| Vendor | Location | State |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/` (honours `CLAUDE_CONFIG_DIR`) | parsed |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (honours `CODEX_HOME`) | parsed |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/` (honours `GEMINI_CLI_HOME`) | detected and counted only; no adapter yet |

Plus the repository you launch from: `CLAUDE.md`, `AGENTS.md`, `.claude/`
(rules, skills, agents, hooks, settings), `.codex/config.toml`, `.mcp.json`,
and `git log` for the instruction files (edit anchors; the mtime when there
is no git). ContextScope never walks your home directory and never reads
credentials.

## Privacy statement

Everything ContextScope writes lives under `~/.contextscope` (mode 0700):

| Path | Holds | Written by |
|---|---|---|
| `index/v1/manifest.json` | one entry per session file: size, mtime, project key, per-session summary and statistics | `start`, `scan`, `index` |
| `index/v1/runs/<vendor>/<hash>/` | `shell.json` (run metadata, per-scope summaries), `findings.json`, `scopes/<id>.json` (per-request usage, per-block sizes) | same |
| `thresholds.json` | your threshold overrides | the UI, or you |
| `server.json` | `{ pid, port, url, repoRoot, startedAt, version }` of the running companion (0600; never the token); removed on close | `start` |
| `experiments/<name>.json` | instruction-chain snapshots (paths, sizes, hashes) of a named experiment | `experiment start` / `candidate` |
| `bin/capture.mjs` | the Claude Code capture hook (mode 0700) | `hooks install` |
| `capture/<sessionId>.jsonl` | hook records: event names, session id, project key, relative paths (files 0600; pruned after 90 days / 500 files) | the installed hook |
| `backups/<scope>-settings-<timestamp>.json` | copies of a Claude `settings.json` taken before `hooks install` / `uninstall` (0600, last 10 per scope) | `hooks install`, `hooks uninstall` |

Blocks carry sizes, content hashes, tool names, attachment types and
repo-relative labels. No message text, prompt text, tool output, file content,
or absolute path outside your home directory is stored or served; the keys
`content`, `text`, `stdout`, `stderr` and `prompt` are stripped before any run
reaches disk, and a release-gate test runs the real adapters over synthetic
fixtures to assert that neither content nor absolute paths survive into the
index, the API or an export. Session-file paths inside the manifest are the
only absolute paths on disk; every path served over HTTP is `~`-relative, and
the Claude project directory (an encoded working-directory path) is replaced
by a hash.

`contextscope index --clear` deletes the index; `rm -r ~/.contextscope`
deletes everything (after `hooks uninstall`, so no settings file points at a
missing script; the hook is fail-open either way).

The server accepts loopback connections only, checks the `Host` header,
requires the launch token as `Authorization: Bearer` on every API route (the
token is accepted as `?token=` on the first page load and on the event stream
only, and the served page moves it out of the URL immediately), rejects
cross-origin state changes, and sends `referrer-policy: no-referrer`.

## Screens

- **Overview**: the repository's sessions (or the machine's, with the scope
  toggle and the `30d | 90d | all` range) with peak occupancy, window share,
  compactions and subagents; the one change to make first; totals and daily
  trends (sessions, peak share, startup H0, instruction-file edit markers);
  the largest blocks and the fattest handoffs with the child's peak and the
  ratio; **costliest tools across sessions** (token-requests, estimated, with
  the cache-read share). A session whose transcript changed in the last
  minutes carries a **live** badge; a session that joined the repository
  through evidence carries an **attributed** badge naming the method. During
  the very first pass the screen shows the first-run card instead of rows.
- **Session**: the occupancy chart of one session (request by request, stacked
  by category, compactions marked), subagent lanes, a block ledger, a **What
  cost the most** panel (per tool, token-requests and uncached token-requests
  with the cache-read share), the findings that apply to it, and while the
  session is live a **compaction forecast** card (tokens per request and
  minutes until the auto-compaction threshold, with the threshold's
  provenance) and a "Follow newest" toggle.
  The **Export** button downloads the session as a `contextscope.export/1`
  document; the *redact* checkbox hashes labels and the project name.
- **Setup**: the instruction chain, skills, agents, hooks, MCP servers and the
  startup budget of the launched repository (disk estimate next to the
  observed value), with what the sessions actually observed (hook runs, skill
  invocations, MCP tools, files reported by the hook). Each instruction file
  expands into its **before/after** table: the sessions before and after each
  edit (a commit, or the mtime), six metrics as medians with `n` per side, a
  90 % interval only from 5 sessions per side, the model/CLI confound, and
  the caveats verbatim; deltas are never coloured green. Files under test
  fixture directories (`test/fixtures`, `__fixtures__`, ...) are listed as
  excluded and never counted.
- **Findings**: every finding for the repository grouped by rule (setup,
  session, subagent and **habit** chips), ranked by severity, tokens affected
  and the number of sessions it recurs in; the top card is the
  leverage-ranked first change, followed by **"Did the last change help?"**,
  the newest instruction-file edit with at least 2 sessions per side (or one
  muted line saying why there is none). Habit rules that need more sessions
  than the repository has say so ("needs 3 sessions, you have 1").
- **Open** (`#/open`): load an exported session (file picker or drop zone)
  into the same UI; the hosted demo uses the same screens over static files.

## API

All routes live under `http://127.0.0.1:<port>/api/v1/` and need the token.
Large JSON bodies are gzip-encoded when the client accepts it.

| Route | Returns |
|---|---|
| `GET overview?scope=repo\|all&since=30d\|90d\|all&limit=200&nested=1&kind=harness` | `Overview`: `scope` (population line with `attributed` and `harness` counts), rows (newest first; `live: { at }` on sessions changed recently; `attribution: { method, confidence, files? }` on sessions claimed by evidence), totals, trends, top offenders, `firstFinding`, `range`, `since` (ISO or `null` for all time), `vendors`, and `index: { files, indexed, failed, runsInRange, state, lastPass }`; `kind=harness` with `scope=all` lists the harness runs |
| `GET habits?since=` | `{ findings, groups, notes, sessions, trends }`: cross-session habit findings (H-01..H-07) of the repository, evaluated from the index at read time |
| `GET changes?since=&file=` | `{ changes: Change[], notes, sessions, files }`: the before/after table per instruction-file edit (newest anchor first, at most 20; anchors with an empty side become notes); manifest only |
| `GET cost?scope=repo\|all&since=` or `cost?run=<vendor:id>[&scope=<scopeId>]` | `CostResponse`: `{ unit: "token-requests", provenance: "estimated.local", scope, denominator, rows, caveats }`; the population form sums `summary.toolCost` over the manifest, the run form reads the run shell |
| `GET runs/:vendor/:id` | `Run` + `findings`; `scopes[0]` is the main scope in full, every child scope is a summary (`partial: true`, `requestCount`, `blockCount`, `peak`, `handoff`, `topBlocks`, ...) |
| `GET runs/:vendor/:id/scopes/:scopeId` | one full `AgentScope` (404 when unknown) |
| `GET runs/:vendor/:id/tail?after=&scope=&sig=` | `RunTail`: the requests, blocks, compactions and forecast appended since request `after` (`rebased: true` = reload) |
| `GET runs/:vendor/:id/export?scopes=main\|all\|id,id&redact=1` | `contextscope.export/1` document as an attachment |
| `GET findings?scope=setup\|session\|subagent\|habit&vendor=` | `{ findings, groups, firstChange }`; each finding carries `recurrence` (sessions of the repository where the rule fired) |
| `GET setup` | `SetupInventory` (+ `excluded` fixture files) + setup `findings` + `sessionStats` |
| `GET` / `PUT thresholds` | `Thresholds` (PUT validates keys, rejects negative values and re-evaluates stored findings) |
| `GET index/events` | server-sent events: `state`, `start`, `progress`, `done`, `live` (sticky per run), `live-idle` |
| `POST index/refresh?force=1` | `{ ok, started, queued }` |

Shapes are typed in `src/ir/types.ts`.

## Thresholds and rules

Rules live in `src/rules/` (`S-*` for setup, `B-*` for sessions and
subagents, `H-*` for cross-session habits); their thresholds are documented in
`src/rules/thresholds.md`. Override any threshold from the UI or by writing
`~/.contextscope/thresholds.json`. The index stores a hash of the rule sources
and thresholds per run; editing a rule or a threshold re-evaluates the stored
runs on the next pass without re-parsing (`scan`, `start` and `index` print
`rules changed: N stored run(s) ... re-evaluated` when that happens).

## Habits (cross-session)

Session rules fire per run; habit rules (H-01..H-07) look across every session
of the repository, all time, using only the compact records the index keeps
per run (top fat results, whole-file reads, agent handoff sizes, compaction
cadence, startup H0, MCP servers invoked): a recurring fat `Read` of the same
file, the same file read whole in session after session, a subagent type whose
handoffs are routinely oversized, compaction that always arrives early, a
startup baseline that keeps growing (H-05, now measured over the same
before/after windows as the changes table), an MCP server that is configured
but never used, the same file re-read inside one session. A Claude `Bash`
command that reads a file (`cat src/big.ts`, `sed -n`, `head`), searches
(`rg foo src`), writes (a heredoc or redirect) or fetches (`curl`) is
classified into that fix family with its target, so Bash reads group with
`Read` and Codex `exec` reads; the block's chart category stays
`tool_result.shell` (what the model saw) and `tool.name` stays `Bash`. Each habit finding carries `sessions` (how many it spans) and takes part
in the "one change to make first" ranking with the same leverage formula as
session findings (severity weight × min(sessions, 10)). They appear under the
`habit` chip on the Findings screen, in `scan`, and at `GET /api/v1/habits`.
A rule that needs more sessions than the repository has is listed as starved,
with the count it needs.

## Before/after per instruction-file edit

Every edit of an instruction file (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`,
...) is an anchor: a commit that touched the file (`git log`, read-only) or,
without git, the file's mtime. The sessions of the repository that started
before the anchor and after it form two windows, and six metrics are compared
as medians per side (startup H0, peak share of the window, compactions per
hour, processed input per request, findings per session, handoff sizes),
with the per-rule count (`B-02 in 0/4 (was 7/9)`), a seeded bootstrap 90 %
interval of the difference only when both sides have at least 5 sessions,
and the model/CLI confound. It is manifest arithmetic: no run file is opened.

The vocabulary is deliberately observational. Every `Change` carries a
`caveats` array (`observational: sessions are different tasks`, `N before / M
after`, the confound line, `startup H0 is a local estimate`, `n small` when
there is no interval) and `claim: "observational"`; the UI never colours a
delta green, `scan` prints one block after Habits:

```
Since the last instruction edits (observational: sessions are different tasks)
  Since CLAUDE.md (Sep 2, commit): 4 sessions vs 9 before · startup 12.1k → 10.9k · B-02 in 0/4 (was 7/9) · compactions/h 1.2 → 0.9 · n small · observational
```

`scan --json` carries the same rows as `changes`; the API serves them at
`GET /api/v1/changes`; the Setup screen shows the table under each file and
the Findings screen shows the newest one as "Did the last change help?".

## `contextscope experiment`

The same engine, with named anchors instead of commits, for a change you
want to evaluate on purpose:

```bash
contextscope experiment start fewer-reads      # snapshot the instruction chain (paths, sizes, hashes) as the baseline
# edit CLAUDE.md / AGENTS.md
contextscope experiment candidate fewer-reads  # snapshot again; refused when nothing changed
# work for a while (at least --min-sessions 2 per side)
contextscope experiment compare fewer-reads    # the before/after table; --md or --json
contextscope experiment list | show <name> | delete <name>
```

Sessions of the repository started in `[baseline, candidate)` are the
baseline, in `[candidate, now)` the candidate; a session that started before
the baseline snapshot is excluded, and Codex sessions whose instruction size
matches neither snapshot are listed as unverified. The report's first line
says what it is not: no task runner, no grader, no model call, no causal claim.
Snapshots live in `~/.contextscope/experiments/<name>.json`.

## Cost by tool

For every scope the index keeps `toolCost`: per tool (built-in tools by name,
an MCP tool by `server/tool`, `Agent handoffs`, attachments; top 8 + `other`)
the **token-requests** its blocks accounted for (the block's estimated tokens
summed over every request it was present in, scaled by the reconciliation
factor of that request) and the **uncached** token-requests (the same, times
the request's non-cache-read share). The unit is deliberately not tokens: a
block that stays in the window for 200 requests costs 200 times its size in
processing, and a cached token costs roughly a tenth of a fresh one on
Claude, so every row shows the cache-read share next to the number. Presence
is not attention; a block dropped at a compaction stops accruing; shares sum
to at most 1. `scan` prints one line (`Cost by tool: Bash 29% (cache-read
96%) · exec 15% · Read 14% … — token-requests, estimated`), the session
screen a sortable panel, the overview the population aggregate, the API
`GET /api/v1/cost`, and exports carry `toolCost` unchanged.

## Live mode and the compaction forecast

While `contextscope start` runs, a watcher (`fs.watch`, polling fallback)
follows the transcript directories that changed in the last 15 minutes. A
change re-parses that one session (typically well under a second; the rail
shows the measured re-parse time) and broadcasts a `live` event; the overview
row and the session header show a **live** badge, and the session view fetches
only the appended requests through the tail route. The forecast card is shown
only while the session is live: it fits the last requests' slope and says how
many requests and minutes remain before the auto-compaction threshold
(observed from earlier compactions when available, otherwise an estimated
share of the window; the card names which), and says "not within this
session" instead of extrapolating far past what was measured. After two
minutes without a change the run goes `live-idle`. Nothing here keeps adapter
state: every live update is a fresh parse of the file on disk.

## Export and open

```bash
contextscope export --run <vendor:id> [--out file.json] [--scopes main|all|id,id] [--redact-labels] [--md]
```

writes a `contextscope.export/1` document: the run, the selected scopes (the
main scope always; child scopes as summaries unless selected), the findings,
the thresholds in force and a markdown summary that says which scopes it
covers ("main scope exported (1,365 of 1,817 requests); 16 subagent scopes
summarised only"). The session screen's **Export** button produces the same
document. Open one with the **Open** screen (`#/open`, file picker or drop
zone) in any ContextScope UI, including the hosted demo, which runs the same
bundle over static files. Importers refuse files above 50 MB, so the exporter
refuses to write one and suggests `--scopes main`.

What an export carries, by mode:

| | plain (default) | `--redact-labels` |
|---|---|---|
| Token counts, sizes, content hashes, tool names, timings, findings | yes | yes |
| Repo-relative file labels (`src/index.ts`), block labels, the project name, `~`-relative `source.file` and `cwdDisplay`, the git branch | readable | hashed |
| Paths quoted in finding prose and fix snippets | readable | hashed, token by token |
| Instruction-file names (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`, `.claude/agents/*.md`, `~/.claude/settings.json`) | readable | readable (the product's vocabulary, never hashed) |
| Built-in tool names (`Read`, `Bash`, `exec`, ...), vendor agent types (`Explore`, `Plan`, `general-purpose`, ...), hook event names, model ids | readable | readable (vendor vocabulary) |
| MCP server and tool names (`mcp__<server>__<tool>`, `tool.server`), custom agent types, skill names, hook matchers, branch names, scope descriptions | readable | hashed (`redaction.names: "vendor-only"`; equal names stay equal) |
| Message text, prompts, tool output, file contents, absolute paths | never | never |

Redaction hashes every label with a random salt drawn per export
(`redaction.salt`, `h:` + 10 hex of a salted sha1): equal labels stay equal
inside one document, and the hashes cannot be reversed with a dictionary or
correlated across documents. Labels are collected from every scope of the run,
exported or not, so a child-scope path quoted in a finding is rewritten even
with `--scopes main`. Two gates run over the whole serialised document,
markdown included, before anything is written: no absolute path in any mode
(`/Users/`, `/home/`, `C:\`, the encoded `-Users-` form, or `~/` outside
`~/.claude`, `~/.codex` and the two display fields), and in redacted mode no
path-like token at all (a slash between name characters, or a file
extension). An export that fails a gate is refused, not written. Plain exports
are for your team; redacted exports can leave it.

## Runtime evidence: `contextscope hooks` (Claude Code)

Transcripts do not record which instruction files Claude Code loaded. The
`InstructionsLoaded` hook does, so ContextScope can install a small capture
hook that turns `expected.load` into `observed.loaded` on the Setup screen,
confirms compactions (`hookObserved`) and fills subagent start/stop times.

```bash
contextscope hooks install --scope user --dry-run   # show the settings.json diff, write nothing
contextscope hooks install --scope user --yes       # user (~/.claude/settings.json or $CLAUDE_CONFIG_DIR/settings.json), project (.claude/settings.json) or local
contextscope hooks install --events instructions,compaction   # a subset of the six events
contextscope hooks install --scope project --repo ../other --yes   # --repo picks the repository for project/local scope
contextscope hooks status                            # installed events per scope, pinned node, script state, record counts, last record
contextscope hooks uninstall --scope user --yes      # remove only ContextScope's entries
```

The guarantee, printed first by the command: **nothing is written without
`--yes` or your confirmation, and `hooks uninstall` removes only these
entries.** Then the command says exactly what changes: one matcher-less hook
group per event (`InstructionsLoaded`, `SessionStart`, `PreCompact`,
`PostCompact`, `SubagentStart`, `SubagentStop`) is appended to the settings
file, existing hooks and settings are kept (a file that is not
`JSON.stringify`-shaped is re-serialised, and the command says so), the
current file is copied to `~/.contextscope/backups/<scope>-settings-<timestamp>.json`
first (mode 0600, never inside the repository, the last 10 per scope kept),
and the capture script lands in `~/.contextscope/bin/capture.mjs` (mode 0700,
zero dependencies). Every write is previewed as a unified diff and refuses a
file that is not valid JSON. Undo: `hooks uninstall`, or copy the backup back.
For `project` and `local` scope the command warns that the file is usually
committed or shared, and that teammates without the script run a fail-open
no-op on every event until they install ContextScope.

The hook command is

```
sh -c '"<node resolved at install>" "$HOME/.contextscope/bin/capture.mjs" 2>/dev/null || node "$HOME/.contextscope/bin/capture.mjs" 2>/dev/null || true'
```

(5 s timeout). The Node binary is the one that ran the installer
(`process.execPath`), because Claude Code launched from a GUI or a shell
without nvm/asdf may have no `node` on its PATH, which would make the hook a
silent no-op; a bare `node` is the fallback, and `|| true` means a missing
Node or a broken script can never block Claude. `hooks status` shows the
pinned path, whether it still exists, what `node` resolves to on the current
PATH, per-event record counts and the time of the last record, and prints a
hint when a hook is installed but no record has arrived. ContextScope's
entries are recognised by the `.contextscope/bin/capture.mjs` marker, so
install is idempotent and uninstall is exact. The `sh -c` wrapper means the
hook is POSIX-only (macOS, Linux, WSL); there is no Windows support yet.

What is captured, per event, into `~/.contextscope/capture/<sessionId>.jsonl`
(directory 0700, files 0600, pruned after 90 days or beyond the newest 500
files): `{ v: 1, at, event, sessionId, cwdKey, transcript }` plus `file`,
`loadReason`, `memoryType` (InstructionsLoaded), `source` (SessionStart),
`trigger` (Pre/PostCompact), `agentId`, `agentType`, `agentTranscript`
(SubagentStart/Stop). `cwdKey` is the same `basename-sha1[0:8]` project key
the index uses; every path is repo-relative, `~`-relative only under
`~/.claude` or `~/.codex` (with the Claude project directory replaced by that
key), and a basename anywhere else, so a record for one repository never
names another. The field whitelist follows the Claude Code hooks reference;
`memory_type` and `agent_transcript_path` are undocumented but observed in
CLI 2.1.258 payloads and are kept, and an absent field writes nothing, so a
vendor rename costs coverage (visible as a zero in `hooks status`), never
privacy. Prompt text, `custom_instructions`, `last_assistant_message`,
summaries and environment never reach disk: the script whitelists fields, an
unknown event writes nothing, and malformed input exits 0. The test suite
installs the hook into a temporary `CLAUDE_CONFIG_DIR`, runs the installed
command through `sh` with a synthetic `InstructionsLoaded` payload and reads
the record back.

To remove everything: `contextscope hooks uninstall --scope <scope> --yes`
for each scope you installed, then `rm -r ~/.contextscope/bin
~/.contextscope/capture ~/.contextscope/backups`.

## CI gate: `contextscope check`

`check` evaluates the setup inventory and the `S-*` rules for one repository
and exits non-zero when the setup regresses. It reads no sessions, no index,
nothing under `~/.contextscope`, and by default nothing under your home
directory either (`--user-config` opts the user-level `CLAUDE.md`, settings
and MCP servers in; `CI=1` keeps them out regardless), so the same repository
gives the same verdict on a laptop and on a runner, in well under a second.

```bash
contextscope check                                   # this repository, defaults or .contextscope.json
contextscope check --repo ../other --budget startup=6000 --max-instruction-file 3000
contextscope check --no-broken-refs --fail-on medium --github
contextscope check --user-config                     # include ~/.claude/CLAUDE.md, ~/.claude/settings.json, ~/.codex/config.toml
contextscope check --json
```

Output is one row per vendor startup budget (marked "estimated from disk":
without sessions the budget is computed from file sizes), one row per
violation (instruction file over `instructionFileTokens`, missing reference),
then the rule findings with their severity and vendor, and a summary line. One
fact reported by several rules is folded into one row (`folded` in `--json`).
Exit codes: `0` pass, `1` violations or findings at or above `--fail-on`, `2`
usage or configuration error (bad flag, invalid `.contextscope.json`, missing
repository), `3` runtime error (an unreadable file, a rule that threw), so a
crash is never mistaken for a verdict. `--github` adds
`::error file=<path>,line=1::…` annotations (and `::warning` for findings
below `--fail-on`). Rules that need observed sessions (`S-09` MCP server
unused, `S-10` memory, `S-11` hook stdout) are off in `check` unless the
config turns them on; nested instruction files that only load lazily are
reported by the rules but never count as violations.

`<repo>/.contextscope.json` (flags override the file):

```json
{
  "budgets": { "startupTokens": 6000, "instructionFileTokens": 3000 },
  "failOn": "high",
  "brokenRefs": true,
  "rules": { "S-05": "off" },
  "thresholds": { "rulesScopingMinTokens": 2000 },
  "vendors": ["claude"],
  "ignore": ["packages/cli/test/fixtures/**"]
}
```

| Key | Meaning |
|---|---|
| `budgets.startupTokens` | Maximum startup budget per vendor (instructions + skills + agents + MCP schemas); also caps the `S-01` chain threshold |
| `budgets.instructionFileTokens` | Maximum estimated tokens for one instruction file (`--max-instruction-file`) |
| `failOn` | `high`, `medium` or `low`: the lowest severity that fails the check |
| `brokenRefs` | `false` disables missing-reference violations and `S-05` (`--no-broken-refs`) |
| `rules` | `{ "S-NN": "on" \| "off" }` per setup rule |
| `thresholds` | Numeric overrides for any key in `src/rules/thresholds.setup.json` |
| `vendors` | Vendors to evaluate; default: inferred from the repository (`CLAUDE.md`/`.claude`, `AGENTS.md`/`.codex`, `GEMINI.md`) |
| `ignore` | Glob list (`*`, `**`, `?`) of repo-relative paths excluded from violations and findings |

The ADR form `{ "check": { "budget": { "startup": 6000 }, "maxInstructionFile": 3000, "brokenRefs": false, "failOn": "high" } }`
is accepted as an alias.

GitHub Actions (this repository runs the same gate on itself in
`.github/workflows/check.yml`):

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx contextscope check --budget startup=6000 --no-broken-refs --fail-on high --github
```

## Limitations

- Token counts labelled `observed.vendor` come from the vendor's usage fields.
  Per-block sizes are `estimated.local` (a calibrated bytes-per-token
  estimator; the calibration constants and the measured error live in
  `src/ir/calibration.json`) and are reconciled against the observed totals
  request by request. The session screen shows the estimator error of the
  scope on screen.
- Input the model saw that is not in the transcript (a resumed history, hidden
  injections) is reported as `unlogged`, never as system prompt.
- Codex rollouts with `history_mode: legacy` children may have no logged input
  for most requests; they are flagged as incomplete.
- Gemini CLI sessions are counted but not parsed.
- Codex reports `cache_write_input_tokens` from 0.146.0 on, but the value is 0
  in every local rollout, so Codex cache creation shows as 0 rather than
  unknown.
- The capture hook is POSIX-only (`sh -c`); no Windows support yet.
- The before/after table and `experiment compare` are observational: the
  sessions on each side are different tasks, and the report says so on
  every row. There is no task runner, no grader and no causal claim.
- Harness classification is a heuristic (SDK entrypoint, temp cwd, no tool
  use); a user's own SDK app is a harness run too. The count is on the
  header and the runs stay listed under `?scope=all&kind=harness`.
- `toolCost` is `estimated.local`: presence in the window, not attention.
  Runs indexed before the field existed show no row until re-indexed
  (`scan` and `status` say how many).

## Development

```bash
cd packages/cli && npm test                     # node --test test/*.test.mjs
node src/contextscope.mjs status                # a diagnostic that must stay under 300 ms (test/status.test.mjs asserts it)
cd packages/ui && npm install && npm run build  # writes packages/cli/ui/ (index.html, app.js, app.css)
cd packages/ui && npm run dev                   # UI against fixtures in packages/ui/dev/fixtures
node src/contextscope.mjs start --yes --no-open # server without the consent page
cd packages/cli && npm pack --dry-run           # what ships: src/, ui/, README, CHANGELOG, LICENSE (prepack refuses a stale or missing UI bundle)
```

Fixtures under `test/fixtures/` are synthetic and generated by the
`make-fixtures.mjs` scripts next to them; never copy a real transcript into
the repository. Release steps and the provenance workflow are in
`docs/publishing.md`; changes per version in `CHANGELOG.md`.
