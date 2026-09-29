/**
 * `#/open`: drop zone + file picker for a `contextscope.export/1` document.
 * The file is read and parsed in this browser only (FileReader → JSON.parse →
 * structural validation → a smoke render of the overview); a valid document
 * becomes the in-memory backend and the screen navigates to its session.
 * Nothing is uploaded anywhere. The importer itself (export.ts) loads on demand.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { Export } from "@ir/types.ts";
import { backend, isCompanion, loadExport, loadedExport, MAX_EXPORT_BYTES } from "../api.ts";
import { CLI_COMMAND } from "../config.ts";
import { hrefs, navigate } from "../router.ts";
import { copyText, indexVersion, pendingFile, toast } from "../store.ts";
import { Panel } from "../components/Panel.tsx";
import { formatNumber } from "../format.ts";

const EXPORT_COMMAND = `${CLI_COMMAND} export --run <vendor:session-id> --redact-labels --out session.json`;

type Status = { kind: "idle" } | { kind: "reading"; name: string } | { kind: "error"; name: string; message: string };

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

/** Lets the "Reading …" label paint before a multi-megabyte parse blocks the thread (#34); a timer, not rAF, so a background tab never stalls. */
const nextFrame = () => new Promise<void>((resolve) => { setTimeout(resolve, 16); });

function describe(doc: Export): string {
  const run = doc.run;
  const scopes = Object.keys(doc.scopes).length;
  return `${run.vendor} session ${run.id.slice(run.id.indexOf(":") + 1, run.id.indexOf(":") + 9)} · ${formatNumber(run.summary.requests)} requests · peak ${formatNumber(run.summary.peak.value)} tokens · ${scopes} scope${scopes === 1 ? "" : "s"}${doc.redaction.labels === "sha1-10" ? " · labels hashed" : ""}`;
}

