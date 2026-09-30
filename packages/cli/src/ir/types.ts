/**
 * ContextScope Context IR (cycle 1). Source of truth for the CLI adapters
 * (plain .mjs, must produce exactly these JSON shapes) and the UI (imports types).
 * See docs/adr-001-product-architecture.md section 5.3 and docs/format-*.md.
 *
 * Privacy invariant: no field anywhere in the IR may carry message text, tool
 * output, prompt text, file contents, or absolute paths outside the user's home.
 * Blocks carry sizes and hashes only.
 */

export type Provenance =
  | "observed.vendor"   // emitted by the vendor runtime (usage fields, compactMetadata, model_context_window)
  | "observed.artifact" // directly present in a session or repository artifact (sizes, paths, tool names)
  | "derived.exact"     // deterministic arithmetic over observations
  | "estimated.local"   // reconstructed or chars/token estimate
  | "unknown";

export type Vendor = "claude" | "codex" | "gemini";

export type Category =
  | "system"              // hidden system prompt + tool schemas (derived H remainder)
  | "instructions"        // CLAUDE.md / AGENTS.md / rules chain
  | "skills"              // skill bodies injected after a Skill invocation
  | "user"                // human prompt text
  | "assistant_text"
  | "assistant_thinking"  // never part of occupancy; reported via usage.thinking
  | "tool_call"           // tool_use / function_call arguments
  | "tool_result.file"
  | "tool_result.shell"
  | "tool_result.search"
  | "tool_result.web"
  | "tool_result.other"
  | "subagent_handoff"    // what the parent received back from a child agent
  | "compaction_summary"
  | "attachments"         // system-reminders, hook stdout, task notifications, budget reminders, nested memory injections
  | "memory"              // auto-memory content when a Read proves it
  | "unlogged"            // input the model saw that is not in the transcript: resumed history, hidden injections, tool schemas beyond the baseline
  | "other";

export const CATEGORIES: Category[] = [
  "system", "instructions", "skills", "user", "assistant_text", "assistant_thinking",
  "tool_call", "tool_result.file", "tool_result.shell", "tool_result.search", "tool_result.web",
  "tool_result.other", "subagent_handoff", "compaction_summary", "attachments", "memory", "unlogged", "other",
];

export interface Measured { value: number; provenance: Provenance }

export type ToolKind = "file" | "shell" | "search" | "web" | "edit" | "agent" | "skill" | "mcp" | "other";

export interface Run {
  id: string;                          // `${vendor}:${sessionId}`
  vendor: Vendor;
  sessionId: string;
  project: { key: string; displayName: string; cwdHash: string; cwdDisplay?: string }; // cwdDisplay is ~-relative or basename only
  startedAt: string;
  endedAt: string;
  activeMs: number;                    // gap-based active time (gaps > 30 min excluded)
  cliVersion?: string;
  gitBranch?: string;
  entrypoint?: string;                 // claude: entrypoint field; codex: source kind
  // project.key = `${basename(cwd)}-${sha1(cwd).slice(0, 8)}` for every vendor (src/ir/project.mjs); never the encoded cwd
  window: Measured & { lowerBound?: number }; // codex: model_context_window (observed.vendor); claude: model table (estimated.local); raised to the smallest documented window >= peak (derived.exact, lowerBound = peak) or kept at the peak (unknown)
  scopes: AgentScope[];                // scopes[0] is the parent ("main")
  summary: RunSummary;
  coverage: Coverage;
  source: { file: string; bytes: number; mtimeMs: number; subagentFiles: number }; // file is ~-relative; the encoded Claude project-dir segment is replaced by project.key
  handoffsByThread?: Record<string, CodexHandoff>; // codex only: what this rollout received back from child threads that live in separate rollouts (join key = child run sessionId)
  instructionFilesObserved?: string[]; // InstructionsLoaded hook records joined to this run (repo- or ~-relative paths, unique, <= 200)
  mcpToolsObserved?: string[];         // claude: every mcp__<server>__<tool> name called in the run
  tokenBudget?: { max: number; last: number; provenance: "observed.vendor" }; // claude: budget reminders seen (extra field, never the window)
  // codex only (adapters/codex.mjs): rollout lineage and instruction observations
  kind?: "main-run" | "subagent-run";
  parentThreadId?: string;             // codex: parent rollout thread id (subagent-run)
  spawnDepth?: number;
  spawnedThreadIds?: string[];
  baseInstructionsTokens?: number;     // codex: estimated tokens of base_instructions
  instructionsObserved?: { chars: number; provenance: "observed.artifact" }; // codex: AGENTS.md chars as loaded by the runtime
  threadSource?: string;
  forkedFromThreadId?: string;
  forkBootstrap?: boolean;
  dynamicTools?: string[];
}

