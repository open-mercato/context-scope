/**
 * "What cost the most" (ADR-005 section 5): the per-tool cost table of the
 * scope on screen. Rows come from `scope.toolCost` (computed by the CLI in
 * `ir/finalize.mjs`); a scope indexed before the field existed is attributed
 * here from its blocks and requests with the same formula. Every row shows
 * token-requests next to its uncached companion and the cache-read share,
 * because presence is not attention and a cached token costs roughly a tenth
 * of a fresh one on Claude.
 */
import { useMemo, useState } from "preact/hooks";
import type { AgentScope, Block, Request, ToolCostRow } from "@ir/types.ts";
import { COST_CAVEATS } from "../api.ts";
import { formatTokens } from "../categories.ts";
import { formatInt, formatPercent } from "../charts/scale.ts";
import { Badge } from "./Badge.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Panel } from "./Panel.tsx";

export const COST_UNIT = "token-requests";
export const COST_TOP = 8;
export const COST_HANDOFFS = "Agent handoffs";
export const COST_OTHER = "other";
export { COST_CAVEATS };

type Key = "name" | "kind" | "blocks" | "tokenRequests" | "uncached" | "cacheRead" | "share";
interface Sort { key: Key; dir: "asc" | "desc" }

/** Cache-read share of a row: 1 − uncached / token-requests. */
export function cacheReadShare(row: ToolCostRow): number {
  if (!(row.tokenRequests > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - row.uncached / row.tokenRequests));
}

/** Browser-side port of `toolCostGroups` + `rankToolCost` for scopes that carry no `toolCost`. */
export function toolCostRows(scope: AgentScope, top = COST_TOP): ToolCostRow[] {
  const requests: Request[] = scope.requests ?? [];
  const n = requests.length;
  if (!n) return [];
  const K = new Float64Array(n + 1);
  const U = new Float64Array(n + 1);
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const usage = requests[i].usage;
    const k = Number.isFinite(requests[i].scale) ? requests[i].scale : 1;
    const total = usage?.total ?? 0;
    const uncached = total > 0 ? Math.max(0, Math.min(1, 1 - (usage.cacheRead ?? 0) / total)) : 1;
    K[i + 1] = K[i] + k;
    U[i + 1] = U[i] + k * uncached;
    denominator += total;
  }
  const groups = new Map<string, ToolCostRow>();
  for (const block of (scope.blocks ?? []) as Block[]) {
    if (block.category === "assistant_thinking") continue;
    const first = block.firstRequest;
    if (!Number.isInteger(first) || first < 0 || first >= n) continue;
    const last = block.lastRequest === undefined ? n - 1 : Math.min(block.lastRequest, n - 1);
    if (last < first) continue;
    let key: { name: string; kind: ToolCostRow["kind"]; server?: string } | null = null;
    if (block.category === "subagent_handoff") key = { name: COST_HANDOFFS, kind: "agent" };
    else if (block.category === "attachments") key = { name: block.attachmentType || "attachment", kind: "attachment" };
    else if (block.category === "tool_call" || block.category.startsWith("tool_result.")) key = { name: block.tool?.name || COST_OTHER, kind: block.tool?.kind ?? "other", ...(block.tool?.server ? { server: block.tool.server } : {}) };
    if (!key) continue;
    let row = groups.get(key.name);
    if (!row) { row = { ...key, blocks: 0, tokenRequests: 0, uncached: 0, share: 0 }; groups.set(key.name, row); }
    row.blocks += 1;
    row.tokenRequests += block.estTokens * (K[last + 1] - K[first]);
    row.uncached += block.estTokens * (U[last + 1] - U[first]);
  }
  const rows = [...groups.values()].sort((a, b) => b.tokenRequests - a.tokenRequests || a.name.localeCompare(b.name));
  const named = rows.filter((r) => r.name !== COST_OTHER);
  const head = named.slice(0, top);
  const tail = [...named.slice(top), ...rows.filter((r) => r.name === COST_OTHER)];
  const finish = (r: ToolCostRow): ToolCostRow => ({ ...r, tokenRequests: Math.round(r.tokenRequests), uncached: Math.round(r.uncached), share: denominator > 0 ? Math.min(1, Number((r.tokenRequests / denominator).toFixed(4))) : 0 });
  const out = head.map(finish);
  if (tail.length) out.push(finish({ name: COST_OTHER, kind: "other", blocks: tail.reduce((s, r) => s + r.blocks, 0), tokenRequests: tail.reduce((s, r) => s + r.tokenRequests, 0), uncached: tail.reduce((s, r) => s + r.uncached, 0), share: 0 }));
  return out;
}

const value = (row: ToolCostRow, key: Key): number | string => {
  switch (key) {
    case "name": return row.name;
    case "kind": return row.kind;
    case "blocks": return row.blocks;
    case "tokenRequests": return row.tokenRequests;
    case "uncached": return row.uncached;
    case "cacheRead": return cacheReadShare(row);
    case "share": return row.share;
  }
};

