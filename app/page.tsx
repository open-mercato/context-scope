"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Source = "system" | "user" | "agent" | "tool" | "file" | "skill";

type ContextEvent = {
  id: string;
  turn: number;
  time: string;
  source: Source;
  label: string;
  detail: string;
  tokens: number;
  retained: number;
  status?: "added" | "reused" | "compacted";
};

type Session = {
  name: string;
  model: string;
  capacity: number;
  duration: string;
  events: ContextEvent[];
};

const SOURCE_META: Record<Source, { label: string; color: string; icon: string }> = {
  system: { label: "System", color: "#7357d8", icon: "S" },
  user: { label: "User", color: "#e87943", icon: "U" },
  agent: { label: "Agents", color: "#2c9c7d", icon: "A" },
  tool: { label: "Tool calls", color: "#4a83c6", icon: "T" },
  file: { label: "Files", color: "#d6a72e", icon: "F" },
  skill: { label: "Skills", color: "#c65c88", icon: "K" },
};

const ALL_SOURCES = Object.keys(SOURCE_META) as Source[];

const SAMPLE_EVENTS: ContextEvent[] = [
  { id: "e1", turn: 1, time: "09:41:02", source: "system", label: "System instructions", detail: "Agent policy, workspace rules, and tool contracts", tokens: 18200, retained: 1, status: "added" },
  { id: "e2", turn: 1, time: "09:41:03", source: "skill", label: "frontend-design skill", detail: "Interface design and validation guidance", tokens: 6700, retained: 0.95, status: "added" },
  { id: "e3", turn: 1, time: "09:41:05", source: "user", label: "Refactor auth request", detail: "Initial task, constraints, and acceptance criteria", tokens: 3800, retained: 1, status: "added" },
  { id: "e4", turn: 2, time: "09:43:11", source: "tool", label: "rg --files", detail: "Repository inventory returned 184 paths", tokens: 5100, retained: 0.42, status: "added" },
  { id: "e5", turn: 2, time: "09:43:24", source: "file", label: "src/auth/session.ts", detail: "Session lifecycle and refresh implementation", tokens: 9400, retained: 0.86, status: "added" },
  { id: "e6", turn: 3, time: "09:47:18", source: "file", label: "src/auth/provider.tsx", detail: "React authentication provider", tokens: 7200, retained: 0.83, status: "added" },
  { id: "e7", turn: 3, time: "09:48:40", source: "agent", label: "explorer-agent", detail: "Auth dependency map and risk summary", tokens: 8200, retained: 0.91, status: "added" },
  { id: "e8", turn: 4, time: "09:52:16", source: "tool", label: "test runner", detail: "Baseline suite: 118 passing, 3 failing", tokens: 6100, retained: 0.38, status: "added" },
  { id: "e9", turn: 5, time: "09:57:42", source: "user", label: "Clarification", detail: "Preserve refresh behavior for inactive tabs", tokens: 1400, retained: 1, status: "added" },
  { id: "e10", turn: 5, time: "09:58:10", source: "file", label: "tests/auth-refresh.test.ts", detail: "Token refresh regression suite", tokens: 11600, retained: 0.74, status: "added" },
  { id: "e11", turn: 6, time: "10:02:31", source: "agent", label: "test-agent", detail: "Reproduction trace and suggested fix", tokens: 7100, retained: 0.79, status: "added" },
  { id: "e12", turn: 6, time: "10:03:15", source: "tool", label: "apply_patch", detail: "Updated session refresh coordinator", tokens: 4200, retained: 0.64, status: "added" },
  { id: "e13", turn: 7, time: "10:07:49", source: "tool", label: "npm test", detail: "Full test output after implementation", tokens: 12400, retained: 0.31, status: "added" },
  { id: "e14", turn: 8, time: "10:11:04", source: "system", label: "Context compaction", detail: "Older raw results compressed into a working summary", tokens: 9800, retained: 1, status: "compacted" },
  { id: "e15", turn: 8, time: "10:11:05", source: "file", label: "Recent file snapshot", detail: "Five most recently accessed files retained", tokens: 13200, retained: 0.92, status: "reused" },
  { id: "e16", turn: 9, time: "10:17:33", source: "tool", label: "npm run build", detail: "Production build output and diagnostics", tokens: 7700, retained: 0.44, status: "added" },
  { id: "e17", turn: 10, time: "10:22:58", source: "agent", label: "review-agent", detail: "Final review: no blocking findings", tokens: 6300, retained: 0.88, status: "added" },
  { id: "e18", turn: 10, time: "10:23:17", source: "tool", label: "git diff", detail: "Final change summary", tokens: 4900, retained: 0.57, status: "added" },
];

