/**
 * Synthetic run generator for the hosted demo (used by `make-fixtures.mjs --demo`).
 * A parameterised port of make-run-fixture.mjs: realistic usage series,
 * reconciliation v2 composition (clamped k, `unlogged` band, base steps), a
 * composition that sums to usage.total on every request, compactions, nested
 * subagents (open ones, fat handoffs) and aggregated findings with `count`.
 * Deterministic per `seed`; no transcript content anywhere: labels are repo-
 * relative paths, command names and attachment types from fixed lists.
 *
 * `generateRun(spec)` returns `{ run, scopes, findings }` in the ADR-002 C shape:
 * `run` is the /runs/:vendor/:id response (main scope full, children as
 * summaries with `partial: true`, `findings` attached); `scopes` maps every
 * scope id to its full AgentScope.
 */

const K_MIN = 0.6, K_MAX = 1.5;
const M = (value, provenance) => ({ value, provenance });
const round4 = (v) => Number(v.toFixed(4));

const FILES = {
  "context-viewer": ["packages/cli/src/index/manifest.mjs", "packages/cli/src/adapters/claude.mjs", "packages/cli/src/ir/finalize.mjs", "packages/ui/src/main.tsx", "docs/adr-001-product-architecture.md", "packages/cli/src/rules/B-01.mjs", "package.json", "packages/cli/test/adapters.test.mjs", "packages/ui/src/screens/Session.tsx", "README.md", "package-lock.json", "packages/ui/src/theme.css"],
  "billing-api": ["src/invoices/service.ts", "src/invoices/controller.ts", "src/db/migrations/0042_tax_rates.sql", "src/generated/schema.ts", "test/invoices.test.ts", "package.json", "openapi.yaml", "src/payments/stripe.ts", "README.md", "pnpm-lock.yaml"],
  "docs-site": ["content/guide/getting-started.md", "content/reference/cli.md", "src/components/Sidebar.astro", "astro.config.mjs", "package.json", "content/blog/2026-08-release.md", "src/styles/global.css", "public/search-index.json"],
};
const SHELL = { claude: ["npm test", "git status", "node build.mjs", "ls -la", "npm run typecheck", "git diff --stat", "node --test test/*.test.mjs", "npm run lint"], codex: ["npm test", "git status --short", "pnpm build", "cat package.json", "git log --oneline -20", "pnpm typecheck"] };
const SEARCH = ["Grep estimateTokens", "Glob **/*.mjs", "Grep compactMetadata", "Grep useState", "Glob src/**/*.ts", "Grep TODO"];
const WEB = ["docs.anthropic.com", "developers.openai.com", "docs.example.dev", "nodejs.org"];

function prng(seed) {
  let state = seed >>> 0;
  const rnd = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[ri(0, 15)]).join("");
  return { rnd, ri, pick, hex };
}

/** Vendor-specific tool vocabulary; categories are the shared IR categories. */
function toolset(vendor, files, r) {
  if (vendor === "codex") {
    return () => {
      const tk = r.rnd();
      if (tk < 0.38) { const target = r.pick(files); return { tool: { name: "shell", kind: "file", argsHash: r.hex(12), target }, cat: "tool_result.file", label: target, bytes: r.rnd() < 0.08 ? r.ri(28000, 56000) : r.ri(1500, 12000) }; }
      if (tk < 0.66) return { tool: { name: "shell", kind: "shell", argsHash: r.hex(12) }, cat: "tool_result.shell", label: r.pick(SHELL.codex), bytes: r.rnd() < 0.07 ? r.ri(22000, 40000) : r.ri(200, 6000) };
      if (tk < 0.82) return { tool: { name: "shell", kind: "search", argsHash: r.hex(12) }, cat: "tool_result.search", label: r.pick(SEARCH).replace("Grep", "rg").replace("Glob", "fd"), bytes: r.ri(300, 8000) };
      if (tk < 0.9) return { tool: { name: "web_search", kind: "web", argsHash: r.hex(12) }, cat: "tool_result.web", label: r.pick(WEB), bytes: r.ri(3000, 14000) };
      const target = r.pick(files);
      return { tool: { name: "apply_patch", kind: "edit", argsHash: r.hex(12), target }, cat: "tool_result.other", label: target, bytes: r.ri(100, 500) };
    };
  }
  return () => {
    const tk = r.rnd();
    if (tk < 0.35) { const target = r.pick(files); const partial = r.rnd() < 0.25; return { tool: { name: "Read", kind: "file", argsHash: r.hex(12), target, ...(partial ? { partial: true } : {}) }, cat: "tool_result.file", label: target, bytes: partial ? r.ri(600, 4000) : r.rnd() < 0.08 ? r.ri(30000, 60000) : r.ri(1500, 14000) }; }
    if (tk < 0.6) return { tool: { name: "Bash", kind: "shell", argsHash: r.hex(12) }, cat: "tool_result.shell", label: r.pick(SHELL.claude), bytes: r.rnd() < 0.06 ? r.ri(25000, 45000) : r.ri(200, 6000) };
    if (tk < 0.8) return { tool: { name: r.rnd() < 0.5 ? "Grep" : "Glob", kind: "search", argsHash: r.hex(12) }, cat: "tool_result.search", label: r.pick(SEARCH), bytes: r.ri(300, 9000) };
    if (tk < 0.88) return { tool: { name: "WebFetch", kind: "web", argsHash: r.hex(12) }, cat: "tool_result.web", label: r.pick(WEB), bytes: r.ri(4000, 18000) };
    if (tk < 0.94) { const target = r.pick(files); return { tool: { name: "Edit", kind: "edit", argsHash: r.hex(12), target }, cat: "tool_result.other", label: target, bytes: r.ri(100, 400) }; }
    return { tool: { name: "Skill", kind: "skill", argsHash: r.hex(12) }, cat: "skills", label: r.pick(["dataviz", "code-review", "release-notes"]), bytes: r.ri(6000, 12000) };
  };
}

