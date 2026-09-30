# Repo A — TypeScript/Next.js npm-workspaces monorepo (app/core/db/ui packages) with spec-driven docs (.ai/specs) and a large agent-skill pipeline
Sessions: 54 (37 claude, 17 codex) · setup findings: 8 (S-01×3, S-02, S-05, S-06, S-09, S-10) + 10 check violations · session/habit rule groups: 19 (15 B-*, 4 H-*)

## Summary
| family | instances evaluated | fact TP | fact FP | useful | marginal | noise | fix good | weak | wrong |
|---|---|---|---|---|---|---|---|---|---|
| setup | 14 | 7 | 7 | 2 | 4 | 8 | 5 | 1 | 8 |
| session | 43 | 32 (+11 unverif.) | 0 | 15 | 16 | 12 | 17 | 15 | 11 |
| habit | 9 | 7 | 2 | 4 | 3 | 2 | 3 | 5 | 1 |
| first change | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| **total** | **67** | **47** | **9** | **21** | **24** | **22** | **25** | **22** | **20** |

Fact precision on checked instances 47/56 = 84% (all 9 FPs in two rules: S-05, H-02). Useful 21/67 = 31%; fix good 25/67 = 37%, wrong 20/67 = 30%.
S-05 is counted per broken ref (7 instances). The 10 check.json violations repeat S-01 (3 budget/file violations, all TP) and S-05 (7 broken refs, all FP).

## Per rule
| rule | title | eval | fact TP/FP/unv | relevance u/m/n | fix g/w/wr | key reason |
|---|---|---|---|---|---|---|
| S-01 | Instruction chain / file oversized | 3 | 3/0/0 | 1/2/0 | 3/0/0 | AGENTS.md is 24.6 KB / 408 lines and far over 3k. But the three instances plus S-06 all describe one problem. Numbers disagree: 6,835 here, 11.6k (claude) / 7.3k (codex) from `tokens`, and the codex chain is reported as 6,692 while its two listed files add up to 7,024. |
| S-06 | No rules scoping | 1 | 1/0/0 | 0/1/0 | 1/0/0 | True: there is no .claude/rules. Duplicates the claude S-01 instance. |
| S-02 | Duplicate instruction blocks | 1 | 1/0/0 | 1/0/0 | 0/0/1 | The "Security Rules" section of AGENTS.md is a near-verbatim copy of the user-global file (17 of 19 lines), but only 9 lines / 108 tok are reported. Fix is wrong: it moves the rules out of a repo-shared file into a personal home file, so codex and teammates lose them. |
| S-05 | Instruction references a missing path | 7 | 0/7/0 | 0/0/7 | 0/0/7 | Every ref is a code span in prose: a negation ("not organized into `modules/`"), an identifier (`process.env`, `NextResponse.json`), import examples (`./foo`, `./foo.js`), a naming template and an example filename. |
| S-09 | MCP server unused (node_repl) | 1 | 1/0/0 | 0/1/0 | 1/0/0 | The server is configured at user scope and has 0 calls across 17 codex sessions. The ~1.5k schema tokens are an estimate. Correct config file. |
| S-10 | Memory missing | 1 | 1/0/0 | 0/0/1 | 0/1/0 | The memory dir has been empty since the first session. The repo already keeps durable memory in `.ai/lessons.md` + AGENTS.md, and the rule does not apply to codex sessions. |
| B-08 | Running hot | 1 | 1/0/0 | 1/0/0 | 1/0/0 | Codex: 19 requests at 80–86% of a 258k window. Consistent with the B-07 pre-compaction sizes. |
| B-02 | Repeated fat results | 4 | 4/0/0 | 3/1/0 | 2/2/0 | Counts look right (the top session has about 120 results over 3k). The title suggests the same result repeated, but the rule means "many fat results". The codex instance is results already capped at about 10k. |
| B-07 | Frequent compaction | 1 | 1/0/0 | 1/0/0 | 0/1/0 | 2 auto compactions 22 min apart. The fix's "reduce startup mass (S-01)" is irrelevant: about 7k out of 258k. |
| B-05 | Fat subagent handoff | 4 | 4/0/0 | 3/1/0 | 4/0/0 | Checked in the index: handoffs of 25.8k / 37.4k tok, 4–10× compression. A real, fixable pattern. |
| B-13 | Session too long | 4 | 4/0/0 | 0/3/1 | 0/4/0 | Triggered only by processed tokens over 3M. The flagged sessions are 0.4–1.4 active hours, one codex session has just 34 requests, and the cost comes from subagent fan-out. "Split into one session per task" does not address that. |
| B-01 | Fat tool result | 4 | 4/0/0 | 3/1/0 | 2/2/0 | A good catch: codex grepped into node_modules/next/dist. On one claude instance the fix says "read in slices", but the top read was already partial (30k tok) and names no file. |
| B-12 | Tool results dominate | 4 | 1/0/3 | 2/2/0 | 0/4/0 | Top instance recomputed from the index at 73% vs the reported 78% (a scaling difference). The fix is generic advice with no target. |
| B-17 | Tool arguments dominate | 1 | 0/0/1 | 0/1/0 | 0/1/0 | Bash args of 11–26k tok named after new spec files, i.e. the specs were authored through the shell. Writing a new spec costs those tokens whichever tool is used. |
| B-03 | Huge file read | 4 | 4/0/0 | 1/3/0 | 3/0/1 | Two instances share IDs with B-01 (same subagent, same reads) and are double-reported. One fix says "Read only the sections of `<path>`", a placeholder nobody can act on. |
| B-16 | Unlogged context | 4 | 0/0/4 | 0/0/4 | 0/0/4 | About 19% on 13 codex sessions and about 20–28% on claude, a near-constant baseline (system prompt / tool schemas). The fix blames a mid-session hook or MCP injection. The repo's only hook prints nothing unless it blocks a call. |
| B-14 | Search flood | 4 | 2/0/2 | 1/3/0 | 4/0/0 | Checked: `search` results over the spec files, capped at 10k. "List files first" fits. |
| B-04 | Repeated identical tool call | 2 | 2/0/0 | 0/0/2 | 0/0/2 | The browser `computer` tool was called 30× with the same args hash; almost certainly screenshots, whose output changes each time. `wait_agent` ×5 is 70 tok of polling. "Record once and reuse" is wrong for both. |
| B-06 | Subagent re-reads parent files | 1 | 1/0/0 | 0/1/0 | 0/1/0 | Checked: 4 of the child's 7 file reads overlap with the parent. 18.8k tok, and it was a review-style child. |
| B-11 | Turn overhead | 4 | 4/0/0 | 0/0/4 | 0/0/4 | The numbers are right, but the flagged requests are autonomous tool-loop steps (confirmed in the index: tool_call + tool_result, no user block). "Batch small follow-ups" misdiagnoses them. |
| B-15 | Parallel duplicate work | 1 | 0/0/1 | 0/0/1 | 1/0/0 | 6k tok shared between two parallel research agents; negligible. |
| H-01 | Recurring fat result | 2 | 2/0/0 | 1/1/0 | 0/2/0 | Bash results over 8k recur in 6 sessions (mostly Explore subagents). The fix ("so results stay small") is generic. The product-brief instance duplicates H-02. |
| H-02 | File read whole repeatedly | 4 | 2/2/0 | 1/1/2 | 1/2/1 | Accounts spec: 7 of 9 "whole" reads were Bash reads of 0.7–3.6k tok against a file of about 28k. The ranges were not flagged partial, so this is an FP, and the agent was already doing what the fix asks. BACKWARD_COMPATIBILITY: 2 of 5 reads were partial, and the file was only about 3k tok at the time. `references/taxonomy.md` is a user-level skill's own reference file, outside the repo, so the CLAUDE.md fix targets the wrong place. The product-brief instance is a real TP. |
| H-03 | Subagent type with fat handoffs | 2 | 2/0/0 | 2/0/0 | 2/0/0 | general-purpose median 16.4k and Explore median 12.3k (max 37k). Consistent with B-05, and the fix is actionable. |
| H-06 | MCP server never invoked | 1 | 1/0/0 | 0/1/0 | 0/1/0 | Duplicate of S-09. "Disable for this project" is not how a user-scope codex server works. |