const SAMPLE_SESSION: Session = {
  name: "refactor-auth",
  model: "Claude Sonnet 4.5",
  capacity: 200000,
  duration: "42m 18s",
  events: SAMPLE_EVENTS,
};

function estimateTokens(value: unknown): number {
  if (typeof value === "string") return Math.max(1, Math.ceil(value.length / 4));
  try { return Math.max(1, Math.ceil(JSON.stringify(value).length / 4)); } catch { return 1; }
}

function classify(item: Record<string, unknown>): Source {
  const haystack = `${item.type ?? ""} ${item.role ?? ""} ${item.name ?? ""} ${item.source ?? ""}`.toLowerCase();
  if (/skill|instruction/.test(haystack)) return "skill";
  if (/file|read|path/.test(haystack)) return "file";
  if (/tool|function|command|exec|grep|glob|search/.test(haystack)) return "tool";
  if (/sub.?agent|agent/.test(haystack)) return "agent";
  if (/system|developer/.test(haystack)) return "system";
  return "user";
}

function labelFor(item: Record<string, unknown>, source: Source, index: number) {
  const candidate = item.label ?? item.name ?? item.title ?? item.tool_name ?? item.path ?? item.role;
  return typeof candidate === "string" ? candidate : `${SOURCE_META[source].label} context ${index + 1}`;
}

function parseSessionText(raw: string, fileName = "imported-session"): Session {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    try { parsed = lines.map((line) => JSON.parse(line)); }
    catch { throw new Error("Use a JSON session export or newline-delimited JSON trace."); }
  }

  const root = parsed as Record<string, unknown>;
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root.events) ? root.events
      : Array.isArray(root.messages) ? root.messages
        : Array.isArray(root.items) ? root.items : [root];

  const events = candidates.map((entry, index): ContextEvent => {
    const item = (typeof entry === "object" && entry ? entry : { content: entry }) as Record<string, unknown>;
    const source = classify(item);
    const tokenCandidate = item.tokens ?? item.token_count ?? item.input_tokens;
    const tokens = typeof tokenCandidate === "number" ? tokenCandidate : estimateTokens(item.content ?? item.output ?? item.text ?? item);
    const turnCandidate = item.turn ?? item.turn_index ?? item.sequence;
    const turn = typeof turnCandidate === "number" ? Math.max(1, turnCandidate) : index + 1;
    const timeCandidate = item.time ?? item.timestamp ?? item.created_at;
    let time = `${String(9 + Math.floor(index / 12)).padStart(2, "0")}:${String((index * 4) % 60).padStart(2, "0")}:00`;
    if (typeof timeCandidate === "string") {
      const date = new Date(timeCandidate);
      time = Number.isNaN(date.valueOf()) ? timeCandidate.slice(0, 8) : date.toLocaleTimeString([], { hour12: false });
    }
    const detailValue = item.detail ?? item.content ?? item.output ?? item.text;
    const detail = typeof detailValue === "string" ? detailValue.slice(0, 180) : "Imported context event";
    return { id: `imported-${index}`, turn, time, source, label: labelFor(item, source, index), detail, tokens, retained: 1, status: "added" };
  });

  if (!events.length) throw new Error("No context events were found in this export.");
  const metadata = (!Array.isArray(parsed) && typeof parsed === "object" && parsed ? parsed : {}) as Record<string, unknown>;
  return {
    name: typeof metadata.name === "string" ? metadata.name : fileName.replace(/\.(jsonl?|txt)$/i, ""),
    model: typeof metadata.model === "string" ? metadata.model : "Imported model",
    capacity: typeof metadata.capacity === "number" ? metadata.capacity : 200000,
    duration: typeof metadata.duration === "string" ? metadata.duration : `${events.length} events`,
    events,
  };
}

function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value);
}

function cumulativeAt(events: ContextEvent[], turn: number, source?: Source) {
  return events.filter((event) => event.turn <= turn && (!source || event.source === source)).reduce((sum, event) => sum + event.tokens * event.retained, 0);
}

