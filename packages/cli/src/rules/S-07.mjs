import { fileEvidence, makeFinding, metricEvidence } from "../setup/findings.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stale instructions. The commit counts come from `git log --since=<mtime> -- <dir>`
 * (src/setup/git.mjs, execFile with a 3 s timeout, only when .git exists) and are
 * carried on the inventory as `commitsSinceMtime`; files without a count are skipped.
 */
const rule = {
  id: "S-07",
  scope: "setup",
  severity: "low",
  title: "Stale instructions",
  whyItMatters: "Stale rules produce confidently wrong behaviour and cost the same tokens as correct ones.",
  thresholdKeys: ["staleInstructionDays", "staleInstructionCommits"],
  evaluate(input, thresholds, { now = Date.now() } = {}) {
    const setup = input.setup;
    if (!setup?.repo?.git) return [];
    const findings = [];
    for (const file of setup.instructionFiles) {
      if (typeof file.commitsSinceMtime !== "number") continue;
      const ageDays = Math.floor((now - Date.parse(file.mtime)) / DAY_MS);
      if (!(ageDays > thresholds.staleInstructionDays) || !(file.commitsSinceMtime > thresholds.staleInstructionCommits)) continue;
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
      findings.push(makeFinding(rule, {
        primaryRef: file.path,
        vendor: file.vendors.length === 1 ? file.vendors[0] : undefined,
        tokensAffected: file.estTokens,
        evidence: [
          fileEvidence(file.path, `${file.path} last modified ${ageDays} days ago (${file.mtime.slice(0, 10)})`, ageDays, "count", "observed.artifact"),
          metricEvidence(`git:${dir}`, `${file.commitsSinceMtime} commits touched ${dir} since then`, file.commitsSinceMtime, "count", "observed.artifact"),
        ],
        fix: {
          platform: file.vendors.length === 1 ? file.vendors[0] : "both",
          summary: `Review ${file.path} against the current structure of ${dir}; delete sections that no longer apply.`,
          path: file.path,
          snippet: `<!-- reviewed ${new Date(now).toISOString().slice(0, 10)}: verified paths, commands and layout below against the current tree -->\n`,
        },
      }));
    }
    return findings;
  },
};

export default rule;
