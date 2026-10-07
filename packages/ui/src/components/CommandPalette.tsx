/**
 * Command palette (⌘K / Ctrl+K): jump to a session, a screen or an action
 * without leaving the keyboard. Sessions come from one `overview` call for the
 * whole machine (cached per index version); screens and actions are static.
 * The list is filtered by every word of the query and ranked by where the
 * match sits (label start, label, then subtitle / keywords).
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Overview, OverviewRun } from "@ir/types.ts";
import { api, backend } from "../api.ts";
import { useFocusTrap } from "../hooks.ts";
import { hrefs, navigate, splitRunId } from "../router.ts";
import { formatDate, formatRelative, formatTokens, percent } from "../format.ts";
import { indexVersion, keyboardMapOpen, liveIdle, liveRuns, paletteOpen, refreshIndex, toggleTheme } from "../store.ts";
import { STALE_MS } from "./LiveBadge.tsx";

type Group = "Sessions" | "Screens" | "Actions";
interface Item { id: string; group: Group; label: string; sub?: string; hint?: string; keywords?: string; live?: boolean; vendor?: string; run: () => void }

type RunNode = OverviewRun & { children?: RunNode[]; parentRunId?: string; agentType?: string; gitBranch?: string };

const RECENT_WHEN_EMPTY = 12;
const MAX_SESSIONS = 40;

let cache: { version: number; rows: RunNode[] } | null = null;

function flatten(runs: RunNode[]): RunNode[] {
  const out: RunNode[] = [];
  for (const run of runs) { out.push(run); if (run.children) out.push(...flatten(run.children)); }
  return out;
}

async function loadSessions(version: number, signal: AbortSignal): Promise<RunNode[]> {
  if (cache && cache.version === version) return cache.rows;
  const overview: Overview = await api.overview({ scope: "all", limit: 200 }, signal);
  const rows = flatten(overview.runs as RunNode[]).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  cache = { version, rows };
  return rows;
}

function sessionItem(run: RunNode, now: number, live: boolean): Item {
  const { vendor, id } = splitRunId(run.id);
  const title = run.parentRunId ? `${run.agentType ?? "subagent"} · child of ${id.slice(0, 8)}` : run.project.displayName;
  const sub = `${formatDate(run.startedAt)} · ${formatRelative(run.startedAt, now)} · ${formatTokens(run.summary.peak.value)} peak (${percent(run.summary.peakShareOfWindow)})${run.summary.compactions ? ` · ${run.summary.compactions} compactions` : ""}`;
  return {
    id: run.id, group: "Sessions", label: title, sub, vendor: run.vendor, live,
    keywords: `${run.vendor} ${run.summary.models.join(" ")} ${run.gitBranch ?? ""} ${id}`,
    run: () => navigate(hrefs.session(vendor, id)),
  };
}

function staticItems(): Item[] {
  const mode = backend.value.mode;
  const screens: Item[] = [
    { id: "s:overview", group: "Screens", label: "Overview", sub: "Sessions of this repository, trends, offenders", hint: "g o", keywords: "home dashboard", run: () => navigate(hrefs.overview()) },
    { id: "s:setup", group: "Screens", label: "Setup", sub: "Context bill of materials: instruction files, skills, agents, hooks, MCP", hint: "g s", keywords: "claude.md agents.md budget", run: () => navigate(hrefs.setup()) },
    { id: "s:findings", group: "Screens", label: "Findings", sub: "Every rule that fired, one card per rule", hint: "g f", keywords: "rules fixes", run: () => navigate(hrefs.findings()) },
    { id: "s:tokens", group: "Screens", label: "Count tokens", sub: "Paste text or add files; counted locally", keywords: "tokenizer estimate", run: () => navigate(hrefs.tokens()) },
    { id: "s:open", group: "Screens", label: "Open an export", sub: "Load a contextscope.export/1 file in this browser", keywords: "import json drop", run: () => navigate(hrefs.open()) },
    { id: "s:all", group: "Screens", label: "Overview · all projects", sub: "Every indexed session on this machine", keywords: "machine", run: () => navigate("#/?scope=all") },
  ];
  const actions: Item[] = [
    { id: "a:refresh", group: "Actions", label: mode === "companion" ? "Re-scan session files" : "Reload data", sub: mode === "companion" ? "Index new or changed transcripts now" : undefined, keywords: "refresh index", run: () => { void refreshIndex(); } },
    { id: "a:theme", group: "Actions", label: "Toggle theme", sub: "Light / dark", hint: "t", keywords: "dark light mode", run: toggleTheme },
    { id: "a:keys", group: "Actions", label: "Keyboard map", sub: "Every shortcut on one page", hint: "?", keywords: "shortcuts help", run: () => { keyboardMapOpen.value = true; } },
  ];
  return [...screens, ...actions];
}

function score(item: Item, words: string[]): number {
  if (!words.length) return 1;
  const label = item.label.toLowerCase();
  const rest = `${item.sub ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
  let total = 0;
  for (const w of words) {
    if (label.startsWith(w)) total += 3;
    else if (label.includes(w)) total += 2;
    else if (rest.includes(w)) total += 1;
    else return 0;
  }
  return total;
}

export function CommandPalette() {
  const open = paletteOpen.value;
  if (!open) return null;
  return <PaletteDialog />;
}

function PaletteDialog() {
  const version = indexVersion.value;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sessions, setSessions] = useState<RunNode[] | null>(cache?.version === version ? cache.rows : null);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useFocusTrap(dialogRef, true, inputRef);

  useEffect(() => {
    const controller = new AbortController();
    loadSessions(version, controller.signal).then((rows) => { if (!controller.signal.aborted) setSessions(rows); }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [version]);

  const now = Date.now();
  const live = liveRuns.value;
  const idle = liveIdle.value;
  const items = useMemo<Item[]>(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const isLive = (run: RunNode) => {
      if (idle.has(run.id)) return false;
      const at = live.get(run.id)?.at ?? run.live?.at;
      return !!at && now - Date.parse(at) <= STALE_MS;
    };
    const sessionItems = (sessions ?? []).map((run) => sessionItem(run, now, isLive(run)));
    // Live sessions first, then by start time (the rows are already newest first).
    sessionItems.sort((a, b) => Number(b.live) - Number(a.live));
    const all = [...sessionItems, ...staticItems()];
    if (!words.length) {
      const recent = sessionItems.slice(0, RECENT_WHEN_EMPTY);
      return [...recent, ...all.filter((i) => i.group !== "Sessions")];
    }
    return all
      .map((item) => ({ item, s: score(item, words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.item)
      .filter((item, i, list) => item.group !== "Sessions" || list.slice(0, i).filter((x) => x.group === "Sessions").length < MAX_SESSIONS);
  }, [query, sessions, live, idle, now]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const close = () => { paletteOpen.value = false; };
  const run = (item: Item) => { close(); item.run(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const item = items[cursor]; if (item) run(item); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  let lastGroup: Group | null = null;
  return (
    <div class="dialog-backdrop palette-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }} onWheel={(e) => { if (!listRef.current?.contains(e.target as globalThis.Node)) e.preventDefault(); }}>
      <div ref={dialogRef} class="palette" role="dialog" aria-modal="true" aria-label="Jump to" onKeyDown={onKey}>
        <div class="palette-head">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          <input ref={inputRef} class="palette-input" type="text" placeholder="Jump to a session, screen or action…" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} aria-label="Search sessions, screens and actions" aria-controls="palette-list" aria-activedescendant={items[cursor] ? `palette-${cursor}` : undefined} role="combobox" aria-expanded="true" autocomplete="off" spellcheck={false} />
          <kbd class="palette-esc">esc</kbd>
        </div>
        <ul ref={listRef} id="palette-list" class="palette-list" role="listbox">
          {items.length === 0 ? <li class="palette-empty">{failed && !sessions ? "Sessions could not be loaded; screens and actions still match." : `Nothing matches “${query.trim()}”.`}</li> : null}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? <li class="palette-group" role="presentation" key={`g-${item.group}`}>{item.group === "Sessions" && !query.trim() ? "Recent sessions" : item.group}</li> : null;
            lastGroup = item.group;
            return (
              <>
                {header}
                <li key={item.id} id={`palette-${i}`} data-index={i} role="option" aria-selected={i === cursor} class={`palette-item${i === cursor ? " on" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => run(item)}>
                  {item.vendor ? <span class={`vendor vendor-${item.vendor}`}>{item.vendor}</span> : null}
                  <span class="palette-main">
                    <span class="palette-label">{item.live ? <span class="live-dot" aria-label="live" /> : null}{item.label}</span>
                    {item.sub ? <span class="palette-sub">{item.sub}</span> : null}
                  </span>
                  {item.hint ? <kbd class="palette-hint">{item.hint}</kbd> : null}
                </li>
              </>
            );
          })}
          {sessions === null && !failed ? <li class="palette-empty">Loading sessions…</li> : null}
        </ul>
        <footer class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close</footer>
      </div>
    </div>
  );
}
