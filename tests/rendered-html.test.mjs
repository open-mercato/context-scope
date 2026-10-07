/**
 * The built worker (dist/server/index.js) server-renders the landing page:
 * title, description, the one command, the demo and export links, the OG
 * image, the privacy promise. Assets are stubbed (404) so only the rendered
 * HTML is under test. `npm test` builds first.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`https://contextscope.example${path}`, { headers: { accept: "text/html", host: "contextscope.example", "x-forwarded-proto": "https" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the ContextScope landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();

  assert.match(html, /<title>ContextScope<\/title>/);
  assert.match(html, /<meta name="description" content="See what filled your coding agent(?:&#x27;|'|’)s context window/);
  assert.match(html, /See what fills your coding agent(?:&#x27;|'|’|&rsquo;)s context window\./);
  assert.match(html, /npx contextscope/);
  assert.match(html, /href="\/app\/index\.html\?demo=1#\/"/, "the demo link");
  assert.match(html, /href="\/app\/index\.html\?demo=1#\/open"/, "the export link");
  assert.match(html, /Where did my context go/);
  assert.match(html, /What did my subagents cost and return/);
  assert.match(html, /What is wrong with my setup/);
  assert.match(html, /Nothing uploaded/);
  assert.match(html, /\/screens\/session\.png/);
  assert.match(html, /property="og:image" content="https:\/\/contextscope\.example\/og\.png"/);
  assert.match(html, /coming soon/i, "unknown repository and package links are labelled, not faked");
  assert.doesNotMatch(html, /attention|tokenów|Attention, prosto/i, "the old explainer is gone");
  assert.match(html, /No scores\./, "the honesty note");
  assert.doesNotMatch(html, /health score|context score|\b\d{1,3}\s*\/\s*100\b|letter grade/i, "no scores, no grades");
});

test("the landing source keeps the site static and honest", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /chatgpt-auth|next\/headers|force-dynamic/, "no sign-in helpers, no per-request identity");
  assert.doesNotMatch(page, /next\/image/, "screenshots are plain images (no optimizer binding)");
  // The repository exists (open-mercato/context-scope); the npm package is not published yet, so no npm link until it is (docs/publishing.md).
  assert.doesNotMatch(page.replace(/https:\/\/github\.com\/open-mercato\/context-scope/g, ""), /https?:\/\/github\.com\/[^"]*|https?:\/\/www\.npmjs\.com/, "no invented repository or package URLs");
  assert.match(layout, /title:\s*TITLE|title:\s*"ContextScope"/);
  assert.match(layout, /\/og\.png/);
  assert.match(packageJson, /"name": "contextscope-site"/);
  assert.match(packageJson, /"prebuild": "npm run sync-ui"/);
});