/** Codex parent-side handoff record; the index joins it to the child run (`codex:<threadId>`) and fills the child's `scope.handoff`. */
export interface CodexHandoff {
  blockId: string;                     // first subagent_handoff block from that child in the parent scope
  tokens: Measured;                    // sum of every handoff block from that child (estimated.local)
  deliveredAtRequest: number;          // parent request index where the first handoff landed
  launchedAtRequest?: number;          // parent request index of the spawn_agent call, when known
  blocks: number;                      // number of handoff blocks from that child
}

export interface Coverage {
  records: number;
  unparsedRecords: number;
  unparsedTypes: Record<string, number>;
  requests: number;
  syntheticRecordsSkipped: number;
  estimatorErrorMedian: number;        // MAIN scope: median |1 - scaleRaw| over unclamped, non-segment-start requests
  estimatorErrorP95: number;           // MAIN scope p95 (same series)
  clampedRequests?: number;            // MAIN scope: requests whose scaleRaw fell outside [reconcileScaleMin, reconcileScaleMax]
  unloggedShare?: number;              // MAIN scope: sum(unlogged_i) / sum(usage.total)
  adapterVersion: string;
  rulesHash?: string;                  // hash of the rule modules + thresholds used for the stored findings
  estimatorVersion?: string;           // ESTIMATOR_VERSION at parse time ("chars-v2"); index invalidation key
  calibrationVersion?: string;         // CALIBRATION_VERSION at parse time; index invalidation key
  capture?: { records: number; unmatchedCompactions: number; unmatchedAgents: number }; // hook capture records joined to this run (capture/join.mjs)
  rulesError?: string;                 // the rules engine threw; findings are empty for this run
  scrubbedKeys?: number;               // forbidden keys removed by the privacy scrub before storage
  ignoredTypes?: Record<string, number>;          // claude: record types deliberately skipped
  transcriptOnlyRecordsSkipped?: number;          // claude: records that never reach the model
  unresolvedHandoffs?: number;         // codex: child results that could not be joined to a spawn
  truncatedOutputs?: number;           // codex: tool outputs the runtime truncated before logging
}

export interface AgentScope {
  id: string;                          // "main" or agentId
  kind: "main" | "subagent";
  agentType?: string;                  // claude: meta.json agentType / attributionAgent; codex: agent_nickname / role
  description?: string;                // claude meta.json description (short, user-authored label)
  parentScopeId?: string;
  depth: number;                       // 0 for main
  launchedAtRequest?: number;          // parent request index of the spawning tool call
  deliveredAtRequest?: number;         // parent request index where the handoff landed
  launchedAt?: string;
  deliveredAt?: string;
  status: "completed" | "open" | "unknown";
  handoff?: { blockId: string; tokens: Measured; compressionRatio: Measured }; // ratio = child peak / handoff tokens
  models: string[];
  requests: Request[];
  blocks: Block[];                     // every block emitted in this scope, in order
  compactions: Compaction[];
  peak: Measured;                      // max usage.total (observed.vendor)
  processedInputTokens: number;        // sum usage.total
  outputTokens: number;                // sum usage.output
  toolCalls: number;
  source?: { file: string; bytes: number };
  partial?: boolean;                   // true when the API omitted blocks/requests (fetch /runs/:vendor/:id/scopes/:scope for the full scope)
  requestCount?: number;               // present on partial scopes
  topBlocks?: Array<{ id: string; category: Category; estTokens: number; firstRequest: number; tool?: string; label?: string }>;
  unloggedShare?: number;              // sum(unlogged_i) / sum(usage.total) for this scope (reconciliation v2)
  estimatorErrorMedian?: number;       // per-scope estimator error: median |1 - scaleRaw| over unclamped, non-segment-start requests (main scope drives the run badge)
  estimatorErrorP95?: number;
  clampedRequests?: number;            // requests whose scaleRaw fell outside the clamp band (counted, never averaged in)
  baseSteps?: Array<{ atRequest: number; delta: number }>; // hidden-base re-derivations (persistent residual steps; mirrors requests[].baseChange)
  forecast?: Forecast;                 // live mode: compaction forecast from the last requests' slope
  capture?: { records: number };       // runtime hook capture records joined to this scope
  resumed?: boolean;                   // unlogged mass at request 0 exceeds half of that request's total (resumed / forked history)
  transcriptIncomplete?: boolean;      // unloggedShare > 0.8 and fewer than 20% of requests gained blocks (codex legacy history_mode children): hide the stack
}

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  thinking?: number;
  total: number;                       // input + cacheCreation + cacheRead (claude) or last_token_usage.input_tokens (codex)
}

