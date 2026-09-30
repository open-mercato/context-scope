/**
 * `#/tokens`: paste text or add files and see their estimated tokens, with the
 * same calibrated estimator the CLI uses (`contextscope tokens`). Everything is
 * computed in this browser tab; nothing is sent to the companion or anywhere else.
 */
import { useMemo, useRef, useState } from "preact/hooks";
import { createEstimator, type ContentKind, type TokenReport } from "@ir/estimate-core.mjs";
import calibration from "@ir/calibration.json";
import { formatNumber, percent } from "../format.ts";
import { formatTokens } from "../categories.ts";
import { Badge } from "../components/Badge.tsx";
import { Panel } from "../components/Panel.tsx";
import { StatTile } from "../components/StatTile.tsx";
import { Table, type Column } from "../components/Table.tsx";

const estimator = createEstimator(calibration);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const WINDOWS = [200_000, 1_000_000];
type KindChoice = ContentKind | "auto";
interface Item { id: string; name: string; text: string }
interface Row extends TokenReport { id: string; name: string; pasted?: boolean }
interface Skipped { name: string; reason: string }

let nextId = 0;

export function TokensScreen() {
  const [pasted, setPasted] = useState("");
  const [files, setFiles] = useState<Item[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [kind, setKind] = useState<KindChoice>("auto");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    if (pasted) list.push({ id: "pasted", name: "Pasted text", pasted: true, ...estimator.tokenReport(pasted, { kind }) });
    for (const file of files) list.push({ id: file.id, name: file.name, ...estimator.tokenReport(file.text, { kind }) });
    return list;
  }, [pasted, files, kind]);

  const total = rows.reduce((sum, row) => ({
    bytes: sum.bytes + row.bytes,
    claude: sum.claude + row.tokens.claude,
    codex: sum.codex + row.tokens.codex,
    neutral: sum.neutral + row.tokens.neutral,
  }), { bytes: 0, claude: 0, codex: 0, neutral: 0 });

  async function addFiles(list: FileList | null | undefined) {
    if (!list?.length) return;
    const added: Item[] = [];
    const refused: Skipped[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) { refused.push({ name: file.name, reason: `over ${MAX_FILE_BYTES / 1024 / 1024} MB` }); continue; }
      const text = await file.text().catch(() => null);
      if (text === null) { refused.push({ name: file.name, reason: "unreadable" }); continue; }
      if (text.slice(0, 8000).includes("\u0000")) { refused.push({ name: file.name, reason: "binary" }); continue; }
      nextId += 1;
      added.push({ id: `file-${nextId}`, name: file.name, text });
    }
    setFiles((current) => [...current, ...added]);
    setSkipped(refused);
  }

  const remove = (row: Row) => (row.pasted ? setPasted("") : setFiles((current) => current.filter((file) => file.id !== row.id)));

  const columns: Column<Row>[] = [
    { key: "name", label: "Source", sortValue: (r) => r.name, render: (r) => <span class="tokens-name" title={r.name}>{r.name}</span> },
    { key: "bytes", label: "Bytes", numeric: true, align: "right", sortValue: (r) => r.bytes, render: (r) => formatNumber(r.bytes) },
    { key: "lines", label: "Lines", numeric: true, align: "right", sortValue: (r) => r.lines, render: (r) => formatNumber(r.lines) },
    { key: "kind", label: "Kind", sortValue: (r) => r.kind, render: (r) => <span class="muted">{r.kind}</span> },
    { key: "claude", label: "Claude", numeric: true, align: "right", sortValue: (r) => r.tokens.claude, title: "Bytes per token fitted on real Claude Code sessions", render: (r) => <strong title={`${formatNumber(r.tokens.claude)} tokens`}>{formatTokens(r.tokens.claude)}</strong> },
    { key: "codex", label: "Codex", numeric: true, align: "right", sortValue: (r) => r.tokens.codex, title: "Bytes per token fitted on real Codex sessions", render: (r) => <span title={`${formatNumber(r.tokens.codex)} tokens`}>{formatTokens(r.tokens.codex)}</span> },
    { key: "neutral", label: "Neutral", numeric: true, align: "right", sortValue: (r) => r.tokens.neutral, title: "~3.6 bytes per token for prose, 3.2 for code", render: (r) => <span title={`${formatNumber(r.tokens.neutral)} tokens`}>{formatTokens(r.tokens.neutral)}</span> },
    { key: "share", label: "Of 200k", numeric: true, align: "right", sortValue: (r) => r.tokens.claude, title: "Claude estimate as a share of a 200k context window", render: (r) => <span class="muted">{percent(r.tokens.claude / WINDOWS[0], 1)}</span> },
    { key: "remove", label: "", align: "right", render: (r) => <button type="button" class="cs-link" onClick={() => remove(r)} aria-label={`Remove ${r.name}`}>remove</button> },
  ];

  return (
    <section class="screen tokens-screen">
      <div class="screen-head">
        <div>
          <h1>Count tokens</h1>
          <p class="screen-sub">Paste text or add files. Counted in this browser with the calibrated estimator ContextScope uses for sessions; nothing is uploaded.</p>
        </div>
        <div class="segmented" role="group" aria-label="Content kind">
          {(["auto", "prose", "code"] as KindChoice[]).map((choice) => (
            <button key={choice} type="button" aria-pressed={kind === choice} onClick={() => setKind(choice)} title={choice === "auto" ? "Detect prose or code per source" : `Treat every source as ${choice}`}>{choice}</button>
          ))}
        </div>
      </div>

      <div class="tiles" role="list">
        <StatTile label="Claude (estimated)" value={formatTokens(total.claude)} hint={`${percent(total.claude / WINDOWS[0], 1)} of 200k · ${percent(total.claude / WINDOWS[1], 1)} of 1M`} provenance="estimated.local" title={`${formatNumber(total.claude)} tokens`} />
        <StatTile label="Codex (estimated)" value={formatTokens(total.codex)} hint="bytes per token fitted on Codex sessions" provenance="estimated.local" title={`${formatNumber(total.codex)} tokens`} accent="var(--series-2)" />
        <StatTile label="Neutral" value={formatTokens(total.neutral)} hint="~3.6 B/token prose, 3.2 code" provenance="estimated.local" title={`${formatNumber(total.neutral)} tokens`} accent="var(--series-3)" />
        <StatTile label="Size" value={formatNumber(total.bytes)} hint={`bytes in ${rows.length} source${rows.length === 1 ? "" : "s"}`} provenance="observed.artifact" accent="var(--series-4)" />
      </div>

      <div class="grid-2 tokens-inputs">
        <Panel title="Paste text" description="Counted as you type.">
          <textarea class="tokens-textarea" aria-label="Text to count" placeholder="Paste a prompt, an AGENTS.md, a tool result…" value={pasted} onInput={(event) => setPasted((event.target as HTMLTextAreaElement).value)} spellcheck={false} />
        </Panel>
        <Panel title="Add files" description={`Text files up to ${MAX_FILE_BYTES / 1024 / 1024} MB each; several at once. Read locally.`}>
          <div
            ref={zone}
            class={`dropzone tokens-dropzone ${dragging ? "dropzone-active" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={(event) => { if (!zone.current?.contains(event.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false); void addFiles(event.dataTransfer?.files); }}
            onClick={() => input.current?.click()}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.current?.click(); } }}
            role="button"
            tabIndex={0}
            aria-label="Drop files here or press Enter to choose files"
          >
            <p class="dropzone-title">{dragging ? "Drop to count" : "Drop files here, or click to choose"}</p>
            <p class="dropzone-sub">Markdown, code, JSON, logs… binary files are skipped</p>
            <input ref={input} type="file" multiple class="visually-hidden" onChange={(event) => { void addFiles((event.target as HTMLInputElement).files); (event.target as HTMLInputElement).value = ""; }} />
          </div>
          {skipped.length ? <p class="muted tokens-skipped">Skipped: {skipped.map((item) => `${item.name} (${item.reason})`).join(", ")}</p> : null}
        </Panel>
      </div>

      <Panel
        title="Results"
        description={rows.length ? `${rows.length} source${rows.length === 1 ? "" : "s"} · ${formatTokens(total.claude)} Claude-estimated tokens in total` : "Nothing to count yet."}
        actions={<>{rows.length ? <button type="button" class="btn btn-ghost" onClick={() => { setPasted(""); setFiles([]); setSkipped([]); }}>Clear all</button> : null}<Badge provenance="estimated.local" /></>}
        flush
      >
        <Table label="Token estimates" columns={columns} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: "claude", dir: "desc" }} empty={<span>Paste text or add files above.</span>} />
      </Panel>

      <p class="muted tokens-note">
        Estimates, not tokenizer output. Claude and Codex use bytes-per-token ratios fitted on real sessions (calibration <code>{calibration.calibrationVersion}</code>), which include how the vendors actually charged that content; the neutral ratio is a plain text average. Exact counts need the vendor's tokenizer, which would mean sending the text out. The CLI does the same for files and folders: <code>contextscope tokens &lt;path&gt;</code>.
      </p>
    </section>
  );
}
