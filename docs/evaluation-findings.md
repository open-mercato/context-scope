# Evaluation: how good are ContextScope's findings?

Date: 2026-09-29 · ContextScope 0.11.0 (branch `contextscope-cycle3`, Claude adapter v5, revised `check`)
Per-repository reports: [Repo A](evaluation/repo-a.md) · [Repo B](evaluation/repo-b.md) · [Repo C](evaluation/repo-c.md) · [Repo D](evaluation/repo-d.md) · [Repo E](evaluation/repo-e.md).
Where each rule's rationale comes from: [sources.md](sources.md).

## Verdict

**The measurements are mostly right, but the recommendations are mostly not ready to follow unreviewed.**

- **Facts:** 89 % of checkable claims were correct (file sizes, read sizes, missing paths, compaction counts, handoff sizes).
- **Useful:** only 36 % of findings were worth a developer's attention.
- **Good fixes:** only 28 % of findings came with a fix that is concrete, correctly targeted and plausibly helpful. 30 % of the fixes were wrong: following them would do nothing, or would do harm.
- **First change:** the "one change to make first" was factually true in 5 of 5 repositories. It was useful in 2 of 5, and its fix was good in 1 of 5.

ContextScope is a reliable **meter** and a noisy **advisor**. Until the issues below are fixed, read a finding as "here is where the tokens go", and treat the fix as a hypothesis to test.

## Method

- **Sample.** Five real repositories on the author's machine, the five with the most indexed sessions. They are anonymised as A–E because one is a client project, and are 8 to 54 sessions each, Claude Code and Codex.
- **Inputs.** For each repository, `contextscope check --json` and `contextscope scan --json` were generated once. An independent reviewer (a Claude agent working read-only) then checked findings by hand against the repository files and the ContextScope index (sizes and labels only, never transcript text).
- **What was evaluated:**
  - every setup violation and S-* finding (up to 5 instances per rule);
  - up to 4 instances per session or habit rule group (the top ones by tokens affected, plus one random);
  - the first change, separately.
- **Three verdicts per instance:**
  - **fact:** true / false / unverifiable. Is the measured claim correct?
  - **relevance:** useful / marginal / noise. Is it worth a developer's attention in this repository?
  - **fix:** good / weak / wrong. Is it concrete, aimed at the right file or tool, and plausibly helpful?
- **Limits.** One reviewer per repository and no second rater. Relevance and fix quality are judgements, and the sample favours the largest findings. These are precision numbers, not recall; the "missed" notes in the reports are anecdotal.

## Results

| Repo | Evaluated | Fact true | Fact false | Unverifiable | Useful | Marginal | Noise | Fix good | Fix weak | Fix wrong |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 66 | 46 | 9 | 11 | 21 | 23 | 22 | 25 | 21 | 20 |
| B | 63 | 51 | 12 | 0 | 25 | 21 | 17 | 19 | 27 | 17 |
| C | 75 | 68 | 3 | 4 | 30 | 25 | 20 | 18 | 33 | 21 |
| D | 43 | 37 | 0 | 6 | 12 | 18 | 13 | 15 | 15 | 13 |
| E | 67 | 47 | 6 | 14 | 26 | 24 | 17 | 11 | 33 | 23 |
| **Total** | **314** | **249 (89 % of checkable)** | **30** | **35** | **114 (36 %)** | **111** | **89** | **88 (28 %)** | **129** | **94 (30 %)** |

### By rule (all repositories)

