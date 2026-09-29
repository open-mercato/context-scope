#!/usr/bin/env node
/**
 * `npm pack` / `npm publish` guard: refuses to build a tarball without the UI
 * bundle (`ui/index.html`, `ui/app.js`, `ui/app.css`; built by
 * `packages/ui npm run build`) or with a stale `ui/` older than the UI sources.
 * Prints nothing else; exit 1 stops npm.
 */
import { stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..");
const ui = path.join(cli, "ui");
const required = ["index.html", "app.js", "app.css"];

async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dev") continue;
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await newestMtime(full) : (await stat(full)).mtimeMs);
  }
  return newest;
}

for (const name of required) {
  try { await stat(path.join(ui, name)); } catch { console.error(`prepack: ${path.relative(cli, path.join(ui, name))} is missing; run \`cd packages/ui && npm install && npm run build\` first.`); process.exit(1); }
}
const bundleAt = (await stat(path.join(ui, "app.js"))).mtimeMs;
const sources = path.join(cli, "..", "ui", "src");
try {
  if ((await newestMtime(sources)) > bundleAt) { console.error("prepack: ui/ is older than packages/ui/src; rebuild the UI before packing."); process.exit(1); }
} catch {
  // No UI sources next to the package (e.g. packing from a published tarball): the bundle presence check is enough.
}
