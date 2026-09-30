import type { ComponentChildren } from "preact";

export interface EmptyStateProps {
  title: string;
  /** One or two sentences that teach what would populate this panel. */
  body?: ComponentChildren;
  /** Vendor path that is read (rendered as code). */
  path?: string;
  /** Command that populates it (rendered as code). */
  command?: string;
  compact?: boolean;
  children?: ComponentChildren;
}

/** Empty panel copy: names the vendor path and the command that would fill it (UX principle 5). */
export function EmptyState({ title, body, path, command, compact, children }: EmptyStateProps) {
  return (
    <div class={`empty ${compact ? "empty-compact" : ""}`} role="note">
      <p class="empty-title">{title}</p>
      {body ? <p class="empty-body">{body}</p> : null}
      {(path || command) ? (
        <dl class="empty-meta">
          {path ? <><dt>Reads</dt><dd><code>{path}</code></dd></> : null}
          {command ? <><dt>Populated by</dt><dd><code>{command}</code></dd></> : null}
        </dl>
      ) : null}
      {children}
    </div>
  );
}
