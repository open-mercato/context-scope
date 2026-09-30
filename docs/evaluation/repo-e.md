# Repo E — TypeScript/Next.js modular business app on a plugin framework (20+ domain modules, large shared AGENTS.md, Claude + Codex with subagents)
Sessions: 8 (claude 5, codex 3; plus 19 codex child threads and 119 subagents in the findings) · setup findings: 11 (4 gate violations + 7 S-*) · session/habit rule groups: 15 (14 B-*, 1 H-*)

## Summary
| family | instances evaluated | fact TP | fact FP | useful | marginal | noise | fix good | weak | wrong |
|---|---|---|---|---|---|---|---|---|---|
| setup | 11 | 9 | 2 | 4 | 4 | 3 | 0 | 7 | 4 |
| session | 55 | 37 | 4 | 21 | 20 | 14 | 11 | 25 | 19 |
| habit | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| first change | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| **total** | 68 | 48 | 6 | 27 | 24 | 17 | 11 | 33 | 24 |

14 session facts are unverifiable from index metadata alone. Fact precision (TP / verified) = 48/54 = 89%. Useful = 27/68 = 40%. Fix good = 11/68 = 16%.

## Per rule
| rule | title | eval | fact TP/FP/unv | rel u/m/n | fix g/w/wr | key reason |
|---|---|---|---|---|---|---|
| gate:budget | startup budget over 6k (claude 10,180, codex 7,859) | 2 | 2/0/0 | 2/0/0 | 0/2/0 | Real (AGENTS.md about 7.9k plus skill descriptions about 2.3k). But the claude violation names `CLAUDE.md` (a 4-token `@AGENTS.md` stub) as the file, and the gate gives no fix. |
| gate:file-size | AGENTS.md 7,859 > 3,000 | 1 | 1/0/0 | 0/1/0 | 0/1/0 | 28 KB / 314 lines, confirmed. Duplicates the budget and S-01 items. |
| gate:broken-ref | AGENTS.md references `nav.ts` | 1 | 0/1/0 | 0/0/1 | 0/0/1 | The bare filename is prose about framework source (it exists under node_modules). It is not a repo path, so "delete the dead reference" would remove correct guidance. |
| S-01 | Instruction chain oversized | 3 | 3/0/0 | 2/1/0 | 0/2/1 | The size is real, but there are 3 instances for one file (claude chain, file, codex chain). The claude fix (`.claude/rules` + `paths:`) forks a file both vendors share. Most content applies to `src/modules/**`, where nearly all work happens, so path scoping saves little. The codex-chain label cites the Claude-only "InstructionsLoaded hook". |
| S-06 | No rules scoping | 2 | 2/0/0 | 0/2/0 | 0/2/0 | True (0 `.claude/rules`, 0 nested AGENTS.md). Same root cause and fix as S-01, restated per vendor. |
| S-05 | Missing path | 1 | 0/1/0 | 0/0/1 | 0/0/1 | Same `nav.ts` false positive as the gate item. |
| S-09 | MCP server unused (node_repl) | 1 | 1/0/0 | 0/0/1 | 0/0/1 | 0 calls in this repo's sessions is true. But the server is user-scope, and index metadata shows 5 codex runs in other repos using it, so the fix (disable in `~/.codex/config.toml`) breaks other work. |
| B-08 | Running hot | 4 | 2/0/2 | 3/1/0 | 2/2/0 | The 1M-window claude session did 268 requests above 80% (checked exactly). Codex child threads at about 93%. "Compact deliberately" fits claude main. For codex children, "split into a new thread" is weak. |
| B-02 | Repeated fat results | 4 | 3/0/1 | 3/1/0 | 0/4/0 | The same 87 KB / 2,131-line page and a 52 KB spec were read by many subagents: real. The evidence counts "results over 3k", which does not match the "Repeated" title. The fix ("standing rule in CLAUDE.md so file results stay small") is vague and targets an import stub. |
| B-07 | Frequent compaction | 4 | 4/0/0 | 4/0/0 | 0/1/3 | 6–7 compactions in 3–4 h (checked in shell.json). 3 of 4 are codex child threads, where "delegate exploration to a subagent / fresh session" is wrong. Missing from the terminal "Findings by leverage" list despite high severity. |
| B-01 | Fat tool result | 4 | 1/1/2 | 1/3/0 | 2/1/1 | Codex exec output is already truncated at about 40 KB (index `truncated:true`, about 11,295 tok). The top instance blames a 22 KB SKILL.md for a 40 KB result, so the target is wrong. Labels include "exec null". "Truncate output" repeats what the harness already does. |
| B-03 | Huge file read | 4 | 3/1/0 | 3/0/1 | 0/3/1 | The top instance, a PDF, is estimated from bytes at 147,770 tok, but the request only grew about 13k: an FP. The code-file instances are real (87 KB and 40 KB pages). The fix "read sections / exclude" misses the root cause: split the 2.1k-line component, which is also over Read's 2,000-line cap. |
| B-05 | Fat subagent handoff | 4 | 2/0/2 | 0/2/2 | 0/4/0 | Fires on an absolute 4k: 5.7k handoffs at 48x compression (2% of child peak) are healthy. "Return findings, not transcripts" does not match 5–11k reports. |
| B-13 | Session too long | 4 | 4/0/0 | 2/1/1 | 2/1/1 | The 11 h / 900M and 7 h / 784M resumed multi-week sessions are real and useful. The 3M-token threshold also flags a 30-min, 37-request codex child thread. tokensAffected = all processed input (2.65B, about 100% of the total). |
| B-12 | Tool results dominate | 4 | 4/0/0 | 0/4/0 | 0/1/3 | Recomputed shares match (83/83/75/62%). 3 of 4 are codex exploration child threads, and the fix "delegate exploration to a subagent" goes to a subagent. |
| B-14 | Search flood | 4 | 1/0/3 | 3/1/0 | 4/0/0 | Search results hitting the 40 KB cap repeatedly (checked on one thread). "List files first, cap matches per file" is concrete and correct. |
| B-16 | Unlogged context | 4 | 1/2/1 | 0/2/2 | 0/2/2 | Two instances are negative deltas (−97k, −41k) caused by estimator overcount (the PDF). Their text still says "a hidden injection grew the prompt". The positive +38k in a subagent is real, but the likely cause (a Read/attachment) differs from the suggested hooks/MCP checks. |
| B-06 | Subagent re-reads parent files | 4 | 4/0/0 | 0/4/0 | 0/4/0 | Overlap confirmed after path normalisation. Structural to fresh-context subagents. "Pass excerpts" trades child reads for parent prompt size. |
| B-04 | Repeated identical tool call | 4 | 2/0/2 | 0/0/4 | 0/0/4 | Every headline tool is a polling call: ScheduleWakeup ×17 (a self-paced loop), codex list_agents ×18–20, repeated browser screenshots. "Record the result once and reuse" is wrong for polling. |
| B-11 | Turn overhead | 4 | 4/0/0 | 0/0/4 | 0/0/4 | Counts every agent-loop request with no new user text as a "tiny follow-up": 1,397 requests in a 32-turn session. 1.70B tok ≈ 64% of all input. "Batch small follow-ups" does not apply. |
| B-15 | Parallel duplicate work | 3 | 2/0/1 | 2/1/0 | 1/2/0 | Real overlaps (up to 14 shared reads, about 2.3M dup tok). "Disjoint scopes" is only partly achievable when every agent needs the same entity/route files. |
| H-02 | File read whole repeatedly | 1 | 1/0/0 | 1/0/0 | 0/1/0 | The habit is real (821-line / 35 KB widget read whole across 3 sessions), but the index shows 8 whole reads, not 12. The title path is truncated to "…ules/…". A per-file rule in the `@AGENTS.md` stub is brittle; splitting the file is the better fix. |

