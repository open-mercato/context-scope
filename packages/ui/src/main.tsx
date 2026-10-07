import { Component, h, render, type ComponentChildren, type ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { hrefs, navigate, route, routeHasAnchor, routeKey, splitRunId, type Route } from "./router.ts";
import { activeLiveRuns, effectiveTheme, indexStatus, keyboardMapOpen, modalOpen, paletteOpen, pendingFile, refreshIndex, startIndexEvents, theme, thresholdsDrawerOpen, toast, toggleTheme } from "./store.ts";
import { CLI_COMMAND, ISSUES_URL, REPO_URL } from "./config.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Badge } from "./components/Badge.tsx";
import { formatNumber, formatRelative, formatTokens } from "./format.ts";
import { useTick } from "./hooks.ts";
import { KeyboardMap } from "./components/KeyboardMap.tsx";
import { Toasts } from "./components/Toast.tsx";
import { ErrorNotice, Loading } from "./components/Status.tsx";
import { OverviewScreen } from "./screens/Overview.tsx";
import { FirstRun, isFirstRun } from "./components/FirstRun.tsx";
import { FindingsScreen } from "./screens/Findings.tsx";
import { OpenScreen } from "./screens/Open.tsx";
import { backend, backendVersion, startedInCompanion, unloadExport } from "./api.ts";
import type { SetupScreenProps } from "./screens/Setup.tsx";
import type { SessionScreenProps } from "./screens/Session.tsx";

// Heavy screens load on demand (code-split chunks); the loader is cached after the first import.
const loadSetup = () => import("./screens/Setup.tsx").then((m) => m.SetupScreen);
const loadTokens = () => import("./screens/Tokens.tsx").then((m) => m.TokensScreen);
const loadSession = () => import("./screens/Session.tsx").then((m) => m.SessionScreen);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyScreen = ComponentType<any>;
function Lazy({ load, props, label }: { load: () => Promise<AnyScreen>; props: SetupScreenProps | SessionScreenProps | Record<string, never>; label: string }) {
  const [Screen, setScreen] = useState<AnyScreen | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  useEffect(() => {
    let live = true;
    load().then((c) => { if (live) setScreen(() => c); }).catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e : new Error(String(e))); });
    return () => { live = false; };
  }, [load]);
  if (failed) return <section class="screen"><ErrorNotice error={failed} retry={() => location.reload()} /></section>;
  if (!Screen) return <section class="screen"><Loading label={label} /></section>;
  return h(Screen, props);
}