export function OpenScreen() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const current = loadedExport.value;

  async function open(file: File) {
    setStatus({ kind: "reading", name: file.name });
    try {
      if (file.size > MAX_EXPORT_BYTES) throw new Error(`The file is ${(file.size / 1024 / 1024).toFixed(0)} MB; exports over ${MAX_EXPORT_BYTES / 1024 / 1024} MB are refused.`);
      const [text, importer] = await Promise.all([readFileText(file), import("../export.ts")]);
      await nextFrame();
      const doc = importer.parseExportText(text, file.size);
      // Smoke render: everything the overview and the session header read must resolve before the route switches (#1).
      let memory: ReturnType<typeof importer.createMemoryBackend>;
      try {
        memory = importer.createMemoryBackend(doc);
        const overview = importer.overviewFromExport(doc);
        const run = await memory.run(doc.run.vendor, doc.run.id.slice(doc.run.id.indexOf(":") + 1));
        const main = run.scopes[0];
        if (!overview.runs.length || !main?.requests?.length || typeof run.coverage.estimatorErrorP95 !== "number" || typeof run.window.value !== "number") throw new Error("the main scope or the run summary is incomplete");
      } catch (error) {
        throw new Error(`The file validates but cannot be rendered (${(error as Error).message}). It may come from a newer or older ContextScope; re-export it with the current CLI.`);
      }
      const { vendor, id } = loadExport(memory, doc, file.name);
      indexVersion.value++;
      toast(`Opened ${file.name} · ${describe(doc)}`, "success", 5000);
      setStatus({ kind: "idle" });
      navigate(hrefs.session(vendor, id));
    } catch (error) {
      setStatus({ kind: "error", name: file.name, message: (error as Error).message || "The file could not be opened." });
    }
  }

  function onFiles(list: FileList | null | undefined) {
    const file = list?.[0];
    if (file) void open(file);
  }

  // A file dropped anywhere else in the app lands here (main.tsx useGlobalDrop, #21).
  const parked = pendingFile.value;
  useEffect(() => {
    if (!parked) return;
    pendingFile.value = null;
    void open(parked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parked]);

  // Whole-page drop while this screen is up: dropping anywhere opens the file; the zone only highlights.
  useEffect(() => {
    const prevent = (event: DragEvent) => { event.preventDefault(); };
    const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer?.files); };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", prevent); window.removeEventListener("drop", drop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const companion = isCompanion();
  return (
    <section class="screen open-screen">
      <div class="screen-head">
        <div>
          <h1>Open an export</h1>
          <p class="screen-sub">A <code>contextscope.export/1</code> file: one session's request ledger, scopes, findings and thresholds. Parsed here, in your browser.</p>
        </div>
      </div>

      <div
        ref={zone}
        class={`dropzone ${dragging ? "dropzone-active" : ""} ${status.kind === "error" ? "dropzone-error" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!zone.current?.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(event.dataTransfer?.files); }}
        onClick={() => input.current?.click()}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.current?.click(); } }}
        role="button"
        tabIndex={0}
        aria-label="Drop a ContextScope export here or press Enter to choose a file"
        aria-busy={status.kind === "reading"}
      >
        <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" class="dropzone-icon"><rect x="5" y="5" width="26" height="26" rx="5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M18 11v12M13 18l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <p class="dropzone-title">{status.kind === "reading" ? `Reading ${status.name}…` : dragging ? "Drop to open" : "Drop an export here, or click to choose a file"}</p>
        <p class="dropzone-sub">JSON, schema <code>contextscope.export/1</code>, up to {MAX_EXPORT_BYTES / 1024 / 1024} MB</p>
        <input ref={input} type="file" accept="application/json,.json" class="visually-hidden" onChange={(event) => { onFiles((event.target as HTMLInputElement).files); (event.target as HTMLInputElement).value = ""; }} />
      </div>

      {status.kind === "error" ? (
        <div class="error-notice" role="alert">
          <p class="error-title">Could not open {status.name}</p>
          <p class="error-body">{status.message}</p>
          <p class="muted">Exports come from <code>contextscope export</code>; anything else (a raw transcript, a different schema, a hollow document, a file carrying message text or absolute paths) is refused before it is shown.</p>
        </div>
      ) : null}

      {current ? (
        <div class="open-current" role="note">
          <span class="badge badge-good">Loaded</span> <code>{backend.value.label}</code> · {describe(current)} ·{" "}
          <a href={hrefs.session(current.run.vendor, current.run.id.slice(current.run.id.indexOf(":") + 1))}>Open the session</a>
        </div>
      ) : null}
      {current && current.redaction.labels === "sha1-10" ? (
        <div class="open-redacted" role="note" aria-label="Redacted export">
          <span class="badge badge-info">Redacted export</span>{" "}
          <span>Paths, MCP servers, custom agents and skills are salted hashes (<code>h:</code> + 10 hex, the same value for the same name inside this file); token counts, vendor tool and model names are as recorded.</span>
        </div>
      ) : null}

      <div class="open-grid">
        <Panel title="Privacy" description="What this screen does with the file">
          <ul class="open-list">
            <li>The file is read with the browser's <code>FileReader</code> and parsed locally; no request carries it anywhere. The network tab stays empty.</li>
            <li>Only <code>contextscope.export/1</code> is accepted. The importer refuses files with content keys (<code>content</code>, <code>text</code>, <code>stdout</code>, <code>stderr</code>, <code>prompt</code>) or absolute paths, so a transcript pasted by mistake never renders.</li>
            <li>An export holds sizes, hashes, tool names, token counts and findings; with <code>--redact-labels</code> file names and labels are replaced by <code>h:</code> + 10 hex of their sha1.</li>
            <li>Reloading the page forgets the file. Nothing is stored.</li>
          </ul>
        </Panel>
        <Panel title="Export a session" description="From the machine that ran the session" actions={<button type="button" class="btn" onClick={() => void copyText(EXPORT_COMMAND, "Command copied")}>Copy command</button>}>
          <pre class="fix-snippet"><code>{EXPORT_COMMAND}</code></pre>
          <ul class="open-list">
            <li><code>--run</code> takes <code>claude:&lt;session-id&gt;</code> or <code>codex:&lt;thread-id&gt;</code>; <code>{CLI_COMMAND} scan</code> lists them.</li>
            <li><code>--scopes main</code> (default) keeps the export small; <code>--scopes all</code> adds every subagent; <code>--md</code> also writes a markdown summary to paste into a PR.</li>
            <li>The same document is served by the companion at <code>/api/v1/runs/&lt;vendor&gt;/&lt;id&gt;/export?redact=1</code>{companion ? " — the session screen's Export button downloads it." : "."}</li>
          </ul>
        </Panel>
      </div>
    </section>
  );
}
