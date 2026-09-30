import { build, context, transform } from "esbuild";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../cli/ui");
const watch = process.argv.includes("--watch");

/**
 * One entry (`app.js`) plus lazy chunks: the Session and Setup screens load on
 * demand via `import()`, so the first paint of the overview does not pay for
 * the charts. Chunks are content-hashed; stale ones are removed before a build.
 */
const options = {
  entryPoints: { app: path.join(here, "src/main.tsx") },
  bundle: true,
  splitting: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  format: "esm",
  target: ["es2022"],
  jsx: "automatic",
  jsxImportSource: "preact",
  outdir: outDir,
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  legalComments: "none",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
};

async function cleanChunks() {
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) if (/^chunk-[A-Z0-9]+\.js$/i.test(name)) await rm(path.join(outDir, name));
}

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  const html = await readFile(path.join(here, "src/index.html"), "utf8");
  await writeFile(path.join(outDir, "index.html"), html);
  // app.css = src/theme.css followed by every src/styles/*.css (sorted), so
  // parallel work streams add styles in their own file instead of editing theme.css.
  let css = await readFile(path.join(here, "src/theme.css"), "utf8");
  const stylesDir = path.join(here, "src/styles");
  const extra = (await readdir(stylesDir).catch(() => [])).filter((name) => name.endsWith(".css")).sort();
  for (const name of extra) css += `\n/* ---- ${name} ---- */\n` + await readFile(path.join(stylesDir, name), "utf8");
  const minified = watch ? { code: css } : await transform(css, { loader: "css", minify: true });
  await writeFile(path.join(outDir, "app.css"), minified.code);
}

await cleanChunks();
if (watch) {
  const ctx = await context(options);
  await copyStatic();
  await ctx.watch();
  console.log("watching", outDir);
} else {
  await build(options);
  await copyStatic();
}