/**
 * Builds one scope. `compactAt` lists request indexes where a compaction
 * boundary sits before the request; `unlogged0` is the persistent unlogged base
 * from request 0 (resumed session); `steps` are persistent base changes.
 */
function buildScope(r, { id, kind, depth, parentScopeId, agentType, description, count, startMs, gapMs, compactAt = [], baseSystem, baseInstructions, models, modelSwitch = 0.25, launch, seedBlocks = [], unlogged0 = 0, steps = [], errorTail = 0.08, size, tools, vendor }) {
  const requests = [];
  const blocks = [];
  const compactions = [];
  const baseSteps = [];
  let seq = 0;
  let t = startMs;
  let visible = [];
  let turn = 0;
  let prevTotal = 0;
  let U = unlogged0;
  let pending = [];
  let lastHadTool = false;
  let peak = 0;
  let processed = 0, outputSum = 0, toolCalls = 0;
  let unloggedSum = 0;
  const seen = new Set();
  const errors = [];
  let clamped = 0;

  function addBlock(category, opts, firstRequest) {
    const bytes = Math.round((opts.bytes ?? r.ri(200, 4000)) * (category === "compaction_summary" || category === "user" ? 1 : size));
    const kindOf = opts.kind ?? (category.startsWith("tool_result") || category === "tool_call" ? "code" : "prose");
    const b = { id: `${id}:${seq}`, seq, at: new Date(t).toISOString(), category, bytes, estTokens: Math.ceil(bytes / (kindOf === "code" ? 3.2 : 3.6)), kind: kindOf, firstRequest, hash: r.hex(16) };
    if (opts.tool) b.tool = opts.tool;
    if (opts.label) b.label = opts.label;
    if (opts.attachmentType) b.attachmentType = opts.attachmentType;
    if (opts.agentId) b.agentId = opts.agentId;
    seq++;
    blocks.push(b);
    return b;
  }

  for (const s of seedBlocks) pending.push(addBlock(s.category, s, 0));

  for (let i = 0; i < count; i++) {
    const compaction = compactAt.includes(i);
    if (compaction) {
      const pre = prevTotal;
      const cid = `${id}:c${compactions.length + 1}`;
      for (const b of visible) { b.lastRequest = i - 1; b.droppedBy = cid; }
      visible = [];
      const summary = addBlock("compaction_summary", { bytes: r.ri(9000, 14000), kind: "prose", label: "compaction summary" }, i);
      visible.push(summary);
      const postEstimate = baseSystem + baseInstructions + U + summary.estTokens + pending.reduce((s, b) => s + b.estTokens, 0);
      compactions.push({ id: cid, at: new Date(t).toISOString(), atRequest: i, trigger: compactions.length === 0 || r.rnd() < 0.6 ? "auto" : "manual", preTokens: M(pre, "observed.vendor"), postTokens: M(postEstimate, "observed.vendor"), droppedTokens: M(pre - postEstimate, "derived.exact"), summaryBlockId: summary.id, durationMs: r.ri(4000, 12000), preservedMessages: r.ri(4, 12) });
    }
    const step = steps.find((s) => s.at === i);
    if (step) { U = Math.max(0, U + step.delta); baseSteps.push({ atRequest: i, delta: step.delta }); }
    if (i === 0 || (!lastHadTool && r.rnd() < 0.7)) {
      turn++;
      pending.push(addBlock("user", { bytes: r.ri(80, 1200), kind: "prose", label: `prompt ${turn}` }, i));
      if (r.rnd() < 0.4) pending.push(addBlock("attachments", { bytes: r.ri(120, 900), kind: "prose", attachmentType: vendor === "codex" ? "environment_context" : "system-reminder", label: vendor === "codex" ? "environment_context" : "system-reminder" }, i));
    }
    for (const b of pending) visible.push(b);
    const newIds = pending.map((b) => b.id);
    const newEst = pending.reduce((s, b) => s + b.estTokens, 0);
    pending = [];

    const sumEst = visible.reduce((s, b) => s + b.estTokens, 0);
    const err = r.rnd() < errorTail ? (r.rnd() - 0.5) * 1.2 : (r.rnd() - 0.5) * 0.08;
    const kRaw = Math.max(0.3, 1 + err);
    const k = Math.min(K_MAX, Math.max(K_MIN, kRaw));
    if (kRaw >= K_MIN && kRaw <= K_MAX) errors.push(Math.abs(1 - kRaw)); else clamped++;
    const total = Math.max(baseSystem + baseInstructions + U + Math.round(kRaw * sumEst), 1000);
    const comp = {};
    for (const b of visible) comp[b.category] = (comp[b.category] ?? 0) + b.estTokens * k;
    for (const c of Object.keys(comp)) comp[c] = Math.round(comp[c]);
    let system = baseSystem;
    const visibleSum = Object.values(comp).reduce((s, v) => s + v, 0);
    let rest = total - system - baseInstructions - visibleSum;
    let unlogged = 0;
    if (rest >= 0) unlogged = rest;
    else { system = Math.max(0, system + rest); rest = total - system - baseInstructions - visibleSum; if (rest < 0) { const largest = Object.keys(comp).sort((a, b) => comp[b] - comp[a])[0]; comp[largest] += rest; } }
    comp.system = system;
    if (baseInstructions > 0) comp.instructions = baseInstructions;
    if (unlogged > 0) comp.unlogged = unlogged;
    unloggedSum += unlogged;

    let cacheRead, cacheCreation, input;
    const cold = i === 0 || compaction || r.rnd() < 0.05;
    if (cold) { cacheRead = compaction ? 0 : Math.round(prevTotal * (i === 0 ? 0 : r.rnd() * 0.5)); cacheCreation = Math.max(0, total - cacheRead - r.ri(50, 400)); }
    else { cacheRead = Math.min(total, prevTotal + r.ri(-200, 0)); cacheCreation = Math.max(0, total - cacheRead - r.ri(0, 120)); }
    if (cacheRead < 0) cacheRead = 0;
    input = Math.max(0, total - cacheRead - cacheCreation);
    const thinking = r.rnd() < 0.35 ? r.ri(200, 2500) : 0;
    const output = r.ri(60, 1200) + thinking;
    const m = models.length > 1 && i > count * 0.6 && r.rnd() < modelSwitch ? models[1] : models[0];
    seen.add(m);

    const usage = vendor === "codex" ? { input, cacheCreation: 0, cacheRead: cacheRead + cacheCreation, output, total } : { input, cacheCreation, cacheRead, output, total, ...(thinking ? { thinking } : {}) };
    const req = { index: i, id: `${vendor === "codex" ? "resp" : "msg"}_${r.hex(12)}`, at: new Date(t).toISOString(), model: m, turn, usage, hiddenBase: M(system + baseInstructions + unlogged, "estimated.local"), scale: round4(k), scaleRaw: round4(kRaw), composition: comp, newBlockIds: newIds };
    if (vendor !== "codex") req.deltaCheck = Math.round((input + cacheCreation) - newEst);
    if (compaction) req.compactionBefore = compactions[compactions.length - 1].id;
    if (step) req.baseChange = { tokens: step.delta, provenance: "derived.exact" };
    requests.push(req);
    processed += total; outputSum += output; peak = Math.max(peak, total); prevTotal = total;

    t += gapMs();
    pending.push(addBlock("assistant_text", { bytes: r.ri(60, 1800), kind: "prose" }, i + 1));
    if (thinking) addBlock("assistant_thinking", { bytes: thinking * 3, kind: "prose" }, i + 1);
    const roll = r.rnd();
    lastHadTool = false;
    const wantsSub = launch && launch.some((l) => l.at === i);
    if (wantsSub) {
      lastHadTool = true;
      for (const l of launch.filter((l) => l.at === i)) {
        toolCalls++;
        pending.push(addBlock("tool_call", { bytes: r.ri(300, 900), tool: { name: vendor === "codex" ? "spawn_agent" : "Agent", kind: "agent", argsHash: r.hex(12) }, label: `${vendor === "codex" ? "spawn_agent" : "Agent"}(${l.agentType})`, agentId: l.id }, i + 1));
      }
    } else if (roll < 0.8) {
      toolCalls++; lastHadTool = true;
      const { tool, cat, label, bytes } = tools();
      pending.push(addBlock("tool_call", { bytes: r.ri(80, 600), tool, label: tool.target ?? label }, i + 1));
      pending.push(addBlock(cat, { bytes, tool: { ...tool, isError: r.rnd() < 0.04 }, label }, i + 1));
      if (r.rnd() < 0.15) pending.push(addBlock("attachments", { bytes: r.ri(100, 700), kind: "prose", attachmentType: r.rnd() < 0.5 ? "hook_stdout" : "task_notification", label: "hook stdout" }, i + 1));
    }
    if (i === 5 && depth === 0 && vendor !== "codex") pending.push(addBlock("memory", { bytes: 2400, kind: "prose", label: "memory/MEMORY.md", tool: { name: "Read", kind: "file", argsHash: r.hex(12), target: "memory/MEMORY.md" } }, i + 1));
  }
  for (const b of pending) b.lastRequest = count - 1;
  const sorted = [...errors].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const scope = {
    id, kind, agentType, description, parentScopeId, depth, status: "completed", models: [...seen], requests, blocks, compactions,
    peak: M(peak, "observed.vendor"), processedInputTokens: processed, outputTokens: outputSum, toolCalls,
    unloggedShare: round4(processed ? unloggedSum / processed : 0), estimatorErrorMedian: round4(q(0.5)), estimatorErrorP95: round4(q(0.95)), baseSteps,
    endMs: t, clamped,
  };
  if (unlogged0 > 0) scope.resumed = true;
  if (kind === "main") { delete scope.agentType; delete scope.description; delete scope.parentScopeId; }
  return scope;
}

