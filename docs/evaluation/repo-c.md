# Repo C — large TypeScript/Node monorepo (modular business platform, ~20 packages, many per-module agent instruction files, Claude + Codex)
Sessions: 22 (claude 17 · codex 5) · setup findings: 27 in check (+3 violations; the scan's setup section has 49, 23 of them S-02) · session/habit rule groups: 17 (14 B-* + 3 H-*)

## Summary
Fact = the measured claim was checked against the repo or the index. Violations carry no fix, so setup fix counts cover 18 of 21.

| family | instances evaluated | fact TP | fact FP | useful | marginal | noise | fix good | weak | wrong |
|---|---|---|---|---|---|---|---|---|---|
| setup | 21 | 18 | 3 | 7 | 5 | 9 | 3 | 7 | 8 |
| session | 48 | 45 | 0 (3 unverif.) | 21 | 17 | 10 | 13 | 23 | 12 |
| habit | 6 | 5 | 0 (1 unverif.) | 2 | 3 | 1 | 2 | 3 | 1 |
| first change | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| **total** | 76 | 69 (91%) | 3 | 30 (39%) | 26 | 20 | 18 (24%) | 34 | 21 |

The measurements are almost always right. Most failures are in how a finding is read and in which fix it proposes.

## Per rule
| rule | title | evaluated | fact TP/FP/unverif | relevance u/m/n | fix g/w/wr | key reason |
|---|---|---|---|---|---|---|
| VIOL | check violations | 3 | 3/0/0 | 2/1/0 | n/a | Byte sizes match. The codex budget violation and the AGENTS.md file violation report the same 8,669 figure. The claude budget names `CLAUDE.md`, an 11-byte `@AGENTS.md` stub. |
| S-01 | chain / nested file oversized | 6 | 6/0/0 | 4/1/1 | 3/3/0 | All sizes are exact. Root chain: useful, but the fix sends shared AGENTS.md content to claude-only `.claude/rules`. Nested files: ai-assistant, core and workflows really get injected (nested CLAUDE.md `@AGENTS.md`). `modules/staff` has no CLAUDE.md, so "loads whenever the model works under…" is false for Claude. `create-app/template` sits 42 tokens over the threshold. |
| S-06 | No rules scoping | 1 | 1/0/0 | 0/1/0 | 0/1/0 | True (no `.claude/rules`), but it repeats S-01 with the same fix path. |
| S-02 | Duplicate instruction blocks | 5 | 5/0/0 | 0/0/5 | 0/0/5 | The shared lines exist, but they are a 5-line "Validation Commands" boilerplate (heading + 3 yarn commands) or a 6-line code sample. Sibling modules never load together, so pointing `sales` at `customers` (and at `customer_accounts`, in another finding) saves ~60 tokens and hurts readability. |
| S-05 | references a missing path | 4 | 1/3/0 | 1/0/3 | 0/1/3 | FP: `lib/tokens/computeAgentTokenUsageFromDir` is a module/function reference (the function exists in `lib/tokens/computeAgentTokenUsage.ts`). FP: three dated filenames listed as naming-format examples. FP: `.github/copilot-instructions.md` is the output path in a generated app (the template exists). TP: `docker/opencode/opencode.json` is stale (real file is `opencode.jsonc`), but the same finding also lists `vendor/` (from "vendor/model ids"), which is FP. |
| S-09 | MCP server unused | 2 | 2/0/0 | 0/2/0 | 0/2/0 | 0 invocations is true. The "~1500 schema tok/request" is a flat guess (tools are deferred). The project server is untracked and opted in via `enabledMcpjsonServers`, so "remove it from .mcp.json for everyone" is wrong. Duplicates H-06. |
| B-08 | Running hot | 3 | 3/0/0 | 3/0/0 | 3/0/0 | Index confirms 262 and 134 requests above 800k of a 1M window (peak 999k), and 12 codex requests above 80% of 258k. |
| B-02 | Repeated fat results | 4 | 4/0/0 | 3/1/0 | 1/3/0 | Recomputed with the rule's classifier: 124 file / 1,014,146 tok, 59 / 382,588, 9 / 54,701 — exact. The shell variant's fix (head/grep) is good. The file variant's "≤200 lines per Read" rule fights spec-review subagents whose task is to read 50–150 KB specs. |
| B-07 | Frequent compaction | 1 | 1/0/0 | 1/0/0 | 0/1/0 | 3 auto compactions, 34-min gap, confirmed. The fix points at startup mass (S-01), but 70–79% of the peak was tool results. |
| B-05 | Fat subagent handoff | 4 | 4/0/0 | 0/2/2 | 0/4/0 | Handoff sizes match the index. A 4.4k handoff after 244k of work (55x compression) is not "fat"; the 4k threshold is too low. "Return findings, not transcripts" does not fit handoffs that are already 10–55x compressed. |
| B-13 | Session too long | 4 | 4/0/0 | 3/1/0 | 3/1/0 | The top sessions are real (14.1 h / 642M, 5.1 h / 340M, 2.9 h / 143M). But the rule fires on 22/22 sessions, including 0.1 h / 56-request ones (3M-token threshold at ~90k context), and "split into one session per task" makes no sense for those. |
| B-17 | Tool arguments dominate | 2 | 2/0/0 | 1/1/0 | 0/2/0 | 372,902 / 957,246 = 39% confirmed from the composition data; one 75 KB Write is the largest. "Write in chunks" does not reduce the total context. |
| B-01 | Fat tool result | 4 | 4/0/0 | 3/1/0 | 1/2/1 | Codex results sit at ~40,156 B (Codex's own output cap). The index flags them `truncated`, but the evidence never says so. Top fix "Read packages/ui/src/backend/AGENTS.md in slices" targets a 6 KB file; the output was a 24k-token multi-file dump. "Truncate output" is moot when Codex already truncated it. The Explore subagent's 36 KB file fix is good. |
| B-12 | Tool results dominate | 4 | 4/0/0 | 2/2/0 | 0/4/0 | 79.3% share recomputed from the composition data. Overlaps B-01/B-14/H-01 for the same Codex sessions. The fix is generic. |
| B-14 | Search flood | 4 | 4/0/0 | 2/1/1 | 3/1/0 | These are search-category exec results, capped by Codex; "list files first, cap matches" is the right advice. The 2 × 4–5k instance is noise. |
| B-03 | Huge file read | 4 | 4/0/0 | 0/4/0 | 0/2/2 | Sizes are plausible (a 148 KB spec gives a 21.8k partial read). 2 of 9 findings print `<path>` because the Read target is missing, so the fix reads "Read only the sections of <path>". Every instance re-reports a B-01/B-02 block. |
| B-16 | Unlogged context | 4 | 3/0/1 | 3/1/0 | 0/1/3 | The jumps are real (+42k, +38k). In the verified case the jump happens at the request where nested_memory attachments for `packages/ai-assistant/CLAUDE.md` + `AGENTS.md` (0 bytes logged) appear. So the cause is nested instruction injection, but the fix blames hooks and MCP schemas. |
| B-04 | Repeated identical tool call | 4 | 4/0/0 | 0/0/4 | 2/0/2 | The browser `computer` ×11 calls have identical args, but 9 distinct result hashes: they are screenshots of changing UI, so "record once and reuse" is wrong. The Codex polling advice is fine, but 160–1.1k tok is noise. |
| B-11 | Turn overhead | 4 | 4/0/0 | 0/1/3 | 0/0/4 | The count is literally true, but 1,141 of 1,225 "tiny requests" are tool-loop continuations, not user follow-ups. "Batch small follow-ups" is the wrong fix; the tokens are B-13/B-08 counted again. |
| B-15 | Parallel duplicate work | 2 | 0/0/2 | 0/2/0 | 0/2/0 | The shared reads are conventions and spec templates each agent needs. "Give each agent a disjoint scope" does not address that; passing the shared context in the prompt would. |
| H-01 | Recurring fat result / call | 3 | 3/0/0 | 2/1/0 | 2/1/0 | exec (28, capped at 40 KB) and Bash (21) are real and the head/grep rule is good. The Write-args habit (11 big file writes) is inherent to authoring, so the fix is weak. |
| H-04 | Compaction frequency rising | 1 | 0/0/1 | 0/0/1 | 0/0/1 | All the evidence is Codex compactions (258k window) arriving in the recent window versus Claude 1M sessions before, so the ratio measures a vendor-mix change on n=7. It is labeled claude and the fix edits CLAUDE.md. |
| H-06 | MCP server never invoked | 2 | 2/0/0 | 0/2/0 | 0/2/0 | Both servers are configured and uncalled (confirmed). The snippet adds `disabledMcpjsonServers` alongside an existing `enabledMcpjsonServers` entry (the simpler fix is to remove it there). The node_repl fix says "for this project" but disables it globally. |

## First change
**B-02 "Repeated fat results" (one spec-review session, file results): fact TP, relevance marginal, fix weak.**
- The count and sum are exact (124 results, 1.01M tokens).
- Most of it is 28 subagents reading 50–150 KB spec files they were asked to review. A blanket "read ≤200 lines" rule in CLAUDE.md fights that task.
- The headline "15 sessions · 30 findings · 1.01M tokens" mixes group scope (15 sessions / 30 findings) with one finding's tokens. The leverage table shows the same group as 4.08M.
- A better first change for Repo C: the nested `CLAUDE.md → @AGENTS.md` imports. ai-assistant is 103 KB, observed as +42k tokens on first touch; core and workflows are also injected. The root AGENTS.md (31 KB) is second.

## Systematic issues
- **Pairwise explosion in S-02.** One 5-line boilerplate block shared by ~7 module files produces 23 findings in the scan (6 in check), with contradictory "keep one copy in X" targets. The rule should cluster by block hash, skip heading- or command-only blocks, and not point sibling scopes at each other.
- **S-05 treats any backticked slash-token as a path.** Here 3 of 4 findings are FP: a function reference, naming-format examples, and paths in a generated project. It should skip "Examples:" lists, `dir/symbol` forms whose prefix resolves to an existing file, and template targets that exist as `.template`.
- **Nested-file load state is not modeled.** Every nested AGENTS.md is "discoverable / loads whenever the model works under X", but Claude only loads the ones imported from a nested CLAUDE.md. Those injections, the costliest real cost here, appear only as S-01 *low*, while B-16 attributes the same tokens to "hooks/MCP".
- **Three different token figures for one file.** The root AGENTS.md is 8.67k (neutral estimate, used by check and S-01), 13.8k (the `tokens` command's claude calibration), and 10,173 in the claude budget. The scan's own claude startup budget says 75,761 instruction tokens. Setup numbers understate Claude cost by ~40–60%.
- **Codex output truncation is hidden.** The index flags the ~40 KB results as `truncated` (with `originalTokens`), but B-01/B-02/B-14/H-01 labels show "11,294 tok" dozens of times with no note, and fixes say "truncate output". Labels also leak parser artefacts: `exec null`, `exec !**/__tests__/**`, `exec exec_command`.
- **Rules that fire on nearly everything.** B-13 fires on 22/22 sessions and B-11 on 22/22. B-11's "tiny request" is a tool-loop step, so it re-counts total processed tokens (1.4B) as if it were overhead.
- **Duplicate reporting across families.** S-09 and H-06 cover the same MCP servers. B-03 re-reports B-01/B-02 blocks. B-12, B-14, B-01 and H-01 hit the same four Codex sessions.
- **The top of the terminal report is inconsistent.** The H-01 row in the leverage table is titled "exec exec_command" but sums three different H-01 habits (716k vs 293k). The first-change token count differs from its group total.

## Missed
- **Gitignored agent config is skipped.** `.claude/` and `.agents/` are gitignored, so 55 locally symlinked skills are excluded. The inventory reports skills = 883 tok (11 plugin skills), but the observed `skill_listing` attachment is ~14.8k tok in every main and subagent context.
- **Nested CLAUDE.md `@AGENTS.md` imports are not flagged.** 19 of them exist; the budget includes none of them and no setup rule reports them.
- **No finding covers repeated manual reads of instruction files.** `agent_orchestrator/AGENTS.md` (45 KB) was read twice at ~20.9k tokens in one session, and a Codex session dumped `packages/ui/src/backend/AGENTS.md` alongside others.
