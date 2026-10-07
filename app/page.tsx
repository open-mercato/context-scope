// `/app/index.html`: the app router owns `/app` (308 → 404), the static assets own the file itself.
const DEMO_HREF = "/app/index.html?demo=1#/";
const OPEN_HREF = "/app/index.html?demo=1#/open";
const COMMAND = "npx contextscope";
// The npm link is added once the package is published (docs/publishing.md); no placeholder links.

const QUESTIONS = [
  {
    n: "01",
    title: "Where did my context go?",
    body: "Every request's window, stacked by category: instructions, tool results, subagent handoffs, attachments, the unlogged remainder. Compaction boundaries are drawn where they happened; the ledger names the block that filled each step.",
    shot: { src: "/screens/session.png", alt: "The session screen: occupancy by category over requests, with compaction boundaries and the request ledger" },
    caption: "Session view on the demo dataset: 768 requests, 4 compactions, a resumed history the transcript does not carry.",
  },
  {
    n: "02",
    title: "What did my subagents cost and return?",
    body: "Each subagent runs in its own window. ContextScope shows that window's peak next to the size of the handoff that came back to the parent, and the ratio between the two, so a fat handoff is visible before it becomes a habit.",
    shot: { src: "/screens/overview.png", alt: "The overview screen: sessions for the repository, trends, and the fattest handoffs and largest blocks" },
    caption: "Overview for one repository, all time: the one change to make first, the sessions, the largest blocks and the fattest handoffs with the child's peak next to each.",
  },
  {
    n: "03",
    title: "What is wrong with my setup, and which change first?",
    body: "Setup and session findings, one card per rule, ranked by severity and tokens affected, each with the evidence that fired it and one platform-correct fix to copy. Thresholds are hypotheses shown next to every finding and editable in place.",
    shot: { src: "/screens/findings.png", alt: "The findings screen: rules grouped by severity with evidence, a fix snippet and editable thresholds" },
    caption: "Findings grouped by rule; the first card is the fix with the most leverage across sessions.",
  },
];

const READS = [
  ["~/.claude/projects/**/*.jsonl", "Claude Code session transcripts and subagent files"],
  ["~/.codex/sessions/**/*.jsonl", "Codex rollouts, including thread_spawn children"],
  ["CLAUDE.md · AGENTS.md · .claude/**", "the repository's instruction chain, rules, skills, agents, hooks, MCP config"],
];

const STORES = [
  "sizes, hashes, tool names and token counts per block",
  "vendor usage fields (input, cache read, cache creation, output) per request",
  "file paths relative to the repository or your home directory",
];

const NEVER = [
  "message text, prompts, tool output or file contents",
  "absolute paths outside your home directory",
  "anything sent over the network: the UI is served on 127.0.0.1 with a per-launch token, and this page has no analytics",
];