export interface Request {
  index: number;
  id?: string;
  at: string;
  model: string;
  turn: number;                        // human-prompt turn number within the scope
  usage: Usage;                        // observed.vendor
  visibleBlockIds?: string[];          // V_i; optional in the JSON to keep payloads small (derivable from blocks' presence windows)
  hiddenBase: Measured;                // system + instructions + unlogged for this request (estimated.local)
  scale: number;                       // k_i after clamping to [reconcileScaleMin, reconcileScaleMax] (below the band only when `reconciled === "rebased"`)
  scaleRaw?: number;                   // k_i before clamping; the estimator error series uses this
  composition: Partial<Record<Category, number>>; // reconciled; sums to usage.total; never negative
  deltaCheck?: number;                 // claude only: (input + cacheCreation) - est(new visible blocks); absent on segment starts
  newBlockIds: string[];               // every block with firstRequest === index (thinking included)
  compactionBefore?: string;           // id of the compaction that happened right before this request
  baseChange?: { tokens: number; provenance: "derived.exact" }; // persistent step in hidden mass detected here (+ up / - down)
  reconciled?: "rebased";              // usage.total was below the hidden base: system, instructions and unlogged were zeroed and k fell below the band
}

export interface Block {
  id: string;                          // `${scopeId}:${seq}`
  seq: number;
  at: string;
  category: Category;
  bytes: number;                       // observed.artifact
  estTokens: number;                   // estimated.local
  kind?: "prose" | "code";
  tool?: { name: string; kind: ToolKind; argsHash: string; target?: string; isError?: boolean; server?: string; partial?: boolean; truncated?: boolean; originalTokens?: number }; // partial = a ranged/limited read, not the whole file
  toolUseId?: string;
  agentId?: string;
  attachmentType?: string;             // claude attachment.type / codex developer tag
  via?: "attachment" | "tool_result";  // claude subagent_handoff / task notification delivered other than as a standalone user record (docs/format-claude-code.md section 5)
  label?: string;                      // short safe label: tool name, repo-relative path, attachment type; never content
  firstRequest: number;
  lastRequest?: number;                // undefined = still present at end of scope; lastRequest < firstRequest = never entered the window (in flight at a compaction)
  droppedBy?: string;                  // compaction id
  preservedBy?: string;                // compaction id whose preservedMessages kept this pre-boundary block in the window
  hash: string;                        // sha1 of content; content never stored
}

export interface Compaction {
  id: string;
  at: string;
  atRequest: number;                   // index of the first request after the boundary
  trigger: "auto" | "manual" | "unknown";
  preTokens: Measured;
  postTokens: Measured;
  droppedTokens: Measured;
  summaryBlockId?: string;
  durationMs?: number;
  preservedMessages?: number;
  hookObserved?: boolean;              // confirmed by a PreCompact/PostCompact capture record
}

/** Where a forecast threshold comes from (ADR-004 section 4: show the provenance and the range, not a point). */
export interface ForecastThresholdBasis {
  kind: "own-compactions" | "own-compactions-inferred" | "calibration" | "calibration-inferred" | "default";
  events: number;                      // auto-compactions behind the number (0 for the documented default)
  min?: number;                        // tokens: lowest / highest event (own compactions) or share x window (calibration)
  max?: number;
  share?: number;                      // calibrated or default share of the window
  window?: number;                     // window the share was measured on / applied to
}