/** Last visited session so `g u` can return to it. */
const lastSession = signal<Extract<Route, { name: "session" }> | null>(null);

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function useGlobalKeys() {
  useEffect(() => {
    let pendingG = 0;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // ⌘K / Ctrl+K opens the palette from anywhere, including inside an input.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        if (keyboardMapOpen.value) keyboardMapOpen.value = false;
        paletteOpen.value = !paletteOpen.value;
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const editable = isEditable(event.target);
      if (event.key === "Escape") {
        if (paletteOpen.value) { paletteOpen.value = false; event.preventDefault(); return; }
        if (keyboardMapOpen.value) { keyboardMapOpen.value = false; event.preventDefault(); return; }
        if (thresholdsDrawerOpen.value) { thresholdsDrawerOpen.value = false; event.preventDefault(); return; }
        if (editable) {
          const input = event.target as HTMLInputElement;
          if (input.value) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
          input.blur();
          event.preventDefault();
        }
        return;
      }
      if (editable || modalOpen()) return;
      const now = Date.now();
      if (pendingG && now - pendingG < 1200) {
        pendingG = 0;
        const go: Record<string, string | undefined> = {
          o: hrefs.overview(), s: hrefs.setup(), f: hrefs.findings(),
          u: lastSession.value ? hrefs.session(lastSession.value.vendor, lastSession.value.id, { scope: lastSession.value.scope, request: lastSession.value.request }) : undefined,
        };
        const target = go[event.key];
        if (target) { event.preventDefault(); navigate(target); }
        return;
      }
      switch (event.key) {
        case "g": pendingG = now; return;
        case "/": {
          const filter = document.querySelector<HTMLInputElement>("[data-filter]");
          if (filter) { event.preventDefault(); filter.focus(); filter.select(); }
          return;
        }
        case "t": event.preventDefault(); toggleTheme(); return;
        case "?": event.preventDefault(); keyboardMapOpen.value = !keyboardMapOpen.value; return;
        case "c": {
          const active = document.activeElement?.closest?.("[data-finding]");
          const button = active?.querySelector<HTMLButtonElement>("[data-copy-fix]");
          if (button) { event.preventDefault(); button.click(); }
          else if (document.querySelector("[data-finding]")) { event.preventDefault(); toast("Focus a finding first (Tab to a card), then press c"); }
          return;
        }
        default: return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

function IndexPill() {
  const status = indexStatus.value;
  const mode = backend.value.mode;
  const now = useTick(15_000);
  let text: string;
  let cls = "pill-idle";
  let title = "Index status";
  const files = status.files ? ` · ${formatNumber(status.files)} files` : "";
  // Static and memory modes have no index and no companion: say what the data is instead of claiming a pass ran (#10, #24).
  if (mode === "static") { text = "demo data"; title = "Synthetic sessions served as static files; nothing is indexed or re-scanned"; }
  else if (mode === "memory") { text = "opened export"; title = `${backend.value.label ?? "export"} · parsed in this browser; nothing is indexed`; }
  else if (status.state === "indexing") { text = status.total ? `indexing ${status.done}/${status.total}` : "indexing"; cls = "pill-busy"; }
  else if (status.state === "connecting") { text = "connecting"; cls = "pill-busy"; }
  else if (status.state === "offline") { text = "companion offline"; cls = "pill-offline"; }
  else text = status.lastRunAt ? `indexed · ${formatRelative(status.lastRunAt, now)}${files}` : `indexed${files}`;
  // Announce state transitions only; the relative time tick stays silent.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (mode !== "companion") { setAnnounced(""); return; }
    setAnnounced(status.state === "indexing" ? "Indexing sessions" : status.state === "offline" ? "Companion offline" : status.state === "idle" ? "Index up to date" : "");
  }, [status.state, mode]);
  return (
    <>
      <span class={`index-pill ${cls}`} title={title}>
        <span class="pill-dot" aria-hidden="true" />{text}
      </span>
      <span class="visually-hidden" role="status" aria-live="polite">{announced}</span>
    </>
  );
}

function ThemeToggle() {
  const dark = effectiveTheme() === "dark";
  return (
    <button type="button" class="icon-btn" onClick={toggleTheme} title={`Switch to ${dark ? "light" : "dark"} theme (t)`} aria-label={`Switch to ${dark ? "light" : "dark"} theme${theme.value === "system" ? " (following the OS now)" : ""}`}>
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
      )}
    </button>
  );
}

/** "● live" in the top bar whenever a transcript is growing right now; links to the session (the first one when several are live). */
function LiveLink() {
  const now = useTick(5_000);
  const live = activeLiveRuns(now);
  if (!live.length) return null;
  const [runId, info] = live[0];
  const { vendor, id } = splitRunId(runId);
  const current = route.value;
  const here = current.name === "session" && current.vendor === vendor && current.id === id;
  const title = live.length === 1
    ? `A ${info.vendor ?? vendor} session is being written right now${info.requests ? ` · ${formatNumber(info.requests)} requests` : ""}${info.peak ? ` · ${formatTokens(info.peak)} peak` : ""}`
    : `${live.length} sessions are being written right now; opens the most recent`;
  return (
    <a href={hrefs.session(vendor, id)} class={`topbar-live${here ? " here" : ""}`} title={title} aria-current={here ? "page" : undefined}>
      <span class="live-dot" aria-hidden="true" />{live.length === 1 ? "live" : `${live.length} live`}
    </a>
  );
}

