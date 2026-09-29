/**
 * Copies the prebuilt ContextScope UI (packages/cli/ui/*) and the synthetic demo
 * dataset (packages/ui/dev/demo/**) into public/app/ so the platform's static
 * assets serve the hosted demo at /app/index.html?demo=1#/ (ADR-003 section 4;
 * the app router owns the bare /app path, so links use the file name).
 *
 * The demo dataset is regenerated first (deterministic, zero dependencies), so a
 * fresh checkout builds without committed generated data. Hash routes and the
 * bundle's relative asset paths need no rewriting; the only edit to index.html is
 * a `<meta name="contextscope-mode" content="demo">` so /app/ works without ?demo=1.
 *
 * Wired as `prebuild` in the root package.json; also `npm run sync-ui`.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(root, "packages", "cli", "ui");
const demoDir = path.join(root, "packages", "ui", "dev", "demo");
const makeFixtures = path.join(root, "packages", "ui", "dev", "make-fixtures.mjs");
const target = path.join(root, "public", "app");
const DEMO_META = '<meta name="contextscope-mode" content="demo">';

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function dirBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirBytes(full) : (await stat(full)).size;
  }
  return total;
}

if (!(await exists(path.join(uiDir, "index.html")))) {
  throw new Error(`${uiDir}/index.html is missing; build the UI first (cd packages/ui && npm run build).`);
}

await run(process.execPath, [makeFixtures, "--demo"], { cwd: root });

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(uiDir, target, { recursive: true });
await cp(demoDir, path.join(target, "demo"), { recursive: true });
await rm(path.join(target, "demo", "README.md"), { force: true });

const indexFile = path.join(target, "index.html");
const html = await readFile(indexFile, "utf8");
if (!html.includes(DEMO_META)) await writeFile(indexFile, html.replace('<meta name="viewport"', `${DEMO_META}\n<meta name="viewport"`));

const bundle = await dirBytes(uiDir);
const demo = await dirBytes(path.join(target, "demo"));
console.log(`synced ${path.relative(root, target)}: UI ${(bundle / 1024).toFixed(0)} KB + demo ${(demo / 1024 / 1024).toFixed(1)} MB`);