export interface Forecast {
  threshold: Measured & { basis?: ForecastThresholdBasis }; // auto-compaction threshold; observed.vendor only when the vendor reported the preTokens
  perRequest: number;                  // tokens added per request over the basis window
  perMinute: number;                   // per ACTIVE minute (gaps >= 30 min excluded, as activeMs)
  requestsLeft: number;
  minutesLeft: number;                 // active minutes
  basis: { requests: number; from: number; to: number };
  provenance: "derived.exact";
  status?: "ok" | "flat";              // flat: threshold > 1,000 requests or > 24 h away at this rate -> "no compaction expected at this rate"; absent on runs indexed before this field existed
}

export interface RunSummary {
  requests: number;
  turns: number;
  processedInputTokens: number;
  outputTokens: number;
  cacheReadShare: number;              // sum cacheRead / sum total
  peak: Measured;
  peakShareOfWindow: number;
  compactions: number;
  subagents: number;
  toolCalls: number;
  models: string[];
  topBlocks: Array<{ id: string; scopeId: string; category: Category; estTokens: number; firstRequest: number; tool?: string; label?: string }>;
  findingIds: string[];
  compositionAtPeak: Partial<Record<Category, number>>;
  compositionAtEnd?: Partial<Record<Category, number>>; // main scope, last request; absent on entries indexed before it existed
}

export type Severity = "high" | "medium" | "low";

export interface Evidence {
  kind: "file" | "request" | "block" | "scope" | "metric" | "run";
  ref: string;                         // file: repo-relative or ~-relative path; request: `${runId}#${scopeId}#${index}`; block: block id prefixed by runId
  label: string;
  value?: number;
  unit?: "tokens" | "chars" | "count" | "ratio" | "percent" | "ms";
  provenance: Provenance;
}

export interface Finding {
  id: string;                          // stable hash of ruleId + primary evidence ref
  ruleId: string;
  severity: Severity;
  scope: "setup" | "session" | "subagent" | "habit";
  vendor?: Vendor;
  runId?: string;
  sessions?: number;                   // habit findings: sessions the evidence spans
  title: string;
  whyItMatters: string;
  evidence: Evidence[];
  fix: { platform: Vendor | "both"; summary: string; snippet?: string; path?: string };
  thresholdKeys: string[];
  tokensAffected?: number;             // ranking signal, estimated
  recurrence?: number;                 // sessions (root runs) in which the same rule fired (computed by the API layer)
  rootRunId?: string;                  // when the finding lives in a child rollout: the session (root run) it belongs to
  count?: number;                      // occurrences aggregated into this finding (per-block rules emit one finding per rule × run × scope)
  scopeId?: string;
}

export interface InstructionFile {
  path: string;                        // repo-relative, or ~-relative for user scope
  scope: "user" | "project" | "local" | "nested" | "rules" | "override";
  vendors: Vendor[];
  bytes: number;
  estTokens: number;
  precedence: number;
  mtime: string;
  loadState: "discoverable" | "expected.load" | "observed.loaded";
  brokenRefs: string[];
  pathsFrontmatter?: string[];
  imports?: string[];
}

export interface SetupInventory {
  repo: { name: string; root: "cwd"; git: boolean };
  vendorsDetected: Vendor[];
  instructionFiles: InstructionFile[];
  skills: Array<{ name: string; path: string; scope: "user" | "project" | "plugin"; hasDescription: boolean; descriptionChars: number; bodyEstTokens: number; frontmatterValid: boolean; invocations30d: number; vendors?: Vendor[]; aliases?: string[] }>; // path = real location; aliases = symlinks to it (e.g. .claude/skills/x -> .agents/skills/x)
  agents: Array<{ name: string; path: string; scope: "user" | "project"; model?: string; tools?: string[]; descriptionChars: number; runs30d: number }>;
  hooks: Array<{ event: string; matcher?: string; command: string; scope: "user" | "project" | "local"; runs30d: number; stdoutP50: number; stdoutP95: number }>;
  mcpServers: Array<{ name: string; scope: "user" | "project" | "local"; transport?: string; toolsObserved: string[]; invocations30d: number }>;
  commands: Array<{ name: string; path: string }>;
  memory: { present: boolean; bytes: number; files: number; indexBytes: number };
  settings: Array<{ path: string; scope: "user" | "project" | "local"; keys: string[] }>;
  startupBudget: Partial<Record<Vendor, { instructions: Measured; skills: Measured; agents: Measured; mcpTools: Measured; total: Measured }>>;
  excluded?: Array<{ path: string; reason: "fixture" }>; // instruction/skill/agent files found under test fixture directories: listed, never counted (chain, budget, trends, S rules)
}

