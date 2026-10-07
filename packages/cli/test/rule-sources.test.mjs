import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSources, sourcesFor, withSources } from "../src/rules/sources.mjs";

const rulesDir = new URL("../src/rules/", import.meta.url);
const ruleIds = fs.readdirSync(rulesDir).filter((name) => /^[SBH]-\d{2}\.mjs$/.test(name)).map((name) => name.replace(".mjs", "")).sort();

test("every rule has a basis entry, every cited source exists, and every source is an https URL with a title", () => {
  const { sources, rules } = loadSources();
  const ids = new Set(sources.map((source) => source.id));
  assert.equal(ids.size, sources.length, "source ids are unique");
  for (const source of sources) {
    assert.match(source.url, /^https:\/\//, source.id);
    assert.ok(source.title && source.type, source.id);
  }
  for (const id of ruleIds) {
    const entry = rules[id];
    assert.ok(entry, `${id} has an entry in sources.json`);
    assert.ok(["sourced", "inferred", "opinion"].includes(entry.basis), `${id} basis`);
    assert.ok(entry.note, `${id} says what is sourced and what is opinion`);
    for (const sid of entry.sources ?? []) assert.ok(ids.has(sid), `${id} cites unknown source ${sid}`);
    if (entry.basis === "sourced") assert.ok(entry.sources.length > 0, `${id} is "sourced" but cites nothing`);
  }
  assert.deepEqual(Object.keys(rules).sort(), ruleIds, "no entries for rules that do not exist");
});

test("sources attach at read time and never mutate the finding", () => {
  const finding = { ruleId: "B-05", title: "Fat subagent handoff" };
  const attached = withSources(finding);
  assert.equal(finding.basis, undefined);
  assert.equal(attached.basis.basis, sourcesFor("B-05").basis);
  assert.ok(attached.basis.sources.every((source) => source.url && source.title));
  assert.equal(withSources({ ruleId: "X-99" }).basis, undefined);
});

test("docs/sources.md is generated from sources.json and up to date", () => {
  const script = fileURLToPath(new URL("../scripts/sources-doc.mjs", import.meta.url));
  execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });
});
