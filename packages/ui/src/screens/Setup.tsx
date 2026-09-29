import { useEffect, useMemo, useState } from "preact/hooks";
import type { Change, ChangeNote, Finding, InstructionFile, Measured, SetupInventory, Vendor } from "@ir/types.ts";
import { api, isCompanion } from "../api.ts";
import { CLI_COMMAND } from "../config.ts";
import { useResource } from "../hooks.ts";
import { indexVersion, rulesVersion } from "../store.ts";
import { formatBytes, formatDate, formatNumber, formatTokens, plural } from "../format.ts";
import { Badge, type BadgeTone } from "../components/Badge.tsx";
import { ChangeNoteLine, ChangePanel } from "../components/ChangePanel.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FindingCard } from "../components/FindingCard.tsx";
import { FindingGroup } from "../components/FindingGroup.tsx";
import { groupFindings } from "../findings.ts";
import { Panel } from "../components/Panel.tsx";
import { Table, type Column } from "../components/Table.tsx";
import { ErrorNotice, Loading } from "../components/Status.tsx";

type Setup = SetupInventory & { findings: Finding[] };
type BudgetKey = "instructions" | "skills" | "agents" | "mcpTools";
const BUDGET_SERIES: Array<{ key: BudgetKey; label: string; color: string }> = [
  { key: "instructions", label: "Instruction files", color: "var(--series-1)" },
  { key: "skills", label: "Skill descriptions", color: "var(--series-2)" },
  { key: "agents", label: "Agent descriptions", color: "var(--series-3)" },
  { key: "mcpTools", label: "MCP tool schemas", color: "var(--series-4)" },
];

const LOAD_STATE: Record<InstructionFile["loadState"], { label: string; tone: BadgeTone; hint: string }> = {
  "observed.loaded": { label: "observed · loaded", tone: "good", hint: "A session artifact shows this file was injected into the prompt." },
  "expected.load": { label: "expected · load", tone: "info", hint: "In the precedence chain the vendor documents; no session proves it yet." },
  discoverable: { label: "discoverable", tone: "neutral", hint: "Present on disk but only loaded when the model touches its scope (nested / rules with paths)." },
};

export interface SetupScreenProps { file?: string }

