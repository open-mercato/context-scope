import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/**
 * Measured content width of a container via a callback ref + ResizeObserver.
 * Starts at 0 ("not measured yet") so charts render nothing until the real
 * width is known instead of painting a 900 px SVG on a phone. Uses a
 * functional update so restoring a previous width never gets skipped.
 */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}
