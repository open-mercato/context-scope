import { useState } from "preact/hooks";
import type { Block, Category, Request } from "@ir/types.ts";
import { CATEGORY_META, STACK_ORDER, formatTokens } from "../categories.ts";
import { formatNumber, percent } from "../format.ts";
import { Badge } from "./Badge.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Panel } from "./Panel.tsx";

/** Categories with no transcript blocks behind them: the hidden base the reconciliation splits out. */
const HIDDEN_NOTE: Partial<Record<Category, string>> = {
  system: "The system prompt and tool schemas the vendor sends with every request. They are not in the transcript, so there are no blocks to split; the size is the hidden base of the first request, capped at the vendor baseline.",
  instructions: "The instruction chain (CLAUDE.md / AGENTS.md / rules) estimated from disk; the transcript does not record it as blocks.",
  unlogged: "Input the model saw that the transcript does not contain (resumed history, hidden injections). There are no blocks to split.",
};
const MAX_GROUPS = 10;

interface Part { key: string; label: string; tokens: number; share: number; count: number }

/** Blocks still in the window at request `at`. */
function presentAt(blocks: Block[], at: number) {
  return blocks.filter((block) => block.firstRequest <= at && (block.lastRequest === undefined || block.lastRequest >= at));
}

/**
 * One category of the last request split into its sources: tools by tool name
 * (or by target when a single tool fills it, e.g. File reads → files), other
 * categories by attachment type or label. Block sizes are local estimates, scaled
 * so the parts sum to the category's reconciled tokens.
 */