export interface OverviewRun {
  id: string; vendor: Vendor; project: Run["project"]; startedAt: string; endedAt: string; activeMs: number;
  summary: RunSummary; window: Measured; findingsCount: number; findingsHigh: number;
  children?: OverviewRun[];            // codex subagent rollouts under their root run (every depth, flattened; ADR-004 section 2)
  parentRunId?: string;                // the direct parent thread's run id
  rootRunId?: string;                  // the session (top-level run) a child belongs to
  handoff?: { tokens: number; childPeak: number; ratio: number }; // the parent's handoff block for a codex child
  live?: { at: string };               // transcript changed within the live window (index.liveRuns(), companion only)
}

export interface Overview {
  // A session is a top-level run; codex child rollouts are its subagents (ADR-004 section 2). Every `sessions` count uses that rule.
  // `attributed` = repo sessions that joined through evidence (temp cwd), `harness` = harness runs on the machine in range (ADR-005 section 2); `kind` echoes a `kind=harness` listing.
  scope?: { mode: "repo" | "all"; repo: { name: string; key: string }; sessions: number; subagents?: number; machineSessions: number; unattributed: number; attributed?: number; harness?: number; kind?: SessionKind };
  runs: OverviewRun[];
  totals: { runs: number; subagents: number; requests: number; processedInputTokens: number; outputTokens: number; cacheReadShare: number; compactions: number; vendors: Vendor[]; sessionsByVendor?: Partial<Record<Vendor, number>>; sessionsHot?: number };
  trends: { days: string[]; processedInputTokens: number[]; requests: number[]; compactions: number[]; subagents: number[]; sessions?: number[]; peakShareMedian?: number[]; startupH0Median?: number[]; instructionEdits?: Array<{ path: string; at: string }> };
  topOffenders: {
    // `runId` is always the session (root run); for a codex child's block/handoff `scopeId` is the child's run id and `sourceRunId` names it.
    largestBlocks: Array<{ runId: string; scopeId: string; blockId: string; category: Category; estTokens: number; firstRequest: number; tool?: string; label?: string; sourceRunId?: string; sourceScopeId?: string }>;
    fattestHandoffs: Array<{ runId: string; scopeId: string; agentType?: string; handoffTokens: number; childPeak: number; ratio: number; parentRunId?: string; sourceRunId?: string }>;
    mostCompacted: Array<{ runId: string; compactions: number; processedInputTokens: number }>;
  };
  // Mean composition of the main scope's last request over the sessions in range (each session weighs the same).
  contextAtEnd?: { sessions: number; meanTotal: number; rows: Array<{ category: Category; share: number; tokens: number; sessions: number }> };
  firstFinding?: Finding;
  since?: string | null;               // ISO lower bound of the range, null for all time
  range?: string;                      // the range as requested/resolved: "30d", "90d", "all", an ISO date; default: all time for scope=repo, 30d for scope=all
  index: { total: number; done: number; failed: number; lastRunAt?: string; state: "idle" | "indexing" };
}

export interface Thresholds { [key: string]: number }

/** Live mode: the requests/blocks appended since a known request index. */
export interface RunTail {
  requests: Request[];
  blocks: Block[];
  closed: Array<{ id: string; lastRequest: number; droppedBy?: string }>;
  compactions: Compaction[];
  summary: RunSummary;
  peak: Measured;
  forecast?: Forecast;
  rebased: boolean;                    // true when reconciliation changed earlier requests; client must reload
}

/** Privacy-safe export document (`contextscope export`). */
export interface Export {
  schema: "contextscope.export/1";
  exportedAt: string;
  generator: { name: string; version: string };
  redaction: { labels: "plain" | "sha1-10"; project: "basename" | "hashed" };
  run: Run & { findings: Finding[] };
  scopes: Record<string, AgentScope>;
  thresholds: Thresholds;
  markdown: string;
}