function TopBar() {
  const current = route.value;
  const mode = backend.value.mode;
  const busy = mode === "companion" && indexStatus.value.state === "indexing";
  const refreshTitle = mode === "static" ? "Reload the demo files" : mode === "memory" ? "Re-read the opened export" : "Re-scan session files";
  const active = (name: Route["name"]) => (current.name === name ? "nav-link active" : "nav-link");
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <a href={hrefs.overview()} class="wordmark" aria-label="ContextScope home">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1.5" y="1.5" width="15" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M4.5 11.5V9M9 11.5V6M13.5 11.5v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          ContextScope
        </a>
        <nav class="nav" aria-label="Screens">
          <a href={hrefs.overview()} class={active("overview")} aria-current={current.name === "overview" ? "page" : undefined}>Overview</a>
          <a href={hrefs.setup()} class={active("setup")} aria-current={current.name === "setup" ? "page" : undefined}>Setup</a>
          <a href={hrefs.findings()} class={active("findings")} aria-current={current.name === "findings" ? "page" : undefined}>Findings</a>
          <a href={hrefs.tokens()} class={active("tokens")} aria-current={current.name === "tokens" ? "page" : undefined}>Tokens</a>
          {current.name === "session" || lastSession.value ? (
            <a href={lastSession.value ? hrefs.session(lastSession.value.vendor, lastSession.value.id) : "#/"} class={active("session")} aria-current={current.name === "session" ? "page" : undefined}>Session</a>
          ) : null}
          <LiveLink />
        </nav>
        <div class="topbar-tools">
          <button type="button" class="jump-btn" onClick={() => { paletteOpen.value = true; }} title="Jump to a session, screen or action (⌘K / Ctrl+K)" aria-label="Jump to a session, screen or action">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
            <span class="jump-text">Jump to…</span><kbd class="jump-kbd">⌘K</kbd>
          </button>
          <IndexPill />
          <button type="button" class="icon-btn" onClick={() => void refreshIndex()} disabled={busy} title={refreshTitle} aria-label={refreshTitle}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class={busy ? "spin" : ""}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><path d="M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <ThemeToggle />
          <button type="button" class="icon-btn" onClick={() => { keyboardMapOpen.value = true; }} title="Keyboard map (?)" aria-label="Keyboard map">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M4 6.5h1M7.5 6.5h1M11 6.5h1M4 9.5h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * Demo / export banner: shown whenever the data does not come from a loopback
 * companion, so nobody mistakes synthetic or imported sessions for their own.
 */
function DemoBanner() {
  const info = backend.value;
  if (info.mode === "companion") return null;
  const memory = info.mode === "memory";
  const back = startedInCompanion() ? "Back to your sessions" : "Back to the demo";
  return (
    <div class={`demo-banner ${memory ? "demo-banner-memory" : ""}`} role="note" aria-label={memory ? "Opened export" : "Demo data"}>
      <div class="demo-banner-inner">
        <span class="demo-banner-tag">{memory ? "Export" : "Demo data"}</span>
        <span class="demo-banner-text" title={memory ? `Showing ${info.label}, parsed in this browser; nothing was uploaded` : `Synthetic sessions; run ${CLI_COMMAND} on your machine to see your own sessions; nothing you do here leaves the browser`}>
          {memory ? (
            <>Showing <code>{info.label}</code><span class="demo-banner-long">, parsed in this browser · nothing was uploaded</span></>
          ) : (
            <><span class="demo-banner-long">Synthetic sessions · run <code>{CLI_COMMAND}</code> on your machine to see your own sessions · </span>nothing leaves the browser</>
          )}
        </span>
        <span class="demo-banner-links">
          {memory ? <button type="button" class="btn btn-ghost" onClick={() => { unloadExport(); navigate(hrefs.overview()); }}>{back}</button> : null}
          <a href={hrefs.open()} class="btn btn-ghost">{memory ? "Open another export" : "Open an export"}</a>
        </span>
      </div>
    </div>
  );
}

/** Version, locality promise, provenance legend and the two keyboard entry points; the same on every screen. */
function Footer() {
  const mode = backend.value.mode;
  return (
    <footer class="app-foot" aria-label="About">
      <div class="app-foot-inner">
        <span class="app-foot-brand"><strong>ContextScope</strong> <span class="muted">v{__CS_VERSION__}</span> <span class="muted">· {mode === "companion" ? "reads ~/.claude and ~/.codex on this machine · nothing leaves it" : mode === "memory" ? "an opened export, parsed in this browser" : "demo data"}</span></span>
        <span class="app-foot-legend" title="Every number carries where it comes from">
          <span class="muted">Provenance</span>
          <Badge provenance="observed.vendor" /><Badge provenance="observed.artifact" /><Badge provenance="derived.exact" /><Badge provenance="estimated.local" />
        </span>
        <span class="app-foot-links">
          <button type="button" class="link" onClick={() => { paletteOpen.value = true; }}><kbd>⌘K</kbd> jump</button>
          <button type="button" class="link" onClick={() => { keyboardMapOpen.value = true; }}><kbd>?</kbd> keys</button>
          <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a href={ISSUES_URL} target="_blank" rel="noreferrer">Report an issue</a>
        </span>
      </div>
    </footer>
  );
}

/** Catches render exceptions. Keyed by route in App, so it resets on every navigation; Reload reloads the page. */
class ErrorBoundary extends Component<{ children: ComponentChildren }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("ContextScope UI error", error); }
  render() {
    if (this.state.error) {
      return (
        <div class="screen">
          <ErrorNotice error={this.state.error} retry={() => location.reload()} />
          <p class="muted"><a href={hrefs.overview()}>Back to the overview</a> · <a href={ISSUES_URL} target="_blank" rel="noreferrer">File an issue</a></p>
        </div>
      );
    }
    return this.props.children;
  }
}