## First change
S-01 (codex variant): "Split root AGENTS.md into nested AGENTS.md", "applies to 54 sessions". Scores: **fact TP, relevance marginal, fix weak.**
- The file really is oversized: 24.6 KB, and several sections (design-system rules, React testing, API layer) are package-specific. The `packages/app/AGENTS.md` + `CLAUDE.md` stub pattern already exists, so the split is doable.
- Instructions account for only 2.5% of token-requests. skill_listing is 7%, and Bash/exec/Read results make up about 55%. Handoffs and fat reads (B-05/H-03, B-01/B-02) would save more.
- The codex-only fix is headlined for 54 sessions, but only 17 are codex.
- The evidence label cites the InstructionsLoaded hook, which is a Claude hook, and its 6,692 total does not match the files it lists.

## Systematic issues
- **S-05 treats every inline-code span as a path.** It flags identifiers (`process.env`, `NextResponse.json`), negated mentions, import examples, templates and example filenames: 7/7 FP here. It also fails the CI gate (exit 1) on these. It needs a path-shape and existence heuristic, e.g. require a `/` plus a known extension, and skip negated or example context.
- **H-02 "read whole" counts Bash range reads as whole** (`partial` undefined for shell `file` reads), so it can blame an agent that is already reading in ranges. The per-read threshold (2k tok) also lets small files (about 3k) through.
- **Wrong-diagnosis fixes on correct numbers.** B-11 labels normal tool loops as "tiny follow-ups". B-13 "too long" fires on 27-minute sessions (it measures fan-out, not duration). B-16 blames hooks/MCP for a constant baseline. B-04 recommends caching screenshots.
- **Duplicates and fragmentation.** One oversized AGENTS.md produces 3×S-01, S-06 and 3 check violations. S-09 and H-06 report the same server. B-01 and B-03 share IDs. H-01 and H-02 both report product-brief.
- **Inconsistent token numbers for the same file.** check/scan say 6,835 for AGENTS.md, `tokens` says 11.6k claude / 7.3k codex, and the codex chain says 6,692 for files that add up to 7,024.
- **Fix targets.** Claude fixes always say "add to CLAUDE.md", but CLAUDE.md here is a one-line `@AGENTS.md` stub, so AGENTS.md is the right file. S-02 moves shared rules into a personal home file. B-03 emits a literal `<path>`.

## Missed
- **Skill inventory misses the 38 project skills.** `.claude/skills` holds symlinks into `.agents/skills`, and `setup.skills` lists only 11 plugin skills. Five skill names exist both as project skills and in the plugin, yet the cost table shows skill_listing at 7% of token-requests with no finding.
- **Size growth.** BACKWARD_COMPATIBILITY.md grew from 11.5 KB to 44 KB and several spec files are 60–86 KB. No setup finding flags large, frequently read docs as candidates for a summary or index file. They only show up after the fact, as H-02/B-03.