## First change
S-01 (codex chain, 7,771 tok observed): fact TP, relevance useful, fix **wrong**.
- AGENTS.md really is about 7.8k tokens, loads on every request for both vendors, and even has the "CRITICAL rules" heading twice.
- The prescribed fix is codex-only ("split into nested `<subdir>/AGENTS.md`"), yet it is labelled "applies to 8 sessions", and 5 of those are Claude.
- In this repo CLAUDE.md is just `@AGENTS.md`. Claude Code does not read nested AGENTS.md, so the fix as written would silently drop the moved guidance for the majority vendor unless nested CLAUDE.md imports are added too.
- A vendor-neutral fix would be better: move the "Task → Context Map", "Key Imports" and module-anatomy sections into the existing on-demand `.ai/guides/` and keep root AGENTS.md as a router.

## Systematic issues
- **Codex child threads treated as sessions.** `entrypoint: subagent:thread_spawn` runs drive B-07/B-12/B-13/B-11/B-16. Their fixes tell a subagent to "delegate to a subagent" or "start a new thread per task", and the parent shows `subagents: 0`. Fixes should target the parent's spawn prompt.
- **Polling misread as waste.** B-04 flags ScheduleWakeup, list_agents and screenshots. B-11 counts every tool-loop request as a user "follow-up" and reports 1.7B tok. B-13 uses whole-session processed input as tokensAffected. These three inflate the headline numbers the most.
- **Byte-based estimate for binary reads.** The PDF (334 KB → 147.8k est vs about 13k actual) produces a B-03 FP and a negative B-16 step. B-16 then describes the negative step as "grew the prompt". B-16 should skip negative deltas.
- **Inconsistent token numbers for one file.** AGENTS.md shows as 7,859 (check, neutral estimate), 7,771 (observed codex) and 13.3k (`tokens`, claude calibration; the file is classified as `kind: code`). The claude chain uses the neutral figure, and the budget violation is attributed to the 4-token CLAUDE.md.
- **One root cause, 8 setup items.** A single 28 KB file yields 3 gate violations + 3 S-01 + 2 S-06, and the claude and codex fixes pull in different directions for a shared file.
- **S-05 treats bare filenames in prose as paths.** Here that is framework source living in node_modules.
- **S-09 judges a user-scope server on one repo.**
- **Codex truncated exec output attributed to the first path argument.** A 40 KB result is blamed on a 22 KB file, and labels read "exec null".
- **Fix field gaps.** Most B-* fixes have no `path`.
- **Terminal report drops some high findings.** The 12-row list omits B-07 (high, 6.6M tok) while showing low-severity B-11.

## Missed
- Root cause of the B-02/B-03/H-02 cluster: a 2,131-line page component. It exceeds Read's 2,000-line default, so whole reads are silently truncated. Several other 35–41 KB UI files are also hot. No finding suggests splitting them.
- `instructionDuplicates` is empty, although AGENTS.md has two "CRITICAL rules — always follow without exception" sections (about 1 KB and 7.9 KB). They may overlap.
- A large skills directory (33 skills, about 360 KB) is read via `cat` by codex (SKILL.md exec reads hit the 40 KB cap). Nothing flags skill-body size for codex, which has no lazy skill loading here.
