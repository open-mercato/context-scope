import { fileEvidence, makeFinding } from "../setup/findings.mjs";
import { IGNORED_DIRS } from "../setup/fs.mjs";

/** Directories the inventory walk skipped (git-ignored, nested repositories), as repo-relative prefixes ending in "/". */
function skippedDirs(setup) {
  return (setup?.excluded ?? []).filter((item) => item?.reason === "gitignored" || item?.reason === "nested-repo").map((item) => String(item.path));
}

/**
 * A reference the inventory could not judge: `~/` paths (the home it saw may be a stand-in, see
 * references.mjs), and paths inside a directory git ignores or a nested checkout (generated
 * projects, build output), which exist only after a generate step this repo does not track.
 */
function unjudgeable(ref, skipped) {
  if (ref.startsWith("~/")) return true;
  const normalized = ref.replace(/^\.\//, "");
  const first = normalized.split("/")[0];
  if (normalized.includes("/") && IGNORED_DIRS.has(first)) return true;
  return skipped.some((dir) => normalized === dir.slice(0, -1) || normalized.startsWith(dir));
}

const rule = {
  id: "S-05",
  scope: "setup",
  // Low: a dead path is hygiene; even after the context filters a reference can be a legitimate forward mention.
  severity: "low",
  title: "Instruction references a missing path",
  whyItMatters: "The model trusts instructions; a dead path costs a failed tool call and a wrong assumption per session.",
  thresholdKeys: [],
  evaluate(input) {
    const findings = [];
    const skipped = skippedDirs(input.setup);
    for (const file of input.setup?.instructionFiles ?? []) {
      const brokenRefs = (file.brokenRefs ?? []).filter((ref) => !unjudgeable(String(ref), skipped));
      if (!brokenRefs.length) continue;
      const refs = brokenRefs.slice(0, 10);
      findings.push(makeFinding(rule, {
        primaryRef: file.path,
        vendor: file.vendors.length === 1 ? file.vendors[0] : undefined,
        evidence: [
          fileEvidence(file.path, `${file.path} references ${brokenRefs.length} path(s) that do not exist`, brokenRefs.length, "count", "observed.artifact"),
          ...refs.map(ref => fileEvidence(ref, `missing: ${ref}`, undefined, undefined, "observed.artifact")),
        ],
        fix: {
          platform: file.vendors.length === 1 ? file.vendors[0] : "both",
          summary: `Update or delete the dead reference(s) in ${file.path}: ${refs.join(", ")}.`,
          path: file.path,
          snippet: refs.map(ref => `- ${ref}  ->  <new path, or remove this line>`).join("\n") + "\n",
        },
      }));
    }
    return findings;
  },
};

export default rule;
