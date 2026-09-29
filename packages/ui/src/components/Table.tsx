import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { navigate } from "../router.ts";
import { modalOpen } from "../store.ts";

export interface Column<T> {
  key: string;
  label: ComponentChildren;
  render?: (row: T) => ComponentChildren;
  /** Value used for sorting; when omitted the column is not sortable. */
  sortValue?: (row: T) => number | string | undefined;
  align?: "left" | "right" | "center";
  width?: string;
  /** Tabular numerals. */
  numeric?: boolean;
  title?: string;
  class?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Enter or click opens the row. Falls back to navigating rowHref. */
  onOpen?: (row: T) => void;
  rowHref?: (row: T) => string | undefined;
  /** Child rows nested under a parent (rendered as an expandable group). */
  childRows?: (row: T) => T[] | undefined;
  defaultExpanded?: boolean;
  empty?: ComponentChildren;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** Accessible label for the table region. */
  label: string;
  rowClass?: (row: T) => string | undefined;
  /** Constrain height so the header sticks inside the scroll area. */
  maxHeight?: string;
  dense?: boolean;
}

interface FlatRow<T> { row: T; depth: number; hasChildren: boolean; expanded: boolean; key: string }

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function compare(a: number | string | undefined, b: number | string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Generic sortable table: sticky header, keyboard row focus, Enter opens,
 * Right/Left expand or collapse nested groups. Scrolls horizontally inside its
 * own wrapper. `j`/`k` reach the first table on a screen even when nothing is
 * focused; arrows, Home/End, Space and Enter only act while the table (or a
 * descendant) has focus, so the page keeps scrolling with the keyboard.
 */
export function Table<T>(props: TableProps<T>) {
  const { columns, rows, rowKey, onOpen, rowHref, childRows, empty, label, rowClass, maxHeight, dense } = props;
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(props.defaultSort ?? null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(props.defaultExpanded ? rows.filter((r) => childRows?.(r)?.length).map(rowKey) : []));
  const wrapRef = useRef<HTMLDivElement>(null);
  const seenKeys = useRef<Set<string>>(new Set(rows.map(rowKey)));

  // New parents arriving after a refresh honour defaultExpanded; removed rows drop out of the set.
  useEffect(() => {
    const current = new Set(rows.map(rowKey));
    setExpanded((prev) => {
      const next = new Set([...prev].filter((k) => current.has(k)));
      if (props.defaultExpanded) for (const r of rows) { const k = rowKey(r); if (!seenKeys.current.has(k) && childRows?.(r)?.length) next.add(k); }
      seenKeys.current = current;
      return next;
    });
  }, [rows]);

  const comparator = useMemo(() => {
    if (!sort) return null;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return null;
    const getter = column.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return (list: T[]) => {
      const tagged = list.map((row, i) => ({ row, i, v: getter(row) }));
      tagged.sort((a, b) => { const c = compare(a.v, b.v); return (c === 0 ? a.i - b.i : c * dir); });
      return tagged.map((x) => x.row);
    };
  }, [sort, columns]);

  const flat = useMemo<FlatRow<T>[]>(() => {
    const out: FlatRow<T>[] = [];
    for (const row of comparator ? comparator(rows) : rows) {
      const kids = childRows?.(row) ?? [];
      const key = rowKey(row);
      const isOpen = expanded.has(key);
      out.push({ row, depth: 0, hasChildren: kids.length > 0, expanded: isOpen, key });
      if (isOpen) for (const kid of comparator ? comparator(kids) : kids) out.push({ row: kid, depth: 1, hasChildren: false, expanded: false, key: rowKey(kid) });
    }
    return out;
  }, [rows, comparator, expanded, childRows, rowKey]);

  const focusedIndex = focusedKey === null ? -1 : flat.findIndex((f) => f.key === focusedKey);
  const flatRef = useRef(flat);
  flatRef.current = flat;
  const focusedRef = useRef(focusedIndex);
  focusedRef.current = focusedIndex;

  const open = (entry: FlatRow<T>) => {
    if (onOpen) return onOpen(entry.row);
    const href = rowHref?.(entry.row);
    if (href) navigate(href);
  };
  const toggle = (key: string, force?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = force ?? !next.has(key);
      if (want) next.add(key); else next.delete(key);
      return next;
    });
  };

  const focusRow = (index: number) => {
    const list = flatRef.current;
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, index));
    setFocusedKey(list[next].key);
    wrapRef.current?.focus({ preventScroll: true });
    wrapRef.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const move = (delta: number) => {
    const current = focusedRef.current;
    focusRow(current < 0 ? (delta > 0 ? 0 : flatRef.current.length - 1) : current + delta);
  };

  const handlers = useRef({ move, focusRow, open, toggle });
  handlers.current = { move, focusRow, open, toggle };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target) || modalOpen()) return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const active = document.activeElement;
      const activeTable = active?.closest?.("[data-kbd-table]") ?? null;
      const hasFocus = activeTable === wrap;
      if (activeTable && !hasFocus) return;
      if (!hasFocus) {
        // Nothing focused: only j/k, and only for the first table on the screen.
        if (event.key !== "j" && event.key !== "k") return;
        if (document.querySelector("[data-kbd-table]") !== wrap) return;
      }
      const h = handlers.current;
      const current = flatRef.current[focusedRef.current];
      switch (event.key) {
        case "j": case "ArrowDown": event.preventDefault(); h.move(1); break;
        case "k": case "ArrowUp": event.preventDefault(); h.move(-1); break;
        case "Enter": if (current) { event.preventDefault(); h.open(current); } break;
        case "ArrowRight": if (current?.hasChildren && !current.expanded) { event.preventDefault(); h.toggle(current.key, true); } break;
        case "ArrowLeft": if (current?.hasChildren && current.expanded) { event.preventDefault(); h.toggle(current.key, false); } break;
        case " ": if (current?.hasChildren) { event.preventDefault(); h.toggle(current.key); } break;
        case "Home": event.preventDefault(); h.focusRow(0); break;
        case "End": event.preventDefault(); h.focusRow(flatRef.current.length - 1); break;
        default: return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sortHandler = (column: Column<T>) => {
    if (!column.sortValue) return;
    setSort((prev) => {
      if (prev?.key === column.key) return prev.dir === "asc" ? { key: column.key, dir: "desc" } : null;
      return { key: column.key, dir: column.numeric ? "desc" : "asc" };
    });
  };

  const idBase = `row-${label.replace(/\W+/g, "-")}`;
  const activeId = focusedIndex >= 0 ? `${idBase}-${focusedIndex}` : undefined;

  return (
    <div
      ref={wrapRef}
      class={`table-wrap ${dense ? "table-dense" : ""}`}
      data-kbd-table
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-activedescendant={activeId}
      aria-rowcount={flat.length}
      style={maxHeight ? { maxHeight } : undefined}
      onFocus={() => { if (focusedRef.current < 0 && flatRef.current.length) setFocusedKey(flatRef.current[0].key); }}
    >
      <table class="table">
        <thead>
          <tr role="row">
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const ariaSort = active && sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th key={column.key} scope="col" role="columnheader" style={column.width ? { width: column.width } : undefined} class={`${column.align ? `al-${column.align}` : ""} ${column.numeric ? "num" : ""} ${column.class ?? ""}`} aria-sort={ariaSort} title={column.title}>
                  {column.sortValue ? (
                    <button type="button" class={`th-sort ${active ? "active" : ""}`} onClick={() => sortHandler(column)}>
                      <span>{column.label}</span>
                      <span class="sort-ind" aria-hidden="true">{active && sort ? (sort.dir === "asc" ? "▴" : "▾") : "▾"}</span>
                    </button>
                  ) : column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {flat.length === 0 ? (
            <tr role="row"><td role="gridcell" colSpan={columns.length} class="table-empty">{empty ?? "Nothing to show."}</td></tr>
          ) : flat.map((entry, index) => (
            <tr
              key={entry.key}
              role="row"
              id={focusedIndex === index ? activeId : undefined}
              data-row-index={index}
              aria-selected={focusedIndex === index ? "true" : undefined}
              aria-level={entry.depth + 1}
              aria-expanded={entry.hasChildren ? entry.expanded : undefined}
              class={`row ${focusedIndex === index ? "row-focused" : ""} ${entry.depth ? "row-child" : ""} ${entry.hasChildren ? "row-parent" : ""} ${rowClass?.(entry.row) ?? ""}`}
              onClick={(e) => {
                setFocusedKey(entry.key);
                const target = e.target as HTMLElement;
                if (target.closest("a, button, input")) return;
                if (window.getSelection()?.toString()) return;
                open(entry);
              }}
            >
              {columns.map((column, ci) => (
                <td key={column.key} role="gridcell" class={`${column.align ? `al-${column.align}` : ""} ${column.numeric ? "num" : ""} ${column.class ?? ""}`}>
                  {ci === 0 ? (
                    <span class="cell-tree" style={{ paddingLeft: `${entry.depth * 18}px` }}>
                      {entry.hasChildren ? (
                        <button type="button" class="expander" aria-expanded={entry.expanded} aria-label={entry.expanded ? "Collapse child runs" : "Expand child runs"} onClick={(e) => { e.stopPropagation(); toggle(entry.key); }}>
                          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={entry.expanded ? "M1 3l4 4 4-4" : "M3 1l4 4-4 4"} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
                        </button>
                      ) : entry.depth ? <span class="tree-line" aria-hidden="true" /> : null}
                      {column.render ? column.render(entry.row) : String((entry.row as Record<string, unknown>)[column.key] ?? "")}
                    </span>
                  ) : column.render ? column.render(entry.row) : String((entry.row as Record<string, unknown>)[column.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
