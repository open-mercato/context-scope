/**
 * H-05: startup cost before/after an instruction edit. The windows, the anchor
 * list and the confound test come from `index/changes.mjs` (ADR-005 §1: one
 * definition of before/after in the product); the thresholds, the dominant
 * model filter and the finding text are unchanged from cycle 2.
 */
import { formatTokens, makeHabitFinding, median, metricEvidence, recordTime, runEvidence } from "./habits.mjs";
import { anchorsOfFile, cliVersionsOf, dominantModel, windowsFor } from "../index/changes.mjs";

const MAX_FINDINGS = 3;

const modelOf = (record) => ({ model: record.habits?.startup?.model, cliVersion: record.cliVersion ?? record.habits?.startup?.cliVersion ?? "unknown" });

export default {
  id: "H-05",
  scope: "habit",
  severity: "low",
  title: "Startup cost changed after an instruction edit",
  whyItMatters: "The hidden base of request 0 is what every request pays before the conversation starts; an instruction edit that moved it is worth knowing about. Estimated locally (chars per token), not vendor-observed.",
  thresholdKeys: ["habitStartupMinSessions", "habitStartupDeltaTokens", "habitStartupDeltaShare"],
  needs: (thresholds) => 2 * (thresholds.habitStartupMinSessions ?? 2),
  evaluate({ habits, setup, thresholds, notes }) {
    const minEach = thresholds.habitStartupMinSessions ?? 2;
    const minDelta = thresholds.habitStartupDeltaTokens ?? 1000;
    const minShare = thresholds.habitStartupDeltaShare ?? 0.15;
    const usable = (habits ?? []).filter((record) => Number.isFinite(record.habits?.startup?.h0) && record.habits.startup.h0 > 0 && recordTime(record) > 0);
    const files = Array.isArray(setup?.instructionFiles) ? setup.instructionFiles : [];
    if (usable.length < 2 * minEach || !files.length) return [];
    const findings = [];
    // One window per anchor per file (commit anchors when git knows the file, else the mtime), newest first across files.
    const windows = files
      .filter((file) => typeof file?.path === "string")
      .flatMap((file) => windowsFor(usable, anchorsOfFile(file), { timeOf: (record) => Date.parse(record.startedAt ?? "") || recordTime(record) }).map((window) => ({ ...window, path: file.path })))
      .sort((a, b) => Date.parse(b.anchor.at) - Date.parse(a.anchor.at));
    for (const window of windows) {
      if (findings.length >= MAX_FINDINGS) break;
      const { before, after, path: editPath } = window;
      const at = Date.parse(window.anchor.at);
      if (before.length < minEach || after.length < minEach) continue;
      const model = dominantModel([...before, ...after].map(modelOf));
      const beforeM = model ? before.filter((record) => record.habits.startup.model === model) : before;
      const afterM = model ? after.filter((record) => record.habits.startup.model === model) : after;
      if (beforeM.length < minEach || afterM.length < minEach) continue;
      const versions = cliVersionsOf([...beforeM, ...afterM].map(modelOf));
      if (versions.length > 1) {
        notes?.push({ ruleId: this.id, path: editPath, reason: `confounded by a CLI upgrade (${versions.join(", ")})` });
        continue;
      }
      const h0Before = median(beforeM.map((record) => record.habits.startup.h0));
      const h0After = median(afterM.map((record) => record.habits.startup.h0));
      const delta = h0After - h0Before;
      if (Math.abs(delta) < Math.max(minDelta, minShare * h0Before)) continue;
      const up = delta > 0;
      const records = [...beforeM, ...afterM];
      const anchorLabel = window.anchor.anchor === "commit" ? `commit ${window.anchor.commit ?? ""}`.trim() : "edited";
      findings.push(makeHabitFinding(this, {
        primaryRef: `habit:H-05:${editPath}`,
        records,
        title: `Startup cost ${up ? "rose" : "fell"} ${formatTokens(Math.abs(delta))} after editing ${editPath}`,
        tokensAffected: Math.abs(delta) * afterM.length,
        evidence: [
          metricEvidence(this.id, editPath, `median startup base ${formatTokens(h0Before)} in ${beforeM.length} sessions before, ${formatTokens(h0After)} in ${afterM.length} after (${model ?? "any model"}, CLI ${versions[0]})`, Math.round(delta), { unit: "tokens", provenance: "estimated.local" }),
          { kind: "file", ref: editPath, label: `${editPath} ${anchorLabel} ${new Date(at).toISOString().slice(0, 10)}`, provenance: "observed.artifact" },
          ...[...afterM].sort((a, b) => recordTime(b) - recordTime(a)).slice(0, 4).map((record) => runEvidence(record, `startup base ${formatTokens(record.habits.startup.h0)} (after)`, { value: record.habits.startup.h0 })),
        ],
        fix: up
          ? { platform: "both", path: editPath, summary: `The edit to ${editPath} added about ${formatTokens(delta)} to every request's base; trim what the agent does not need on every turn.` }
          : { platform: "both", path: editPath, summary: `Keep the change: ${editPath} now costs about ${formatTokens(-delta)} less per request.` },
      }));
    }
    return findings;
  },
};
