import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { claudeProjectDirFor, decodeProjectDir, displaySessionFile, encodedDirIsReversible, encodedProjectDirToKey, projectKeyFor } from "../src/ir/project.mjs";

const sha8 = (text) => createHash("sha1").update(text).digest("hex").slice(0, 8);

test("projectKeyFor is basename + 8 hex of sha1(cwd), never the path", () => {
  const cwd = "/opt/client/secret-repo";
  const key = projectKeyFor(cwd);
  assert.equal(key, `secret-repo-${sha8(cwd)}`);
  assert.ok(!key.includes("/opt") && !key.includes("-opt-client"));
  assert.equal(projectKeyFor(cwd + "/"), key, "trailing slash is normalised");
  assert.equal(projectKeyFor("C:\\Users\\x\\repo"), `repo-${sha8("C:/Users/x/repo")}`);
  assert.equal(projectKeyFor(""), `unknown-${sha8("")}`);
});

test("encodedProjectDirToKey matches projectKeyFor when the encoding is reversible, and is documented otherwise", () => {
  const cwd = "/Users/x/projects/foo";
  const dir = claudeProjectDirFor(cwd);
  assert.equal(dir, "-Users-x-projects-foo");
  assert.equal(decodeProjectDir(dir), cwd);
  assert.equal(encodedDirIsReversible(cwd), true);
  assert.equal(encodedProjectDirToKey(dir), projectKeyFor(cwd));

  const dashed = "/Users/x/projects/open-mercato-2";
  assert.equal(encodedDirIsReversible(dashed), false, "a dash inside a segment makes the decode ambiguous");
  assert.notEqual(encodedProjectDirToKey(claudeProjectDirFor(dashed)), projectKeyFor(dashed));
  assert.equal(encodedProjectDirToKey(claudeProjectDirFor(dashed)), encodedProjectDirToKey(claudeProjectDirFor(dashed)), "deterministic");

  const notEncoded = "C--Users-x-repo";
  assert.equal(encodedProjectDirToKey(notEncoded), `${notEncoded}-${sha8(notEncoded)}`, "non-absolute names hash the encoded name itself");
});

test("displaySessionFile is ~-relative and replaces the encoded project-dir segment with the key", () => {
  const home = "/Users/x";
  const projectDir = `${home}/.claude/projects/-Users-x-projects-foo`;
  const file = `${projectDir}/1111.jsonl`;
  const key = projectKeyFor("/Users/x/projects/foo");
  assert.equal(displaySessionFile(file, { home, projectDir, projectKey: key }), `~/.claude/projects/${key}/1111.jsonl`);
  assert.equal(displaySessionFile(file, { home }), `~/.claude/projects/${key}/1111.jsonl`, "derived from the directory name when no key is given");
  assert.equal(displaySessionFile(`${projectDir}/1111/subagents/agent-a.jsonl`, { home, projectDir, projectKey: key }), `~/.claude/projects/${key}/1111/subagents/agent-a.jsonl`);
  assert.equal(displaySessionFile("/srv/elsewhere/-opt-x/2222.jsonl", { home }), "2222.jsonl", "outside home only the basename survives");
  assert.equal(displaySessionFile(`${home}/.codex/sessions/2026/09/01/rollout-x.jsonl`, { home }), "~/.codex/sessions/2026/09/01/rollout-x.jsonl");
});
