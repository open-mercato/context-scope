# ContextScope product research: from context visualizer to Context Engineering Setup Buddy

Research date: 2026-09-01

## Executive verdict

ContextScope addresses a real and growing problem, but the current product is more useful as a **hypothesis generator** than as proof that a context setup is good.

The market does not need another trace viewer. Claude Code already provides `/context` with a live category breakdown and optimization suggestions, while LangSmith and Phoenix already combine tracing, datasets, evaluations, and experiments. The defensible product is:

> **ContextScope is Context CI for coding agents: it reconstructs what every agent actually saw, finds risky or wasteful setup choices, proposes one platform-correct change, and proves the change on repeatable tasks.**

This is a focused pivot, not a restart. Keep the repository scanner, local-first privacy, platform recipes, session import, and separate parent/subagent scopes. Replace universal scores and simulated improvements with exact lineage, metric provenance, and controlled comparisons.

## Why the problem is real

Long context capacity is not the same as reliable long-context use. *Lost in the Middle* found strong position effects, with relevant information used less reliably in the middle of long inputs. RULER found substantial degradation as sequence length and task complexity increased, even where simple needle retrieval looked strong. Chroma's later controlled evaluation of 18 models found increasing and non-uniform unreliability as input length grew while holding task difficulty constant. These results justify treating context as a quality variable, not only a capacity or cost variable.

