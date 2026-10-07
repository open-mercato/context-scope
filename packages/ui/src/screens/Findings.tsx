import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Finding, Severity, Thresholds } from "@ir/types.ts";
import { api, backend, isCompanion, type ApiRuleGroup, type FirstChange } from "../api.ts";
import { CLI_COMMAND } from "../config.ts";
import { useFocusTrap, useResource } from "../hooks.ts";
import { hrefs, navigate, splitRunId } from "../router.ts";
import { indexVersion, loadThresholds, rulesVersion, thresholdEditKey, thresholds, thresholdsDrawerOpen, toast } from "../store.ts";
import { formatDate, plural } from "../format.ts";
import { compareFindings, groupFindings, type RuleGroup } from "../findings.ts";
import { ChangePanel, MIN_CARD_N, anchorLabel } from "../components/ChangePanel.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FindingCard, formatThreshold } from "../components/FindingCard.tsx";
import { FindingGroup } from "../components/FindingGroup.tsx";
import { ErrorNotice, Loading } from "../components/Status.tsx";
import type { OverviewRunNode } from "./Overview.tsx";

const SCOPES = ["setup", "session", "subagent", "habit"] as const;
/** Minimum population of the habit rules (ADR-003 §2 `habitMinSessions`); H-04 needs 6, H-06 needs 5. */
const HABIT_MIN_SESSIONS = 3;

export interface FindingsScreenProps { scope?: string; vendor?: string }

/** Companion groups carry the same ordering as the client's; add the representative finding and the shared vendor. */
function fromApiGroups(groups: ApiRuleGroup[]): RuleGroup[] {
  const out: RuleGroup[] = [];
  for (const g of groups) {
    const list = [...(g.findings ?? [])].sort(compareFindings);
    if (!list.length) continue;
    const primary = list[0];
    out.push({ ruleId: g.ruleId, title: g.title || primary.title, severity: g.severity, scope: g.scope, vendor: list.every((f) => f.vendor === primary.vendor) ? primary.vendor : undefined, sessions: g.sessions, occurrences: g.occurrences, tokensAffected: g.tokensAffected, findings: list, primary });
  }
  return out;
}

/**
 * The vendor most of a group's instances belong to. The fix platform of the
 * head finding can disagree with it (ADR-004 §3: a Claude head over Codex
 * children); the card then says so instead of pointing at the wrong file.
 */