function childScope(r, spec, { id, parent, agentType, description, count, launchAt, deliverAt, depth, status, handoffBytes, model, steps = [], errorTail = 0.08 }) {
  const parentReq = parent.requests[launchAt];
  const startMs = Date.parse(parentReq.at) + 2_000;
  const scope = buildScope(r, { id, kind: "subagent", depth, parentScopeId: parent.id, agentType, description, count, startMs, gapMs: () => r.ri(4_000, 15_000), baseSystem: spec.vendor === "codex" ? 9_800 : 11_200, baseInstructions: 0, models: [model], seedBlocks: [{ category: "user", bytes: r.ri(600, 1800), kind: "prose", label: "agent prompt" }], steps, errorTail, size: spec.size, tools: spec.tools, vendor: spec.vendor });
  scope.launchedAtRequest = launchAt;
  scope.launchedAt = parentReq.at;
  scope.status = status;
  scope.source = spec.vendor === "codex"
    ? { file: `~/.codex/sessions/${spec.day}/rollout-${spec.day}T${String(r.ri(8, 18)).padStart(2, "0")}-${String(r.ri(0, 59)).padStart(2, "0")}-00-${id}.jsonl`, bytes: r.ri(80_000, 400_000) }
    : { file: `~/.claude/projects/${spec.project.key}/${spec.sessionId}/subagents/${id}.jsonl`, bytes: r.ri(80_000, 400_000) };
  if (deliverAt !== undefined) {
    scope.deliveredAtRequest = deliverAt;
    scope.deliveredAt = parent.requests[deliverAt].at;
    const b = { id: `${parent.id}:${parent.blocks.length}`, seq: parent.blocks.length, at: parent.requests[deliverAt].at, category: "subagent_handoff", bytes: handoffBytes, estTokens: Math.ceil(handoffBytes / 3.6), kind: "prose", agentId: id, label: `handoff from ${agentType}`, tool: { name: spec.vendor === "codex" ? "spawn_agent" : "Agent", kind: "agent", argsHash: r.hex(12) }, firstRequest: deliverAt, hash: r.hex(16) };
    const c = parent.compactions.find((c) => c.atRequest > deliverAt);
    if (c) { b.lastRequest = c.atRequest - 1; b.droppedBy = c.id; }
    parent.blocks.push(b);
    parent.requests[deliverAt].newBlockIds.push(b.id);
    const last = b.lastRequest ?? parent.requests.length - 1;
    for (let i = deliverAt; i <= last; i++) {
      const req = parent.requests[i];
      const donor = Object.keys(req.composition).filter((k) => !["system", "instructions", "unlogged", "subagent_handoff"].includes(k)).sort((x, y) => req.composition[y] - req.composition[x])[0];
      if (!donor) continue;
      const take = Math.min(b.estTokens, req.composition[donor] - 100);
      if (take > 0) { req.composition[donor] -= take; req.composition.subagent_handoff = (req.composition.subagent_handoff ?? 0) + take; }
    }
    scope.handoff = { blockId: b.id, tokens: M(b.estTokens, "observed.artifact"), compressionRatio: M(Number((scope.peak.value / b.estTokens).toFixed(2)), "derived.exact") };
  }
  return scope;
}