- [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- [RULER](https://arxiv.org/abs/2404.06654)
- [Context Rot](https://www.trychroma.com/research/context-rot)

The proposed intervention families are also real. Anthropic recommends tight context, just-in-time retrieval, tool-result clearing, compaction, structured memory, and isolated subagents. Claude Code documents that subagents run in separate windows and return a summary to the parent. OpenAI's Agents SDK distinguishes local application context from LLM-visible context and supports on-demand context through tools and retrieval.

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Claude Code subagents](https://code.claude.com/docs/en/subagents)
- [OpenAI Agents SDK context management](https://openai.github.io/openai-agents-python/context/)

Repository context is not merely cosmetic. A 2026 study of 124 pull requests across 10 repositories found that the presence of `AGENTS.md` was associated with a 28.64% lower median runtime and 16.58% fewer output tokens while task completion remained comparable. This is early, limited evidence rather than a universal causal law, but it validates repository instructions as a legitimate optimization surface. Another 2026 analysis of 138,133 public skills found at least one detected defect in 91.8% of them and showed that valid routing metadata improved retrieval reliability. That strongly supports a deterministic setup linter.

- [Impact of AGENTS.md on coding-agent efficiency](https://arxiv.org/abs/2601.20404)
- [What Keeps Agent Skills from Being Reusable?](https://arxiv.org/abs/2608.08453)

## Is the current app useful?

### Already useful

| Capability | Value | Why it should stay |
|---|---|---|
| Local repository scan | High | Context files can contain source, policies, and secrets. Local processing is a meaningful trust advantage. |
| Context inventory | High | Users need one manifest covering instructions, rules, skills, tools, memory, and agent definitions. |
| Parent/subagent separation | High | Subagents have independent context windows. Keeping their private work out of the parent peak is conceptually correct. |
| Platform-specific recipes | High | An exact setting, file location, limitation, and verification command is much more actionable than generic advice. |
| Broken imports, missing skill metadata, unscoped rules, and duplicates | Medium-high | These are inspectable setup defects and can become reliable CI checks. |
| Measurement-coverage disclosure | Medium | Admitting when counts are estimated is the right trust pattern. |

### Useful only as hypotheses

| Current metric or behavior | Problem | Required correction |
|---|---|---|
| `characters / 4` token estimates | Tokenization is model-specific; Anthropic explicitly recommends counting against the actual model. | Prefer vendor usage. Otherwise use a model-specific tokenizer/API and label it `estimated.local`. |
| Regex source classification | Names such as `read`, `path`, or `search` can misclassify messages; nested vendor schemas are ignored. | Build versioned Claude, Codex, Gemini, OpenAI, and OTel adapters with fixtures. Preserve unknown events. |
| Summing context events into a peak | A transcript is not a sequence of complete model-input snapshots. History may be resent, cached, cleared, compacted, or omitted. | Model each inference request and its exact context blocks. Show reconstructed occupancy only when snapshots are missing. |
| `retained` / “signal retained” | Most traces do not report semantic usefulness. Presence in history is not attention, use, or causal contribution. | Rename structural retention to `still present`. Measure usefulness only with citations, downstream references, judges, or ablation. |
| Fixed 0–100 diagnostic score | The weights and thresholds are product opinions, not calibrated predictors of task success. | Replace with an evidence ledger and separate dimensions. Reintroduce a score only after calibration against outcomes. |
| 45% compaction and eight-tool trigger | There is no universal optimum. Claude's documented default is approximately 95%, Gemini documents a different configurable threshold, and task needs vary. | Recommend an experiment range based on observed failures; never present one threshold as universally correct. |
| 2,500-token subagent return limit | A concise handoff is sensible, but the right budget depends on task complexity and required evidence. | Measure handoff compression ratio and handoff sufficiency; tune per agent/task class. |
| Projected token saving and score gain | Static percentages create false precision and can imply causality from one trace. | Replace “Projected” with an explicit experiment plan until a replay has run. Then show measured delta and confidence interval. |
| Discoverable repository files labeled as loaded | Loading rules differ by platform, launch directory, scope, settings, and runtime triggers. | Separate `discoverable`, `expected to load`, `observed loaded`, and `used`. Prefer runtime hooks/events. |

The current UI contains a valuable disclaimer—“diagnostic, not an eval”—but the prominent score and counterfactual projection contradict that disclaimer. Trust requires the uncertainty to be part of the data model, not fine print.

## Competitive landscape and the open wedge

| Product or platform | Strong at | Gap ContextScope can own |
|---|---|---|
| Claude Code `/context`, `/memory`, `/doctor` | First-party live context inspection and setup debugging | Cross-platform comparison, repository-wide policy linting, history across runs, causal experiments, CI |
| OpenAI Agents tracing | LLM generations, tools, handoffs, guardrails, and custom spans | Coding-agent repository setup analysis and platform-specific repair |
| LangSmith | Production traces, offline/online evaluation, datasets, recurring issue workflows | Understanding `AGENTS.md`, `CLAUDE.md`, skills, memory, compaction, and coding-agent session artifacts without custom instrumentation |
| Phoenix | OTel/OpenInference tracing, evaluations, datasets, experiments, span replay | Repo-native context graph, setup linting, context-specific ablations, and exact local repair recipes |
| Provider dashboards | Token and cost accounting | Cross-vendor semantics, local artifacts, configuration lineage, and quality-per-context optimization |

Sources: [Claude context window](https://code.claude.com/docs/en/context-window), [OpenAI Agents tracing](https://openai.github.io/openai-agents-python/tracing/), [LangSmith evaluation](https://docs.langchain.com/langsmith/evaluation), [Phoenix overview](https://arize.com/docs/phoenix/).

The strategic rule is: **integrate with observability products; do not rebuild them.** Accept OpenTelemetry/OpenInference and vendor JSONL, then export findings and experiment results back to those systems. OpenTelemetry's GenAI conventions already define inference, retrieval, tool, memory, workflow, and agent spans, although the conventions remain in development.

- [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md)
- [OpenInference specification](https://github.com/Arize-ai/openinference/blob/main/spec/README.md)

## Recommended pivot: Context CI for coding agents

### Beachhead

Start with teams using Claude Code and Codex in software repositories. Add Gemini CLI next. Do not begin as a universal agent-observability platform.

The core user question is:

> “Which part of my agent setup is helping or hurting, what single change should I make, and can I prove it improved the same work?”

### Product loop

1. **Connect** — install a local collector or import a repository/session.
2. **Inventory** — create a Context Bill of Materials covering instructions, skill descriptions/bodies, tools and schemas, memory, files, user messages, compaction summaries, and parent/subagent handoffs.
3. **Explain** — show exactly when and why each block became visible, its position, token/caching cost, and provenance.
4. **Diagnose** — identify deterministic defects and evidence-backed risks. Separate facts from inferences.
5. **Prescribe** — generate one platform-correct patch, where to put it, expected mechanism, limitations, and rollback.
6. **Prove** — replay a fixed task set with baseline and candidate setup, repetitions, the same model/settings, and task-specific graders.
7. **Enforce** — save the winning policy as a repository check and watch for regression.

### North-star metric

Do not optimize “context health score.” Optimize:

> **Validated improvement rate: the percentage of applied ContextScope recommendations that improve task success per unit of cost/latency without violating a quality non-inferiority margin.**

Supporting business metric: time from installation to first validated improvement.

## Trustworthy metric system

Every number should carry provenance:

| Provenance | Meaning | Examples |
|---|---|---|
| `observed.vendor` | Emitted by provider/runtime | input, output, cache-read, cache-write tokens; compaction event; agent ID |
| `observed.artifact` | Directly present in a session or repository | message, tool result, instruction text, file path |
| `derived.exact` | Deterministic arithmetic over observations | compression ratio, cache hit ratio, handoff ratio |
| `estimated.local` | Reconstructed or tokenizer-estimated | likely startup tokens, inferred context snapshot |
| `evaluated` | Produced by code, human, or LLM grader | task success, compaction fidelity, instruction adherence |
| `unknown` | Not supported by evidence | attention paid, causal usefulness, uncaptured hidden prompt |

Never blend these categories into one confidence percentage.

### Metrics worth shipping

**Per inference:** exact input/output/cache/reasoning tokens, context-window utilization, block position, context churn, tool-schema overhead, latency, and cost.

**Per context block:** source, owner, scope, content hash, first/last visibility, load reason, repetitions, cache state, consumers/references, and provenance.

**Compaction:** before/after tokens, facts/decisions/risks/tests preserved, facts lost, repeated-compaction count, and downstream failure rate. Compaction should be evaluated against future information needs; recent formal work shows that discarded information can make future queries impossible and that generic summarization offers no universal preservation guarantee. See [Context Compaction Theory](https://arxiv.org/abs/2608.01326).

**Subagents:** private input, private peak, handoff size, handoff compression ratio, handoff sufficiency, duplication across agents, parallelism, latency, and model cost. Do not add private windows to parent occupancy.

**Instructions and skills:** discoverable vs observed-loaded, route precision/recall, contradiction graph, duplication, stale path/symbol references, enforceable-vs-advisory classification, and adherence on relevant tasks.

**Causal metrics after experiments:** marginal quality contribution per block, quality per 1,000 processed tokens, cost-quality frontier, success delta, latency delta, and bootstrap confidence interval. Context attribution can be approximated by controlled inclusion/exclusion; ContextCite demonstrates a scalable perturbation-based approach, while also underscoring that attribution is an experiment rather than a transcript field. See [ContextCite](https://arxiv.org/abs/2409.00729).

## Where an LLM should and should not be used

The product should be hybrid.

Use deterministic analysis for parsing, token/cost arithmetic, hierarchy, precedence, imports, path scopes, duplicates, cache accounting, lifecycle events, and configuration validity.

Use an optional LLM for semantic contradiction detection, instruction specificity, handoff sufficiency, compaction-fidelity review, clustering recurring failures, and drafting platform-specific repairs. LLM findings must expose the rubric, evidence blocks, model, and repeatability. A judge score is evidence, not ground truth.

Never use an LLM to invent token counts, infer a hidden context snapshot when runtime data exists, or declare a context block “useful” from one successful trace.

## Technical product architecture

### 1. Collectors

- Claude Code JSONL plus a small hook/plugin using `InstructionsLoaded`, `PreCompact`, `PostCompact`, `SubagentStart`, and `SubagentStop`. Official hooks expose load reasons and subagent transcript paths, avoiding filename-only inference: [Claude hooks reference](https://code.claude.com/docs/en/hooks).
- Codex session and repository adapters.
- Gemini session/headless JSONL and OTel adapter.
- OpenTelemetry/OpenInference ingestion for custom agents.

### 2. Canonical Context IR

Use a graph, not a flat event list:

`Run → AgentScope → Inference → ContextSnapshot → ContextBlock`

Edges should represent `loaded-by`, `derived-from`, `summarized-into`, `returned-to-parent`, `referenced-by`, `evicted-at`, and `evaluated-by`. Retain the raw vendor event and adapter version for reprocessing.

### 3. Evidence engine

Rules emit a finding with: claim, evidence, provenance, confidence class, affected scope, likely mechanism, proposed experiment, and known limitations. A finding without evidence cannot become a recommendation.

### 4. Experiment runner

A task manifest pins repository revision, prompt, model, settings, permissions, environment, grader, and repetition count. It applies one context-policy diff at a time, runs paired tasks, and reports quality/cost/latency deltas.

### 5. Enforcement

Ship a CLI and GitHub Action:

- `contextscope audit`
- `contextscope record`
- `contextscope compare baseline candidate`
- `contextscope check --budget startup=6000 --no-broken-imports`

The web app becomes the explanation and experiment UI; the CLI becomes the adoption and CI surface.

## Prioritized roadmap

### P0 — Trust surgery (now, 1–2 weeks)

1. Remove the universal 0–100 score from the primary hierarchy.
2. Replace projected score/savings with “experiment not run.”
3. Add provenance badges to every metric and finding.
4. Separate context processed, uncached billed input, cache reads/writes, and active-window estimate.
5. Rename “signal retained” to structural presence unless an evaluator exists.
6. Make thresholds editable hypotheses, not product facts.

### P1 — Accurate Claude + Codex setup doctor (2–5 weeks)

1. Versioned vendor parsers with golden fixture tests.
2. Exact parent/subagent correlation using IDs before folder names.
3. Active instruction manifest and precedence graph.
4. Full repo audit: global/project/local instructions, skills, agents, hooks, MCP, memory, settings, imports, scopes, conflicts, and stale references.
5. Platform-correct patch generation with preview and rollback.

### P2 — Context replay and comparison (5–10 weeks)

1. Baseline/candidate configuration snapshots.
2. Task manifests and deterministic graders first: tests, lint, exact artifacts, constraints, and human review.
3. Optional LLM judges for semantic outcomes.
4. Paired repeated runs with quality/cost/latency comparison.
5. Compaction preservation and subagent handoff evals.

### P3 — Context CI (10–16 weeks)

1. CLI, GitHub Action, budgets, and regression gates.
2. Trend history by repository, model, task class, and setup version.
3. Export/import with LangSmith, Phoenix, and OTel backends.
4. Team-shared approved recipes and exceptions.

### P4 — Opt-in benchmark and recommendations moat

Build a privacy-preserving benchmark of setup diffs and measured outcomes. Recommend changes from matched task/repository patterns, not static percentages. This evidence network—not charts—is the potential moat.

## Product validation plan

### Study 1: parser and lineage accuracy

- Dataset: at least 100 sessions across Claude Code and Codex, including compaction, cache use, skills, nested instructions, and subagents.
- Human-label a representative sample.
- Success gate: ≥95% precision and recall for source type, agent scope, compaction boundaries, and observed instruction loads; token arithmetic must exactly match vendor totals when available.

### Study 2: recommendation precision

- Recruit 10–15 teams and audit 30 repositories.
- Experts label each top recommendation as correct, actionable, already known, or misleading.
- Success gate: ≥70% of top-three recommendations are correct and actionable; <5% are materially misleading; median time to first useful finding under five minutes.

### Study 3: causal value

- Select at least 20 repeatable coding tasks from real repositories.
- Apply one recommendation at a time and run baseline/candidate multiple times with the same model and settings.
- Initial success gate: either at least 15% median processed-token/cost reduction with quality inside a predefined non-inferiority margin, or a statistically credible task-success improvement at similar cost.
- Report negative results. A recommendation family that repeatedly fails should be removed, not cosmetically reweighted.

### Study 4: workflow pull

- Success signals: ≥50% of activated users apply or export one recommendation, ≥30% return for a second comparison within four weeks, and teams voluntarily add the CI check to active repositories.

### Pivot/no-go rule

If static recommendations do not predict measured improvements, stop selling an “AI context optimizer.” Keep the accurate collector, Context Bill of Materials, linter, and comparison runner as an open Context CI toolkit. That remains valuable and honest.

## What not to build

- More decorative per-turn charts without a decision attached.
- A generic chat interface over traces.
- A universal context score before outcome calibration.
- Automatic edits without a preview, rollback, and experiment.
- A cloud-only collector that requires teams to upload proprietary transcripts.
- A proprietary tracing format; use OTel/OpenInference and retain raw artifacts.
- Advice that ignores provider/version differences.

## Final product thesis

ContextScope should own the layer between coding-agent configuration and general agent observability:

> **Setup-aware context forensics + platform-correct repair + causal verification.**

The present app validates the interaction model and the local-first wedge. The next milestone is not a prettier visualization. It is one end-to-end proof: detect a real setup defect, generate a safe patch, rerun the same task, and show that quality held or improved while context cost fell. Repeat that reliably, and ContextScope can become the best Context Engineering Setup Buddy rather than another dashboard.
