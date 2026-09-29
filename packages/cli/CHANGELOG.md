# Changelog

All notable changes to the `contextscope` package. Cycle detail lives in `docs/cycle-log.md` of the repository.

## 0.11.0 (unreleased) — cycle 3

Every number that compares a before to an after is observational and says so; nothing in this version adds a score or a verdict.

### Added
- **Before/after per instruction-file edit** (`index/changes.mjs`): every commit that touched `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md` (or the mtime without git) anchors two session windows; six metrics as medians per side with `n`, per-rule counts, a seeded bootstrap 90 % interval from 5 sessions per side, the model/CLI confound and a verbatim `caveats` array. `GET /api/v1/changes`, the Setup screen's per-file table, the Findings screen's "Did the last change help?" card, one block in `scan` (and `changes` in `scan --json`). H-05 is measured over the same windows. Manifest only: no run file is opened.
- **`contextscope experiment start|candidate|compare|list|show|delete <name>`**: named instruction-chain snapshots under `~/.contextscope/experiments/`, sessions assigned by start time, the same paired table (`--md`, `--json`), `--min-sessions`. No task runner, no grader, no model call.
- **Harness classification and attribution**: SDK-driven runs in a temp cwd with no tool use are `kind: "harness"`, excluded from populations, habits, trends and offenders, counted on the header and listed under `?scope=all&kind=harness`; a temp-cwd session joins a repository through file-path overlap of its tool targets or the hash of its nested instruction blocks (`attribution: { method, confidence, files? }`, an **attributed** row badge). The population line reads `3 sessions in this repo (1 attributed by file-path overlap) · 189 on this machine · 56 harness runs · 3 unattributed`.
- **Claude `Bash` classification**: a Bash command that reads (`cat`, `sed -n`, `head`, ...), searches (`rg`, `grep`), writes (heredoc, redirect) or fetches (`curl`) gets `tool.kind` and `tool.target` of that family, so H-01/H-02/H-07 and B-01 group Bash reads with `Read` and Codex `exec` reads; the block category stays `tool_result.shell` and `tool.name` stays `Bash`.
- **Cost by tool**: `scope.toolCost` (per tool: blocks, token-requests, uncached token-requests, share; `estimated.local`) in every run, summed into `summary.toolCost`; `GET /api/v1/cost` (run, scope or population), the session screen's "What cost the most" panel, the overview's "Costliest tools across sessions" panel, one `scan` line, and `toolCost` in exports.
- **First run**: `start` prints the pass progress and, when the first pass ends, a "what we found" block (files, sessions on the machine and in the repo, subagents, pass time; where the context went at peak; the fattest handoff with its ratio; the first change with its fix; the hooks state; the URL). The overview shows a first-run card during that pass (stores read, what populates them, the 3-session habit minimum). `start --json` prints `{ url, repo, repoKey, consent }` then NDJSON index events (`start`, `progress`, `done`, `found`, `live`, `live-idle`) and never opens the browser.
- **`contextscope status [--repo] [--json]`**: vendors with file counts, the repo's sessions and instruction files (sizes, load state), index entries, bytes on disk, adapter versions, rules hash, last pass and last live pass, hooks per scope with capture record counts, the `fs.watch` capability, and whether a companion is running; answers in well under 300 ms and never runs a pass; exit 0 always.
- **`~/.contextscope/server.json`** (`{ pid, port, url, repoRoot, startedAt, version }`, mode 0600, never the token) written by `start` once it listens and removed on close; `status` reports a dead pid as stale.

### Changed
- Export redaction names policy (`redaction.names: "vendor-only"`): built-in tool names, vendor agent types, hook event names and model ids stay readable; MCP server and tool names, custom agent types, skill names, hook matchers, branch names and scope descriptions are hashed with the per-export salt. The Open screen's banner says which.
- `scan` header: `Sessions 3 (claude 1 · codex 2; 1 attributed by path overlap) · … · 56 harness runs and 3 unattributed on this machine`; `Cost by tool` line after the totals; the changes block after Habits; `scan --json` gains `changes` and `cost` when present.
- Adapter versions bumped (`claude-v4`): one full re-index on the first pass; `start` and `scan` print the reason.
- Status line: deferred again (ADR-005 §8); `server.json` gives a future `contextscope statusline` a stable way to ask the running companion.

