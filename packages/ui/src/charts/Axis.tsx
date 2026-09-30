import type { Request } from "@ir/types.ts";
import { formatClock, indexTicks, type LinearScale } from "./scale.ts";

/**
 * Request-index axis with a time ruler beneath it. Rendered once under the
 * occupancy chart; the cache strip and lanes below it share the same x scale.
 */
export function Axis({ x, requests, width, height = 40 }: { x: LinearScale; requests: Request[]; width: number; height?: number }) {
  const [d0, d1] = x.domain;
  const px = Math.max(1, x.range[1] - x.range[0]);
  const count = Math.max(2, Math.floor(px / 90));
  const idx = indexTicks(d0, d1, count);
  const timeTicks = idx.filter((i) => requests[i]);
  return (
    <svg class="cs-axis" width={width} height={height} role="img" aria-label={`Request index axis from ${Math.round(d0)} to ${Math.round(d1)}, with wall-clock time beneath`}>
      <line x1={x.range[0]} x2={x.range[1]} y1={0.5} y2={0.5} class="cs-axis-line" />
      {idx.map((i) => (
        <g key={i} transform={`translate(${x(i)},0)`}>
          <line y1={0} y2={4} class="cs-axis-line" />
          <text y={15} class="cs-axis-text" text-anchor="middle">{i}</text>
        </g>
      ))}
      {timeTicks.map((i) => (
        <text key={`t${i}`} x={x(i)} y={30} class="cs-axis-text cs-axis-time" text-anchor="middle">{formatClock(requests[i].at)}</text>
      ))}
      <text x={x.range[0] - 8} y={15} text-anchor="end" class="cs-axis-text cs-axis-name">request</text>
      <text x={x.range[0] - 8} y={30} text-anchor="end" class="cs-axis-text cs-axis-name">time</text>
    </svg>
  );
}
