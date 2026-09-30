// Types for the I/O-free estimator (imported by the UI's Tokens screen).
export type ContentKind = "prose" | "code";
export interface TokenReport { bytes: number; chars: number; lines: number; kind: ContentKind; tokens: { claude: number; codex: number; neutral: number } }
export function byteLength(text: string): number;
export function detectKind(text: string): ContentKind;
export function createEstimator(calibration: unknown): {
  calibrationFor(vendor?: string): unknown;
  estimateTokensFromBytes(bytes: number, kind?: ContentKind, options?: { vendor?: string; category?: string }): number;
  tokenReport(text: string, options?: { kind?: ContentKind | "auto" }): TokenReport;
};