/**
 * Compaction forecast for the main scope of a live run (ADR-003 §3 shape, plus the cycle-2
 * `status` and `threshold.basis`): least-squares slope over the last 20 requests of the
 * current segment, threshold from the run's own auto-compactions or a calibrated share.
 */
function forecastOf(main, window) {
  const last = main.compactions.length ? main.compactions[main.compactions.length - 1].atRequest : 0;
  const segment = main.requests.slice(last);
  if (segment.length < 8) return undefined;
  const sample = segment.slice(-20);
  const xs = sample.map((r) => r.index), ys = sample.map((r) => r.usage.total);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / Math.max(1e-9, xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const auto = main.compactions.filter((c) => c.trigger === "auto").map((c) => c.preTokens.value).sort((a, b) => a - b);
  const threshold = auto.length
    ? { value: auto[Math.floor(auto.length / 2)], provenance: "observed.vendor", basis: { events: auto.length, min: auto[0], max: auto[auto.length - 1], source: "this session" } }
    : { value: Math.round(window * 0.92), provenance: "estimated.local", basis: { events: 5, min: Math.round(window * 0.89), max: Math.round(window * 0.95), source: "calibration.json" } };
  const current = ys[ys.length - 1];
  const minutes = (Date.parse(sample[sample.length - 1].at) - Date.parse(sample[0].at)) / 60_000;
  const perMinute = minutes > 0 ? slope * ((sample.length - 1) / minutes) : 0;
  const round = (v) => Number(v.toFixed(1));
  const base = { threshold, basis: { requests: sample.length, from: xs[0], to: xs[xs.length - 1] }, provenance: "derived.exact" };
  if (!(slope > 0) || current >= threshold.value) return { ...base, status: "flat", perRequest: round(Math.max(0, slope)), perMinute: 0, requestsLeft: 0, minutesLeft: 0 };
  const remaining = threshold.value - current;
  return { ...base, status: "ok", perRequest: round(slope), perMinute: round(perMinute), requestsLeft: round(remaining / slope), minutesLeft: perMinute > 0 ? round(remaining / perMinute) : 0 };
}

const topBlocksOf = (s, n) => s.blocks.filter((b) => b.category !== "assistant_thinking").slice().sort((a, b) => b.estTokens - a.estTokens).slice(0, n).map((b) => ({ id: b.id, category: b.category, estTokens: b.estTokens, firstRequest: b.firstRequest, tool: b.tool?.name, label: b.label }));

function buildFindings(r, spec, runId, scopes, main, window) {
  const findings = [];
  const platform = spec.vendor === "codex" ? "codex" : "claude";
  const instructionFile = spec.vendor === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const fatBlocks = (s, cat, threshold) => s.blocks.filter((b) => b.category === cat && b.estTokens >= threshold).sort((a, b) => b.estTokens - a.estTokens);
  const blockEvidence = (b) => ({ kind: "block", ref: `${runId}#${b.id}`, label: `${b.tool?.name ?? b.category} ${b.label ?? ""}`.trim(), value: b.estTokens, unit: "tokens", provenance: "estimated.local" });
  const fatThreshold = 3_000;
  for (const s of scopes) {
    const fat = fatBlocks(s, "tool_result.file", fatThreshold).concat(fatBlocks(s, "tool_result.shell", fatThreshold)).sort((a, b) => b.estTokens - a.estTokens);
    if (!fat.length) continue;
    const sum = fat.reduce((x, b) => x + b.estTokens, 0);
    findings.push({
      id: `B-01:${r.hex(10)}`, ruleId: "B-01", severity: fat[0].estTokens >= Math.max(8_000, 0.05 * window) ? "high" : "medium", scope: s.kind === "main" ? "session" : "subagent", vendor: spec.vendor, runId, scopeId: s.id,
      title: "Fat tool result", count: fat.length,
      whyItMatters: `${fat.length} tool result${fat.length === 1 ? "" : "s"} over ${fatThreshold.toLocaleString("en-US")} tokens entered ${s.kind === "main" ? "the main scope" : `${s.agentType} (${s.id})`} and were resent on every request until dropped; the largest is ${fat[0].estTokens.toLocaleString("en-US")} tokens.`,
      evidence: fat.slice(0, 5).map(blockEvidence),
      fix: { platform, summary: "Read with offset/limit or grep for the symbol instead of loading whole files; pipe shell output through head.", snippet: spec.vendor === "codex" ? "npm test 2>&1 | tail -60\n# or lower [shell] truncation_policy.limit in ~/.codex/config.toml" : "Prefer targeted reads: Read with offset/limit, Grep with head_limit, Bash | head -c 8000.", path: instructionFile },
      thresholdKeys: ["fatToolResultTokens"], tokensAffected: sum,
    });
    const huge = s.blocks.filter((b) => b.category === "tool_result.file" && b.estTokens >= 15_000).sort((a, b) => b.estTokens - a.estTokens)[0];
    if (huge) findings.push({
      id: `B-03:${r.hex(10)}`, ruleId: "B-03", severity: huge.estTokens >= 20_000 ? "high" : "medium", scope: s.kind === "main" ? "session" : "subagent", vendor: spec.vendor, runId, scopeId: s.id, title: "Huge file read", count: 1,
      whyItMatters: `A single read of ${huge.label} added ${huge.estTokens.toLocaleString("en-US")} tokens and stayed in the window until the next compaction.`,
      evidence: [blockEvidence(huge)],
      fix: { platform, summary: "Read only the sections you need.", snippet: `sed -n 1,120p ${huge.label}`, path: instructionFile },
      thresholdKeys: ["hugeFileReadTokens"], tokensAffected: huge.estTokens,
    });
  }
  for (const s of scopes.slice(1)) {
    if (!s.handoff || s.handoff.tokens.value < 4_000) continue;
    findings.push({
      id: `B-05:${r.hex(10)}`, ruleId: "B-05", severity: s.handoff.tokens.value > 0.3 * s.peak.value ? "high" : "medium", scope: "subagent", vendor: spec.vendor, runId, scopeId: s.id,
      title: "Fat subagent handoff", count: 1,
      whyItMatters: `A subagent exists to isolate context; ${s.agentType} returned ${s.handoff.tokens.value.toLocaleString("en-US")} tokens (${Math.round((s.handoff.tokens.value / s.peak.value) * 100)}% of its own peak) into the parent window.`,
      evidence: [
        { kind: "block", ref: `${runId}#${s.handoff.blockId}`, label: `handoff block #${s.handoff.blockId}`, value: s.handoff.tokens.value, unit: "tokens", provenance: "observed.artifact" },
        { kind: "scope", ref: `${runId}#${s.id}`, label: "child peak", value: s.peak.value, unit: "tokens", provenance: "observed.vendor" },
        { kind: "request", ref: `${runId}#main#${s.deliveredAtRequest}`, label: `delivered at request ${s.deliveredAtRequest}`, provenance: "derived.exact" },
        { kind: "metric", ref: "ratio", label: "compression ratio", value: s.handoff.compressionRatio.value, unit: "ratio", provenance: "derived.exact" },
      ],
      fix: { platform, summary: "Constrain the subagent's return format in its agent definition.", snippet: "Return findings only: file:line references, decisions, and open questions. Under 600 words.", path: spec.vendor === "codex" ? ".codex/agents/worker.toml" : `.claude/agents/${s.agentType}.md` },
      thresholdKeys: ["fatHandoffTokens", "fatHandoffShare"], tokensAffected: s.handoff.tokens.value,
    });
  }
  const hot = main.requests.filter((req) => req.usage.total > 0.8 * window);
  if (hot.length >= 10) findings.push({
    id: `B-08:${r.hex(10)}`, ruleId: "B-08", severity: "high", scope: "session", vendor: spec.vendor, runId, scopeId: "main",
    title: "Running hot", count: 1,
    whyItMatters: `${hot.length} requests ran above 80% of the ${window.toLocaleString("en-US")}-token window; every request there resends nearly the whole window and compaction is one tool result away.`,
    evidence: [{ kind: "request", ref: `${runId}#main#${hot[0].index}`, label: `first hot request ${hot[0].index}`, value: hot[0].usage.total, unit: "tokens", provenance: "observed.vendor" }, { kind: "metric", ref: "count", label: "requests above 80% of window", value: hot.length, unit: "count", provenance: "derived.exact" }],
    fix: { platform, summary: "Compact or start a fresh session at phase boundaries; fix the fat results first.", snippet: spec.vendor === "codex" ? "/new   # fresh thread per task" : "/compact focus on the remaining steps" },
    thresholdKeys: ["runningHotShare", "runningHotRequests"], tokensAffected: hot.reduce((x, req) => x + req.usage.total, 0),
  });
  if (main.compactions.length >= 3) findings.push({
    id: `B-07:${r.hex(10)}`, ruleId: "B-07", severity: "high", scope: "session", vendor: spec.vendor, runId, scopeId: "main", title: "Frequent compaction", count: 1,
    whyItMatters: `${main.compactions.length} compaction boundaries in one session; the model rebuilt its working set ${main.compactions.length} times.`,
    evidence: main.compactions.slice(0, 3).map((c) => ({ kind: "request", ref: `${runId}#main#${c.atRequest}`, label: `${c.trigger} compaction before request ${c.atRequest}`, value: c.preTokens.value, unit: "tokens", provenance: "observed.vendor" })),
    fix: { platform, summary: "Split the task and fix the fat results first.", snippet: spec.vendor === "codex" ? "/new   # new task, fresh thread" : "Start a fresh session per task (/clear), delegate exploration to subagents." },
    thresholdKeys: ["compactionsPerSession", "compactionsPerHour"], tokensAffected: main.compactions.reduce((x, c) => x + c.droppedTokens.value, 0),
  });
  const tiny = main.requests.filter((req, i) => i > 0 && req.usage.total > 100_000 && (req.usage.input + (req.usage.cacheCreation ?? 0)) < 50);
  if (tiny.length >= 10) findings.push({
    id: `B-11:${r.hex(10)}`, ruleId: "B-11", severity: "low", scope: "session", vendor: spec.vendor, runId, scopeId: "main", title: "Turn overhead", count: tiny.length,
    whyItMatters: `Each tiny follow-up resends the entire window; ${tiny.length} requests carried under 50 new tokens on top of 100k+.`,
    evidence: [{ kind: "request", ref: `${runId}#main#${tiny[0].index}`, label: `example request ${tiny[0].index}`, value: tiny[0].usage.total, unit: "tokens", provenance: "observed.vendor" }, { kind: "metric", ref: "count", label: "requests matching", value: tiny.length, unit: "count", provenance: "derived.exact" }],
    fix: { platform, summary: "Batch small follow-ups and compact between phases.", snippet: spec.vendor === "codex" ? "/compact" : "/compact focus on the remaining migration steps" },
    thresholdKeys: ["turnOverheadRequests", "turnOverheadRequestTokens", "turnOverheadNewTokens"], tokensAffected: tiny.reduce((x, req) => x + req.usage.total, 0),
  });
  const explorers = scopes.filter((s) => s.depth === 1 && s.agentType === "Explore");
  if (explorers.length >= 2) findings.push({
    id: `B-15:${r.hex(10)}`, ruleId: "B-15", severity: "low", scope: "subagent", vendor: spec.vendor, runId, scopeId: explorers[0].id, title: "Parallel subagents duplicated work", count: 2,
    whyItMatters: `${explorers[0].agentType} (${explorers[0].id}) and ${explorers[1].agentType} (${explorers[1].id}) read the same four files.`,
    evidence: [{ kind: "scope", ref: `${runId}#${explorers[0].id}`, label: `${explorers[0].id} (${explorers[0].agentType})`, value: 4, unit: "count", provenance: "observed.artifact" }, { kind: "scope", ref: `${runId}#${explorers[1].id}`, label: `${explorers[1].id} (${explorers[1].agentType})`, value: 4, unit: "count", provenance: "observed.artifact" }],
    fix: { platform, summary: "Give each subagent a disjoint scope in the delegation prompt.", snippet: "Agent A: only packages/cli/**. Agent B: only packages/ui/**. Do not read outside your scope." },
    thresholdKeys: ["parallelDuplicateFiles"], tokensAffected: r.ri(3_000, 12_000),
  });
  const SEV = { high: 3, medium: 2, low: 1 };
  findings.sort((a, b) => (SEV[b.severity] - SEV[a.severity]) || ((b.tokensAffected ?? 0) - (a.tokensAffected ?? 0)) || a.id.localeCompare(b.id));
  for (const f of findings) if (f.fix.path === undefined) delete f.fix.path;
  return findings;
}

/**
 * spec: { seed, vendor, sessionId, project: { key, displayName, cwdHash, cwdDisplay }, projectName (FILES key),
 *         startMs, mainCount, compactAt, subagents: [{ id, at, agentType, count, deliverAfter?, handoffBytes, nested?, open? }],
 *         window, windowProvenance, baseSystem, baseInstructions, models, unlogged0, steps, size, idleGapAt, cliVersion, gitBranch, day }
 */
export function generateRun(spec) {
  const r = prng(spec.seed);
  const runId = `${spec.vendor}:${spec.sessionId}`;
  const files = FILES[spec.projectName] ?? FILES["context-viewer"];
  const tools = toolset(spec.vendor, files, r);
  const full = { ...spec, tools, size: spec.size ?? 0.36 };
  const launches = (spec.subagents ?? []).map((s) => ({ id: s.id, at: s.at, agentType: s.agentType }));
  const main = buildScope(r, {
    id: "main", kind: "main", depth: 0, count: spec.mainCount, startMs: spec.startMs, gapMs: () => r.ri(6_000, 40_000),
    compactAt: spec.compactAt ?? [], baseSystem: spec.baseSystem ?? 18_400, baseInstructions: spec.baseInstructions ?? 4_600, models: spec.models, launch: launches,
    unlogged0: spec.unlogged0 ?? 0, steps: spec.steps ?? [], size: full.size, tools, vendor: spec.vendor,
  });
  if (spec.idleGapAt !== undefined) {
    const at = Math.floor(spec.mainCount * spec.idleGapAt); const shift = 45 * 60_000;
    for (const req of main.requests) if (req.index >= at) req.at = new Date(Date.parse(req.at) + shift).toISOString();
    for (const b of main.blocks) if (b.firstRequest >= at) b.at = new Date(Date.parse(b.at) + shift).toISOString();
    main.endMs += shift;
  }
  if (spec.forecast) { const f = forecastOf(main, spec.window); if (f) main.forecast = f; }
  const scopes = [main];
  for (const s of spec.subagents ?? []) {
    const deliver = s.open ? undefined : Math.min(spec.mainCount - 1, s.at + (s.deliverAfter ?? r.ri(6, 60)));
    const child = childScope(r, full, { id: s.id, parent: main, agentType: s.agentType, description: s.description ?? `task ${s.id}`, count: s.count, launchAt: s.at, deliverAt: deliver, depth: 1, status: deliver === undefined ? "open" : "completed", handoffBytes: s.handoffBytes ?? r.ri(2_000, 12_000), model: s.model ?? spec.models[Math.min(1, spec.models.length - 1)], steps: s.steps ?? [], errorTail: s.errorTail ?? 0.08 });
    scopes.push(child);
    if (s.nested && s.count > 12) scopes.push(childScope(r, full, { id: `${s.id}-n`, parent: child, agentType: "Explore", description: "nested lookup", count: r.ri(6, 14), launchAt: 3, deliverAt: Math.min(s.count - 1, 9), depth: 2, status: "completed", handoffBytes: r.ri(3_000, 8_000), model: spec.models[Math.min(1, spec.models.length - 1)] }));
  }

  const peakReq = main.requests.reduce((best, req) => (req.usage.total > best.usage.total ? req : best), main.requests[0]);
  const topBlocks = scopes.flatMap((s) => topBlocksOf(s, 5).map((b) => ({ ...b, scopeId: s.id }))).sort((a, b) => b.estTokens - a.estTokens).slice(0, 5);
  const totalRequests = scopes.reduce((s, sc) => s + sc.requests.length, 0);
  const sumTotal = scopes.reduce((s, sc) => s + sc.processedInputTokens, 0);
  const sumCacheRead = scopes.reduce((s, sc) => s + sc.requests.reduce((x, req) => x + req.usage.cacheRead, 0), 0);
  const startedAt = new Date(spec.startMs).toISOString();
  const endedAt = new Date(scopes.reduce((m, s) => Math.max(m, s.endMs), 0)).toISOString();
  let activeMs = 0;
  for (let i = 1; i < main.requests.length; i++) { const d = Date.parse(main.requests[i].at) - Date.parse(main.requests[i - 1].at); if (d <= 30 * 60_000) activeMs += d; }
  const window = spec.window;
  const findings = buildFindings(r, spec, runId, scopes, main, window);

  const strip = ({ endMs, clamped, ...s }) => s;
  const summaryOf = (s) => {
    const { requests, blocks, ...rest } = strip(s);
    return { ...rest, partial: true, requestCount: requests.length, blockCount: blocks.length, compactionCount: s.compactions.length, topBlocks: topBlocksOf(s, 5) };
  };
  const sourceFile = spec.vendor === "codex"
    ? `~/.codex/sessions/${spec.day}/rollout-${spec.day}T09-00-00-${spec.sessionId}.jsonl`
    : `~/.claude/projects/${spec.project.key}/${spec.sessionId}.jsonl`;
  const run = {
    id: runId, vendor: spec.vendor, sessionId: spec.sessionId,
    project: spec.project,
    startedAt, endedAt, activeMs, cliVersion: spec.cliVersion, gitBranch: spec.gitBranch, entrypoint: spec.vendor === "codex" ? "cli" : "cli",
    window: M(window, spec.windowProvenance ?? (spec.vendor === "codex" ? "observed.vendor" : "estimated.local")),
    scopes: [strip(main), ...scopes.slice(1).map(summaryOf)],
    summary: {
      requests: totalRequests, turns: main.requests[main.requests.length - 1].turn, processedInputTokens: sumTotal, outputTokens: scopes.reduce((s, sc) => s + sc.outputTokens, 0),
      cacheReadShare: Number((sumCacheRead / sumTotal).toFixed(3)), peak: main.peak, peakShareOfWindow: Number((main.peak.value / window).toFixed(3)),
      compactions: main.compactions.length, subagents: scopes.length - 1, toolCalls: scopes.reduce((s, sc) => s + sc.toolCalls, 0), models: [...new Set(scopes.flatMap((s) => s.models))],
      topBlocks, findingIds: findings.map((f) => f.id), compositionAtPeak: peakReq.composition, compositionAtEnd: main.requests[main.requests.length - 1].composition,
    },
    coverage: { records: totalRequests * 3 + 12, unparsedRecords: r.ri(0, 4), unparsedTypes: spec.vendor === "codex" ? { turn_context: 2 } : { "custom-title": 2, "file-history-snapshot": 1 }, requests: totalRequests, syntheticRecordsSkipped: r.ri(4, 60), estimatorErrorMedian: main.estimatorErrorMedian, estimatorErrorP95: main.estimatorErrorP95, clampedRequests: main.clamped, unloggedShare: main.unloggedShare, adapterVersion: `${spec.vendor}-v1`, estimatorVersion: "chars-v2", calibrationVersion: "2026-09-01" },
    source: { file: sourceFile, bytes: Math.round(sumTotal / 40), mtimeMs: Date.parse(endedAt), subagentFiles: scopes.length - 1 },
    findings,
  };
  if (spec.parentRunId) run.parentRunId = spec.parentRunId;
  const scopesById = Object.fromEntries(scopes.map((s) => [s.id, strip(s)]));
  return { run, scopes: scopesById, findings };
}
