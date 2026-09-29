/**
 * Minimal YAML-ish frontmatter parser for SKILL.md, agent and rules files.
 * Supports `key: value`, quoted strings, `>` / `|` block scalars, inline
 * `[a, b]` lists and `- item` block lists, and one level of nested maps.
 * Anything else marks the frontmatter as invalid (ok: false) without throwing.
 */

export function parseFrontmatter(text) {
  const source = String(text ?? "");
  if (!/^---[ \t]*\r?\n/.test(source)) return { ok: true, present: false, data: {}, body: source };
  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return { ok: false, present: true, data: {}, body: source, error: "unterminated frontmatter (missing closing ---)" };
  const body = lines.slice(end + 1).join("\n");
  const result = parseMap(lines.slice(1, end));
  return { ok: result.ok, present: true, data: result.data, body, error: result.error };
}

function scalar(raw) {
  const value = raw.trim();
  if (value === "") return "";
  const quoted = value.match(/^"(.*)"$/s) ?? value.match(/^'(.*)'$/s);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/''/g, "'");
  if (/^\[.*\]$/.test(value)) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map(item => scalar(item)) : [];
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/\s+#.*$/, "");
}

function indentOf(line) {
  return line.match(/^[ \t]*/)[0].length;
}

function parseMap(lines, baseIndent = 0) {
  const data = {};
  let ok = true;
  let error;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i += 1; continue; }
    const indent = indentOf(line);
    if (indent < baseIndent) break;
    const match = line.match(/^[ \t]*([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/);
    if (!match) {
      ok = false;
      error = error ?? `cannot parse line ${i + 1}: ${line.trim().slice(0, 40)}`;
      i += 1;
      continue;
    }
    const key = match[1];
    const rest = (match[2] ?? "").trim();
    i += 1;
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const block = [];
      while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > indent)) {
        block.push(lines[i].trim() === "" ? "" : lines[i].slice(Math.min(indentOf(lines[i]), indent + 2)));
        i += 1;
      }
      while (block.length && block.at(-1) === "") block.pop();
      data[key] = rest.startsWith(">") ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n");
      continue;
    }
    if (rest !== "") { data[key] = scalar(rest); continue; }
    // Nested block: list or map.
    const nested = [];
    while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > indent || /^[ \t]*-[ \t]/.test(lines[i]) && indentOf(lines[i]) >= indent)) {
      if (lines[i].trim() === "") { i += 1; continue; }
      nested.push(lines[i]);
      i += 1;
    }
    if (!nested.length) { data[key] = null; continue; }
    if (nested.every(l => /^[ \t]*-([ \t]|$)/.test(l))) {
      data[key] = nested.map(l => scalar(l.replace(/^[ \t]*-[ \t]?/, "")));
      continue;
    }
    const child = parseMap(nested, indentOf(nested[0]));
    if (!child.ok) { ok = false; error = error ?? child.error; }
    data[key] = child.data;
  }
  return { ok, data, error };
}

export function asStringList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(v => v.trim()).filter(Boolean);
  return [];
}