## 0.10.0 (2026-09-02) — cycle 2 and its fix wave

First published version (`npx contextscope`). Everything below is relative to 0.9.

### Added
- **Repository scoping**: the overview, `scan`, findings and habits describe the repository the companion was launched from (`--repo`, default: the current directory), all time by default; `?scope=all` / `scan --all` show the machine-wide population (last 30 days). One population rule: a session is a top-level run; Codex thread-spawn children are subagents.
- **Cross-session habits** H-01..H-06 (recurring fat reads, whole-file reads, oversized handoffs per agent type, early compaction, growing startup baseline, unused MCP servers) with `sessions` counts and starved-rule notes; daily trends; the "one change to make first" ranking.
- **Live mode**: a watcher re-parses a changed session (~250 ms for an 18 MB transcript), `live` SSE events, a live badge, tail route, and a **compaction forecast** card while a session is live.
- **Privacy-safe export**: `contextscope export --run <vendor:id> [--scopes main|all|id,id] [--redact-labels] [--md]` writes a `contextscope.export/1` document with a markdown summary; the **Open** screen (`#/open`) and the hosted demo load it in the browser.
- **Runtime evidence**: `contextscope hooks install|status|uninstall` installs a fail-open Claude Code hook (InstructionsLoaded, SessionStart, Pre/PostCompact, SubagentStart/Stop) that appends metadata-only records under `~/.contextscope/capture`; the Setup screen turns `expected.load` into `observed.loaded`.
- **CI gate**: `contextscope check` evaluates the setup only (startup budget, instruction-file sizes, broken references, S-* rules) with `.contextscope.json`, `--github` annotations and exit codes 0/1/2/3.
- Rules-hash invalidation (editing a rule or a threshold re-evaluates stored runs without re-parsing), handoff-via-attachment fallback for Claude subagents, `tool.partial`, Codex cache writes, envelope calibration.

### Changed (fix wave, ADR-004)
- Export redaction hashes labels with a **per-export random salt** (`redaction.salt`), collects labels from every scope of the run, hashes every path-like token in finding prose and evidence labels, and never hashes instruction-file names (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`, `.claude/agents/*.md`). The leak gate is substring-based over the whole document (`/Users/`, `/home/`, `C:\`, `-Users-`, `~/` outside the vendor config directories); a redacted document with any surviving path-like token is refused. The exporter enforces the importer's 50 MB cap and the markdown says which scopes were exported.
- `hooks install` writes backups to `~/.contextscope/backups/<scope>-settings-<timestamp>.json` (0600, never inside the repository, last 10 kept), pins the Node binary resolved at install time with a PATH fallback, leads with the guarantee line and warns about project/local scope; `hooks status` shows the pinned node, per-event counts, the last record time and a hint when no record has arrived; capture files are pruned (90 days / 500 files); the hook records `~/` paths only under `~/.claude` and `~/.codex`, a basename elsewhere.
- `check` deduplicates one fact reported by several rules, tags findings with the vendor, says "estimated from disk", exits 2 on usage or configuration errors and 3 on runtime errors.
- Session names, three-significant-digit numbers, forecast bounded to the live session, overview "one change first" above the table, H-06 fix un-inverted.
- Package renamed from `@contextscope/cli` to **`contextscope`**; `generator.name` in exports follows.

## 0.9.0 (2026-09-02) — cycle 1 fix wave
- Reconciliation v2 (`unlogged` category, clamped scale, per-scope estimator error), privacy-safe project keys, in-flight blocks dropped at compaction, Codex handoffs, `calibration.json`.
- Split payloads (`/runs/:vendor/:id` shell + `/scopes/:id`), gzip, `scan` command, findings aggregated per (rule, run, scope), B-16 unlogged context.

## 0.8.0 — cycle 1
- Exact per-request occupancy from vendor usage fields for Claude Code and Codex; subagent windows linked to parents; compaction boundaries; incremental index under `~/.contextscope`; setup inventory with S-01..S-12; session rules B-01..B-15; the loopback companion with the Preact UI.
