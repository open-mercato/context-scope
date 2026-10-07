Synthetic Claude Code hook payloads (one per event) for capture.test.mjs. `$HOME`, `$CWD` and `$ENCODED` are
replaced by the test with a temporary home, repo path and its Claude project-directory encoding. Every fixture
carries a `NEVER-STORE` marker in a field the capture script must drop.
