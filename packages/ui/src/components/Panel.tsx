import type { ComponentChildren } from "preact";

export interface PanelProps {
  title: ComponentChildren;
  description?: ComponentChildren;
  /** Right-side slot in the header (badges, buttons, totals). */
  actions?: ComponentChildren;
  children?: ComponentChildren;
  id?: string;
  class?: string;
  /** Remove inner padding (for tables that need edge-to-edge scrolling). */
  flush?: boolean;
}

/** Card with a title row, optional description, right-side slot and body. */
export function Panel({ title, description, actions, children, id, class: cls, flush }: PanelProps) {
  return (
    <section class={`panel ${flush ? "panel-flush" : ""} ${cls ?? ""}`} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <header class="panel-head">
        <div class="panel-heading">
          <h2 class="panel-title" id={id ? `${id}-title` : undefined}>{title}</h2>
          {description ? <p class="panel-desc">{description}</p> : null}
        </div>
        {actions ? <div class="panel-actions">{actions}</div> : null}
      </header>
      <div class="panel-body">{children}</div>
    </section>
  );
}
