#!/usr/bin/env node
/**
 * Generates synthetic Codex rollout fixtures with the exact envelope shapes from
 * docs/format-codex.md. All text is deterministic lorem ipsum carrying the
 * sentinel word LOREMSENTINEL so tests can prove no content leaks into the IR.
 * Nothing here is copied from a real transcript.
 *
 *   node test/fixtures/codex/make-fixtures.mjs        # rewrites the .jsonl files next to this script
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const HOME = "/home/synthetic";
export const CWD = `${HOME}/work/orchard`;
export const THREAD_PLAIN = "01a00000-0000-7000-8000-000000000001";
export const THREAD_DESKTOP = "01a00000-0000-7000-8000-000000000002";
export const THREAD_CHILD = "01a00000-0000-7000-8000-000000000003";
export const WINDOW = 258_400;
export const BASE_INSTRUCTIONS_CHARS = 17_000;
export const AGENTS_MD_CHARS = 11_000;
export const COMPACTION_SUMMARY_CHARS = 12_000;
export const BOOTSTRAP_SUMMARY_CHARS = 8_000;
export const USER_INSTRUCTIONS_A_CHARS = 9_000;
export const USER_INSTRUCTIONS_B_CHARS = 9_600;

// ---- deterministic lorem ---------------------------------------------------

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(" ");
let seed = 42;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
export function lorem(chars, { sentinel = "LOREMSENTINEL" } = {}) {
  let out = sentinel + " ";
  while (out.length < chars) {
    out += WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.08 ? ".\n" : " ");
  }
  return out.slice(0, chars);
}
export function loremCode(chars) {
  let out = "// LOREMSENTINEL\n";
  let i = 0;
  while (out.length < chars) {
    out += `export function fn${i}(a, b) { return { a: [a, b], b: a * ${Math.floor(random() * 100)} }; }\n`;
    i += 1;
  }
  return out.slice(0, chars);
}

// ---- envelope helpers --------------------------------------------------------

class Clock {
  constructor(start) { this.ms = Date.parse(start); }
  next(seconds = 1) { this.ms += seconds * 1000; return new Date(this.ms).toISOString(); }
}

function record(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function rateLimits() {
  return { limit_id: "synthetic", limit_name: null, plan_type: "synthetic", primary: { used_percent: 1, window_minutes: 300, resets_at: 0 }, secondary: null, credits: null, rate_limit_reached_type: null };
}

let cumulative = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
export function tokenCount(timestamp, { input, cached, output, reasoning, cacheWrite = 0 }) {
  const last = { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
  cumulative = {
    input_tokens: cumulative.input_tokens + input, cached_input_tokens: cumulative.cached_input_tokens + cached, output_tokens: cumulative.output_tokens + output,
    reasoning_output_tokens: cumulative.reasoning_output_tokens + reasoning, total_tokens: cumulative.total_tokens + input + output,
  };
  return record(timestamp, "event_msg", { type: "token_count", info: { total_token_usage: { ...cumulative }, last_token_usage: last, model_context_window: WINDOW }, rate_limits: rateLimits() });
}

function sessionMeta(timestamp, overrides) {
  return {
    session_id: overrides.id, id: overrides.id, timestamp, cwd: CWD, originator: "codex-tui", cli_version: "0.150.1", source: "cli", thread_source: "user",
    model_provider: "openai", base_instructions: { text: lorem(BASE_INSTRUCTIONS_CHARS), provenance: { type: "builtin", model: "gpt-5.6-sol" } },
    history_mode: "paginated", context_window: { window_id: `${overrides.id}-w1` }, git: { branch: "feature/synthetic", commit_hash: "0000000000000000000000000000000000000000", repository_url: "git@synthetic.invalid:orchard/orchard.git" },
    ...overrides,
  };
}

function turnContext(turnId, overrides = {}) {
  return {
    turn_id: turnId, cwd: CWD, workspace_roots: [CWD], current_date: "2026-09-01", timezone: "UTC", approval_policy: "on-request", approvals_reviewer: "auto_review",
    sandbox_policy: { type: "workspace-write", network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true, writable_roots: [] },
    permission_profile: { type: "managed", network: "restricted", file_system: { type: "restricted", entries: [{ access: "read_write", path: { type: "literal", value: CWD } }] } },
    file_system_sandbox_policy: { type: "workspace-write" }, model: "gpt-5.6-sol", comp_hash: "synthetic", personality: "pragmatic",
    collaboration_mode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "low", developer_instructions: lorem(900) } },
    multi_agent_version: 2, realtime_active: false, summary: "auto", effort: "low", ...overrides,
  };
}

function itemBase(id, turnId) {
  return { id, internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: 0 } };
}

function userMessage(turnId, parts, id = "msg_u") {
  return { type: "message", role: "user", content: parts.map((part) => (typeof part === "string" ? { type: "input_text", text: part } : part)), ...itemBase(id, turnId) };
}
function developerMessage(turnId, parts, id = "msg_d") {
  return { type: "message", role: "developer", content: parts.map((text) => ({ type: "input_text", text })), ...itemBase(id, turnId) };
}
function assistantMessage(turnId, text, phase, id = "msg_a") {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase, ...itemBase(id, turnId) };
}
function reasoning(turnId, chars, id = "rs") {
  return { type: "reasoning", summary: [], encrypted_content: lorem(chars, { sentinel: "LOREMSENTINELENC" }).replace(/\s/g, "x"), content: null, ...itemBase(id, turnId) };
}
function execCall(turnId, callId, cmd, { workdir = CWD } = {}) {
  const input = `const r = await tools.exec_command(${JSON.stringify({ cmd, workdir, max_output_tokens: 12000, yield_time_ms: 1000 })});\nreturn r;`;
  return { type: "custom_tool_call", name: "exec", input, call_id: callId, status: "completed", ...itemBase(`ctc_${callId}`, turnId) };
}
function execOutput(turnId, callId, body, { failed = false, wall = 0.4 } = {}) {
  const text = `${failed ? "Script failed" : "Script completed"}\nWall time ${wall} seconds\nOutput:\n${body}`;
  return { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text }], ...itemBase(`ctco_${callId}`, turnId) };
}
function functionCall(turnId, callId, name, args, namespace) {
  return { type: "function_call", name, arguments: JSON.stringify(args), call_id: callId, ...(namespace ? { namespace } : {}), ...itemBase(`fc_${callId}`, turnId) };
}
function functionOutput(turnId, callId, output) {
  return { type: "function_call_output", call_id: callId, output, ...itemBase(`fco_${callId}`, turnId) };
}
function itemCompleted(turnId, threadId, item) {
  return { type: "item_completed", thread_id: threadId, turn_id: turnId, item, started_at_ms: 0, completed_at_ms: 1 };
}
function agentsMdPart(dir = CWD) {
  return `# AGENTS.md instructions for ${dir}\n\n<INSTRUCTIONS>\n${lorem(AGENTS_MD_CHARS)}\n</INSTRUCTIONS>`;
}
function environmentPart() {
  return `<environment_context>\n  <cwd>${CWD}</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-09-01</current_date>\n  <timezone>UTC</timezone>\n  <filesystem>${lorem(400)}</filesystem>\n</environment_context>`;
}
function tagged(tag, chars, closeTag = tag) {
  return `<${tag}>\n${lorem(chars)}\n</${closeTag}>`;
}
function truncatedExecCommandOutput(originalTokens, body, tail) {
  return `Chunk ID: 0a1b2c3d\nWall time: 0.2 seconds\nProcess exited with code 0\nOriginal token count: ${originalTokens}\nOutput:\n${body}\n…${originalTokens - 400} tokens truncated…\n${tail}`;
}
export function worldState(full, state) {
  return { full, state };
}

// ---- fixture 1: plain cli -------------------------------------------------------

export function plainCliRollout() {
  const clock = new Clock("2026-09-01T10:00:00.000Z");
  const T = THREAD_PLAIN;
  const t1 = "turn-0001";
  const t2 = "turn-0002";
  const lines = [];
  const meta = sessionMeta(clock.next(0), { id: T });
  lines.push(record(clock.next(), "session_meta", meta));
  lines.push(record(clock.next(), "session_meta", meta)); // reconnect re-emit: must be a no-op
  lines.push(record(clock.next(), "event_msg", { type: "task_started", turn_id: t1, started_at: 1_788_000_000, model_context_window: WINDOW, collaboration_mode_kind: "default" }));
  lines.push(record(clock.next(), "response_item", developerMessage(t1, [tagged("skills_instructions", 6000), tagged("permissions instructions", 4000), tagged("collaboration_mode", 900), tagged("apps_instructions", 600), tagged("plugins_instructions", 1000)])));
  lines.push(record(clock.next(), "response_item", userMessage(t1, [agentsMdPart(), environmentPart(), `${lorem(1500)} ${lorem(200)}`])));
  lines.push(record(clock.next(), "world_state", worldState(true, { agents_md: { directory: CWD, text: lorem(AGENTS_MD_CHARS - 100) }, environments: {}, permissions: {}, skills: { includeInstructions: true }, model: "gpt-5.6-sol", personality: "pragmatic" })));
  lines.push(record(clock.next(), "turn_context", turnContext(t1)));
  lines.push(record(clock.next(), "event_msg", { type: "user_message", message: lorem(1500), images: [], local_images: [], text_elements: [] }));
  lines.push(record(clock.next(), "event_msg", { type: "token_count", info: null, rate_limits: rateLimits() }));
  // request 0
  lines.push(record(clock.next(), "response_item", reasoning(t1, 1400, "rs_1")));
  lines.push(record(clock.next(), "response_item", assistantMessage(t1, lorem(200), "commentary", "msg_a1")));
  lines.push(record(clock.next(), "response_item", execCall(t1, "call_1", "sed -n '1,200p' packages/core/src/index.ts")));
  lines.push(record(clock.next(), "event_msg", itemCompleted(t1, T, { type: "CommandExecution", id: "call_1", command: "sed", cwd: CWD, status: "completed" })));
  lines.push(record(clock.next(), "response_item", execOutput(t1, "call_1", `Warning: truncated output (original token count: 9000)\nTotal output lines: 800\n${loremCode(30_000)}`)));
  lines.push(tokenCount(clock.next(), { input: 18_500, cached: 11_000, output: 450, reasoning: 300, cacheWrite: 7_500 }));
  // request 1
  lines.push(record(clock.next(), "response_item", reasoning(t1, 900, "rs_2")));
  lines.push(record(clock.next(), "response_item", functionCall(t1, "call_2", "exec_command", { cmd: 'rg -n "needle" packages/core/src', workdir: CWD, max_output_tokens: 12000, yield_time_ms: 1000 })));
  lines.push(record(clock.next(), "response_item", functionOutput(t1, "call_2", truncatedExecCommandOutput(750, lorem(1200), lorem(300)))));
  lines.push(tokenCount(clock.next(), { input: 28_000, cached: 18_000, output: 300, reasoning: 120 }));
  // request 2 (web search + unknown record type in between)
  lines.push(record(clock.next(), "response_item", { type: "web_search_call", status: "completed", action: { type: "search", query: lorem(40) }, ...itemBase("ws_1", t1) }));
  lines.push(record(clock.next(), "future_record", { anything: lorem(50) }));
  lines.push(record(clock.next(), "response_item", reasoning(t1, 700, "rs_3")));
  lines.push(record(clock.next(), "response_item", assistantMessage(t1, lorem(900), "final_answer", "msg_a2")));
  lines.push(tokenCount(clock.next(), { input: 29_200, cached: 27_900, output: 400, reasoning: 100 }));
  lines.push(record(clock.next(), "event_msg", { type: "task_complete", turn_id: t1, last_agent_message: lorem(900), duration_ms: 12_000, time_to_first_token_ms: 900 }));
  // turn 2: image attachment + apply_patch + shell pipeline with a bash -lc wrapper
  lines.push(record(clock.next(), "event_msg", { type: "user_message", message: lorem(300), images: [], local_images: [`${HOME}/pic.png`], text_elements: [] }));
  lines.push(record(clock.next(), "response_item", userMessage(t2, [lorem(300), `<image name=[Image #1] path="${HOME}/pic.png">`, { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(4000)}`, detail: "auto" }], "msg_u2")));
  lines.push(record(clock.next(), "turn_context", turnContext(t2)));
  lines.push(record(clock.next(), "response_item", reasoning(t2, 500, "rs_4")));
  lines.push(record(clock.next(), "response_item", { type: "custom_tool_call", name: "exec", input: `const patch = ${JSON.stringify(`*** Begin Patch\n*** Update File: packages/core/src/index.ts\n@@\n-old\n+new\n*** End Patch\n`)};\nconst r = await tools.apply_patch({ input: patch });\nreturn r;`, call_id: "call_3", status: "completed", ...itemBase("ctc_call_3", t2) }));
  lines.push(record(clock.next(), "response_item", { type: "custom_tool_call_output", call_id: "call_3", output: { output: "Done!\n", metadata: { exit_code: 0, duration_seconds: 0.1 } }, ...itemBase("ctco_call_3", t2) }));
  lines.push(tokenCount(clock.next(), { input: 31_000, cached: 29_000, output: 200, reasoning: 80 }));
  lines.push(record(clock.next(), "response_item", execCall(t2, "call_4", `bash -lc 'cd ${CWD} && yarn test 2>&1 | tail -n 40'`)));
  lines.push(record(clock.next(), "response_item", execOutput(t2, "call_4", lorem(2000), { failed: true })));
  lines.push(tokenCount(clock.next(), { input: 32_200, cached: 31_000, output: 250, reasoning: 90 }));
  lines.push(record(clock.next(), "response_item", assistantMessage(t2, lorem(400), "final_answer", "msg_a3")));
  lines.push(tokenCount(clock.next(), { input: 32_600, cached: 32_200, output: 120, reasoning: 0 }));
  lines.push(record(clock.next(), "event_msg", { type: "task_complete", turn_id: t2, last_agent_message: lorem(400), duration_ms: 8_000 }));
  // trailing partial line (live file being written): must count as unparsed, never throw
  lines.push('{"timestamp":"2026-09-01T10:59:59.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":99');
  return lines.join("\n") + "\n";
}

// ---- fixture 2: desktop session with a real compaction and an orchestrated child ------

export function compactedDesktopRollout() {
  const clock = new Clock("2026-09-01T12:00:00.000Z");
  const T = THREAD_DESKTOP;
  const lines = [];
  const meta = sessionMeta(clock.next(0), { id: T, originator: "Codex Desktop", source: "vscode", history_mode: "legacy", cli_version: "0.147.0-alpha.6.5", git: { branch: "main" }, dynamic_tools: [{ type: "namespace", name: "collaboration", description: lorem(200), tools: Array.from({ length: 4 }, (_, i) => ({ name: `tool_${i}`, description: lorem(300), parameters: { type: "object", properties: {} } })) }] });
  lines.push(record(clock.next(), "session_meta", meta));
  const t1 = "turn-1001";
  lines.push(record(clock.next(), "turn_context", turnContext(t1, { model: "gpt-5.5", user_instructions: lorem(USER_INSTRUCTIONS_A_CHARS) })));
  lines.push(record(clock.next(), "response_item", developerMessage(t1, [tagged("app-context", 4000), tagged("skills_instructions", 8000), tagged("permissions instructions", 4500), tagged("collaboration_mode", 950), tagged("multi_agent_mode", 270)])));
  lines.push(record(clock.next(), "response_item", userMessage(t1, [environmentPart(), lorem(2200)])));
  lines.push(record(clock.next(), "event_msg", { type: "user_message", message: lorem(2200), images: [], local_images: [], text_elements: [] }));
  const steps = [
    { cmd: "cat packages/core/src/store.ts", body: loremCode(40_000), input: 20_000, cached: 11_000 },
    { cmd: "rg --files packages | head -n 200", body: lorem(60_000), input: 60_000, cached: 19_000 },
    { cmd: "nl -ba packages/core/src/index.ts && wc -l packages/core/src/*.ts", body: loremCode(120_000), input: 120_000, cached: 59_000 },
    { cmd: `curl -s https://synthetic.invalid/spec.json`, body: lorem(110_000), input: 180_000, cached: 119_000 },
    { cmd: "git status && git diff --stat", body: lorem(90_000), input: 225_000, cached: 179_000 },
  ];
  steps.forEach((step, i) => {
    const callId = `call_${100 + i}`;
    lines.push(record(clock.next(), "response_item", reasoning(t1, 1200, `rs_${100 + i}`)));
    lines.push(record(clock.next(), "response_item", execCall(t1, callId, step.cmd)));
    lines.push(record(clock.next(), "response_item", execOutput(t1, callId, step.body)));
    lines.push(tokenCount(clock.next(), { input: step.input, cached: step.cached, output: 400, reasoning: 250 }));
  });
  // real compaction: compacted -> world_state -> turn_context -> zero token_count -> context_compacted
  lines.push(record(clock.next(), "compacted", {
    message: "",
    replacement_history: [
      userMessage(t1, [agentsMdPart(), environmentPart()], "msg_rh1"),
      developerMessage(t1, [tagged("collaboration_mode", 950)], "msg_rh2"),
      { type: "compaction", encrypted_content: lorem(COMPACTION_SUMMARY_CHARS, { sentinel: "LOREMSENTINELENC" }).replace(/\s/g, "x"), ...itemBase("cmp_1", t1) },
    ],
    window_number: 1, window_id: `${T}-w2`, first_window_id: `${T}-w1`, previous_window_id: `${T}-w1`,
  }));
  lines.push(record(clock.next(), "world_state", worldState(false, { environments: {} })));
  const t2 = "turn-1002";
  lines.push(record(clock.next(), "turn_context", turnContext(t2, { model: "gpt-5.5", user_instructions: lorem(USER_INSTRUCTIONS_B_CHARS) })));
  lines.push(record(clock.next(), "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 605_000, cached_input_tokens: 387_000, output_tokens: 2_000, reasoning_output_tokens: 1_250, total_tokens: 607_000 }, last_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 79_128 }, model_context_window: WINDOW }, rate_limits: rateLimits() }));
  lines.push(record(clock.next(), "event_msg", { type: "context_compacted" }));
  // post-compaction requests
  lines.push(record(clock.next(), "response_item", reasoning(t2, 800, "rs_200")));
  lines.push(record(clock.next(), "response_item", execCall(t2, "call_200", "sed -n '1,80p' packages/core/src/store.ts")));
  lines.push(record(clock.next(), "response_item", execOutput(t2, "call_200", loremCode(6_000))));
  lines.push(tokenCount(clock.next(), { input: 30_000, cached: 11_000, output: 300, reasoning: 200 }));
  // orchestration: spawn -> sub_agent_activity -> wait -> handoff via agent_message
  lines.push(record(clock.next(), "response_item", functionCall(t2, "call_201", "spawn_agent", { task_name: "worker_a", fork_turns: true, message: lorem(600) }, "collaboration")));
  lines.push(record(clock.next(), "response_item", functionOutput(t2, "call_201", JSON.stringify({ task_name: "/root/worker_a" }))));
  lines.push(record(clock.next(), "event_msg", { type: "sub_agent_activity", event_id: "evt_1", occurred_at_ms: 0, agent_thread_id: THREAD_CHILD, agent_path: "/root/worker_a", kind: "started" }));
  lines.push(record(clock.next(), "event_msg", itemCompleted(t2, T, { type: "SubAgentActivity", id: "call_201", kind: "started", agent_thread_id: THREAD_CHILD, agent_path: "/root/worker_a" })));
  lines.push(tokenCount(clock.next(), { input: 31_500, cached: 30_000, output: 150, reasoning: 60 }));
  lines.push(record(clock.next(), "response_item", functionCall(t2, "call_202", "wait_agent", { timeout_ms: 20_000 }, "collaboration")));
  lines.push(record(clock.next(), "response_item", functionOutput(t2, "call_202", JSON.stringify({ message: "Wait completed.", timed_out: false }))));
  lines.push(tokenCount(clock.next(), { input: 31_700, cached: 31_500, output: 60, reasoning: 20 }));
  lines.push(record(clock.next(), "inter_agent_communication_metadata", { trigger_turn: false }));
  lines.push(record(clock.next(), "response_item", { type: "agent_message", author: "/root/worker_a", recipient: "/root", content: [{ type: "input_text", text: lorem(3000) }], ...itemBase("amsg_1", t2) }));
  lines.push(record(clock.next(), "response_item", reasoning(t2, 600, "rs_201")));
  lines.push(record(clock.next(), "response_item", assistantMessage(t2, lorem(700), "final_answer", "msg_a200")));
  lines.push(tokenCount(clock.next(), { input: 32_900, cached: 31_700, output: 300, reasoning: 100 }));
  lines.push(record(clock.next(), "event_msg", { type: "task_complete", turn_id: t2, last_agent_message: lorem(700), duration_ms: 30_000 }));
  return lines.join("\n") + "\n";
}

// ---- fixture 3: thread_spawn child with a fork bootstrap ----------------------------

export function threadSpawnChildRollout() {
  const clock = new Clock("2026-09-01T12:10:00.000Z");
  const T = THREAD_CHILD;
  const lines = [];
  const spawn = { parent_thread_id: THREAD_DESKTOP, depth: 1, agent_path: "/root/worker_a", agent_nickname: "Darwin", agent_role: null };
  lines.push(record(clock.next(), "session_meta", sessionMeta(clock.next(0), {
    id: T, session_id: T, forked_from_id: THREAD_DESKTOP, parent_thread_id: THREAD_DESKTOP, source: { subagent: { thread_spawn: spawn } }, thread_source: "subagent",
    agent_nickname: "Darwin", agent_path: "/root/worker_a", subagent_history_start_ordinal: 3, multi_agent_version: 2, originator: "Codex Desktop", cli_version: "0.147.0-alpha.6.5",
  })));
  lines.push(record(clock.next(), "session_meta", sessionMeta(clock.next(0), { id: THREAD_DESKTOP, session_id: THREAD_DESKTOP, source: "vscode", originator: "Codex Desktop", cli_version: "0.147.0-alpha.6.5" })));
  const t1 = "turn-2001";
  lines.push(record(clock.next(), "compacted", {
    message: "",
    replacement_history: [
      userMessage(t1, [agentsMdPart(), environmentPart()], "msg_fb1"),
      developerMessage(t1, [`You are an agent in a team of agents. ${lorem(2200)}`, tagged("multi_agent_mode", 270)], "msg_fb2"),
      { type: "compaction", encrypted_content: lorem(BOOTSTRAP_SUMMARY_CHARS, { sentinel: "LOREMSENTINELENC" }).replace(/\s/g, "x"), ...itemBase("cmp_fb", t1) },
    ],
    window_number: 1, window_id: `${T}-w1`, first_window_id: `${T}-w1`, previous_window_id: null,
  }));
  lines.push(record(clock.next(), "world_state", worldState(true, { agents_md: { directory: CWD, text: lorem(AGENTS_MD_CHARS - 100) }, environments: {}, model: "gpt-5.5" })));
  lines.push(record(clock.next(), "turn_context", turnContext(t1, { model: "gpt-5.5", multi_agent_mode: "worker" })));
  lines.push(record(clock.next(), "inter_agent_communication_metadata", { trigger_turn: true }));
  lines.push(record(clock.next(), "response_item", { type: "agent_message", author: "/root", recipient: "/root/worker_a", content: [{ type: "input_text", text: lorem(1200) }], ...itemBase("amsg_p1", t1) }));
  lines.push(record(clock.next(), "response_item", reasoning(t1, 1000, "rs_300")));
  lines.push(record(clock.next(), "response_item", { type: "custom_tool_call", name: "exec", input: `const r = await tools.apply_patch({ input: ${JSON.stringify("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch\n")} });\nreturn r;`, call_id: "call_300", status: "completed", ...itemBase("ctc_call_300", t1) }));
  lines.push(record(clock.next(), "response_item", { type: "custom_tool_call_output", call_id: "call_300", output: { output: "Done!\n", metadata: { exit_code: 0, duration_seconds: 0.2 } }, ...itemBase("ctco_call_300", t1) }));
  lines.push(tokenCount(clock.next(), { input: 24_000, cached: 11_008, output: 500, reasoning: 300 }));
  lines.push(record(clock.next(), "response_item", reasoning(t1, 400, "rs_301")));
  lines.push(record(clock.next(), "response_item", functionCall(t1, "call_301", "send_message", { target: "/root", message: lorem(2500) }, "collaboration")));
  lines.push(record(clock.next(), "response_item", functionOutput(t1, "call_301", "")));
  lines.push(tokenCount(clock.next(), { input: 25_300, cached: 24_000, output: 700, reasoning: 100 }));
  lines.push(record(clock.next(), "event_msg", { type: "task_complete", turn_id: t1, last_agent_message: "", duration_ms: 20_000 }));
  return lines.join("\n") + "\n";
}

export const FIXTURES = {
  "plain-cli.jsonl": plainCliRollout,
  "compacted-desktop.jsonl": compactedDesktopRollout,
  "thread-spawn-child.jsonl": threadSpawnChildRollout,
};

export function writeFixtures(dir = here) {
  seed = 42;
  cumulative = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (const [name, build] of Object.entries(FIXTURES)) {
    writeFileSync(path.join(dir, name), build(), "utf8");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFixtures();
  console.log(`wrote ${Object.keys(FIXTURES).length} fixtures to ${here}`);
}