| Rule | Repos | Evaluated | Fact true / false / unverif. | Useful / marginal / noise | Fix good / weak / wrong | Reading |
|---|---|---|---|---|---|---|
| S-01 instruction chain oversized | 5 | 18 | 18 / 0 / 0 | 11 / 6 / 1 | 11 / 5 / 2 | Keep. Size is real. The fix must not tell Claude users to split into nested `AGENTS.md` (see issue 3). |
| B-08 running hot | 5 | 10 | 8 / 0 / 2 | 9 / 1 / 0 | 8 / 2 / 0 | Best session rule. |
| H-03 subagent type with fat handoffs | 2 | 3 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | Good, small sample. |
| B-02 repeated fat results | 5 | 20 | 19 / 0 / 1 | 13 / 7 / 0 | 5 / 15 / 0 | Right signal, generic fix. |
| B-01 fat tool result | 5 | 20 | 16 / 1 / 3 | 11 / 9 / 0 | 6 / 12 / 2 | Right signal; the fix often loses the file path. |
| B-14 search flood | 4 | 13 | 8 / 0 / 5 | 6 / 6 / 1 | 12 / 1 / 0 | Good fixes. |
| B-13 session too long | 5 | 20 | 20 / 0 / 0 | 9 / 7 / 4 | 9 / 10 / 1 | The 3M-token threshold fires on 6–30 minute sessions. |
| B-05 fat subagent handoff | 5 | 20 | 18 / 0 / 2 | 3 / 11 / 6 | 11 / 9 / 0 | True but rarely important. |
| B-12 tool results dominate | 4 | 16 | 13 / 0 / 3 | 8 / 8 / 0 | 0 / 13 / 3 | No good fix in any instance. |
| H-01 recurring fat result | 4 | 14 | 13 / 1 / 0 | 6 / 7 / 1 | 6 / 6 / 2 | The group title sums several habits. |
| B-03 huge file read | 5 | 20 | 19 / 1 / 0 | 9 / 10 / 1 | 5 / 11 / 4 | The byte estimate is badly wrong for PDFs and images. |
| B-07 frequent compaction | 3 | 6 | 6 / 0 / 0 | 6 / 0 / 0 | 0 / 3 / 3 | Useful; fixes wrong for Codex child threads. |
| S-06 no rules scoping | 5 | 8 | 8 / 0 / 0 | 1 / 7 / 0 | 5 / 3 / 0 | Marginal. |
| B-16 unlogged context | 3 | 12 | 4 / 2 / 6 | 3 / 3 / 6 | 0 / 3 / 9 | Blames hooks and MCP for nested-memory loads; mishandles negative steps. |
| B-04 repeated identical call | 5 | 17 | 13 / 0 / 4 | **0 / 0 / 17** | 3 / 0 / 14 | **All noise:** polling, screenshots and reloads with different results. |
| B-11 turn overhead | 5 | 20 | 16 / 4 / 0 | **0 / 1 / 19** | **0 / 0 / 20** | **All noise:** counts agent tool-loop steps as tiny user follow-ups. |
| S-05 missing path | 4 | 19 | **1 / 18 / 0** | 1 / 0 / 18 | 0 / 1 / 18 | **Mostly false:** prose, identifiers and templates read as paths; `~/` refs checked against an empty home. |
| S-02 duplicate blocks | 2 | 6 | 6 / 0 / 0 | 1 / 0 / 5 | 0 / 0 / 6 | One shared boilerplate block becomes N² findings with contradictory fixes. |
| S-09 / H-06 MCP unused | 5 | 10 | 10 / 0 / 0 | 0 / 8 / 2 | 1 / 6 / 3 | Suggests disabling user-scope servers that other repos use; schema cost overstated (Claude defers MCP schemas by default). |

Other rules had one or two instances; see the per-repository reports.

## Systematic issues, ranked by damage

1. **Agent loops read as user habits.** B-11 counts every tool-loop request as a "tiny follow-up" (up to 64 % of all input in one repository). B-04 treats polling, screenshots and reloads as identical calls to cache. B-13 fires on short sessions because its threshold is processed input, not length. Together these produce most of the noise and about half the wrong fixes, and they inflate the headline totals.
2. **Codex child threads and Claude subagents judged as sessions.** Fixes tell a subagent to "delegate to a subagent" or "start a new session per task". Worktree and subagent scopes also lose file paths, so fixes say `<path>`. That hides the most actionable pattern in Repo B: many subagents each re-reading the same 20k-token `AGENTS.md`.
3. **Vendor loading semantics are wrong in the fixes.**
   - The S-01 fix ("split into nested `AGENTS.md`") is Codex-only, yet it is headlined for all sessions. Claude loads `AGENTS.md` only through an `@AGENTS.md` import in `CLAUDE.md`, so following the fix silently drops guidance for Claude. This happened in Repos A, D and E.
   - Nested `AGENTS.md` files are described as loading in any directory. For Claude they load only through a nested `CLAUDE.md` import.
   - Codex's 32 KiB `project_doc_max_bytes` cap is not checked; it truncates Repo B's `AGENTS.md`.