function Screen() {
  const current = route.value;
  switch (current.name) {
    // First run (ADR-005 §6): the teaching card sits above the overview until the companion's first pass has finished.
    case "overview": return <>{isFirstRun() ? <section class="screen first-run"><FirstRun /></section> : null}<OverviewScreen /></>;
    case "setup": return <Lazy load={loadSetup} props={{ file: current.file }} label="Loading setup" />;
    case "findings": return <FindingsScreen scope={current.scope} vendor={current.vendor} />;
    case "open": return <OpenScreen />;
    case "tokens": return <Lazy load={loadTokens} props={{}} label="Loading token counter" />;
    case "session": return <Lazy load={loadSession} props={{ vendor: current.vendor, id: current.id, scope: current.scope, request: current.request }} label={`Loading session ${current.id.slice(0, 8)}`} />;
    default:
      return (
        <section class="screen">
          <h1>Not found</h1>
          <p class="muted">No screen at <code>#{current.path}</code>. <a href={hrefs.overview()}>Back to the overview</a>.</p>
        </section>
      );
  }
}

/**
 * Dropping a file outside `#/open` used to navigate the tab to the JSON (and
 * lose the `?token=` URL). Now the drop is swallowed, the file is parked in
 * `pendingFile`, and the Open screen picks it up (#21).
 */
function useGlobalDrop() {
  useEffect(() => {
    const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      if (route.value.name === "open" || route.value.name === "tokens") return; // these screens handle their own drops
      pendingFile.value = file;
      navigate(hrefs.open());
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, []);
}

function App() {
  useGlobalKeys();
  useGlobalDrop();
  // Re-subscribe whenever the backend changes (an export opened or closed) so `done`/`live` events reach the right listeners (#2).
  const backendKey = backendVersion.value;
  useEffect(() => { startIndexEvents(); }, [backendKey]);
  const current = route.value;
  const key = routeKey(current);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (current.name === "session") lastSession.value = current;
    document.title = `ContextScope · ${current.name === "session" ? `Session ${current.id.slice(0, 8)}` : current.name === "open" ? "Open an export" : current.name[0].toUpperCase() + current.name.slice(1)}`;
    if (lastKey.current !== key && !routeHasAnchor(current)) window.scrollTo({ top: 0 });
    lastKey.current = key;
  }, [current, key]);
  return (
    <>
      <a href="#main" class="skip-link">Skip to content</a>
      <TopBar />
      <DemoBanner />
      <main id="main" class="shell" key={key}>
        <ErrorBoundary key={key}>
          <Screen />
        </ErrorBoundary>
      </main>
      <Footer />
      <KeyboardMap />
      <CommandPalette />
      <Toasts />
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
