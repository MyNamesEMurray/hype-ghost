# Contributing to Hype Ghost 👻

## Branch model

- **`v3`** — the integration branch for 3.x. All feature work targets `v3`.
- **`main`** — the released/stable line the installer and auto-updater build from.
  `v3` merges into `main` at release time.
- Older release lines (1.x, 2.x) live in `main`'s history and the `v1.x` tags — there are
  no standing historical branches.
- **Feature branches** — `claude/<topic>` or `feature/<topic>`, branched off `v3`,
  one focused PR each into `v3`.

At release: merge `v3` → `main`, bump the version in `package.json`, update
`RELEASE_NOTES.md`, tag it (`vX.Y.Z`), and push the tag — the Release workflow
(`.github/workflows/release.yml`) builds the Windows installer and publishes
the GitHub Release the auto-updater reads.

> This is the one rule worth remembering: **branch off `v3`, PR into `v3`.**
> (PR #1 once merged into `v2` by accident — that's the confusion this prevents.)

## Making a change

1. Branch off `v3`:
   ```
   git fetch origin
   git switch -c feature/<topic> origin/v3
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
4. Open a PR into `v3` using the template. CI (`.github/workflows/ci.yml`) must be green.

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

`.github/workflows/ci.yml` runs on every PR into `v3`/`main` and on pushes to those branches:
syntax-checks all JS, validates `config.example.json`, runs the `node:test` suite, and boots
the headless server to confirm it serves its pages. It installs with `--ignore-scripts` (no
Electron binary needed), so it's fast and needs no Windows runner or display.
