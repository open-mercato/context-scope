import { fileEvidence, makeFinding } from "../setup/findings.mjs";

const rule = {
  id: "S-04",
  scope: "setup",
  severity: "medium",
  title: "Skill frontmatter invalid",
  whyItMatters: "Malformed metadata makes the skill invisible or truncates its description.",
  thresholdKeys: ["skillDescriptionMaxChars"],
  evaluate(input, thresholds) {
    const max = thresholds.skillDescriptionMaxChars;
    const findings = [];
    for (const skill of input.setup?.skills ?? []) {
      const problems = [];
      if (!skill.frontmatterValid) problems.push(skill.frontmatterError ?? "frontmatter does not parse");
      if (skill.descriptionChars > max) problems.push(`description is ${skill.descriptionChars} chars (limit ${max})`);
      if (!problems.length) continue;
      const dirName = skill.path.split("/").at(-2) ?? skill.name;
      findings.push(makeFinding(rule, {
        primaryRef: skill.path,
        vendor: "claude",
        evidence: problems.map(problem => fileEvidence(skill.path, `${skill.path}: ${problem}`, skill.descriptionChars, "chars", "observed.artifact")),
        fix: {
          platform: "claude",
          summary: `Fix the YAML frontmatter of ${skill.path}: name must match the directory (${dirName}) and the description must stay under ${max} characters.`,
          path: skill.path,
          snippet: `---\nname: ${dirName}\ndescription: <one or two sentences, under ${max} characters, saying when to use this skill>\n---\n`,
        },
      }));
    }
    return findings;
  },
};

export default rule;
