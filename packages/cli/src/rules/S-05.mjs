import { fileEvidence, makeFinding } from "../setup/findings.mjs";

const rule = {
  id: "S-05",
  scope: "setup",
  severity: "medium",
  title: "Instruction references a missing path",
  whyItMatters: "The model trusts instructions; a dead path costs a failed tool call and a wrong assumption per session.",
  thresholdKeys: [],
  evaluate(input) {
    const findings = [];
    for (const file of input.setup?.instructionFiles ?? []) {
      if (!file.brokenRefs?.length) continue;
      const refs = file.brokenRefs.slice(0, 10);
      findings.push(makeFinding(rule, {
        primaryRef: file.path,
        vendor: file.vendors.length === 1 ? file.vendors[0] : undefined,
        evidence: [
          fileEvidence(file.path, `${file.path} references ${file.brokenRefs.length} path(s) that do not exist`, file.brokenRefs.length, "count", "observed.artifact"),
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
