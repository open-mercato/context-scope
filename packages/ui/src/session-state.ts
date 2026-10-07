/**
 * Coordinated state for the session view: every panel (occupancy chart, cache
 * strip, lanes, ledger, findings) reads and writes these signals so hover,
 * pin, scope, filters and the brush stay in sync without prop drilling.
 *
 * Rule: hover / pin / focus signals are read only in the leaf component that
 * draws them (chart, strip, ledger row, pinned-request panel). The screen body
 * never reads them, so a hover frame re-renders a handful of nodes, not the tree.
 */
import { signal, computed } from "@preact/signals";
import type { Category } from "@ir/types.ts";

/** Request index under the pointer (any aligned panel), or null. */
export const hoveredRequest = signal<number | null>(null);
/** Request index pinned by click / `p`; composition stays in the rail. */
export const pinnedRequest = signal<number | null>(null);
/** Keyboard cursor moved by j/k; falls back to pinned, then hovered. */
export const focusedRequest = signal<number | null>(null);
/** Scope id currently displayed ("main" or an agent id). */
export const selectedScope = signal<string>("main");
/** Categories removed from the stack (the exact total line always stays). */
export const hiddenCategories = signal<ReadonlySet<Category>>(new Set());
/** Inclusive request-index range selected by the brush; null = whole scope. */
export const brushRange = signal<[number, number] | null>(null);
/** Free-text filter for the ledger (model, tool, label, category). */
export const ledgerFilter = signal<string>("");
/** Right rail visibility (kept across sessions; it is a layout preference). */
export const railOpen = signal<boolean>(true);
/** Lane (child scope id) under the pointer. */
export const hoveredLane = signal<string | null>(null);
/** Ledger rows expanded to show their new blocks. */
export const expandedRows = signal<ReadonlySet<number>>(new Set());
/** Total request count of the selected scope, so the keyboard cursor can clamp. */
export const requestCount = signal<number>(0);
/** Lanes panel: show every lane or only the top N by peak. */
export const showAllLanes = signal<boolean>(false);
/** Live mode: keep the cursor on the newest request as the tail grows. Off once the user pins or brushes. */
export const followLive = signal<boolean>(true);

/** The request the panels should highlight: focus, else pin, else hover. */
export const activeRequest = computed<number | null>(() => focusedRequest.value ?? pinnedRequest.value ?? hoveredRequest.value);

/** Reset per-scope interaction state (called when the run or the scope changes). */
export function resetSessionState(scope: string) {
  cancelHover();
  hoveredRequest.value = null;
  pinnedRequest.value = null;
  focusedRequest.value = null;
  brushRange.value = null;
  hoveredLane.value = null;
  expandedRows.value = new Set();
  ledgerFilter.value = "";
  requestCount.value = 0;
  followLive.value = true;
  selectedScope.value = scope;
}

/** Reset per-run state on top of the per-scope reset (hidden categories, lane expansion). */
export function resetRunState(scope: string) {
  resetSessionState(scope);
  hiddenCategories.value = new Set();
  showAllLanes.value = false;
}

export function toggleCategory(category: Category) {
  const next = new Set(hiddenCategories.value);
  if (next.has(category)) next.delete(category); else next.add(category);
  hiddenCategories.value = next;
}

export function toggleExpanded(index: number) {
  const next = new Set(expandedRows.value);
  if (next.has(index)) next.delete(index); else next.add(index);
  expandedRows.value = next;
}

export function pin(index: number | null) {
  pinnedRequest.value = index;
  focusedRequest.value = index;
  if (index !== null) followLive.value = false;
}

/** Brush change from the user: a range stops live following; clearing it does not resume (use `resumeFollow`). */
export function setBrush(range: [number, number] | null) {
  brushRange.value = range;
  if (range) followLive.value = false;
}

/** Back to following the newest request: unpin, clear the brush and the keyboard cursor. */
export function resumeFollow() {
  pinnedRequest.value = null;
  focusedRequest.value = null;
  brushRange.value = null;
  followLive.value = true;
}

/**
 * Hover updates are coalesced to one per animation frame (1,400+ requests).
 * When the document is hidden (rAF suspended) the value is applied directly so
 * the throttle can never wedge; `cancelHover` drops a pending frame on reset.
 */
let hoverFrame = 0;
let hoverNext: number | null = null;
export function setHovered(index: number | null) {
  hoverNext = index;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") { cancelHover(); if (hoveredRequest.peek() !== index) hoveredRequest.value = index; return; }
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    if (hoveredRequest.peek() !== hoverNext) hoveredRequest.value = hoverNext;
  });
}

export function cancelHover() {
  if (hoverFrame) { cancelAnimationFrame(hoverFrame); hoverFrame = 0; }
  hoverNext = null;
}

/** Clamp a request index into the current brush range (or the scope). */
export function clampToRange(index: number): number {
  const range = brushRange.peek();
  const lo = range ? range[0] : 0;
  const hi = range ? range[1] : Math.max(0, requestCount.peek() - 1);
  return Math.min(hi, Math.max(lo, index));
}

// Dev-only: expose the signals for console / automation timing (stripped by minification in production builds).
if (process.env.NODE_ENV !== "production") (window as unknown as { __cs?: unknown }).__cs = { hoveredRequest, pinnedRequest, focusedRequest, brushRange, hoveredLane, setHovered };
