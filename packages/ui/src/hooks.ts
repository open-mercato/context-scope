import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { isAbortError } from "./api.ts";

export interface Resource<T> { data: T | null; error: Error | null; loading: boolean; reload: () => void }

/**
 * Load an async resource once per dependency change. Keeps the previous data
 * while reloading so the screen does not flash to a spinner on refresh. The
 * in-flight request is aborted when the deps change or the screen unmounts.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal).then((result) => {
      if (latest.current !== id) return;
      setData(result);
      setError(null);
      setLoading(false);
    }).catch((err: unknown) => {
      if (latest.current !== id || isAbortError(err)) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    });
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Re-render every `ms` (for relative timestamps). */
export function useTick(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Keyboard-modal dialog: traps Tab inside `ref`, makes the rest of the page
 * inert, focuses the first focusable element (or `initial`) and restores focus
 * to the opener on close.
 */
export function useFocusTrap(ref: { current: HTMLElement | null }, open: boolean, initial?: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    const app = document.getElementById("app");
    app?.setAttribute("inert", "");
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    const target = initial?.current ?? focusables()[0];
    target?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = focusables();
      if (!list.length) { event.preventDefault(); return; }
      const first = list[0], last = list[list.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      app?.removeAttribute("inert");
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, ref, initial]);
}
