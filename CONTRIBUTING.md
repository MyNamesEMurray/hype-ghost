# Contributing to Hype Ghost 👻

## Branch model

- **`main`** — the only long-lived branch: the trunk all work targets, and the line the
  installer and auto-updater build from. Released states are pinned by `vX.Y.Z` tags.
- Older lines (1.x, 2.x, and the retired 3.x integration branch `v3`) live in `main`'s
  history and the version tags — there are no standing historical branches.
- **Feature branches** — `claude/<topic>` or `feature/<topic>`, branched off `main`,
  one focused PR each into `main`.

At release: bump the version in `package.json`, update `RELEASE_NOTES.md`, and tag
(`vX.Y.Z`) — pushing the tag (or running the Release workflow manually from Actions)
builds the Windows installer and publishes the GitHub Release the auto-updater reads
(`.github/workflows/release.yml`).

> The one rule worth remembering: **branch off `main`, PR into `main`.**

## Making a change

1. Branch off `main`:
   ```
   git fetch origin
   git switch -c feature/<topic> origin/main
   ```
2. Develop. Keep commits focused — imperative subject line, the "why" in the body.
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
