import { useRef } from "preact/hooks";
import { keyboardMapOpen } from "../store.ts";
import { useFocusTrap } from "../hooks.ts";

const ROWS: Array<[string[], string]> = [
  [["⌘ K", "Ctrl K"], "Jump to a session, screen or action"],
  [["g o", "g s", "g f", "g u"], "Go to Overview / Setup / Findings / current Session"],
  [["j", "k"], "Next / previous request (session) or row (first table on the screen)"],
  [["↑", "↓", "Home", "End"], "Move in a focused table; Space expands a group, ← / → collapse or expand"],
  [["Enter"], "Open the focused row or lane; expand the focused ledger row (session)"],
  [["[", "]"], "Jump to previous / next compaction boundary"],
  [["p"], "Pin the focused request (composition stays in the rail)"],
  [["f"], "Live session: follow the newest request again (unpins, keeps the zoom)"],
  [["Home", "End"], "Session: scroll the page to the top / bottom (the ledger never traps it)"],
  [["z", "Z"], "Zoom the brush to ±50 requests around the cursor / reset the zoom"],
  [["← →"], "Nudge a focused brush handle by 1 (Shift: 10); Delete resets"],
  [["/"], "Focus the filter box"],
  [["c"], "Copy the fix of the focused finding"],
  [["t"], "Toggle theme"],
  [["?"], "Show this keyboard map"],
  [["Esc"], "Close a dialog; in a session: unpin (and resume following when live), then clear zoom, then clear filter, then hide the rail"],
];

/** Modal listing the keyboard map from ADR-001 section 2.5. Opened with `?`. */
export function KeyboardMap() {
  const open = keyboardMapOpen.value;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open, closeRef);
  if (!open) return null;
  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) keyboardMapOpen.value = false; }}>
      <div ref={dialogRef} class="dialog" role="dialog" aria-modal="true" aria-labelledby="kbd-title">
        <header class="dialog-head">
          <h2 id="kbd-title">Keyboard map</h2>
          <button ref={closeRef} class="btn btn-ghost" onClick={() => { keyboardMapOpen.value = false; }} aria-label="Close keyboard map">Close</button>
        </header>
        <table class="kbd-table">
          <tbody>
            {ROWS.map(([keys, action]) => (
              <tr key={action}>
                <th scope="row">{keys.map((k, i) => <span key={i}>{i > 0 ? <span class="kbd-sep"> / </span> : null}<kbd>{k}</kbd></span>)}</th>
                <td>{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