function majorityVendor(group: RuleGroup | undefined): { vendor: string; share: number; total: number } | null {
  if (!group) return null;
  const counts = new Map<string, number>();
  for (const f of group.findings) if (f.vendor) counts.set(f.vendor, (counts.get(f.vendor) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return null;
  const [vendor, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { vendor, share: n / total, total };
}

export function FindingsScreen({ scope, vendor }: FindingsScreenProps) {
  const version = indexVersion.value;
  const rules = rulesVersion.value;
  const { data, error, reload } = useResource((signal) => api.findings({ scope, vendor }, signal), [scope, vendor, version, rules]);
  // Session labels for the instance list (#11): project · start date instead of eight hex characters. Best effort; the list renders without it.
  const { data: overview } = useResource((signal) => api.overview({ limit: 200 }, signal).catch(() => null), [version]);
  const [query, setQuery] = useState("");
  useEffect(() => { void loadThresholds(); }, [rules]);
  // "Did the last change help?" (ADR-005 §1): the newest change with ≥ 2 sessions per side; else one muted line. Companion only.
  const { data: changes } = useResource((signal) => (isCompanion() ? api.changes({}, signal).catch(() => null) : Promise.resolve(null)), [version, rules]);
  const lastChange = useMemo(() => (changes?.changes ?? []).find((c) => c.n.before >= MIN_CARD_N && c.n.after >= MIN_CARD_N), [changes]);
  const lastNote = useMemo(() => {
    if (!changes) return null;
    const thin = changes.changes.find((c) => c.n.before < MIN_CARD_N || c.n.after < MIN_CARD_N);
    if (thin) return `${thin.file} (${anchorLabel(thin)}, ${formatDate(thin.at)}): ${thin.n.after} session${thin.n.after === 1 ? "" : "s"} after vs ${thin.n.before} before; not enough sessions to compare (need ${MIN_CARD_N} per side)`;
    if (changes.notes[0]) return changes.notes[0].reason;
    return changes.files ? "No instruction-file edit has sessions on both sides yet." : "No instruction file in this repository to pair sessions around.";
  }, [changes]);

  const runLabel = useMemo(() => {
    const byId = new Map<string, OverviewRunNode>();
    const walk = (runs: OverviewRunNode[] | undefined) => { for (const r of runs ?? []) { byId.set(r.id, r); walk(r.children); } };
    walk(overview?.runs as OverviewRunNode[] | undefined);
    return (runId: string) => {
      const r = byId.get(runId);
      if (!r) return splitRunId(runId).id.slice(0, 8);
      if (r.parentRunId) { const parent = byId.get(r.parentRunId); return `${r.agentType ?? "subagent"} · child of ${parent ? formatDate(parent.startedAt) : splitRunId(r.parentRunId).id.slice(0, 8)}`; }
      return `${r.project.displayName} · ${formatDate(r.startedAt)}`;
    };
  }, [overview]);
  const repoSessions = overview?.scope?.sessions;

  const findings = useMemo(() => {
    const list = data?.findings ?? [];
    const q = query.trim().toLowerCase();
    return list
      .filter((f) => (!scope || f.scope === scope) && (!vendor || f.vendor === vendor))
      .filter((f) => !q || `${f.title} ${f.ruleId} ${f.whyItMatters} ${f.fix.summary} ${f.fix.path ?? ""}`.toLowerCase().includes(q));
  }, [data, scope, vendor, query]);

  // Groups: the companion's (`groups`, already scoped by the route) unless a text filter narrows the list; then group client-side.
  const groups = useMemo(() => (!query.trim() && data?.groups?.length ? fromApiGroups(data.groups) : groupFindings(findings)), [data, findings, query]);
  const vendors = useMemo(() => Array.from(new Set((data?.findings ?? []).map((f) => f.vendor).filter(Boolean) as string[])).sort(), [data]);
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
    for (const g of groups) c[g.severity]++;
    return c;
  }, [groups]);

  if (error) return <section class="screen"><ErrorNotice error={error} retry={reload} /></section>;
  if (!data) return <section class="screen"><Loading label="Loading findings" /></section>;

  // The top card is the API's leverage-ranked `firstChange` (legacy `firstFinding`); with a text filter, the top group's primary finding.
  const apiFirst = data.firstChange ?? data.firstFinding;
  const first: FirstChange | undefined = apiFirst && findings.some((f) => f.ruleId === apiFirst.ruleId) ? apiFirst : groups[0]?.primary;
  const firstGroup = first ? groups.find((g) => g.ruleId === first.ruleId) : undefined;
  // Leverage is a ranking signal, not a score (ADR-001 §6.3): it lives in the tooltip, not on the card (ADR-004 §7.9).
  const leverageTitle = first?.leverage ? `Leverage rank ${first.leverage}: severity × sessions the fix removes findings in` : undefined;
  const subline = first?.removes ? `removes ${plural(first.removes.findings, "finding")} in ${plural(first.removes.sessions, "session")} of this repo`
    : firstGroup ? `${plural(firstGroup.occurrences, "occurrence")} in ${plural(firstGroup.sessions, "session")} of this repo` : undefined;
  const majority = majorityVendor(firstGroup);
  const platformLabel = first && majority && first.fix.platform !== "both" && majority.vendor !== first.fix.platform && majority.share > 0.5
    ? `${majority.vendor} · ${Math.round(majority.share * 100)}% of the ${majority.total} instances; this fix text targets ${first.fix.platform}`
    : undefined;
  const hasAny = (data.findings ?? []).length > 0;
  const mode = backend.value.mode;
  const habitStarved = scope === "habit" && repoSessions !== undefined && repoSessions < HABIT_MIN_SESSIONS;

  return (
    <section class="screen screen-findings">
      <header class="screen-head">
        <div>
          <h1>Findings</h1>
          <p class="screen-sub">
            {groups.length ? (
              <>{plural(groups.length, "rule")} · {plural(findings.length, "finding")} · <span class="sev-text sev-high">{counts.high} high</span> · <span class="sev-text sev-medium">{counts.medium} medium</span> · <span class="sev-text sev-low">{counts.low} low</span> · one card per rule, ordered by severity, tokens affected, sessions · fixes are hypotheses to test</>
            ) : "No findings match the current filters"}
          </p>
        </div>
        <div class="screen-tools">
          <input type="search" class="filter-input" data-filter placeholder="Filter findings  ( / )" aria-label="Filter findings" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <button type="button" class="btn" onClick={() => { thresholdsDrawerOpen.value = true; }}>Thresholds</button>
        </div>
      </header>

      <nav class="chips" aria-label="Scope and vendor filters">
        <span class="chips-label">Scope</span>
        <a class={`chip ${!scope ? "on" : ""}`} aria-current={!scope ? "true" : undefined} href={hrefs.findings({ vendor })}>all</a>
        {SCOPES.map((s) => <a key={s} class={`chip ${scope === s ? "on" : ""}`} aria-current={scope === s ? "true" : undefined} href={hrefs.findings({ scope: scope === s ? undefined : s, vendor })} title={s === "habit" ? `Cross-session rules H-01..H-06; they need at least ${HABIT_MIN_SESSIONS} sessions of this repo` : undefined}>{s}</a>)}
        <span class="chips-label">Vendor</span>
        <a class={`chip ${!vendor ? "on" : ""}`} aria-current={!vendor ? "true" : undefined} href={hrefs.findings({ scope })}>all</a>
        {vendors.map((v) => <a key={v} class={`chip ${vendor === v ? "on" : ""}`} aria-current={vendor === v ? "true" : undefined} href={hrefs.findings({ scope, vendor: vendor === v ? undefined : v })}>{v}</a>)}
      </nav>

      {!hasAny && !scope && !vendor ? (
        <EmptyState
          title="No findings yet"
          body={<>Rules S-01..S-12 run over the repository setup, B-01..B-16 over indexed sessions and H-01..H-06 over cross-session habits. Nothing has fired, or nothing is indexed for this repository.</>}
          path="~/.contextscope/index/v1/"
          command={`${CLI_COMMAND}   # from the repository you want to inspect`}
        />
      ) : !first ? (
        <EmptyState
          compact
          title={query.trim() ? `Nothing matches “${query.trim()}”` : scope === "habit" ? "No habit findings" : `No ${scope ?? ""}${scope && vendor ? " · " : ""}${vendor ?? ""} findings`}
          body={query.trim()
            ? <>Clear the filter (<kbd>Esc</kbd>) or try another word; the filter matches titles, rule ids, the why and the fix.</>
            : scope === "habit"
              ? <>Habit rules (H-01..H-06) need at least {HABIT_MIN_SESSIONS} sessions of this repository{repoSessions !== undefined ? <>; {habitStarved ? <strong>this repo has {plural(repoSessions, "session")}</strong> : <>this repo has {plural(repoSessions, "session")} and no habit crossed a threshold</>}</> : null}. H-04 needs 6 and H-06 needs 5. They look for repeated fat results, whole-file re-reads, verbose subagents, compaction drift and instruction files that never changed.</>
              : <>No rule in this scope{vendor ? ` for ${vendor}` : ""} crossed a threshold. Pick another scope above, or open <a href={hrefs.findings()}>all findings</a>.</>}
        />
      ) : (
        <>
          <div title={leverageTitle}>
            <FindingCard finding={first} headline="One change to make first" subline={subline} highlight platformLabel={platformLabel} />
          </div>
          {changes && !query.trim() ? (
            lastChange ? (
              <section class="change-card" aria-label="Did the last change help?">
                <h2 class="change-card-title">Did the last change help? <span class="muted">· observational: sessions are different tasks, so this says what moved, not why</span></h2>
                <ChangePanel change={lastChange} />
              </section>
            ) : lastNote ? <p class="change-card-line muted">Did the last change help? {lastNote}</p> : null
          ) : null}
          <section class="finding-group" aria-label="Findings by rule">
            <h2 class="group-title">By rule <span class="muted">· {plural(groups.length, "rule")} · expand a card for the per-session instances</span></h2>
            {groups.map((g, i) => <FindingGroup key={`${g.ruleId}/${g.scope}`} group={g} defaultOpen={i === 0} runLabel={runLabel} />)}
          </section>
        </>
      )}

      {thresholdsDrawerOpen.value ? <ThresholdsDrawer findings={data.findings} mode={mode} onSaved={() => { rulesVersion.value++; reload(); }} /> : null}
    </section>
  );
}

/** Slide-in editor for rule thresholds ("hypotheses"). In companion mode Save PUTs the whole map and the rules re-run; elsewhere the edit stays in memory. */
function ThresholdsDrawer({ findings, mode, onSaved }: { findings: Finding[]; mode: "companion" | "static" | "memory"; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const focusKey = thresholdEditKey.value;
  useFocusTrap(drawerRef, true);
  const companion = mode === "companion";

  useEffect(() => {
    loadThresholds(true).then((t) => {
      if (!t) { setLoadError(new Error("thresholds unavailable")); return; }
      setDraft(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])));
    });
  }, []);

  useEffect(() => {
    if (!draft) return;
    const target = focusKey ? document.getElementById(`th-${focusKey}`) as HTMLInputElement | null : firstInput.current;
    target?.focus();
    target?.select();
  }, [draft, focusKey]);

  const usedBy = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const f of findings) for (const key of f.thresholdKeys ?? []) { const set = map.get(key) ?? new Set<string>(); set.add(f.ruleId); map.set(key, set); }
    return map;
  }, [findings]);

  const close = () => { thresholdsDrawerOpen.value = false; thresholdEditKey.value = null; };

  const save = async () => {
    if (!draft) return;
    const next: Thresholds = {};
    for (const [key, raw] of Object.entries(draft)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) { toast(`${key}: not a number`, "error"); return; }
      next[key] = value;
    }
    setSaving(true);
    try {
      const saved = await api.saveThresholds(next);
      thresholds.value = saved && Object.keys(saved).length ? saved : next;
      toast(companion ? "Thresholds saved · rules re-run" : "Thresholds changed for this page · the 'fires above' lines follow; rules do not re-run here", "success", companion ? 3200 : 5000);
      onSaved();
      close();
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const keys = draft ? Object.keys(draft).sort((a, b) => (focusKey === a ? -1 : focusKey === b ? 1 : a.localeCompare(b))) : [];

  return (
    <div class="dialog-backdrop drawer-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <aside ref={drawerRef} class="drawer" role="dialog" aria-modal="true" aria-labelledby="th-title">
        <header class="dialog-head">
          <div>
            <h2 id="th-title">Thresholds</h2>
            <p class="muted">
              {companion
                ? <>Hypotheses, not truths. Saving writes <code>~/.contextscope/thresholds.json</code> and re-runs the rules locally.</>
                : mode === "static"
                  ? <>Hypotheses, not truths. In the demo, edits only change the “fires above” line under each card; the rules do not re-run and nothing is written.</>
                  : <>Hypotheses, not truths. For an opened export, edits only change the “fires above” line; the findings in the file stay as they were computed.</>}
            </p>
          </div>
          <button type="button" class="btn btn-ghost" onClick={close} aria-label="Close thresholds">Close</button>
        </header>
        {loadError ? <ErrorNotice error={loadError} /> : !draft ? <Loading label="Loading thresholds" /> : (
          <form class="th-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div class="th-list">
              {keys.map((key, i) => {
                const users = usedBy.get(key);
                return (
                  <label key={key} class={`th-row ${focusKey === key ? "th-focus" : ""}`} htmlFor={`th-${key}`}>
                    <span class="th-key">
                      <code>{key}</code>
                      <span class="th-hint muted">
                        {users ? `used by ${Array.from(users).join(", ")}` : "no active finding uses this"} · now {formatThreshold(key, Number(draft[key]) || 0)}
                      </span>
                    </span>
                    <input
                      ref={i === 0 ? firstInput : undefined}
                      id={`th-${key}`}
                      class="th-input"
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={draft[key]}
                      onInput={(e) => setDraft({ ...draft, [key]: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                );
              })}
              {keys.length === 0 ? <p class="muted">No thresholds reported by the companion.</p> : null}
            </div>
            <footer class="drawer-foot">
              <button type="submit" class="btn btn-primary" disabled={saving || keys.length === 0}>{saving ? "Saving…" : companion ? "Save and re-run rules" : "Apply on this page"}</button>
              <button type="button" class="btn" onClick={close}>Cancel</button>
              <button type="button" class="btn btn-ghost" onClick={() => navigate(hrefs.findings())} title="Clear filters">Reset filters</button>
            </footer>
          </form>
        )}
      </aside>
    </div>
  );
}
