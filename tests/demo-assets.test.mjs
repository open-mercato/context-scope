/**
 * After `prebuild` (scripts/sync-ui.mjs) the static assets carry the UI bundle
 * and the demo dataset, and the dataset is as private as the real index:
 * no content keys, no absolute paths, the demo meta tag, the OG image and the
 * landing screenshots within their size budgets.
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

const publicRoot = new URL("../public/", import.meta.url);
const appRoot = new URL("app/", publicRoot);
const FORBIDDEN_KEYS = ["content", "text", "stdout", "stderr", "prompt"];
const ABSOLUTE = /"\/(Users|home|private|var|tmp|etc|root)\/[^"]*"|"[A-Za-z]:\\\\/;
const SCREENSHOT_BUDGET = 400 * 1024;

function keysIn(value, found = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 64) return found;
  if (Array.isArray(value)) { for (const item of value) keysIn(item, found, depth + 1); return found; }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) found.add(key);
    keysIn(nested, found, depth + 1);
  }
  return found;
}

async function walk(url) {
  const out = [];
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, url);
    if (entry.isDirectory()) out.push(...(await walk(child)));
    else out.push(child);
  }
  return out;
}

test("public/app carries the UI bundle and the demo dataset", async () => {
  const index = await readFile(new URL("index.html", appRoot), "utf8");
  assert.match(index, /<meta name="contextscope-mode" content="demo">/);
  assert.match(index, /src="\.\/app\.js"/);
  assert.match(index, /href="\.\/app\.css"/);
  await stat(new URL("app.js", appRoot));
  await stat(new URL("app.css", appRoot));
  for (const name of ["overview.json", "findings.json", "setup.json", "thresholds.json"]) await stat(new URL(`demo/${name}`, appRoot));
  const overview = JSON.parse(await readFile(new URL("demo/overview.json", appRoot), "utf8"));
  assert.ok(overview.runs.length >= 10, "at least ten demo sessions");
  assert.deepEqual(overview.totals.vendors, ["claude", "codex"]);
  for (const run of overview.runs) {
    const [vendor, id] = run.id.split(":");
    await stat(new URL(`demo/runs/${vendor}--${id}.json`, appRoot));
  }
});

test("the demo dataset is as private as the index: no content keys, no absolute paths", async () => {
  const files = (await walk(new URL("demo/", appRoot))).filter((url) => url.pathname.endsWith(".json"));
  assert.ok(files.length > 20, `expected the demo JSON files, found ${files.length}`);
  let bytes = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    bytes += Buffer.byteLength(text);
    assert.deepEqual([...keysIn(JSON.parse(text))], [], `${file.pathname}: forbidden keys`);
    assert.doesNotMatch(text, ABSOLUTE, `${file.pathname}: absolute path`);
  }
  assert.ok(bytes < 12 * 1024 * 1024, `demo dataset is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
});

test("the OG image, favicon and landing screenshots exist within budget", async () => {
  const og = await stat(new URL("og.png", publicRoot));
  assert.ok(og.size > 10 * 1024 && og.size < 1024 * 1024, `og.png is ${og.size} bytes`);
  await stat(new URL("favicon.svg", publicRoot));
  for (const name of ["overview.png", "session.png", "findings.png"]) {
    const shot = await stat(new URL(`screens/${name}`, publicRoot));
    assert.ok(shot.size > 5 * 1024, `${name} is empty`);
    assert.ok(shot.size < SCREENSHOT_BUDGET, `${name} is ${Math.round(shot.size / 1024)} KB (budget ${SCREENSHOT_BUDGET / 1024} KB)`);
  }
  const leftovers = (await readdir(publicRoot)).filter((name) => /attention|classroom/i.test(name));
  assert.deepEqual(leftovers, [], "the explainer's images are gone");
});
