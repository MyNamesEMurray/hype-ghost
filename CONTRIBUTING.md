# Contributing to Hype Ghost 👻

## Branch model

- **`main`** — the only long-lived branch: the trunk all work targets, and the line the
  installer and auto-updater build from. Released states are pinned by `vX.Y.Z` tags.
- Older lines (1.x, 2.x, and the retired 3.x integration branch `v3`) live in `main`'s
  history and the version tags — there are no standing historical branches.
- **Feature branches** — `claude/<topic>` or `feature/<topic>`, branched off `main`,
  one focused PR each into `main`.

**Merging to `main` releases automatically** when app code changed (`src/`, `public/`,
`electron/`, `assets/`, `config.example.json`, or the package manifests): a patch bump
by default, or the bump named by a `Release-Bump: minor` / `Release-Bump: major` trailer
line in any commit of the PR (`Release-Skip: true` suppresses the release). The version
lives in git tags — CI stamps `package.json` at build time
(`.github/workflows/auto-release.yml` computes and tags; `release.yml` builds the
Windows installer and publishes the GitHub Release the auto-updater reads). Release
notes are generated from PR titles — label PRs `enhancement`/`bug` to sort them
(`.github/release.yml`). Manual fallback: run the Release workflow from Actions against
an existing tag, or push a `vX.Y.Z` tag by hand.

> The one rule worth remembering: **branch off `main`, PR into `main`.**

## Making a change

1. Branch off `main`:
   ```
   git fetch origin
   git switch -c feature/<topic> origin/main
   ```
2. Develop. Keep commits focused — imperative subject line, the "why" in the body.
   To control the release bump, put a trailer on its own line in any commit of the PR:
   `Release-Bump: minor` or `Release-Bump: major` (no trailer = patch;
   `Release-Skip: true` = no release). Trailers must be their own line — prose that
   merely mentions the keywords never triggers anything.
3. Before pushing, run the same checks CI runs:
   ```
   npm ci --ignore-scripts
   for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f"; done
   node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"
   npm test
   npm run smoke
   ```
4. Open a PR into `main` using the template. CI (`.github/workflows/ci.yml`) must be green.

## Conventions

- **Design** — UI changes follow [DESIGN.md](DESIGN.md): color/spacing/type tokens live in
  `public/theme.css`; page `<style>` blocks hold layout only.
- **Ethics (non-negotiable)** — every cast message is labeled `🤖 AI`; the overlay keeps its
  permanent "simulated viewers" watermark; nothing ever touches real Twitch chat or metrics.
- **Config** — `config.example.json` is the single source of defaults (deep-merged at load), so
  every new setting goes there with a sane default and gets a row in the README config reference.
- **Secrets** — never commit `config.json` (it holds the API key); it's gitignored.

## Running locally

```
npm install      # first time (downloads the Electron binary)
npm start        # the desktop app
npm run serve    # headless server only (no window/tray)
npm run smoke    # boot + route check — exactly what CI runs
npm run dist     # build the Windows installer into dist/
```

## CI

`.github/workflows/ci.yml` runs on every PR into `main` and on pushes to it:
syntax-checks all JS, validates `config.example.json`, runs the `node:test` suite, and boots
the headless server to confirm it serves its pages. It installs with `--ignore-scripts` (no
Electron binary needed), so it's fast and needs no Windows runner or display.