export default function Home() {
  const [session, setSession] = useState<Session>(SAMPLE_SESSION);
  const [activeSources, setActiveSources] = useState<Source[]>(ALL_SOURCES);
  const [selectedTurn, setSelectedTurn] = useState(8);
  const [selectedEvent, setSelectedEvent] = useState<ContextEvent | null>(SAMPLE_EVENTS[13]);
  const [importOpen, setImportOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const maxTurn = Math.max(...session.events.map((event) => event.turn), 1);
  const turns = Array.from({ length: maxTurn }, (_, index) => index + 1);
  const filteredEvents = session.events.filter((event) => activeSources.includes(event.source));
  const sourceTotals = useMemo(() => Object.fromEntries(ALL_SOURCES.map((source) => [source, session.events.filter((event) => event.source === source).reduce((sum, event) => sum + event.tokens, 0)])) as Record<Source, number>, [session]);
  const totalInput = session.events.reduce((sum, event) => sum + event.tokens, 0);
  const currentContext = cumulativeAt(filteredEvents, selectedTurn);
  const peakContext = Math.max(...turns.map((turn) => cumulativeAt(session.events, turn)));
  const retainedTokens = session.events.reduce((sum, event) => sum + event.tokens * event.retained, 0);
  const retention = Math.round((retainedTokens / totalInput) * 100);
  const currentEvents = filteredEvents.filter((event) => event.turn <= selectedTurn).sort((a, b) => b.tokens * b.retained - a.tokens * a.retained);

  function toggleSource(source: Source) {
    setActiveSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);
  }

  function applyImport(raw: string, fileName?: string) {
    try {
      const next = parseSessionText(raw, fileName);
      setSession(next);
      setSelectedTurn(Math.max(...next.events.map((event) => event.turn)));
      setSelectedEvent(next.events[0]);
      setActiveSources(ALL_SOURCES);
      setImportOpen(false);
      setPasteValue("");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This session could not be parsed.");
    }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    applyImport(await file.text(), file.name);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  }

  function exportAnalysis() {
    const summary = { session: session.name, model: session.model, capacity: session.capacity, totalInput, peakContext, retention, sources: sourceTotals, events: session.events };
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${session.name}-context-analysis.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">C</span><span>ContextScope</span><span className="beta">BETA</span></div>
        <nav aria-label="Primary navigation">
          <button className="nav-item active">Analyze</button>
          <button className="nav-item" onClick={() => document.getElementById("ledger")?.scrollIntoView({ behavior: "smooth" })}>Events</button>
          <button className="nav-item" onClick={() => setImportOpen(true)}>Import</button>
        </nav>
        <div className="top-actions">
          <button className="text-button" onClick={() => setSession(SAMPLE_SESSION)}>Demo session</button>
          <button className="primary-button" onClick={() => setImportOpen(true)}><span>↑</span> Load session</button>
        </div>
      </header>

      <section className="session-bar">
        <div>
          <p className="eyebrow">SESSION ANALYSIS</p>
          <div className="session-title-row">
            <h1>{session.name}</h1>
            <span className="model-chip">{session.model}</span>
            <span className="session-meta">{session.duration} · {session.events.length} context events</span>
          </div>
        </div>
        <button className="outline-button" onClick={exportAnalysis}>↓ Export analysis</button>
      </section>

      <div className="workspace">
        <aside className="source-panel">
          <div className="panel-heading">
            <h2>Context sources</h2>
            <button onClick={() => setActiveSources(activeSources.length === ALL_SOURCES.length ? [] : ALL_SOURCES)}>{activeSources.length === ALL_SOURCES.length ? "Clear" : "All"}</button>
          </div>
          <p className="panel-note">Toggle sources to isolate their contribution across the session.</p>
          <div className="source-list">
            {ALL_SOURCES.map((source) => {
              const count = session.events.filter((event) => event.source === source).length;
              const active = activeSources.includes(source);
              return <button className={`source-row ${active ? "selected" : ""}`} key={source} onClick={() => toggleSource(source)}>
                <span className="source-icon" style={{ background: SOURCE_META[source].color }}>{SOURCE_META[source].icon}</span>
                <span className="source-copy"><strong>{SOURCE_META[source].label}</strong><small>{count} events · {formatTokens(sourceTotals[source])}</small></span>
                <span className="check" aria-label={active ? "Included" : "Excluded"}>{active ? "✓" : ""}</span>
              </button>;
            })}
          </div>
          <div className="method-card">
            <span className="method-icon">∿</span>
            <div><strong>How counts work</strong><p>Uses reported tokens when present. Otherwise estimates from content length.</p></div>
          </div>
        </aside>

        <div className="analysis-canvas">
          <section className="metrics-grid" aria-label="Session summary">
            <article className="metric-card featured">
              <div className="metric-top"><span>Peak context</span><span className="trend good">Within limit</span></div>
              <div className="metric-value">{formatTokens(peakContext)} <small>/ {formatTokens(session.capacity)}</small></div>
              <div className="capacity-track"><span style={{ width: `${Math.min(100, peakContext / session.capacity * 100)}%` }} /></div>
              <p>{Math.round(peakContext / session.capacity * 100)}% of the available window</p>
            </article>
            <article className="metric-card"><div className="metric-top"><span>Total input</span><span className="metric-symbol">↗</span></div><div className="metric-value">{formatTokens(totalInput)}</div><p>Across {session.events.length} context events</p></article>
            <article className="metric-card"><div className="metric-top"><span>Context entries</span><span className="metric-symbol">≡</span></div><div className="metric-value">{session.events.length}</div><p>{session.events.filter((event) => event.turn === 1).length} initial · {session.events.filter((event) => event.turn > 1).length} retrieved in-session</p></article>
            <article className="metric-card"><div className="metric-top"><span>Signal retained</span><span className="metric-symbol">◎</span></div><div className="metric-value">{retention}%</div><p>{formatTokens(totalInput - retainedTokens)} tokens pruned or compacted</p></article>
          </section>

          <section className="chart-layout">
            <article className="card context-chart-card">
              <div className="card-header">
                <div><p className="eyebrow">WINDOW OVER TIME</p><h2>How context was built</h2></div>
                <div className="legend">{ALL_SOURCES.map((source) => <span key={source}><i style={{ background: SOURCE_META[source].color }} />{SOURCE_META[source].label}</span>)}</div>
              </div>
              <div className="chart-wrap">
                <div className="y-labels"><span>{formatTokens(session.capacity)}</span><span>{formatTokens(session.capacity * .75)}</span><span>{formatTokens(session.capacity * .5)}</span><span>{formatTokens(session.capacity * .25)}</span><span>0</span></div>
                <div className="bar-area">
                  {[25, 50, 75, 100].map((line) => <div key={line} className="grid-line" style={{ bottom: `${line}%` }} />)}
                  <div className="bars">
                    {turns.map((turn) => {
                      const total = cumulativeAt(filteredEvents, turn);
                      return <button key={turn} className={`bar-column ${selectedTurn === turn ? "active" : ""}`} onClick={() => setSelectedTurn(turn)} aria-label={`Turn ${turn}, ${formatTokens(total)} tokens`}>
                        <div className="stack" style={{ height: `${Math.max(3, total / session.capacity * 100)}%` }}>
                          {ALL_SOURCES.map((source) => {
                            const amount = cumulativeAt(filteredEvents, turn, source);
                            return amount > 0 ? <span key={source} title={`${SOURCE_META[source].label}: ${formatTokens(amount)}`} style={{ height: `${amount / total * 100}%`, background: SOURCE_META[source].color }} /> : null;
                          })}
                        </div>
                        <small>T{turn}</small>
                      </button>;
                    })}
                  </div>
                </div>
              </div>
              <div className="chart-footer"><span><i className="pulse-dot" /> Select a turn to inspect its active context</span><strong>Capacity {formatTokens(session.capacity)}</strong></div>
            </article>

            <aside className="card turn-inspector">
              <div className="turn-header"><div><p className="eyebrow">SNAPSHOT</p><h2>Context at turn {selectedTurn}</h2></div><span className="turn-total">{formatTokens(currentContext)}</span></div>
              <div className="donut-row">
                <div className="donut" style={{ background: `conic-gradient(#7357d8 0 ${Math.min(100, currentContext / session.capacity * 100)}%, #eceaf1 0)` }}><span>{Math.round(currentContext / session.capacity * 100)}%</span></div>
                <div><strong>{formatTokens(session.capacity - currentContext)}</strong><p>tokens still available</p></div>
              </div>
              <div className="contributors">
                <div className="contributors-heading"><span>Top contributors</span><span>Tokens</span></div>
                {currentEvents.slice(0, 5).map((event) => <button key={event.id} onClick={() => setSelectedEvent(event)}>
                  <span className="mini-source" style={{ background: SOURCE_META[event.source].color }}>{SOURCE_META[event.source].icon}</span>
                  <span className="contributor-copy"><strong>{event.label}</strong><small>{SOURCE_META[event.source].label} · {Math.round(event.retained * 100)}% retained</small></span>
                  <span>{formatTokens(event.tokens * event.retained)}</span>
                </button>)}
              </div>
            </aside>
          </section>

          <section className="card provenance-card">
            <div className="card-header"><div><p className="eyebrow">PROVENANCE</p><h2>Where context came from</h2></div><p className="card-description">Token flow from origin to the active working window</p></div>
            <div className="flow-view">
              <div className="flow-column">
                <span className="flow-label">SOURCES</span>
                {ALL_SOURCES.slice(0, 3).map((source) => <div className="flow-node" key={source}><i style={{ background: SOURCE_META[source].color }}>{SOURCE_META[source].icon}</i><span>{SOURCE_META[source].label}<small>{formatTokens(sourceTotals[source])}</small></span></div>)}
              </div>
              <div className="flow-lines first"><span /><span /><span /></div>
              <div className="window-node"><span className="window-rings">◎</span><small>ACTIVE WINDOW</small><strong>{formatTokens(currentContext)}</strong><p>at turn {selectedTurn}</p></div>
              <div className="flow-lines last"><span /><span /><span /></div>
              <div className="flow-column right">
                <span className="flow-label">RETRIEVED</span>
                {ALL_SOURCES.slice(3).map((source) => <div className="flow-node" key={source}><i style={{ background: SOURCE_META[source].color }}>{SOURCE_META[source].icon}</i><span>{SOURCE_META[source].label}<small>{formatTokens(sourceTotals[source])}</small></span></div>)}
              </div>
            </div>
          </section>

          <section className="card ledger-card" id="ledger">
            <div className="card-header"><div><p className="eyebrow">EVENT LEDGER</p><h2>Every context addition</h2></div><span className="result-count">{filteredEvents.length} events shown</span></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Source</th><th>Context</th><th>Turn</th><th>Tokens</th><th>Retained</th></tr></thead>
                <tbody>{filteredEvents.map((event) => <tr key={event.id} onClick={() => setSelectedEvent(event)} className={selectedEvent?.id === event.id ? "selected" : ""}>
                  <td className="mono">{event.time}</td>
                  <td><span className="table-source"><i style={{ background: SOURCE_META[event.source].color }}>{SOURCE_META[event.source].icon}</i>{SOURCE_META[event.source].label}</span></td>
                  <td><strong>{event.label}</strong><small>{event.detail}</small></td>
                  <td>T{event.turn}</td><td className="mono strong">{formatTokens(event.tokens)}</td><td><span className={`retained ${event.retained < .5 ? "low" : ""}`}>{Math.round(event.retained * 100)}%</span></td>
                </tr>)}</tbody>
              </table>
            </div>
            {selectedEvent && <div className="event-detail"><span className="event-accent" style={{ background: SOURCE_META[selectedEvent.source].color }} /><div><p>SELECTED EVENT · TURN {selectedEvent.turn}</p><strong>{selectedEvent.label}</strong><span>{selectedEvent.detail}</span></div><div className="event-stats"><span>{formatTokens(selectedEvent.tokens)} input</span><span>{formatTokens(selectedEvent.tokens * selectedEvent.retained)} retained</span><span>{selectedEvent.status}</span></div></div>}
          </section>
        </div>
      </div>

      {importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setImportOpen(false)}>
        <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="modal-close" onClick={() => setImportOpen(false)} aria-label="Close">×</button>
          <p className="eyebrow">NEW ANALYSIS</p><h2 id="import-title">Load an agent session</h2>
          <p className="modal-copy">Import a JSON or JSONL trace from Codex, Claude Code, or another agent tool. Your file is analyzed locally in this browser.</p>
          <div className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => fileInput.current?.click()}>
            <span className="upload-mark">↑</span><strong>Drop a session export here</strong><span>or click to choose .json, .jsonl, or .txt</span>
            <input ref={fileInput} type="file" accept=".json,.jsonl,.txt,application/json" onChange={(event: ChangeEvent<HTMLInputElement>) => void loadFile(event.target.files?.[0])} />
          </div>
          <div className="divider"><span>OR PASTE RAW TRACE</span></div>
          <textarea value={pasteValue} onChange={(event) => setPasteValue(event.target.value)} placeholder={'{"name":"my-session","events":[{"type":"tool_call","name":"read_file","tokens":1240}]}'}/>
          {error && <p className="error-message">{error}</p>}
          <div className="modal-actions"><button className="text-button" onClick={() => { setSession(SAMPLE_SESSION); setImportOpen(false); }}>Explore sample</button><button className="primary-button" disabled={!pasteValue.trim()} onClick={() => applyImport(pasteValue)}>Analyze trace →</button></div>
        </section>
      </div>}
    </main>
  );
}