/** One line of ~/.contextscope/capture/<sessionId>.jsonl written by the installed hook. No text, no absolute paths. */
export interface CaptureRecord {
  v: 1;
  at: string;
  event: string;                       // InstructionsLoaded | SessionStart | PreCompact | PostCompact | SubagentStart | SubagentStop | ...
  sessionId: string;
  cwdKey: string;                      // projectKeyFor(cwd)
  transcript: string;                  // ~-relative transcript path
  file?: string;                       // instruction file: relative to the hook's cwd, or ~-relative when outside it (never absolute)
  memoryType?: string;                 // observed in the wild (`memory_type` / `is_global_instructions`), not in the hooks reference; absent when the CLI omits it
  loadReason?: string;
  source?: string;
  agentId?: string;                    // with or without the `agent-` prefix depending on the CLI build; the join accepts both
  agentType?: string;
  agentTranscript?: string;            // ~-relative subagent transcript path (SubagentStop); observed in the wild (`agent_transcript_path`), not in the hooks reference. The join matches its basename (`agent-<id>.jsonl`) when `agentId` does not resolve
  trigger?: string;
}

// ---------- per-tool cost (ADR-005 section 5; cycle 3, stream C) ----------

/** Row kind: a ToolKind for tool blocks, `agent` for subagent handoffs, `attachment` for attachments and reminders. */
export type ToolCostKind = ToolKind | "attachment";

/**
 * One row of a per-tool cost table. Unit: token-requests (`ir/finalize.mjs`
 * TOOL_COST_UNIT), provenance `estimated.local` (TOOL_COST_PROVENANCE): for
 * every block of the group, `estTokens x sum(k_i)` over the block's presence
 * window; `uncached` weights each request by `1 - cacheRead_i / total_i`;
 * `share = tokenRequests / sum(usage.total)` of the scope (or the run for the
 * summary). Tables hold the top 8 rows plus one `other` row. Cache-read share
 * of a row = `1 - uncached / tokenRequests`. Presence is not attention: see
 * TOOL_COST_CAVEATS.
 */
export interface ToolCostRow {
  name: string;                        // tool name (`mcp__<server>__<tool>` for MCP), "Agent handoffs", an attachment type, or "other"
  kind: ToolCostKind;
  server?: string;                     // MCP server name (hashed under --redact-labels)
  blocks: number;
  tokenRequests: number;
  uncached: number;
  share: number;                       // of the scope's / run's sum of vendor totals (observed.vendor denominator)
}

export interface AgentScope {
  toolCost?: ToolCostRow[];            // this scope's table (absent on runs indexed before cycle 3)
}

export interface RunSummary {
  toolCost?: ToolCostRow[];            // main + subagent scopes merged, top 8 + other
}

/** `GET /api/v1/cost` (`server/routes/cost.mjs`): a run's table, one scope's table, or the population aggregate (manifest only). */
export interface CostResponse {
  unit: "token-requests";
  provenance: "estimated.local";
  /** What the rows describe: one run (optionally one scope of it), or every session of the repo / machine in the range. */
  scope: { mode: "run"; runId: string; scopeId?: string } | { mode: "repo" | "all"; sessions: number; runs: number; runsWithoutCost: number; since: string | null; range: string };
  denominator: number;                 // sum of vendor totals the shares are taken over
  rows: ToolCostRow[];
  caveats: string[];
}

// --- ADR-005 (cycle 3): session kind and minimal attribution (stream B) ---

/**
 * "harness": an SDK-driven run (`Run.entrypoint === "sdk-cli"`) or a temp-cwd
 * run with no tool call and at most two requests; "interactive" otherwise.
 * Harness runs never enter a repo or machine population, habits, trends or
 * offenders; they are counted on the overview header and listed only under
 * `scope=all&kind=harness`. (Codex `Run.kind` is the rollout lineage; this is
 * the session kind on the manifest entry and the overview row.)
 */
export type SessionKind = "interactive" | "harness";

