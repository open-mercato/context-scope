# Repo B — TypeScript npm-workspaces monorepo (Node server + React web UI + shared contract) that orchestrates coding-agent runs
Sessions: 34 (27 claude, 7 codex) · setup findings: 5 rules (S-01 ×2, S-05, S-06, S-09, S-12) + 7 check violations · session/habit rule groups: 15 (13 B-*, H-01, H-06)

Paths below that contain the project's own name are written as `<core>` / `~/.<tool>`.

## Summary
| family | evaluated | fact TP | fact FP | useful | marginal | noise | fix good | weak | wrong |
|---|---|---|---|---|---|---|---|---|---|
| setup (check + scan S-*) | 17 | 10 | 7 | 5 | 5 | 7 | 7 | 2 | 8 |
| session (B-*) | 40 | 36 | 4 | 18 | 12 | 10 | 10 | 23 | 7 |
| habit (H-*) | 6 | 5 | 1 | 2 | 4 | 0 | 2 | 2 | 2 |
| first change | 1 | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| **total** | **64** | **52 (81%)** | **12** | **26 (41%)** | **21** | **17** | **20** | **27** | **17** |

## Per rule
| rule | title | eval | fact TP/FP/unv | rel u/m/n | fix g/w/wr | key reason |
|---|---|---|---|---|---|---|
| S-01 (+budget/file violations) | Instruction file/chain oversized | 5 | 5/0/0 | 3/2/0 | 5/0/0 | AGENTS.md is 46.7 KB / 201 lines (tokens cmd: 12.3k codex est). Observed Codex load is ~8.7k tok, still over 6k. Clear sections exist to split out (HTTP API, Layout, Validation). The scan emits it twice, with different numbers: 12,968 file and 9,069 chain |
| S-06 | No rules scoping | 2 | 2/0/0 | 0/2/0 | 2/0/0 | True (0 nested AGENTS.md), but it repeats S-01 with the same fix |
| S-05 (+5 broken-ref violations) | Instruction references a missing path | 7 refs | 0/7/0 | 0/0/7 | 0/0/7 | All wrong. `process.env` is a JS identifier. `config.json` is a substring of `.ai/<tool>/config.json`/`~/.<tool>/config.json`. `~/.<tool>`, `~/.<tool>/`, `~/.cache/<tool>/` exist on this machine: `check` stats them against an empty temp home. The text also says these dirs are optional and written on demand. check reports 5, scan reports 2 |
| S-12 | Vendor without instructions | 2 | 2/0/0 | 2/0/0 | 0/2/0 | No CLAUDE.md, and 27 Claude sessions have to Read AGENTS.md by hand. The generic template fix ignores the existing AGENTS.md. The scan label says "(34)" Claude sessions; the real count is 27 |
| S-09 | MCP server unused | 1 | 1/0/0 | 0/1/0 | 0/0/1 | node_repl is configured, with 0 calls in the 7 codex sessions (label says 34). The fix disables it globally, but node_repl is used in 5 sessions of other repos |
| B-08 | Running hot | 1 | 1/0/0 | 1/0/0 | 1/0/0 | Peak 820,916 of a 1M window (82%), 11 hot requests, 0 compactions. The /compact advice fits |
| B-02 | Repeated fat results | 4 | 4/0/0 | 3/1/0 | 1/3/0 | Checked in the index. The top session holds 8+ subagent Reads with the same content hash as AGENTS.md (20,310 tok each). The fix ("≤200 lines" in a CLAUDE.md that doesn't exist) misses that cause. The shell instance is fine |
| B-01 | Fat tool result | 4 | 4/0/0 | 3/1/0 | 0/4/0 | Block sizes match the index. Half of the B-01 fixes say "the file"/`<path>` with no target. "Delegate browser_batch to a subagent" is weak advice for UI checks. "Read AGENTS.md in slices" treats the symptom, not the file size |
| B-03 | Huge file read | 4 | 4/0/0 | 3/1/0 | 0/4/0 | Reads are real (21–27k; they come from ~290–350 KB source files and AGENTS.md). 13 of 15 B-03 findings say "`<path>`" because paths are dropped in subagent/worktree scopes, so the fix can't be acted on |
| B-13 | Session too long | 4 | 4/0/0 | 2/1/1 | 2/2/0 | 142.7M / 851 requests / 3.0 h matches. The 3M processed-token threshold is trivial at 97% cache-read on 1M windows: a 0.4 h session gets flagged, 16 of 34 in total |
| B-11 | Turn overhead | 4 | 0/4/0 | 0/0/4 | 0/0/4 | The rule counts every agentic tool-loop request (0 user tokens) as a "tiny follow-up": 157 of 303 requests in an 8-turn session. The "batch small follow-ups" advice has nothing to act on |
| B-12 | Tool results dominate | 4 | 4/0/0 | 4/0/0 | 0/4/0 | Recomputed exactly (0.756/0.728/0.740/0.768) on 258k-window codex runs. Shell output dominates, but the fix is about search and subagents |
| B-17 | Tool arguments dominate | 2 | 2/0/0 | 2/0/0 | 0/2/0 | 207,072/535,718 = 38.65% is correct. Large Write args and Bash heredocs of HTML. "Write in chunks" doesn't lower the tokens that stay in context. Only the Edit-not-rewrite part helps |
| B-05 | Fat subagent handoff | 4 | 4/0/0 | 0/3/1 | 4/0/0 | Handoff sizes match the index (6.8k, 14.2k). At 11–19× compression into a 437–535k main context, "high" severity is overstated. The "findings only, <600 words" snippet is concrete |
| B-04 | Repeated identical tool call | 4 | 4/0/0 | 0/0/4 | 1/0/3 | Arguments really are identical (41-byte screenshot calls), but 7/7 and 8/8 results have distinct hashes because the UI changed. "Record once and reuse" is wrong advice. The codex poll is 328 tok |
| B-06 | Subagent re-reads parent files | 1 | 1/0/0 | 0/1/0 | 0/1/0 | Parent read the 3 files at requests 25/33/39 and the child launched at 42, so the claim is correct. 20k tok in a 105M session. Passing excerpts also costs tokens |
| B-14 | Search flood | 1 | 1/0/0 | 0/1/0 | 1/0/0 | One 7,070-tok grep over the ~290 KB run.ts. `rg -l`/`--max-count` is the right fix |
| B-15 | Parallel duplicate work | 3 | 3/0/0 | 0/3/0 | 0/3/0 | Sibling Explore agents overlap on target paths (AGENTS.md, core files), but ranges differ and 0 result hashes are shared, so the "tok duplicated" figure is inflated. The auto-generated "disjoint scope" snippet is arbitrary |
| H-01 | Recurring fat result/tool call | 5 | 4/1/0 | 2/3/0 | 2/2/1 | Read and exec_command are real, with good one-line rules. "Bash (shell)" has a codex `wait` result (22.9k) as its biggest item, so the CLAUDE.md fix can't reach it. The Write-args "chunk it" rule is wrong. Bash-args is weak |
| H-06 | MCP server never invoked | 1 | 1/0/0 | 0/1/0 | 0/0/1 | Duplicates S-09. It says "for this project" but the snippet edits the global config.toml |

## First change
S-01 "Instruction file oversized" (codex), fix: split AGENTS.md into nested `<subdir>/AGENTS.md`.
**fact TP · useful · fix good, but the reach is overstated.** The file is 46.7 KB, and Codex runs observably load ~8.7k tok of it. It's also the file Claude subagents Read whole again and again (20.3k each), so shrinking it helps both vendors. "Applies to 34 sessions" is inflated, though. Only 7 are codex sessions, and 2 of those never loaded AGENTS.md (cwd outside the repo). The 27 Claude sessions don't auto-load it. The advice is also codex-only while 79% of sessions are Claude. A better first change would pair the split with a short CLAUDE.md that tells agents which AGENTS.md section to read (S-12).

## Systematic issues
- **S-05 fails completely here (7/7 FP).** `check` points the inventory at an empty temp home, so every `~/` reference is "missing" by construction. check and scan disagree (5 vs 2 refs). JS identifiers (`process.env`) and bare basenames cut out of longer paths (`config.json`) are treated as paths. Duplicate forms (`~/x` and `~/x/`) are listed separately. These are CI-failing violations.
- **B-11 misreads agentic loops.** Every request whose new blocks are tool results has "0 tok new user content". The rule fires on almost any long agentic session (17/34), and its 365M "tokens affected" is meaningless.
- **Subagent/worktree scopes lose file targets.** 13/15 B-03 findings and about half of B-01 fixes show `<path>`/"the file". That hid the top actionable pattern: many subagents each Read AGENTS.md whole (verified by identical content hash 7421…, 20,310 tok).
- **The same blocks are counted by several rules** (one 25.6k read is in B-01, B-02, B-03, H-01 and feeds B-12). Leverage is ranked on processed-token sums (B-13 536M, B-11 365M, B-08 8.9M), which dwarf the per-block numbers and look alarming without being actionable.
- **Group label vs content mismatch.** The H-01 group is titled "Recurring fat result: Read (file)" but sums 5 different habits (6 sessions / 83 / 1.19M, against 4 / 36 / 615k in the habit list). The terminal "Findings by leverage" table shows that mixed row. Separately, H-01 files a codex `wait` result under Claude's "Bash (shell)".
- **Duplicates:** S-01 appears twice with different numbers (12,968 and 9,069 for the same file). S-06 restates S-01. S-09 and H-06 are the same finding. Session counts say "34" for claims that only cover codex (7) or Claude (27).
- **B-04 ignores results.** Identical screenshot calls with distinct results are normal UI-verification polling. The rule should compare result hashes before advising reuse.
- **MCP-disable fixes target the global `~/.codex/config.toml`** for a server used in other repos. "Write in chunks" (H-01, B-17) doesn't reduce context.
- The terminal top-12 list leaves out B-08 (high, the only session at >80% of window) but shows the low-severity B-11.

## Missed
- **Codex truncates AGENTS.md at the 32 KiB project-doc limit.** No override is set, and the observed block is ~8.7k tok against 12.97k for the full file. The cut falls around line 141, so the "Validation" and "Related documents" sections likely never reach Codex. The tool reports 12,968 as startup instead of flagging the truncation.
- **The root cause behind B-01/B-03/B-14 is monolithic source files** (`packages/<core>/src/server/server.ts` ~347 KB, `.../workflows/run.ts` ~291 KB). Whole-file Reads of these get capped at ~20–27k tok. A setup-level signal like "huge source files agents keep opening" would be more actionable than "read in slices".
- **Claude doesn't load AGENTS.md on its own, and nothing connects that fact to the repeated manual Reads.** The S-12 fix should point to AGENTS.md or a slim CLAUDE.md, not a generic template.