export default function Landing() {
  return (
    <main className="site">
      <header className="site-nav">
        <a className="wordmark" href="/" aria-label="ContextScope home">
          <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true"><rect x="1.5" y="1.5" width="15" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M4.5 11.5V9M9 11.5V6M13.5 11.5v-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          ContextScope
        </a>
        <nav className="site-links" aria-label="Site">
          <a href="#questions">What it shows</a>
          <a href="#privacy">Privacy</a>
          <a href="#how">How it works</a>
          <a className="nav-cta" href={DEMO_HREF}>Try the demo</a>
        </nav>
      </header>

      <section className="hero">
        <p className="kicker">A local profiler for coding-agent context · Claude Code and Codex</p>
        <h1>See what fills your coding agent&rsquo;s context window.</h1>
        <p className="lede">
          ContextScope reads the session transcripts Claude Code and Codex already keep on your disk, plus your repository&rsquo;s instruction setup, and shows exactly what filled each model request, what each subagent cost and returned, and which one setup change to make first. It runs on your machine; nothing leaves it.
        </p>
        <div className="command" role="group" aria-label="The one command">
          <span className="prompt" aria-hidden="true">$</span>
          <code>{COMMAND}</code>
          <span className="command-note">npm package <code>contextscope</code> 0.11, publishing now; indexes the sessions of the current repository and opens the UI on 127.0.0.1</span>
        </div>
        <div className="cta-row">
          <a className="btn btn-primary" href={DEMO_HREF}>Try the demo</a>
          <a className="btn" href={OPEN_HREF}>Open an export</a>
          <span className="cta-note">The demo is the same UI on a synthetic dataset. No sign-in, no upload.</span>
        </div>
        <ul className="facts" aria-label="Three things you get">
          <li><strong>Where did my context go</strong> — by category, request by request, with compactions.</li>
          <li><strong>What did my subagents cost and return</strong> — private window versus handoff.</li>
          <li><strong>What is wrong with my setup</strong> — and the one change to make first.</li>
        </ul>
      </section>

      <section className="questions" id="questions" aria-label="What it shows">
        {QUESTIONS.map((q) => (
          <article className="question" key={q.n}>
            <div className="question-text">
              <p className="kicker">{q.n}</p>
              <h2>{q.title}</h2>
              <p>{q.body}</p>
            </div>
            <figure className="shot">
              <img src={q.shot.src} alt={q.shot.alt} width={1440} height={900} loading="lazy" decoding="async" />
              <figcaption>{q.caption}</figcaption>
            </figure>
          </article>
        ))}
        <p className="honesty">
          <strong>No scores.</strong> Every number carries its provenance: <span className="prov">observed</span> from the vendor&rsquo;s usage fields or an artifact on disk, <span className="prov">derived</span> by exact arithmetic over observations, or <span className="prov">estimated</span> by local reconstruction. Exact and estimated are never summed into one figure without saying so, and &ldquo;not observed&rdquo; stays an em dash.
        </p>
      </section>

      <section className="privacy" id="privacy">
        <div className="privacy-head">
          <p className="kicker">Private by construction</p>
          <h2>Local-first. Index metadata only. Nothing uploaded.</h2>
        </div>
        <div className="privacy-grid">
          <div className="privacy-col">
            <h3>What it reads</h3>
            <ul>
              {READS.map(([path, what]) => <li key={path}><code>{path}</code><span>{what}</span></li>)}
            </ul>
          </div>
          <div className="privacy-col">
            <h3>What the index keeps <span className="muted">(~/.contextscope)</span></h3>
            <ul>{STORES.map((s) => <li key={s}><span>{s}</span></li>)}</ul>
          </div>
          <div className="privacy-col privacy-never">
            <h3>What it never stores or sends</h3>
            <ul>{NEVER.map((s) => <li key={s}><span>{s}</span></li>)}</ul>
          </div>
        </div>
        <p className="privacy-note">
          Sharing a finding is a file you make on purpose: <code>contextscope export --run &lt;vendor:id&gt; --redact-labels</code> writes a <code>contextscope.export/1</code> document (sizes, hashes, token counts, findings; every file label and path-like token hashed with a per-export salt, instruction-file names kept) plus a markdown summary, and refuses to write it if any absolute path survives. The demo&rsquo;s <a href={OPEN_HREF}>Open an export</a> screen parses it in your browser and uploads nothing.
        </p>
      </section>

      <section className="how" id="how">
        <p className="kicker">How it works</p>
        <ol className="steps">
          <li><span className="step-n">1</span><div><h3>Run it in a repository</h3><p><code>{COMMAND}</code> discovers the vendors present, asks once which directories it may read, indexes the changed session files in seconds, and opens the UI; <code>contextscope scan</code> prints the same summary in the terminal.</p></div></li>
          <li><span className="step-n">2</span><div><h3>Read the three answers</h3><p>The UI opens on a loopback port with a per-launch token: overview for the repository, one screen per session, findings with suggested fixes, and the setup inventory with its startup budget.</p></div></li>
          <li><span className="step-n">3</span><div><h3>Fix one thing, then re-scan</h3><p>Treat the fix as a hypothesis: copy it into <code>CLAUDE.md</code>, <code>AGENTS.md</code> or the agent definition it names, and let the next sessions show whether the finding went away. Export a session to put the evidence in a PR.</p></div></li>
        </ol>
        <div className="cta-row">
          <a className="btn btn-primary" href={DEMO_HREF}>Try the demo</a>
          <a className="btn" href={OPEN_HREF}>Open an export</a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-links">
          <span><a href="https://github.com/open-mercato/context-scope" rel="noreferrer">GitHub repository</a></span>
          <span><span className="soon">coming soon</span> npm: <code>contextscope</code></span>
          <span><a href={DEMO_HREF}>Demo</a></span>
          <span><a href={OPEN_HREF}>Open an export</a></span>
        </div>
        <p className="footer-note">ContextScope is a profiler, not a scorecard. Synthetic sessions in the demo; your own sessions never leave your machine.</p>
      </footer>
    </main>
  );
}