4. **Token numbers disagree across commands.** The same `AGENTS.md` shows as 8.7k in `check` (neutral ratio), 13.8k in `tokens` (Claude-calibrated) and 10.2k in the Claude budget. In Repo D, the instructions Claude sessions actually loaded were about 2x the neutral figure, so a budget shown as "4,966 / 6,000 ok" would actually fail. Byte-based estimates are badly wrong for PDFs (147.8k estimated, about 13k actual).
5. **Duplicates and double counting.** One large read is evidence in B-01, B-02, B-03, B-12 and H-01. One oversized file produces up to 8 setup items. S-02 turns one boilerplate block into 23 pairwise findings.
6. **S-05 is still noisy** after the same-day revision. It flags sentences that say a path is *not* used, identifiers, naming templates, paths inside generated projects, and `~/` paths (checked against an empty home when `--user-config` is off). It also fails CI on them.
7. **H-02 treats ranged shell reads as whole-file reads**, so it blames an agent that was already reading in ranges.
8. **Skills are missed entirely when `.claude/skills` entries are symlinks, or when the directory is gitignored.** Four of five repositories had 25–55 project skills that ContextScope did not see. The skill listing (7–15k tokens per request, often more than the instructions) got no finding.

## What the sources add

The knowledge base ([sources.md](sources.md), 52 sources, every link checked) confirms most mechanisms: 21 rules are sourced and 14 inferred. It gives no support for any numeric threshold. It also contradicts some rationales:

- **Claude Code defers MCP tool schemas by default** through tool search. S-08 and H-06 overstate the per-request cost for Claude.
- **Evidence on `AGENTS.md` is mixed.** One study found faster runs and fewer output tokens. Another (ETH) found no general gain in task success and over 20 % higher inference cost.
- **Hook stdout enters context only for some events** (SessionStart, UserPromptSubmit), capped at 10k characters. S-11 overstates this.
- **Cached history bills at about 0.1x.** B-01, B-10 and B-11 overstate the monetary cost; the attention cost stands.

## Fix list (next cycle)

| Priority | Change | Addresses |
|---|---|---|
| 1 | B-11: count only requests that start a user turn; drop tool-loop steps. B-04: exclude polling, waits and calls whose results differ (the result hash is known). | Issue 1, the largest noise source |
| 2 | Vendor-aware fixes: never suggest nested `AGENTS.md` to a Claude population; add a Codex `project_doc_max_bytes` check; model Claude's `@import` loading. | Issue 3 |
| 3 | Scope-aware rules: no "start a new session" or "delegate" fix for child threads and subagents; keep file paths through subagent and worktree scopes. | Issue 2 |
| 4 | One token estimate per file across `check`, budget and `tokens`, labelled with its basis; content-type aware estimates for PDFs and images. | Issue 4 |
| 5 | Fold findings about one file or one block into one card; collapse S-02 into one finding per shared block. | Issue 5 |
| 6 | S-05: skip `~/` refs without `--user-config`; negation and template contexts; path-inside-generated-project. | Issue 6 |
| 7 | H-02: use partial-read detection for Bash ranges (`sed -n`, `head`). | Issue 7 |
| 8 | Skills: follow symlinks inside `.claude/skills`, scan `.agents/skills`, add a skill-listing cost rule. | Issue 8 |
| 9 | Rewrite the rationales the sources contradict (S-08, H-06, S-11, S-12, B-07, B-08, H-07, S-03, S-04). | Sources |

Re-run this evaluation after each change on the same five repositories, and track three numbers: fact precision, useful rate and good-fix rate.
