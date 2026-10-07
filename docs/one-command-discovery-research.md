# One-command local discovery for ContextScope

Research date: 2026-09-01

## Executive recommendation

ContextScope should ship as a **local companion with a bundled browser UI**, launched by one command:

```bash
npx -y @contextscope/cli@latest start
```

The package name is illustrative until the npm namespace is secured. `npx` is a credible first distribution path for a developer product: npm documents that `npm exec`/`npx` can fetch a package into the npm cache and run its binary, and that `-y` suppresses the install confirmation. A package exposes that command through the `bin` field in `package.json`. The companion should have no install-time scripts; all discovery should happen visibly after the command starts. ([npm exec](https://docs.npmjs.com/cli/npm-exec/), [npm `package.json` `bin`](https://docs.npmjs.com/files/package.json/))

The product should not be a hosted page that promises to search the user's computer. Browser filesystem APIs require a user-selected file or directory and explicit permission; they do not give a website general filesystem discovery. The File System Access proposal defines `showDirectoryPicker()` as a user-facing picker that grants access to the selected directory, and MDN likewise states that access to device files is disallowed unless the user specifically permits it. ([File System Access specification](https://wicg.github.io/file-system-access/), [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API))

Therefore the reliable architecture is:

1. `npx` starts a Node companion on the user's machine.
2. The companion binds only to loopback, serves the UI and API from the same origin, and prints the URL.
3. A first-run screen shows exactly which known agent locations and current repository paths it proposes to read.
4. After consent, vendor adapters enumerate sessions and relevant context configuration.
5. Deterministic analysis runs locally without an LLM.
6. Semantic analysis is optional: the user either signs in for a ContextScope subscription or supplies an API key. The UI clearly marks every model-generated judgment as an evaluation, not an observed fact.

This delivers the desired one-command experience without pretending that browser sandbox restrictions do not exist.

## What the first command should do

### Recommended first-run flow

```text
$ npx -y @contextscope/cli@latest start

ContextScope found:
  Codex CLI      installed · 284 stored threads
  Claude Code    installed · 91 stored sessions
  Gemini CLI     installed · 17 stored sessions
  Current repo   8 context sources

Read-only access requested:
  ~/.codex/…
  ~/.claude/…
  ~/.gemini/…
  /current/repository/…

Nothing is uploaded unless you enable semantic analysis.
Open http://127.0.0.1:4318/?token=…
```

The actual output should separate **detected** from **authorized** and **indexed**. Detection can be limited to checking whether expected binaries and top-level directories exist. Reading session contents begins only after the consent screen.

### Start command contract

`contextscope start` should:

- bind to `127.0.0.1` or `::1`, never `0.0.0.0` by default;
- choose an available random port;
- use a high-entropy per-launch capability token;
- serve UI and API from one local origin, with no permissive CORS;
- open the browser unless `--no-open` is passed;
- scan only an allowlist of vendor locations plus the current repository;
- default to read-only mode;
- never read API keys or reuse another agent's authentication tokens;
- keep raw session contents local unless the user explicitly enables an upload-backed feature;
- expose `--json`, `--no-open`, `--repo PATH`, `--include-agent NAME`, `--exclude PATH`, and `--since 30d` for automation and control.

These are product security requirements rather than vendor-documented behavior. The closest relevant first-party precedent is Codex app-server: OpenAI documents loopback WebSocket use, rejects health requests containing an `Origin` header, and warns that non-loopback listeners must be authenticated. ([Codex app-server](https://learn.chatgpt.com/docs/app-server))

## Acquisition strategy by agent

The adapter rule should be: **use a supported vendor API or telemetry surface first, use documented artifacts second, and parse private transcript files only as a versioned fallback.** Every imported field should retain its acquisition method and confidence.

### OpenAI Codex

#### Primary path: Codex app-server

Do not start with a recursive scan of `~/.codex/sessions`. Codex exposes a supported local integration surface specifically for rich clients. The official app-server documentation says it supports authentication, conversation history, approvals, and streamed events. It provides:

- `thread/list` to paginate stored threads;
- `thread/read` to read a stored thread without resuming it;
- experimental `thread/turns/list` and `thread/items/list` for paged persisted history;
- `parentThreadId` and `ancestorThreadId` filters for child and descendant threads;
- source kinds that distinguish `cli`, `vscode`, `exec`, `appServer`, and several `subAgent*` variants.

This is the strongest available implementation for automatic Codex and subagent discovery. Start `codex app-server` over its default stdio transport, initialize it, list threads, and read selected threads. Avoid the experimental WebSocket transport for the embedded adapter. ([Codex app-server: stored thread APIs](https://learn.chatgpt.com/docs/app-server))

**Documented:** the APIs and filters above; persisted threads are backed by JSONL logs; app-server can list and read them.

**Not documented:** that app-server can always read thread history when the user is logged out, or that its schema remains identical across Codex releases. Generate or bundle schemas per supported Codex version and test the logged-out case before claiming it.

#### Context configuration

Codex reads a global instruction file from `CODEX_HOME` (default `~/.codex`) and builds a project instruction chain from `AGENTS.md`/`AGENTS.override.md` files. The official guide documents the discovery and precedence rules. User config lives in `~/.codex/config.toml`, with trusted project overrides in `.codex/config.toml`. ([Codex `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference))

The repository adapter should inspect only files relevant to those documented rules, then label them:

- `observed.loaded` when a runtime event or app-server item proves loading;
- `expected.load` when vendor rules imply loading for the recorded working directory;
- `discoverable` when the file merely exists.

Existence must never be shown as proof that the model saw or followed the file.

#### Optional continuous capture

Codex hooks can observe `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, and related events. Common hook input includes `session_id`, `transcript_path`, `cwd`, event name, and model; tool events include tool name, use ID, and structured input; subagent events include `agent_id` and `agent_type`. Codex explicitly warns that `transcript_path` is convenient but its format is not a stable interface. ([Codex hooks](https://learn.chatgpt.com/docs/hooks))

ContextScope may offer an **Install Codex capture** button, but it cannot silently complete setup. Codex requires users to review and trust non-managed hooks and records trust against the hook definition's hash. The recipe should write a narrow hook definition only after showing a diff, then tell the user to review it with `/hooks`. ([Codex hook trust](https://learn.chatgpt.com/docs/hooks))

OpenTelemetry is a second optional path. Codex config documents OTLP log, metric, and trace exporters and requires telemetry routing at user scope rather than project scope. ContextScope should not overwrite an existing exporter; it should support fan-out through an external collector or show a reversible configuration recipe. ([Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference))

### Claude Code

#### Historical sessions and exact subagent paths

Claude Code documents its local data directory in enough detail for zero-configuration discovery. Sessions are stored as plaintext JSONL under `~/.claude/projects/<project>/<session>.jsonl`; related session directories contain `subagents/`, `tool-results/`, and other artifacts. `file-history/<session>/` stores file snapshots. The documented default session retention is 30 days, and the documentation warns that transcripts are unencrypted and may contain secrets exposed through tools. `CLAUDE_CONFIG_DIR` relocates the documented `~/.claude` tree. ([How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works), [Claude Code directory reference](https://code.claude.com/docs/en/claude-directory))

Subagent correlation can be exact. `SubagentStart` provides `agent_id` and `agent_type`; `SubagentStop` includes both the parent `transcript_path` and the exact `agent_transcript_path`. The documented example layout is:

```text
~/.claude/projects/<project>/<parent-session>/subagents/agent-<id>.jsonl
```

ContextScope should prefer those hook fields when available, then use the documented directory structure for historical sessions. ([Claude Code hooks](https://code.claude.com/docs/en/hooks))

#### Context configuration

The Claude adapter should inventory the documented instruction and extension surfaces:

- global and project `CLAUDE.md`/`CLAUDE.local.md`;
- `.claude/rules/*.md`;
- `.claude/settings.json` and `.claude/settings.local.json`;
- `.mcp.json`;
- `.claude/skills/<name>/SKILL.md`;
- `.claude/agents/*.md`;
- corresponding user files under `~/.claude/` or `CLAUDE_CONFIG_DIR`;
- auto-memory under `~/.claude/projects/<project>/memory/`.

Claude documents the instruction hierarchy and lazy loading of nested instruction files. `/memory` lists loaded instructions, so an exported `/memory` snapshot is stronger evidence than filesystem existence alone. ([Claude Code directory reference](https://code.claude.com/docs/en/claude-directory), [Claude Code memory](https://code.claude.com/docs/en/memory))

#### Optional continuous capture

Claude's `InstructionsLoaded` hook is especially valuable for context provenance: it reports the absolute file path, instruction scope, load reason, and relevant trigger or parent path. Other useful events include `PreCompact`, `PostCompact`, tool hooks, subagent hooks, and session lifecycle hooks. `PostCompact` can expose the generated compact summary. ([Claude Code hooks](https://code.claude.com/docs/en/hooks))

For Claude, the product ladder should be:

1. historical JSONL import for immediate value;
2. optional, previewed hook installation for exact future instruction-load and lifecycle evidence;
3. optional OpenTelemetry for aggregate/token observability where the user already operates a collector.

Hook installation must be an explicit configuration change with a diff and uninstall path.

### Gemini CLI

#### Historical sessions and subagents

Gemini CLI automatically saves project-scoped sessions under:

```text
~/.gemini/tmp/<project_hash>/chats/
```

The session-management documentation says saved sessions include prompts, responses, tool executions, and token usage and use a 30-day default retention. `GEMINI_CLI_HOME` changes the root in which `.gemini` is created. ([Gemini CLI session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md), [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md))

The current official source provides the file-layout detail needed by a versioned adapter. Main files follow `session-<UTC-minute>-<first-8-session-id>.jsonl`; subagent logs are nested at `<project-temp>/chats/<complete-parent-session-id>/<subagent-session-id>.jsonl`, and recording metadata distinguishes `kind: "main"` from `kind: "subagent"`. ContextScope should inspect the schema version and `kind` field rather than applying Claude's `subagents/agent-*` convention. ([Gemini `chatRecordingService.ts`](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts), [Gemini local subagent executor](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/agents/local-executor.ts))

Because this precise naming comes from implementation source rather than a compatibility guarantee in user documentation, pin it to tested Gemini CLI versions and preserve unknown fields.

#### Context configuration

Gemini supports global and workspace `GEMINI.md` context plus just-in-time files discovered when tools access components. `context.fileName` can be configured as an array—for example, `AGENTS.md`, `CONTEXT.md`, and `GEMINI.md`. `/memory list`, `/memory show`, and `/memory refresh` expose active files and concatenated memory. Custom subagents live in project or user `.gemini/agents/*.md` and run with independent context/history and explicit tool/MCP configuration. ([Gemini context files](https://geminicli.com/docs/cli/gemini-md/), [Gemini CLI subagents](https://geminicli.com/docs/core/subagents/))

Unlike Claude's dedicated `InstructionsLoaded` event, Gemini does not currently document an equivalent hook. Filesystem reconstruction should therefore remain `expected.load` unless an exported `/memory` state, a captured outgoing-model request, or another runtime record proves the content was included.

#### Optional continuous capture

Gemini hook input includes `session_id`, an absolute `transcript_path`, working directory, event name, and timestamp. `BeforeTool`/`AfterTool`, `BeforeModel`/`AfterModel`, `PreCompress`, and session lifecycle hooks give progressively stronger runtime evidence; `BeforeModel` is particularly useful because it exposes the normalized outgoing messages and generation configuration. ([Gemini hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md))

Gemini's optional OpenTelemetry surface reports request/response token types, tool duration and success, file operations, compression tokens before/after, and agent lifecycle metrics. It is disabled by default. When enabled, prompts are logged by default unless `telemetry.logPrompts=false`, and detailed traces require a separate opt-in. ContextScope should surface that privacy implication before generating telemetry configuration. ([Gemini CLI telemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md))

The Gemini ladder should mirror Claude's: historical read-only import first, then a separate **Improve fidelity** action for hooks or a local OpenTelemetry collector.

## Repository and multimodal discovery

### Scan context, not the whole computer

The initial scan should be intentionally narrow:

- the selected repository's documented instruction, rule, skill, agent, plugin, MCP, and settings locations;
- the relevant global configuration locations for detected agents;
- stored session metadata and only the session bodies selected for analysis;
- paths explicitly referenced by a selected session.

Do not recursively search the user's home directory, Desktop, Documents, Photos, or mounted drives. “Automatic” should mean zero manual path hunting inside a documented allowlist, not unrestricted computer search.

### Images and other graphics

If “find graphics inside the computer” means visual inputs used by agents, ContextScope should index only:

1. image paths explicitly attached to or referenced by a selected session;
2. images inside the selected repository that are referenced by an instruction file, tool event, or session item;
3. optional user-selected folders.

Default to metadata—path, type, dimensions, hash, reference source—and generate thumbnails locally only when the user opens the visual-context view. Do not crawl the user's photo library. A thumbnail is **evidence of an available/referenced asset**, not proof that a model received the original pixels; that requires an observed model-input event.

## Finding related parent, subagent, and cross-agent sessions

ContextScope should build a relationship graph with explicit evidence levels.

| Relationship evidence | Confidence | Treatment |
|---|---:|---|
| Vendor parent/ancestor identifier or trace-span parentage | Exact | Show as a solid edge |
| Hook event containing parent session plus subagent ID | Exact for lifecycle; partial for transcript mapping | Show lifecycle edge and keep transcript association separate |
| Tool invocation that launches another agent and returns its session ID | Strong | Show as a solid edge with invocation evidence |
| Same repository fingerprint, overlapping timestamps, compatible working directories, and matching prompt fragment | Probable | Show as a dashed edge with reasons |
| Same filename or same-name folder convention only | Weak | Offer as a candidate; never auto-merge |

For Codex, app-server's `parentThreadId`/`ancestorThreadId` filters and `subAgent*` source kinds provide supported relationship data. For other agents, prefer vendor agent IDs, hook fields, and OpenTelemetry trace ancestry. Cross-vendor relationships generally have no shared identifier, so they remain inferred unless the launching tool call captures the callee's session ID.

Do not combine parent and subagent context windows into one “peak context” number. They are separate model invocations. The graph should show the parent context, each child context, the handoff payload, and which portion of the child result later entered the parent.

## Static analysis versus optional LLM analysis

One command should produce a useful report without requiring a subscription or API key.

### Always local and deterministic

- vendor and repository inventory;
- source lineage and relationship evidence;
- byte counts and vendor-reported token counts;
- duplicate and near-duplicate instruction blocks;
- missing frontmatter or invalid skill metadata;
- conflicting path scopes that can be proven syntactically;
- observed compaction, truncation, tool, and subagent lifecycle events;
- measurement coverage and unparsed-event counts.

### Optional semantic analysis

- whether instructions appear contradictory in meaning;
- whether a handoff appears to omit required decisions or evidence;
- whether a compacted summary retained a task-specific fact set;
- clustering repeated failures across sessions;
- explaining findings and drafting platform-specific fixes.

These outputs must be labeled `evaluated.llm`, include model/version and input scope, and be reproducible. They are not “facts” simply because a model generated them. A subscription can provide managed models; bring-your-own-key can run from the local companion. ContextScope should never silently use credentials discovered in Claude, Codex, Gemini, shell history, `.env`, or OS agent stores.

### Privacy modes

Offer three visible modes:

| Mode | Leaves device | Capability |
|---|---|---|
| Local static | Nothing | Inventory, exact lineage, linting, counts |
| Local redacted + managed evaluator | Only previewed/redacted excerpts and derived facts | Subscription semantic analysis |
| BYOK direct | The selected evaluator request goes to the user's chosen provider | Semantic analysis without ContextScope model billing |

The user should see a payload preview before the first remote analysis and be able to make local-only the permanent default.

## Safety and trust requirements

### Read boundaries

- Use exact documented roots, not a home-directory recursive walk.
- Resolve symlinks and reject escapes beyond authorized roots unless separately approved.
- Ignore common secret files by default (`.env*`, credential stores, SSH keys, browser profiles, cloud credentials).
- Parse only supported extensions and impose maximum file/session size, depth, count, and age.
- Never execute repository files, hooks, or skill scripts while scanning them.
- Treat all transcript and repository content as untrusted data, not instructions to the companion or evaluator.

### Local service boundaries

- Loopback only.
- Per-launch bearer/capability token.
- Same-origin UI and API; no wildcard CORS.
- Validate `Origin` and `Host` on state-changing requests.
- No filesystem write API in the read-only daemon.
- Configuration repair is a separate, previewed, explicitly approved operation with backups.
- Do not expose raw absolute paths in shareable exports unless the user opts in.

### Packaging boundaries

The npm package should be auditable, signed/provenanced where possible, and have no install-time lifecycle scripts. npm's current `npm exec` documentation highlights that fetched packages are installed into the npm cache and that install-script execution has explicit security controls; minimizing dependency and lifecycle-script surface is part of the product's trust story. ([npm exec](https://docs.npmjs.com/cli/npm-exec/))

`npx` also assumes Node/npm already exists. That is acceptable for an initial coding-agent audience but not a universal one-command story. A later release should add signed standalone binaries distributed through Homebrew, WinGet, and a direct installer, all invoking the same companion core.

## Documented facts versus design inferences

| Claim | Status | Evidence or required validation |
|---|---|---|
| A normal website cannot silently enumerate arbitrary local agent directories | Documented web security model | File/directory access is picker- and permission-based in the File System Access specification |
| `npx` can fetch and execute a package binary in one command | Documented | npm exec and `package.json` `bin` docs |
| Codex app-server can list/read stored threads and filter descendants | Documented | Codex app-server docs |
| Codex transcript files are a stable public schema | False | Codex hooks explicitly say the transcript format may change |
| Codex hooks can observe compaction, tools, sessions, and subagents | Documented | Codex hooks docs |
| ContextScope can install Codex hooks with no user step | False | Non-managed hooks require review/trust |
| Claude Code sessions and subagent transcripts are discoverable under its config root | Documented | Claude Code directory and hooks references |
| Claude filesystem existence proves an instruction loaded | False | Runtime `InstructionsLoaded` or `/memory` is stronger evidence |
| Gemini sessions live under a project-hash `chats` directory | Documented | Gemini session-management docs |
| Gemini subagents use Claude's same-name `subagents/` convention | False | Gemini's current source uses a parent-session directory plus `kind` metadata |
| Gemini has a dedicated instruction-loaded hook | Not documented | Use `/memory`, `BeforeModel`, or inferred loading labels |
| A same-name folder proves a session is a subagent of a parent | Not documented / weak inference | Use only as a candidate when stronger identifiers are absent |
| A referenced image was actually sent to the model | Not necessarily | Requires an observed model-input record, not merely a path in the repo |
| App-server reading works without active Codex authentication | Unknown | Add an integration test before product copy claims it |
| A hosted semantic analysis improves recommendations | Hypothesis | Validate with blinded, repeatable setup-repair evals |

## Recommended implementation sequence

### Milestone 1 — one-command local inventory

- publish a minimal CLI with a `bin` entry;
- start a same-origin loopback UI/API;
- implement consented repo scanning;
- implement Codex app-server `thread/list` and `thread/read`;
- show `detected → authorized → indexed → analyzed` status;
- retain raw records locally and normalize into a provenance-aware schema.

Success criterion: a new user with Node installed reaches a real, useful inventory in under two minutes without finding paths manually.

### Milestone 2 — vendor adapters and relationship graph

- Claude Code session/config adapter;
- Gemini CLI session/config adapter;
- exact vendor subagent links plus confidence-scored inferred links;
- referenced visual-asset inventory;
- unknown-event and adapter-version reporting.

Success criterion: supported fixtures reconstruct parent/child relationships and context sources without double-counting independent windows.

### Milestone 3 — optional capture

- previewed Codex/Claude hooks recipes;
- Gemini and vendor OpenTelemetry ingestion;
- live compaction, truncation, tool, and handoff events;
- reversible uninstall and trust review instructions.

Success criterion: an instrumented new session records lifecycle events without adding model-visible context or changing agent behavior.

### Milestone 4 — paid semantic buddy

- subscription and BYOK evaluator choices;
- payload preview/redaction;
- evidence-linked explanations;
- platform-specific change recipes;
- before/after eval runner.

Success criterion: recommendations improve representative task outcomes in repeatable comparisons, rather than merely lowering token counts.

## Product decision

Build the local companion. Keep the hosted product for account, billing, team policy, aggregate benchmarks, and optional evaluation—not for direct filesystem discovery.

The best concise promise is:

> **Run one command. ContextScope finds the coding-agent sessions and context setup you authorize, reconstructs what each parent and subagent received, and gives you fixes you can verify. Static facts stay local; LLM judgment is optional and clearly labeled.**
