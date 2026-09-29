import { fileEvidence, makeFinding } from "../setup/findings.mjs";

const rule = {
  id: "S-03",
  scope: "setup",
  severity: "high",
  title: "Skill missing description",
  whyItMatters: "The description is the routing key; without it the skill either never loads or loads by accident.",
  thresholdKeys: ["skillDescriptionMinChars"],
  evaluate(input, thresholds) {
    const min = thresholds.skillDescriptionMinChars;
    const findings = [];
    for (const skill of input.setup?.skills ?? []) {
      if (skill.hasDescription && skill.descriptionChars >= min) continue;
      const label = skill.hasDescription
        ? `${skill.path}: description is ${skill.descriptionChars} chars (minimum ${min})`
        : `${skill.path}: no description in frontmatter`;
      findings.push(makeFinding(rule, {
        primaryRef: skill.path,
        vendor: "claude",
        evidence: [fileEvidence(skill.path, label, skill.descriptionChars, "chars", "observed.artifact")],
        fix: {
          platform: "claude",
          summary: `Add a description to ${skill.name} stating when to use it and its trigger phrases.`,
          path: skill.path,
          snippet: `---\nname: ${skill.name}\ndescription: Use when <situation>. Triggers on "<phrase>", "<phrase>". Does <what it does> and returns <output>.\n---\n`,
        },
      }));
    }
    return findings;
  },
};

export default rule;
