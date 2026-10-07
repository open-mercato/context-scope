# Repo D — TypeScript/Next.js app built on a modular business-app framework (MikroORM, yarn, ~8 domain modules, heavy agent tooling in .ai/)
Sessions: 21 (20 claude, 1 codex; 2 of the 21 are empty with 0 requests) · setup findings: 4 (1 gate violation = S-01, 2× S-06, 1× S-09) · session/habit rule groups: 12 (B-01/02/03/04/05/08/11/13/15/17, H-01, H-03)

## Summary
| family | instances evaluated | fact TP | fact FP | useful | marginal | noise | fix good | weak | wrong |
|---|---|---|---|---|---|---|---|---|---|
| setup | 4 | 4 | 0 | 2 | 1 | 1 | 2 | 1 | 1 |
| session | 34 | 28 (6 unverifiable) | 0 | 8 | 15 | 11 | 10 | 13 | 11 |
| habit | 5 | 5 | 0 | 2 | 2 | 1 | 3 | 1 | 1 |
| first change | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |

Fact precision is high (no FP found; every checked number matched index/disk). Relevance precision is poor: only 12/43 useful, and 13/43 suggested fixes are wrong.

## Per rule
| rule | title | evaluated | fact TP/FP/unverif | relevance u/m/n | fix g/w/wr | key reason |
|---|---|---|---|---|---|---|
| S-01 | Instruction file oversized (gate violation, first change) | 1 | 1/0/0 | 1/0/0 | 0/0/1 | AGENTS.md is 17,860 B, over 3k by any estimate; actually understated (see issues). Fix "nested AGENTS.md" is labelled `both`, but Claude (20/21 sessions) only reads it via the one-line `@AGENTS.md` import in CLAUDE.md, so content moved into nested AGENTS.md files would stop loading for Claude |
| S-06 (claude) | No rules scoping | 1 | 1/0/0 | 1/0/0 | 1/0/0 | 0 `.claude/rules`; AGENTS.md has module-anatomy/imports/conventions sections that fit `paths: src/modules/**`. Caveat: moves shared guidance to Claude-only |
| S-06 (codex) | No rules scoping | 1 | 1/0/0 | 0/1/0 | 1/0/0 | Correct for Codex but the only Codex session is empty; same file and same `<subdir>/AGENTS.md` fix as S-01, so it's a duplicate |
| S-09 | MCP server unused | 1 | 1/0/0 | 0/0/1 | 0/1/0 | node_repl exists in user-level Codex config, 0 calls; "across 21 sessions" hides that just 1 Codex session exists (0 requests); the server comes from a desktop app install, not this repo |
| B-08 | Running hot | 1 | 1/0/0 | 1/0/0 | 1/0/0 | Peak 997,385/1M, auto-compact at 999,634 (index); a real problem with a good fix |
| B-02 | Repeated fat results | 4 | 4/0/0 | 1/3/0 | 1/3/0 | Counts cover all 35 subagents of an orchestrator session; most are normal source/skill reads. The useful one: a 64 KB agent-written cookbook read whole twice. Some "search" items are file cats |
| B-05 | Fat subagent handoff | 4 | 4/0/0 | 0/3/1 | 3/1/0 | Handoffs verified (15.8k, 11.4k, 14.4k, 4.9k). 8–24x compression: reports the orchestrator asked for. The 4.9k/24x one only just clears the 4k threshold |
| B-13 | Session too long | 4 | 4/0/0 | 2/1/1 | 2/2/0 | 3M processed-token threshold flags 12/21 sessions at 98% cache-read; a 0.3 h, 103-request session gets "too long". Right for the 3-week and 2,072-request sessions |
| B-01 | Fat tool result | 4 | 3/0/1 | 1/3/0 | 1/3/0 | Useful: a dump of a 102 KB generated routes file. Others: 10–13k results in subagents on 1M windows. One "Read page.tsx in slices" names a 14.9 KB file whose Bash output was 28.7 KB, so the output was not just that file |
| B-17 | Tool arguments dominate | 3 | 3/0/0 | 1/2/0 | 0/2/1 | Share at peak verified (37–38%). "Write in chunks" does not shrink what stays in context. In the orchestrator session the top args are Agent prompts, so the fix is wrong |
| B-03 | Huge file read | 4 | 4/0/0 | 2/2/0 | 2/2/0 | Cookbook reads are useful with a good fix. 2/4 give the fix as "Read only the sections of `<path>`" because the target isn't captured (reads outside the repo), so the fix can't be acted on |
| B-04 | Repeated identical tool call | 3 | 1/0/2 | 0/0/3 | 0/0/3 | Identical args are ~53-byte chrome `computer` calls (screenshots) and same-URL `navigate` reloads; the results differ each time, so "record once and reuse" is wrong |
| B-11 | Turn overhead | 4 | 4/0/0 | 0/0/4 | 0/0/4 | Rule counts every agentic tool-loop request (these never carry user text) as a "tiny follow-up": 838/1443 requests. Advice to "batch small follow-ups" is misapplied |
| B-15 | Parallel duplicate work | 3 | 0/0/3 | 0/1/2 | 0/0/3 | Shared reads are the skill/spec file each agent needs. The snippet tells agent B "do not read .ai/skills/…/SKILL.md", the file it has to follow |
| H-01 | Recurring fat result/call | 4 | 4/0/0 | 1/2/1 | 2/1/1 | Sums check out. Bash-shell/Read snippets are concrete. The "Bash null" variant has a broken label (kind=edit, label "null") and its snippet quotes `null`. The group row shows 396k under the first habit's title, but that is the sum of 4 different habits |
| H-03 | Subagent type with fat handoffs: Explore | 1 | 1/0/0 | 1/0/0 | 1/0/0 | 9 Explore handoffs, median 10k (verified 2); a CLAUDE.md line fits because Explore has no definition file |

