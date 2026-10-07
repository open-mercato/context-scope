/**
 * Streaming JSONL reader. Splits on "\n" bytes only: vendor files contain raw
 * U+2028 inside JSON strings, and Node's readline treats that as a line break.
 * Never loads the whole file. Yields { line, value, bytes } for parseable
 * lines and { line, error, bytes } for the rest so adapters can count coverage.
 */
import { createReadStream } from "node:fs";

export async function* readJsonl(filePath, { highWaterMark = 1 << 20 } = {}) {
  const stream = createReadStream(filePath, { highWaterMark });
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let lineNumber = 0;
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline;
    while ((newline = carry.indexOf("\n", start)) >= 0) {
      const raw = carry.slice(start, newline);
      start = newline + 1;
      lineNumber += 1;
      const parsed = parseLine(raw, lineNumber);
      if (parsed) yield parsed;
    }
    carry = carry.slice(start);
  }
  carry += decoder.decode();
  if (carry.trim()) {
    lineNumber += 1;
    const parsed = parseLine(carry, lineNumber);
    if (parsed) yield parsed;
  }
}

function parseLine(raw, line) {
  const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (!text.trim()) return null;
  const bytes = Buffer.byteLength(text, "utf8");
  try { return { line, value: JSON.parse(text), bytes }; }
  catch (error) { return { line, error: error.message, bytes }; }
}
