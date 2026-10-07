# Publishing `contextscope` (checklist)

Package name decision (2026-09-02): **`contextscope`**, unscoped. Evidence: `https://registry.npmjs.org/contextscope`
and `https://registry.npmjs.org/@contextscope%2Fcli` both returned HTTP 404 (free). The unscoped name is the one
the landing page, the UI and the README already print; the scoped fallback would have been `@contextscope/cli`.

One command everywhere: `npx contextscope` (landing hero, `#/open` panel, UI empty states, both READMEs, CI snippet
uses `npx contextscope check …`). No `@latest` suffix: npx resolves the latest tag anyway and a second spelling is
what drifted last time.

## TODO before the first publish

- [ ] **Repository URL.** `package.json` (`repository`, `homepage`, `bugs`), the UI error boundary
      (`packages/ui/src/main.tsx` "File an issue"), `docs/publishing.md` and the landing footer use the placeholder
      `https://github.com/pat-lewczuk/contextscope`. No such remote exists yet (the only remote today is the
      ChatGPT-team git host). Create the GitHub repository, push `main`, then replace the placeholder if the
      owner/name differ (`grep -rn "pat-lewczuk/contextscope" --exclude-dir=node_modules .`).
- [ ] **npm account and 2FA.** `npm login` as the publishing user; enable 2FA (auth-and-writes). Confirm the name is
      still free right before publishing: `npm view contextscope version` must fail with E404.
- [ ] **Provenance needs CI.** `npm publish --provenance` only works from a supported CI (GitHub Actions with
      `id-token: write`); a laptop publish cannot carry provenance. Either:
  - [ ] create an npm **automation token** and store it as the `NPM_TOKEN` repository secret
        (`.github/workflows/publish.yml` reads it as `NODE_AUTH_TOKEN`), or
  - [ ] configure npm **trusted publishing** for `pat-lewczuk/contextscope` + workflow `publish.yml` on npmjs.com
        (package settings → Trusted publisher) and delete the `NODE_AUTH_TOKEN` line from the workflow.
- [ ] **UI bundle is part of the tarball.** `packages/cli/ui/` (`index.html`, `app.js`, `app.css`, chunks) is built by
      `cd packages/ui && npm ci && npm run build`; both workflows build it before packing. `scripts/prepack.mjs`
      refuses a pack without it or with a bundle older than `packages/ui/src`.
- [ ] **Dry run.** `cd packages/cli && npm pack --dry-run` — expect `src/**`, `ui/**`, `README.md`, `CHANGELOG.md`,
      `LICENSE`, `package.json` only (no `test/`, `scripts/` except none, no fixtures). Last measured: see the cycle
      log entry for the fix wave.
- [ ] **Release.** Bump `packages/cli/package.json` (`0.11.0` now), update `packages/cli/CHANGELOG.md`, commit,
      `git tag v0.11.0 && git push --tags`. The `publish` workflow checks the tag equals the package version, builds
      the UI, runs the CLI tests and the setup gate, then publishes with `--provenance --access public`.
- [ ] **After publish.** `npx contextscope@0.11.0 help` from an empty directory; open `https://www.npmjs.com/package/contextscope`
      and confirm the provenance badge; replace the "coming soon" footer links on the landing page (`app/page.tsx`)
      with the real npm and GitHub links.

## What ships

`files` in `package.json`: `src/` (adapters, index, rules, server, commands, export, capture, setup, util),
`ui/` (prebuilt bundle), `README.md`, `CHANGELOG.md`, `LICENSE`. Excluded by construction: `test/` (fixtures with
synthetic transcripts), `scripts/` (calibration and smoke tools that read real sessions; `prepack.mjs` runs only at
pack time from the repository), `docs/`, the site.

`engines.node >= 20`, zero runtime dependencies, `bin: { contextscope }`.

Smoke test after `npm pack` / before tagging (all from an empty directory, no index): `contextscope help` (every
command and flag; the README command list must match it), `contextscope status` (answers in under 300 ms with
`last pass never` and `companion not running`), `contextscope start --json --yes --no-open` (first line
`{ url, repo, repoKey }`, then NDJSON events ending in `found`; Ctrl+C removes `~/.contextscope/server.json`).

## Versioning

Semver; the export schema tag (`contextscope.export/1`) and the index layout (`~/.contextscope/index/v1`) are
versioned separately and only move on a breaking change of the on-disk contract.