/** `mcp__server__tool` rendered as server / tool; anything else as is. */
function RowName({ row }: { row: ToolCostRow }) {
  if (row.name.startsWith("mcp__")) {
    const rest = row.name.slice(5);
    const at = rest.indexOf("__");
    const server = at < 0 ? rest : rest.slice(0, at);
    const tool = at < 0 ? "" : rest.slice(at + 2);
    return <span class="cs-cost-name" title={row.name}><span class="cs-cost-server">{server} /</span> {tool || "—"}</span>;
  }
  return <span class={`cs-cost-name${row.name === COST_OTHER ? " cs-muted" : ""}`} title={row.name}>{row.name}</span>;
}

export interface CostPanelProps { scope: AgentScope; where?: string }

const COLUMNS: Array<{ key: Key; label: string; numeric?: boolean; title: string }> = [
  { key: "name", label: "Tool", title: "Tool name; MCP tools as server / tool; subagent results as Agent handoffs; attachments by type" },
  { key: "kind", label: "Kind", title: "Tool kind" },
  { key: "blocks", label: "Blocks", numeric: true, title: "Blocks of this tool that entered the window" },
  { key: "tokenRequests", label: "Token-requests", numeric: true, title: "Σ over each block's presence window of estTokens × k (the reconciled scale of that request)" },
  { key: "uncached", label: "Uncached", numeric: true, title: "Token-requests weighted by each request's uncached share (1 − cacheRead ÷ total)" },
  { key: "cacheRead", label: "Cache read", numeric: true, title: "1 − uncached ÷ token-requests: how much of this tool's presence the cache served" },
  { key: "share", label: "Share", numeric: true, title: "Token-requests ÷ the scope's processed input (vendor totals)" },
];

/** The per-tool cost table of one scope, sortable; `estimated.local` throughout. */
export function CostPanel({ scope, where }: CostPanelProps) {
  const derived = !Array.isArray(scope.toolCost);
  const rows = useMemo(() => (Array.isArray(scope.toolCost) ? scope.toolCost : toolCostRows(scope)), [scope]);
  const [sort, setSort] = useState<Sort>({ key: "tokenRequests", dir: "desc" });
  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    return rows.map((row, i) => ({ row, i })).sort((a, b) => {
      const x = value(a.row, sort.key), y = value(b.row, sort.key);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
      return c === 0 ? a.i - b.i : c * dir;
    }).map((e) => e.row);
  }, [rows, sort]);
  const maxShare = rows.reduce((m, r) => Math.max(m, r.share), 0) || 1;
  const total = rows.reduce((s, r) => s + r.share, 0);
  const toggle = (key: Key, numeric?: boolean) => setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: numeric ? "desc" : "asc" }));
  const place = where ?? (scope.kind === "main" ? "the main scope" : scope.agentType ?? scope.id);
  return (
    <Panel title="What cost the most" id="cs-cost"
      description={`Each tool's blocks multiplied by the requests they sat in, over ${place}. Cache reads make presence cheap: the uncached column weights every request by what the cache did not serve.`}
      actions={<><span class="cs-cost-unit">{COST_UNIT}{derived ? " · attributed in the browser" : ""}</span><Badge provenance="estimated.local" /></>}>
      {rows.length === 0 ? (
        <EmptyState compact title="No tool blocks in this scope" body="Token-requests are attributed to tool calls and results, subagent handoffs and attachments; this scope recorded none in the window." />
      ) : (
        <>
          <div class="cs-cost-wrap">
            <table class="cs-table cs-cost-table" aria-label="Per-tool cost">
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const active = sort.key === c.key;
                    return (
                      <th key={c.key} class={c.numeric ? "num" : ""} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} title={c.title}>
                        <button type="button" class={`cs-cost-sort${active ? " active" : ""}`} onClick={() => toggle(c.key, c.numeric)}>
                          <span>{c.label}</span><span class="cs-cost-sort-ind" aria-hidden="true">{active ? (sort.dir === "asc" ? "▴" : "▾") : "▾"}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => {
                  const cached = cacheReadShare(row);
                  return (
                    <tr key={row.name} class={row.name === COST_OTHER ? "cs-cost-other" : ""}>
                      <td><RowName row={row} /></td>
                      <td class="cs-muted">{row.kind}</td>
                      <td class="num">{formatInt(row.blocks)}</td>
                      <td class="num" title={`${formatInt(row.tokenRequests)} ${COST_UNIT}`}>{formatTokens(row.tokenRequests)}</td>
                      <td class="num" title={`${formatInt(row.uncached)} ${COST_UNIT} not served from cache`}>{formatTokens(row.uncached)}</td>
                      <td class="num" title="Share of this tool's presence the cache served"><span class="cs-cost-share"><span class="cs-cost-bar cs-cost-bar-uncached" aria-hidden="true"><span style={{ width: `${Math.round(cached * 100)}%` }} /></span>{formatPercent(cached, 0)}</span></td>
                      <td class="num"><span class="cs-cost-share"><span class="cs-cost-bar" aria-hidden="true"><span style={{ width: `${Math.round((row.share / maxShare) * 100)}%` }} /></span>{formatPercent(row.share, 1)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="cs-note">{formatPercent(total, 0)} of this scope's processed input sits in these rows; the rest is the hidden base, prompts, assistant text and compaction summaries.</p>
          <details class="cs-cost-caveats">
            <summary>What this number is not</summary>
            <ul>{COST_CAVEATS.map((line) => <li key={line}>{line}</li>)}</ul>
          </details>
        </>
      )}
    </Panel>
  );
}
