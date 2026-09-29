import type { ComponentChildren } from "preact";

/**
 * HTML tooltip positioned inside a `position: relative` chart container.
 * Flips to the left of the anchor when it would overflow the container.
 * Not announced: the chart carries an aria-label and hover is pointer-only.
 */
export function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ComponentChildren }) {
  const flip = x > width * 0.6;
  const style = flip ? { right: `${Math.max(0, width - x + 12)}px`, top: `${y}px` } : { left: `${x + 12}px`, top: `${y}px` };
  return <div class="cs-tooltip" role="tooltip" aria-hidden="true" style={style}>{children}</div>;
}

export function TooltipRow({ color, hatch, label, value, share, dim }: { color?: string; hatch?: boolean; label: string; value: string; share?: string; dim?: boolean }) {
  return (
    <div class={`cs-tt-row${dim ? " cs-tt-dim" : ""}`}>
      <span class={`cs-tt-key${hatch ? " cs-swatch-hatch" : ""}`} style={color ? { background: color } : { background: "transparent" }} aria-hidden="true" />
      <span class="cs-tt-label">{label}</span>
      <span class="cs-tt-value">{value}</span>
      {share !== undefined && <span class="cs-tt-share">{share}</span>}
    </div>
  );
}
