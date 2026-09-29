/** Number, time and date formatting shared by every screen. */
export { formatTokens } from "./categories.ts";

const numberFormat = new Intl.NumberFormat("en-US");

/** Full number with thousands separators (for tables and evidence rows). */
export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return numberFormat.format(Math.round(value));
}

/** Compact byte count. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes >= 102_400 ? 0 : 1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** "1h 12m", "48m", "35s". */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** "Sep 2, 14:05" in the viewer's locale; year appended when it differs from now. */
export function formatDate(iso: string | undefined | null, now = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Date only: "Sep 2, 2026". */
export function formatDay(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "just now", "2 min ago", "3 h ago", "5 d ago". */
export function formatRelative(iso: string | number | undefined | null, now = Date.now()): string {
  if (iso === undefined || iso === null) return "—";
  const time = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";
  const diff = Math.max(0, now - time);
  const seconds = Math.round(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.round(days / 30);
  return `${months} mo ago`;
}

/**
 * 0.347 -> "34.7%", 0.0712 -> "7.12%", 1 -> "100%": three significant digits
 * (ADR-004 §7.9), one decimal at most from 10% up so tables stay narrow.
 * `digits` forces a fixed number of decimals when given.
 */
export function percent(ratio: number | undefined | null, digits?: number): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return "—";
  const value = ratio * 100;
  if (digits !== undefined) return `${value.toFixed(digits)}%`;
  const abs = Math.abs(value);
  const text = abs >= 99.95 ? value.toFixed(0) : abs >= 9.995 ? value.toFixed(1) : abs >= 0.9995 ? value.toFixed(2) : abs === 0 ? "0" : value.toPrecision(3);
  return `${text.replace(/\.0+$/, "")}%`;
}

/** "2.60x", "11.5x", "116x": three significant digits. */
export function formatRatio(ratio: number | undefined | null): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return "—";
  const abs = Math.abs(ratio);
  return `${abs >= 99.95 ? ratio.toFixed(0) : abs >= 9.995 ? ratio.toFixed(1) : ratio.toFixed(2)}x`;
}

/** Pluralise a count: plural(3, "finding") -> "3 findings". */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${formatNumber(count)} ${count === 1 ? noun : pluralNoun}`;
}
