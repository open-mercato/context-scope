import { toasts } from "../store.ts";

/** Stack of transient messages, bottom-right. Announced via aria-live. */
export function Toasts() {
  const items = toasts.value;
  return (
    <div class="toasts" role="status" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div key={item.id} class={`toast toast-${item.tone}`}>{item.message}</div>
      ))}
    </div>
  );
}
