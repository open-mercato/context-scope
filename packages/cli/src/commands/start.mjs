/** `contextscope [start]`: serve the UI on loopback and index in the background. */
import path from "node:path";
import { resolveRepoRoot } from "../util/repo.mjs";
import { randomBytes } from "node:crypto";
import { createServer } from "../server/app.mjs";
import { openBrowser } from "../server/http.mjs";
import { projectKeyFor } from "../adapters/discover.mjs";
import { firstRunReport, renderFirstRun } from "../index/scan.mjs";
import { concurrencyOf } from "./args.mjs";
import { hooksStatus } from "./hooks.mjs";
import { installSignalHandlers, printPassNotes, progressPrinter } from "./shared.mjs";

export const name = "start";
export const usage = "contextscope [start] [--repo <path>] [--port 0] [--no-open] [--yes] [--json] [--concurrency 4]";
export const summary = [
  "Serve the UI on loopback, index sessions in the background, open the browser.",
  "--repo <path> analyses that repository (default: the current directory, git top level).",
  "--yes skips the consent page (trusted automation); --no-open prints the URL only.",
  "After the first pass: what was found (files, sessions, subagents), where the",
  "context went at peak, the fattest handoff, the one change to make first.",
  "--json prints { url, repo, repoKey } then one JSON line per index event (start,",
  "progress, done, found, live) for tooling; the browser is not opened.",
];

/** Builds and prints the "what we found" block (ADR-005 §6); never throws (the server keeps running). */
async function reportFirstRun({ app, home, repoRoot, pass, url, json, env }) {
  let hooks = null;
  try { hooks = await hooksStatus({ home, repoRoot, env }); } catch {}
  const analysis = app.routes?.analysis;
  if (!analysis) return;
  const found = await firstRunReport(analysis, { pass, hooks });
  if (json) process.stdout.write(`${JSON.stringify({ type: "found", ...found })}\n`);
  else console.log(renderFirstRun(found, { url }));
}

export async function run(args, { home, cwd, env = process.env }) {
  const repoRoot = resolveRepoRoot(cwd, args.option("--repo", undefined));
  const requestedPort = Number(args.option("--port", "0"));
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  const json = args.has("--json");
  const app = createServer({
    home,
    repoRoot,
    token: randomBytes(32).toString("hex"),
    consent: !args.has("--yes"),
    autoIndex: true,
    concurrency: concurrencyOf(args),
  });
  const printProgress = progressPrinter({ ndjson: json });
  let url = null;
  let reported = false;
  app.index.events.on("event", (event) => {
    if (!event || typeof event !== "object") return;
    if (event.live) { if (json && (event.type === "live" || event.type === "live-idle")) printProgress(event); return; }
    printProgress(event);
    if (event.type !== "done" || reported) return;
    reported = true;
    if (!json) printPassNotes({ rulesChanged: event.rulesChanged, reevaluated: event.reevaluated });
    reportFirstRun({ app, home, repoRoot, pass: event, url, json, env }).catch((error) => console.error(`ContextScope: could not summarise the first pass (${error?.message ?? error}).`));
  });
  // Live events come from the watcher over the SSE hub, not from the index emitter: mirror them for `--json`.
  if (json && typeof app.sse?.broadcast === "function") {
    const broadcast = app.sse.broadcast.bind(app.sse);
    app.sse.broadcast = (event, options) => { if (event?.type === "live" || event?.type === "live-idle") printProgress(event); return broadcast(event, options); };
  }
  const listened = await app.listen(requestedPort);
  url = listened.url;
  if (json) {
    process.stdout.write(`${JSON.stringify({ url, repo: repoRoot, repoKey: projectKeyFor(repoRoot), consent: !args.has("--yes") })}\n`);
  } else {
    console.log(`ContextScope is ready: ${url}`);
    console.log(`Read-only local index of ~/.claude and ~/.codex for ${repoRoot} · nothing leaves this machine · Ctrl+C to stop`);
    if (!app.authorized) console.log("Waiting for consent in the browser; the first pass starts once you approve the scan (or use --yes).");
  }
  if (!json && !args.has("--no-open")) openBrowser(url);
  installSignalHandlers(() => app.close());
}