function breakdown(blocks: Block[], at: number, category: Category, categoryTokens: number): Part[] {
  const present = presentAt(blocks, at).filter((block) => block.category === category && block.estTokens > 0);
  if (!present.length) return [];
  const isTool = category === "tool_call" || category.startsWith("tool_result.");
  const byTool = (block: Block) => block.tool?.name ?? block.label ?? "unknown";
  const byTarget = (block: Block) => block.label ?? block.tool?.target ?? block.tool?.name ?? "unknown";
  const byType = (block: Block) => block.attachmentType ?? block.label ?? CATEGORY_META[category].short;
  let keyOf = isTool ? byTool : category === "attachments" ? byType : byTarget;
  if (isTool && new Set(present.map(byTool)).size === 1) keyOf = byTarget;
  const groups = new Map<string, { tokens: number; count: number }>();
  for (const block of present) {
    const key = keyOf(block);
    const group = groups.get(key) ?? { tokens: 0, count: 0 };
    group.tokens += block.estTokens;
    group.count += 1;
    groups.set(key, group);
  }
  const estTotal = [...groups.values()].reduce((sum, group) => sum + group.tokens, 0);
  const scale = estTotal > 0 && categoryTokens > 0 ? categoryTokens / estTotal : 1;
  const sorted = [...groups.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  const parts: Part[] = sorted.slice(0, MAX_GROUPS).map(([key, group]) => ({ key, label: key, tokens: Math.round(group.tokens * scale), share: group.tokens / estTotal, count: group.count }));
  const rest = sorted.slice(MAX_GROUPS);
  if (rest.length) {
    const tokens = rest.reduce((sum, [, group]) => sum + group.tokens, 0);
    parts.push({ key: "__rest", label: `${rest.length} more`, tokens: Math.round(tokens * scale), share: tokens / estTotal, count: rest.reduce((sum, [, group]) => sum + group.count, 0) });
  }
  return parts;
}

/** Steps of one hue: the category colour mixed toward the surface, darkest first. */
function shade(color: string, index: number, count: number) {
  const strength = count <= 1 ? 100 : Math.round(100 - (index / (count - 1)) * 62);
  return `color-mix(in srgb, ${color} ${strength}%, var(--surface))`;
}

/**
 * Session screen: the scope's last request as one 100 % bar split by category
 * (stack order, same colours as the occupancy chart), with a legend that
 * doubles as the table. Clicking a category opens a second 100 % bar below
 * with what that category is made of.
 */
export function EndMixBar({ last, blocks, scopeName, reliable }: { last?: Request; blocks: Block[]; scopeName: string; reliable: boolean }) {
  const [selected, setSelected] = useState<Category | null>(null);
  const [activePart, setActivePart] = useState<string | null>(null);
  const title = "Context at session end";
  const composition = last?.composition ?? {};
  const total = Object.values(composition).reduce((sum, value) => sum + (value ?? 0), 0);
  if (!last || !(total > 0)) {
    return <Panel title={title}><EmptyState compact title="No composition for the last request" body="This scope has no request with a reconciled composition." /></Panel>;
  }
  const parts = STACK_ORDER
    .filter((category) => (composition[category] ?? 0) > 0)
    .map((category) => ({ category, tokens: composition[category] ?? 0, share: (composition[category] ?? 0) / total }));
  const open = selected && parts.some((part) => part.category === selected) ? selected : null;
  const toggle = (category: Category) => { setSelected(open === category ? null : category); setActivePart(null); };

  return (
    <Panel
      title={title}
      description={`How the ${formatTokens(total)} tokens of the last request (#${last.index}) in ${scopeName} split by category: the state the context was left in. Click a category to see what it is made of.`}
      class="end-mix-panel"
      actions={<>{reliable ? null : <span class="cs-badge-warn" title="The estimator error for this scope is high; treat the split as approximate">approximate</span>}<Badge provenance="estimated.local" /></>}
    >
      <MixStack parts={parts} total={total} selected={open} onSelect={toggle} />
      {open ? <Breakdown category={open} tokens={composition[open] ?? 0} parts={breakdown(blocks, last.index, open, composition[open] ?? 0)} activePart={activePart} setActivePart={setActivePart} onClose={() => setSelected(null)} /> : null}
    </Panel>
  );
}

export interface MixPart {
  category: Category; tokens: number; share: number; sessions?: number;
  /** Overrides for a folded pseudo-part ("4 smaller"): legend text, swatch colour, hover text. */
  label?: string; color?: string; title?: string;
}
const partShort = (part: MixPart) => part.label ?? CATEGORY_META[part.category].short;
const partLabel = (part: MixPart) => part.title ?? CATEGORY_META[part.category].label;
const partColor = (part: MixPart) => part.color ?? CATEGORY_META[part.category].color;

/**
 * One 100 % bar split by category (stack order, occupancy-chart colours) with a
 * legend that doubles as the table. With `onSelect` segments and legend rows are
 * buttons (the session screen opens a split); without it they only highlight.
 */
export function MixStack({ parts, total, selected = null, onSelect, note, detailOf, compact = false }: { parts: MixPart[]; total: number; selected?: Category | null; onSelect?: (category: Category) => void; note?: string; detailOf?: (part: MixPart) => string; compact?: boolean }) {
  const [active, setActive] = useState<Category | null>(null);
  const legend = [...parts].sort((a, b) => b.share - a.share);
  const focus = parts.find((part) => part.category === active);
  const open = selected;
  const dimmed = (category: Category) => (active ? active !== category : open ? open !== category : false);
  const toggle = (category: Category) => onSelect?.(category);
  const hint = onSelect ? " (click to split)" : "";
  const Seg = onSelect ? "button" : "span";
  const Row = onSelect ? "button" : "span";
  return (
    <>
      <div class="end-mix-bar" role="group" aria-label={`Last request split: ${legend.map((part) => `${partShort(part)} ${percent(part.share, 1)}`).join(", ")}`} onMouseLeave={() => setActive(null)}>
        {parts.map((part) => (
          <Seg
            type={onSelect ? "button" : undefined}
            key={part.category}
            class={`end-mix-seg${part.category === "unlogged" ? " cs-swatch-hatch" : ""}${dimmed(part.category) ? " dim" : ""}${open === part.category ? " on" : ""}`}
            style={{ flexGrow: part.share, background: partColor(part) }}
            onMouseEnter={() => setActive(part.category)}
            onClick={onSelect ? () => toggle(part.category) : undefined}
            aria-pressed={onSelect ? open === part.category : undefined}
            aria-label={`${partShort(part)} ${percent(part.share, 1)}`}
            title={`${partLabel(part)}: ${percent(part.share, 1)} · ${formatNumber(part.tokens)} tokens${hint}`}
          />
        ))}
      </div>
      <ul class={`end-mix-legend${compact ? " end-mix-legend-compact" : ""}`} onMouseLeave={() => setActive(null)}>
        {legend.map((part) => (
          <li key={part.label ?? part.category}>
            <Row type={onSelect ? "button" : undefined} tabIndex={0} class={`end-mix-row${dimmed(part.category) ? " dim" : ""}${open === part.category ? " on" : ""}`} aria-pressed={onSelect ? open === part.category : undefined} onMouseEnter={() => setActive(part.category)} onFocus={() => setActive(part.category)} onBlur={() => setActive(null)} onClick={onSelect ? () => toggle(part.category) : undefined} title={`${partLabel(part)}${hint}`}>
              <span class={`cs-swatch${part.category === "unlogged" ? " cs-swatch-hatch" : ""}`} style={{ background: partColor(part) }} />
              <span class="end-mix-name">{partShort(part)}</span>
              <strong>{percent(part.share, 1)}</strong>
              <span class="muted">{formatTokens(part.tokens)}</span>
            </Row>
          </li>
        ))}
      </ul>
      <p class="end-mix-detail muted" aria-live="polite">
        {focus ? <>{partLabel(focus)} · <strong>{percent(focus.share, 1)}</strong> · {formatNumber(focus.tokens)} tokens{detailOf ? ` · ${detailOf(focus)}` : ""}</> : <>{note ?? `Estimated per block, reconciled to the vendor's exact total of ${formatNumber(total)} tokens.`}</>}
      </p>
    </>
  );
}

function Breakdown({ category, tokens, parts, activePart, setActivePart, onClose }: { category: Category; tokens: number; parts: Part[]; activePart: string | null; setActivePart: (key: string | null) => void; onClose: () => void }) {
  const meta = CATEGORY_META[category];
  const focus = parts.find((part) => part.key === activePart);
  return (
    <div class="end-mix-split" role="region" aria-label={`${meta.short} split`}>
      <div class="end-mix-split-head">
        <span class="cs-swatch" style={{ background: meta.color }} />
        <strong>{meta.short}</strong>
        <span class="muted">{formatTokens(tokens)} · {parts.length ? `${parts.length} source${parts.length === 1 ? "" : "s"}` : "no blocks"}</span>
        <button type="button" class="cs-link end-mix-close" onClick={onClose}>close</button>
      </div>
      {parts.length ? (
        <>
          <div class="end-mix-bar end-mix-bar-sub" onMouseLeave={() => setActivePart(null)}>
            {parts.map((part, index) => (
              <span
                key={part.key}
                class={`end-mix-seg${activePart && activePart !== part.key ? " dim" : ""}`}
                style={{ flexGrow: part.share, background: part.key === "__rest" ? "var(--faint)" : shade(meta.color, index, parts.length) }}
                onMouseEnter={() => setActivePart(part.key)}
                title={`${part.label}: ${percent(part.share, 1)} · ~${formatNumber(part.tokens)} tokens · ${part.count} block${part.count === 1 ? "" : "s"}`}
              />
            ))}
          </div>
          <ol class="end-mix-legend end-mix-legend-sub" onMouseLeave={() => setActivePart(null)}>
            {parts.map((part, index) => (
              <li key={part.key} class={activePart && activePart !== part.key ? "dim" : ""} tabIndex={0} onMouseEnter={() => setActivePart(part.key)} onFocus={() => setActivePart(part.key)} onBlur={() => setActivePart(null)} title={part.label}>
                <span class="cs-swatch" style={{ background: part.key === "__rest" ? "var(--faint)" : shade(meta.color, index, parts.length) }} />
                <span class="end-mix-name">{part.label}</span>
                <strong>{percent(part.share, 1)}</strong>
                <span class="muted">{formatTokens(part.tokens)}</span>
              </li>
            ))}
          </ol>
          <p class="end-mix-detail muted" aria-live="polite">
            {focus ? <>{focus.label} · <strong>{percent(focus.share, 1)}</strong> of {meta.short} · ~{formatNumber(focus.tokens)} tokens · {focus.count} block{focus.count === 1 ? "" : "s"}</> : <>Blocks still in the window at the last request, grouped by source; sizes are local estimates scaled to the category total.</>}
          </p>
        </>
      ) : (
        <p class="end-mix-detail muted">{HIDDEN_NOTE[category] ?? "No blocks of this category are still in the window at the last request."}</p>
      )}
    </div>
  );
}