/** How a session joined the launched repo's population (index/reader.mjs `attributionOf`). */
export interface Attribution {
  key: string;                         // the repo's project key
  method: "cwd" | "nested-hash" | "instructions-hash" | "path-overlap";
  // cwd / nested-hash / instructions-hash are observed.artifact (exact); path-overlap is derived (>= 5 distinct targets, >= 80 % in the repo's file list)
  confidence: "exact" | "derived";
  files?: number;                      // path-overlap: matched targets
}

export interface InstructionFile {
  hash?: string;                       // sha1 of the file content (observed.artifact); joins a session's nested_memory / AGENTS.md block hash
}

export interface OverviewRun {
  kind?: SessionKind;                  // absent = interactive (entry indexed before the field existed)
  attribution?: Attribution;           // present only for a temp-cwd session attributed through evidence (never for a cwd match)
  entrypoint?: string;                 // claude: entrypoint field; codex: source kind
}

// --- ADR-005 §1 / §3: before/after per instruction-file edit, experiments (additive; stream A) ---

/** One side of a paired metric: the median over the sessions that carry the metric. */
export interface ChangeMeasure { value: number | null; n: number; provenance: Provenance }
export type ChangeMetricKey = "startupH0" | "peakShare" | "compactionsPerHour" | "processedInputTokens" | "fatResults" | "handoffRatio";
export type ChangeAnchor = "commit" | "mtime" | "experiment";

/** Before/after around one edit of an instruction file (or an experiment's candidate snapshot). Observational: every row carries `caveats`. */
export interface Change {
  file: string;                        // repo-relative instruction file, or the experiment name
  at: string;                          // anchor time (ISO)
  anchor: ChangeAnchor;
  commit?: string;                     // short commit id for `anchor: "commit"`
  n: { before: number; after: number; afterObserved: number; unverified?: number; baseline?: number; candidate?: number };
  before: Record<ChangeMetricKey, ChangeMeasure>;
  after: Record<ChangeMetricKey, ChangeMeasure>;
  /** after − before per metric; token metrics add `<key>Ratio` = after / before. */
  delta: Partial<Record<ChangeMetricKey | `${ChangeMetricKey}Ratio`, number>>;
  /** Seeded bootstrap of the difference of medians, only when n ≥ 5 on both sides. */
  ci?: Partial<Record<ChangeMetricKey, { low: number; high: number; level: 0.9; provenance: "derived.exact"; claim: "observational" }>>;
  findingsByRule: Array<{ ruleId: string; title: string; before: { sessions: number; of: number }; after: { sessions: number; of: number } }>;
  confounds: { models: { before?: string; after?: string }; cliVersions: { before: string[]; after: string[] }; confounded: boolean; reason?: string };
  caveats: string[];
  claim: "observational";
}

export interface ChangeNote { file: string; at: string; anchor: ChangeAnchor; reason: string }
/** GET /api/v1/changes */
export interface ChangesResponse { changes: Change[]; notes: ChangeNote[]; since: string; sessions: number; files: number }

/** `contextscope experiment`: the instruction chain at one instant. No absolute paths. */
export interface ExperimentSnapshot {
  at: string;
  repo: { name: string; key: string };
  chain: Array<{ path: string; hash: string; bytes: number; vendors: Vendor[] }>;
  chainHash: string;
  rulesHash: string | null;
  thresholdsHash: string | null;
  vendors: Vendor[];
}

export interface Experiment { version: 1; name: string; repo: { name: string; key: string }; createdAt: string; baseline: ExperimentSnapshot; candidate?: ExperimentSnapshot }

/** `experiment compare --json`: the Change (anchor "experiment") plus the bookkeeping. */
export type ExperimentReport = Change & {
  experiment: {
    name: string;
    repo: { name: string; key: string };
    baseline: { at: string; chainHash: string; files: number; rulesHash: string | null; thresholdsHash: string | null };
    candidate: { at: string; chainHash: string; files: number; rulesHash: string | null; thresholdsHash: string | null };
    changedFiles: Array<{ path: string; state: "changed" | "added" | "removed"; from?: string; to?: string; bytesFrom?: number; bytesTo?: number }>;
    verified: { baseline: number; candidate: number };
    excluded: { vendor: number; model: number; cliVersion: number };
    comparable: { vendors: Vendor[]; model: string | null; cliVersion: string | null };
    minSessions: number;
    enough: boolean;
  };
};
