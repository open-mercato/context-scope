/**
 * Number formatting shared by the terminal (`scan`) and the API layer
 * (ADR-002 section E): counts are exact integers with thousands separators;
 * tokens pick a unit so the mantissa stays below 1,000.
 */

export function formatCount(n) {
  return Math.round(Number(n) || 0).toLocaleString("en-US");
}

/**
 * Tokens with three significant digits (ADR-004 fix 9): 11,100,812,908 → "11.1B";
 * 1,739,210 → "1.74M"; 140,000,000 → "140M"; 9,876 → "9.88k"; 123,456 → "123k"; 812 → "812".
 */
export function formatTokens(n) {
  const value = Math.max(0, Number(n) || 0);
  const unit = (divisor, suffix) => {
    const scaled = value / divisor;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    const text = scaled.toFixed(digits);
    // 999.6k rounds up to "1000k": promote to the next unit instead.
    return Number(text) >= 1000 ? null : `${text}${suffix}`;
  };
  if (value >= 1e9) return unit(1e9, "B");
  if (value >= 1e6) return unit(1e6, "M") ?? unit(1e9, "B");
  if (value >= 1e3) return unit(1e3, "k") ?? unit(1e6, "M");
  return String(Math.round(value));
}

export function formatPercent(ratio, digits = 0) {
  return `${(Math.max(0, Number(ratio) || 0) * 100).toFixed(digits)}%`;
}

const SINCE_UNITS = { d: 24 * 3600 * 1000, h: 3600 * 1000, w: 7 * 24 * 3600 * 1000, m: 60 * 1000 };

/**
 * Parses `since` query values: "30d", "12h", "2w", an ISO date, or a millisecond
 * epoch. Returns an epoch in ms, or null when the value is unusable.
 */
export function parseSince(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const text = String(value).trim();
  if (/^all$/i.test(text)) return 0; // "all" = no lower bound (all time); callers treat 0 as unbounded
  const relative = /^(\d+(?:\.\d+)?)([dhwm])$/i.exec(text);
  if (relative) return now - Number(relative[1]) * SINCE_UNITS[relative[2].toLowerCase()];
  if (/^\d{12,}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function padRight(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function padLeft(text, width) {
  const value = String(text);
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}