## First change
S-01 "Instruction file oversized". Fact: TP (the size is real, and understated for Claude). Relevance: marginal as the #1 item. AGENTS.md is already a routing table into .ai/guides, and at 98% cache-read the cost is about 1% of a 1M window. The session evidence points to bigger waste: an auto-compacted 3-week session, repeated whole-file reads, and 12.7k tok/request of skill listing. Fix: wrong for Claude. Nested AGENTS.md files are not loaded by Claude Code (the root one arrives only via `@AGENTS.md`), and AGENTS.override.md is Codex-only. The right Claude target is `.claude/rules/*.md` or nested CLAUDE.md, which is what S-06 already says.

## Systematic issues
- **Estimator inconsistency:** check/S-01 say AGENTS.md = 4,962 tok (neutral 3.6 B/tok). The `tokens` command says 8.43k for Claude. In sessions the `instructions` attachment is 20,400 B ≈ 9.7k tok. So the gate understates Claude startup cost by about 2x, and the budget "4,966/6,000 ok" would really fail.
- **Advice aimed at agent loops as if they were user habits:** B-11 (every tool-loop step is a "tiny follow-up"), B-04 (screenshots/reloads as "identical calls") and B-13 (processed tokens with 98% cache-read) together make up most of the noise and wrong fixes.
- **Same block counted several times:** one 24,575-tok Read is evidence in B-01, B-02 and B-03 (shared id suffix `be5c253129`). S-06(codex) repeats S-01's fix. H-01 Read/file repeats B-02. Two B-03 findings cover the same cookbook in sibling subagents.
- **Unusable placeholders and labels:** `<path>` in B-03/B-01 fixes when the target isn't captured, "Bash null" in H-01, and H-01 group totals shown under a single sub-habit's title.
- **Counts inflated by empty sessions:** "applies to 21 sessions" and S-09 "across 21 sessions" include 2 empty sessions and 20 Claude sessions that can't use a Codex MCP server.
- **Confusing change notes:** "AGENTS.md edited 2026-08-20: no session before" while a session started 3 h before the edit and ran across it. Dates are shown in UTC, one day off from the local commit date.
- **Sampling of fix plausibility:** "split into nested AGENTS.md" and "disjoint scope" snippets don't check vendor loading or task semantics.

## Missed
- **Symlinked project skills not seen:** `.claude/skills/*` are 25 symlinks to `.agents/skills`, and `skillDirs()` uses `Dirent.isDirectory()`, which is false for symlinks, so the inventory shows 0 project skills. `.agents/skills` (Codex) isn't scanned either.
- **Duplicate skills:** 7 skill names exist both as plugin skills and as project skills (e.g. code-review, implement-spec, troubleshooter, auto-create-pr), and skill_listing is 12.7k tok/request, more than the instructions. No finding flags either.
- **Unused plugin skills:** 10 of 11 plugin skills have 0 invocations in 30 days, with no finding.