export function SetupScreen({ file }: SetupScreenProps) {
  const version = indexVersion.value;
  const rules = rulesVersion.value;
  const { data, error, reload } = useResource((signal) => api.setup(signal), [version, rules]);
  // Before/after per instruction-file edit (ADR-005 §1): companion only; a 404 elsewhere leaves the expander out.
  const { data: changes } = useResource((signal) => (isCompanion() ? api.changes({}, signal).catch(() => null) : Promise.resolve(null)), [version, rules]);
  const [openFile, setOpenFile] = useState<string | undefined>(file);
  useEffect(() => { if (file) setOpenFile(file); }, [file]);
  const changesByFile = useMemo(() => {
    const map = new Map<string, { changes: Change[]; notes: ChangeNote[] }>();
    for (const c of changes?.changes ?? []) { const slot = map.get(c.file) ?? { changes: [], notes: [] }; slot.changes.push(c); map.set(c.file, slot); }
    for (const n of changes?.notes ?? []) { const slot = map.get(n.file) ?? { changes: [], notes: [] }; slot.notes.push(n); map.set(n.file, slot); }
    return map;
  }, [changes]);

  useEffect(() => {
    if (!data || !file) return;
    const row = document.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(file)}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.closest<HTMLElement>("[data-kbd-table]")?.focus({ preventScroll: true });
  }, [data, file]);

  const budgetMax = useMemo(() => Object.values(data?.startupBudget ?? {}).reduce((m, b) => Math.max(m, b?.total.value ?? 0), 1), [data]);

  if (error) return <section class="screen"><ErrorNotice error={error} retry={reload} /></section>;
  if (!data) return <section class="screen"><Loading label="Loading setup inventory" /></section>;

  const vendors = data.vendorsDetected;
  const budgets = (Object.keys(data.startupBudget) as Vendor[]).flatMap((v) => { const b = data.startupBudget[v]; return b ? [{ vendor: v, b }] : []; });
  const budgetVendors = budgets.map((x) => x.vendor);
  const isClaude = vendors.includes("claude") || budgetVendors.includes("claude");
  const isCodex = vendors.includes("codex") || budgetVendors.includes("codex");

  const instructionColumns: Column<InstructionFile>[] = [
    { key: "path", label: "Path", sortValue: (f) => f.path, render: (f) => (
      <span class="cell-path" data-file-path={f.path}>
        <code>{f.path}</code>
        {f.brokenRefs.length ? (
          <span class="broken-refs" title="Referenced paths that do not exist">
            {f.brokenRefs.map((ref) => <code key={ref} class="broken-ref">{ref}</code>)}
          </span>
        ) : null}
      </span>
    ) },
    { key: "scope", label: "Scope", width: "6rem", sortValue: (f) => f.scope, render: (f) => <span class="scope-tag">{f.scope}</span> },
    { key: "vendors", label: "Vendors", width: "8rem", sortValue: (f) => f.vendors.join(","), render: (f) => f.vendors.map((v) => <span key={v} class={`vendor vendor-${v}`}>{v}</span>) },
    { key: "tokens", label: "Est. tokens", numeric: true, align: "right", sortValue: (f) => f.estTokens, render: (f) => <span class="cell-peak"><span title={`${formatNumber(f.estTokens)} tokens · ${formatBytes(f.bytes)}`}>{formatNumber(f.estTokens)}</span><Badge provenance="estimated.local" /></span> },
    { key: "precedence", label: "Precedence", numeric: true, align: "right", title: "Order in the vendor's load chain (1 loads first)", sortValue: (f) => f.precedence, render: (f) => f.precedence },
    { key: "loadState", label: "Load state", sortValue: (f) => f.loadState, render: (f) => <Badge label={LOAD_STATE[f.loadState].label} tone={LOAD_STATE[f.loadState].tone} title={LOAD_STATE[f.loadState].hint} /> },
    { key: "mtime", label: "Modified", sortValue: (f) => Date.parse(f.mtime), render: (f) => <time dateTime={f.mtime}>{formatDate(f.mtime)}</time> },
    ...(changes ? [{ key: "since", label: "Since this edit", title: "Sessions after the last edit of this file vs before (observational)", sortValue: (f: InstructionFile) => changesByFile.get(f.path)?.changes[0]?.n.after ?? -1, render: (f: InstructionFile) => {
      const slot = changesByFile.get(f.path);
      const latest = slot?.changes[0];
      const label = latest ? `${latest.n.after} vs ${latest.n.before} before` : slot?.notes[0] ? "no pair yet" : "no sessions";
      const open = openFile === f.path;
      return <button type="button" class="change-toggle" aria-expanded={open} aria-controls="change-expander" onClick={() => setOpenFile(open ? undefined : f.path)}>{label}</button>;
    } } as Column<InstructionFile>] : []),
  ];
  const openSlot = openFile ? changesByFile.get(openFile) : undefined;

  const skillColumns: Column<Setup["skills"][number]>[] = [
    { key: "name", label: "Skill", sortValue: (s) => s.name, render: (s) => <span class="cell-path"><strong>{s.name}</strong><code class="cell-sub">{s.path}</code></span> },
    { key: "scope", label: "Scope", width: "6rem", sortValue: (s) => s.scope, render: (s) => <span class="scope-tag">{s.scope}</span> },
    { key: "description", label: "Description", sortValue: (s) => s.descriptionChars, render: (s) => s.hasDescription ? <span>{formatNumber(s.descriptionChars)} chars{s.descriptionChars < 20 ? <span class="warn-text"> · short</span> : null}</span> : <span class="danger-text">missing</span> },
    { key: "frontmatter", label: "Frontmatter", sortValue: (s) => (s.frontmatterValid ? 1 : 0), render: (s) => s.frontmatterValid ? <Badge label="valid" tone="good" /> : <Badge label="invalid" tone="danger" /> },
    { key: "body", label: "Body est. tokens", numeric: true, align: "right", sortValue: (s) => s.bodyEstTokens, render: (s) => <span class="cell-peak">{formatNumber(s.bodyEstTokens)}<Badge provenance="estimated.local" /></span> },
    { key: "invocations", label: "Invocations 30d", numeric: true, align: "right", sortValue: (s) => s.invocations30d, render: (s) => <span class="cell-peak">{s.invocations30d || <span class="muted">0</span>}<Badge provenance="derived.exact" /></span> },
  ];

  const agentColumns: Column<Setup["agents"][number]>[] = [
    { key: "name", label: "Agent", sortValue: (a) => a.name, render: (a) => <span class="cell-path"><strong>{a.name}</strong><code class="cell-sub">{a.path}</code></span> },
    { key: "scope", label: "Scope", width: "6rem", sortValue: (a) => a.scope, render: (a) => <span class="scope-tag">{a.scope}</span> },
    { key: "model", label: "Model", sortValue: (a) => a.model ?? "", render: (a) => a.model ?? <span class="muted">inherit</span> },
    { key: "tools", label: "Tools", render: (a) => a.tools?.length ? <span class="tool-list">{a.tools.join(", ")}</span> : <span class="muted">all</span> },
    { key: "description", label: "Description", numeric: true, align: "right", sortValue: (a) => a.descriptionChars, render: (a) => <span class="cell-peak">{formatNumber(a.descriptionChars)} chars<Badge provenance="observed.artifact" /></span> },
    { key: "runs", label: "Runs 30d", numeric: true, align: "right", sortValue: (a) => a.runs30d, render: (a) => <span class="cell-peak">{a.runs30d || <span class="muted">0</span>}<Badge provenance="observed.artifact" /></span> },
  ];

  const hookColumns: Column<Setup["hooks"][number]>[] = [
    { key: "event", label: "Event", sortValue: (h) => h.event, render: (h) => <span class="cell-path"><strong>{h.event}</strong>{h.matcher ? <code class="cell-sub">matcher: {h.matcher}</code> : null}</span> },
    { key: "command", label: "Command", render: (h) => <code class="cmd">{h.command}</code> },
    { key: "scope", label: "Scope", width: "6rem", sortValue: (h) => h.scope, render: (h) => <span class="scope-tag">{h.scope}</span> },
    { key: "runs", label: "Runs 30d", numeric: true, align: "right", sortValue: (h) => h.runs30d, render: (h) => h.runs30d || <span class="muted">0</span> },
    { key: "p50", label: "stdout p50", numeric: true, align: "right", title: "Median hook stdout size (est. tokens)", sortValue: (h) => h.stdoutP50, render: (h) => h.runs30d ? <span class="cell-peak">{formatNumber(h.stdoutP50)}<Badge provenance="estimated.local" /></span> : <span class="muted">—</span> },
    { key: "p95", label: "stdout p95", numeric: true, align: "right", title: "95th percentile hook stdout size (est. tokens)", sortValue: (h) => h.stdoutP95, render: (h) => h.runs30d ? <span class="cell-peak"><span class={h.stdoutP95 >= 1500 ? "warn-text" : ""}>{formatNumber(h.stdoutP95)}</span><Badge provenance="estimated.local" /></span> : <span class="muted">—</span> },
  ];

  const mcpColumns: Column<Setup["mcpServers"][number]>[] = [
    { key: "name", label: "Server", sortValue: (m) => m.name, render: (m) => <strong>{m.name}</strong> },
    { key: "scope", label: "Scope", width: "6rem", sortValue: (m) => m.scope, render: (m) => <span class="scope-tag">{m.scope}</span> },
    { key: "transport", label: "Transport", sortValue: (m) => m.transport ?? "", render: (m) => m.transport ?? <span class="muted">—</span> },
    { key: "tools", label: "Tools observed", numeric: true, align: "right", sortValue: (m) => m.toolsObserved.length, render: (m) => <span class="cell-peak"><span class={m.toolsObserved.length > 15 ? "warn-text" : ""} title={m.toolsObserved.join("\n")}>{m.toolsObserved.length}</span><Badge provenance="observed.artifact" /></span> },
    { key: "invocations", label: "Invocations 30d", numeric: true, align: "right", sortValue: (m) => m.invocations30d, render: (m) => <span class="cell-peak">{m.invocations30d ? m.invocations30d : <span class="danger-text">0</span>}<Badge provenance="derived.exact" /></span> },
  ];

  const setupFindings = data.findings.filter((f) => f.scope === "setup");
  const setupGroups = groupFindings(setupFindings);
  const repoLabel = data.repo.name || "this repository";
  const excluded = data.excluded ?? [];
  // What still enters every request when no instruction file exists (ADR-004 §6): the non-instruction parts of the budget.
  const nonInstruction = budgets.map(({ vendor: v, b }) => ({ vendor: v, tokens: b.total.value - b.instructions.value, parts: BUDGET_SERIES.filter((s) => s.key !== "instructions" && b[s.key].value > 0).map((s) => s.label.toLowerCase()) })).filter((x) => x.tokens > 0);

  return (
    <section class="screen screen-setup">
      <header class="screen-head">
        <div>
          <h1>Setup</h1>
          <p class="screen-sub">Context bill of materials for <strong>{repoLabel}</strong>{data.repo.git ? "" : " (not a git repository)"} · vendors detected: {vendors.length ? vendors.join(", ") : "none"}</p>
        </div>
        <ul class="strip" aria-label="Setup summary">
          <li><strong>{data.instructionFiles.length}</strong> instruction files</li>
          <li><strong>{data.skills.length}</strong> skills</li>
          <li><strong>{data.agents.length}</strong> agents</li>
          <li><strong>{data.hooks.length}</strong> hooks</li>
          <li><strong>{data.mcpServers.length}</strong> MCP servers</li>
        </ul>
      </header>

      <Panel id="budget" title="Startup budget" description="Estimated tokens that enter every request before the user types">
        {budgetVendors.length ? (
          <div class="budget">
            <div class="budget-legend" aria-hidden="true">
              {BUDGET_SERIES.map((s) => <span key={s.key} class="legend-item"><span class="legend-swatch" style={{ background: s.color }} />{s.label}</span>)}
            </div>
            {budgets.map(({ vendor, b }) => {
              const total = b.total.value || 1;
              return (
                <div key={vendor} class="budget-row">
                  <div class="budget-vendor"><span class={`vendor vendor-${vendor}`}>{vendor}</span></div>
                  <div class="budget-bar-wrap">
                    <div class="budget-bar" role="img" aria-label={`${vendor}: ${BUDGET_SERIES.map((s) => `${s.label} ${formatNumber(b[s.key].value)}`).join(", ")}, total ${formatNumber(b.total.value)} tokens`} style={{ width: `${Math.max(2, (b.total.value / budgetMax) * 100)}%` }}>
                      {BUDGET_SERIES.map((s) => {
                        const v = b[s.key].value;
                        if (!v) return null;
                        return <span key={s.key} class="budget-seg" style={{ flexBasis: `${(v / total) * 100}%`, background: s.color }} title={`${s.label}: ${formatNumber(v)} tokens (${b[s.key].provenance})`} />;
                      })}
                    </div>
                  </div>
                  <div class="budget-total">
                    <strong>{formatTokens(b.total.value)}</strong> <span class="muted">tok</span> <Badge provenance={b.total.provenance} />
                  </div>
                  <ul class="budget-values">
                    {BUDGET_SERIES.map((s) => <li key={s.key}><span class="legend-swatch" style={{ background: s.color }} aria-hidden="true" />{s.label} <strong>{formatTokens(b[s.key].value)}</strong> <Badge provenance={b[s.key].provenance} /></li>)}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState compact title="No startup budget" body="The budget is computed from instruction files, skill and agent descriptions, and MCP tool schemas once a vendor is detected in this repository." path="CLAUDE.md · AGENTS.md · .claude/ · .mcp.json" command={CLI_COMMAND} />
        )}
      </Panel>

      <Panel id="instructions" title="Instruction files" description="Precedence chain per vendor; broken references shown inline" flush actions={<span class="muted">{plural(data.instructionFiles.length, "file")} · {formatTokens(data.instructionFiles.reduce((s, f) => s + f.estTokens, 0))} tok est.</span>}>
        {data.instructionFiles.length ? (
          <>
            <Table label="Instruction files" columns={instructionColumns} rows={data.instructionFiles} rowKey={(f) => f.path} defaultSort={{ key: "precedence", dir: "asc" }} rowClass={(f) => (file && f.path === file ? "row-highlight" : undefined)} dense />
            {changes && openFile && data.instructionFiles.some((f) => f.path === openFile) ? (
              <div id="change-expander" aria-live="polite">
                {openSlot?.changes.length ? openSlot.changes.map((c) => <ChangePanel key={`${c.file}@${c.at}`} change={c} />) : (
                  <div class="change-empty">
                    {openSlot?.notes.length ? openSlot.notes.map((n) => <ChangeNoteLine key={n.at} note={n} />) : <p class="change-note muted">Not enough sessions to pair around an edit of <code>{openFile}</code>: no session of this repository before or after it yet.</p>}
                  </div>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <div class="panel-pad">
            <EmptyState compact title="No instruction files found" body={<>{nonInstruction.length
              ? <>No repository instructions reach the model, but {nonInstruction.map((x, i) => <span key={x.vendor}>{i > 0 ? "; " : ""}<strong>{formatTokens(x.tokens)} tokens</strong> of {x.parts.join(", ") || "startup context"} still enter every {x.vendor} request</span>)}. </>
              : <>Nothing is sent to the model before your first message. </>}{isCodex ? "Codex reads AGENTS.md from the repo root and nested directories." : "Claude Code reads CLAUDE.md, .claude/CLAUDE.md and .claude/rules/*.md."}</>} path={isCodex && !isClaude ? "AGENTS.md" : "CLAUDE.md · .claude/rules/*.md · ~/.claude/CLAUDE.md"} command={isCodex && !isClaude ? "codex   # then write AGENTS.md" : "claude /init"} />
          </div>
        )}
        {excluded.length ? (
          <details class="excluded panel-pad">
            <summary>Excluded ({excluded.length}) <span class="muted">· test fixtures, nested repositories / worktrees and git-ignored directories; listed, never counted in the chain, the budget or the rules</span></summary>
            <ul class="excluded-list">
              {excluded.map((e) => <li key={e.path}><code>{e.path}</code> <span class="muted">{e.reason}</span></li>)}
            </ul>
          </details>
        ) : null}
      </Panel>

      <div class="stack">
        <Panel id="skills" title="Skills" description="Frontmatter descriptions are prompt text on every request" flush actions={<span class="muted">{data.skills.length}</span>}>
          {data.skills.length ? (
            <Table label="Skills" columns={skillColumns} rows={data.skills} rowKey={(s) => s.path} defaultSort={{ key: "body", dir: "desc" }} dense />
          ) : (
            <div class="panel-pad"><EmptyState compact title="No skills" body="Skills are SKILL.md files with a description in frontmatter." path=".claude/skills/<name>/SKILL.md · ~/.claude/skills/" command="mkdir -p .claude/skills/<name> && $EDITOR .claude/skills/<name>/SKILL.md" /></div>
          )}
        </Panel>
        <Panel id="agents" title="Agents" description="Definition files and observed runs" flush actions={<span class="muted">{data.agents.length}</span>}>
          {data.agents.length ? (
            <Table label="Agents" columns={agentColumns} rows={data.agents} rowKey={(a) => a.path} defaultSort={{ key: "runs", dir: "desc" }} dense />
          ) : (
            <div class="panel-pad"><EmptyState compact title="No agent definitions" body="Subagents are Markdown files with frontmatter (name, description, model, tools)." path=".claude/agents/<name>.md · ~/.claude/agents/" command="claude   # then /agents" /></div>
          )}
        </Panel>
      </div>

      <Panel id="hooks" title="Hooks" description="From settings files, with observed stdout sizes (est. tokens)" flush actions={<span class="muted">{data.hooks.length}</span>}>
        {data.hooks.length ? (
          <Table label="Hooks" columns={hookColumns} rows={data.hooks} rowKey={(h, ) => `${h.scope}:${h.event}:${h.matcher ?? ""}:${h.command}`} defaultSort={{ key: "p95", dir: "desc" }} dense />
        ) : (
          <div class="panel-pad"><EmptyState compact title="No hooks configured" body="Hook stdout is injected into context every time it fires, so none is a fine state." path=".claude/settings.json · .claude/settings.local.json · ~/.claude/settings.json" command="claude   # then /hooks" /></div>
        )}
      </Panel>

      <div class="grid-2">
        <Panel id="mcp" title="MCP servers" description="Each tool schema is prompt text on every request" flush actions={<span class="muted">{data.mcpServers.reduce((s, m) => s + m.toolsObserved.length, 0)} tools observed</span>}>
          {data.mcpServers.length ? (
            <Table label="MCP servers" columns={mcpColumns} rows={data.mcpServers} rowKey={(m) => `${m.scope}:${m.name}`} defaultSort={{ key: "tools", dir: "desc" }} dense />
          ) : (
            <div class="panel-pad"><EmptyState compact title="No MCP servers" body="No tool schemas from MCP are added to the startup set." path=".mcp.json · ~/.claude.json · ~/.codex/config.toml [mcp_servers]" command="claude mcp add <name> -- <command>" /></div>
          )}
        </Panel>
        <Panel id="memory" title="Memory" description="Auto-memory for this project" actions={<Badge provenance="observed.artifact" />}>
          {data.memory.present ? (
            <dl class="kv">
              <dt>Directory</dt><dd>present</dd>
              <dt>Files</dt><dd>{formatNumber(data.memory.files)}</dd>
              <dt>Total size</dt><dd>{formatBytes(data.memory.bytes)} <span class="muted">(~{formatTokens(data.memory.bytes / 4)} tok)</span></dd>
              <dt>MEMORY.md</dt><dd>{data.memory.indexBytes ? formatBytes(data.memory.indexBytes) : <span class="warn-text">empty</span>}</dd>
            </dl>
          ) : (
            <EmptyState compact title="No memory directory" body="Without memory, each session re-discovers the same facts through tool calls." path="~/.claude/projects/<project>/memory/MEMORY.md" command="claude   # memory fills as sessions run, or seed MEMORY.md by hand" />
          )}
          {(data.commands.length || data.settings.length) ? (
            <dl class="kv kv-secondary">
              <dt>Commands</dt><dd>{data.commands.length ? data.commands.map((c) => <code key={c.path} class="inline-code">/{c.name}</code>) : <span class="muted">none</span>}</dd>
              <dt>Settings</dt><dd>{data.settings.length ? data.settings.map((s) => <span key={s.path} class="settings-file"><code class="inline-code" title={s.keys.join(", ")}>{s.path}</code> <span class="muted">{s.keys.length} keys</span></span>) : <span class="muted">none</span>}</dd>
            </dl>
          ) : null}
        </Panel>
      </div>

      <section class="finding-group" aria-label="Setup findings">
        <h2 class="group-title">Setup findings <span class="muted">· {setupFindings.length} · rules S-01..S-12</span></h2>
        {setupGroups.length ? <>
          <FindingCard finding={setupGroups[0].primary} headline="One change to make first" highlight />
          {setupGroups.slice(1).map((g) => <FindingGroup key={`${g.ruleId}/${g.scope}`} group={g} />)}
        </> : (
          <EmptyState compact title="No setup findings" body="The setup rules did not fire for this repository. They re-run after every index refresh and whenever thresholds change." />
        )}
      </section>
    </section>
  );
}

export function measuredText(m: Measured): string {
  return `${formatNumber(m.value)} (${m.provenance})`;
}
