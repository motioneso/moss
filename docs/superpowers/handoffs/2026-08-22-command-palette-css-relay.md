# Relay: #1498 / #1427-B — command palette CSS cleanup

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, child B row (line 142).
Plan: `docs/superpowers/plans/2026-08-22-command-palette-css-residue.md`.
Branch/worktree: `1498-command-palette-css`, this worktree. Coordinator herdr agent name:
`coordinator`. Sign off messages with your own pane id (`$HERDR_PANE_ID`).

## Done (2 commits, already rebased onto current main)

1. `docs: plan for #1498 command-palette CSS residue extraction`
2. `fix(ui): move command-palette visual CSS into @moss/ui` — moved the 48 banned declarations
   (color, background, border, radius, shadow, font) out of
   `apps/web/src/styles/command-palette.css` into new
   `packages/ui/src/styles/components-command-palette.css`, registered the new sheet in
   `packages/ui/src/styles.css`, and added a temporary registration for the app file in
   `MIGRATED_SECTION_CSS_FILES` in `scripts/check-design-tokens.ts`. Layout declarations
   (position, flex, sizing, animation, cursor) stayed in the app file. No selector, value, or
   markup changed.

Verified green already, do not re-run unless you touch the CSS again:
- `pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm check:file-size` — all exit 0.
- `pnpm exec vitest run tests/unit/check-design-tokens.test.ts` — 4/4 pass.
- `pnpm format:check && pnpm lint && pnpm typecheck` — all exit 0 (ran after formatting the plan
  doc with `pnpm exec prettier --write`).
- A one-off measurement script at `/tmp/measure-cp.mjs` (may not survive a reboot — recreate if
  gone) confirmed the command-palette file goes from 48 banned declarations to 0.

## What's left

1. **Live browser proof.** Command palette open (Ctrl/Cmd+K), light and dark mode, before (main)
   vs after (this branch) screenshots, compared for identical output. This is the spec's required
   proof for child B — see spec line 178.
   - No automated e2e test covers the command palette (grepped `tests/e2e` and `tests/uat` for
     "command-palette" and "kbar" — zero hits), so this is manual screenshot comparison, not a
     Playwright run. Say so plainly in the PR rather than implying UAT coverage that doesn't
     exist.
   - I could not confirm a working live dev instance in the time I had. The documented shared
     instance at `http://192.168.50.36:5173` (see memory `dev-preview-recipe`) returned HTTP 500
     on `/api/health` when I checked — its API proxy looks broken right now (or someone else's
     work-in-progress), and regardless it runs `main`, not this branch's code, so it can't show
     the "after" state on its own.
   - Ports 3001-3030 on this box are occupied by unrelated services and other worktrees' API
     instances; I did not find the actual listening port for a working `@moss/api` dev server.
   - **Recommended next step:** run your own paired instance from this worktree —
     `pnpm dev:api` (check `apps/api` for its actual listen port; it wasn't 3000 when I checked)
     and `pnpm dev:web` (Vite, proxies `/api` to the API via `JARVIS_API_PROXY_TARGET`, defaults
     to `localhost:3000` — override if the API lands elsewhere), pointed at the shared dev
     Postgres (`jarv1s-postgres` on `:55433`, db `jarv1s`, schema `app`; login
     `ben@ben.com` / `jarvistest123!`). Use the `run` skill's server pattern
     (`.claude/skills/run/examples/server.md` from the skill's base dir, or `playwright.md` for a
     browser-driven capture) if you need the exact recipe. Take the "after" screenshots on your
     branch; you can compare visually against the spec description or a quick `git stash`-free
     checkout of `main` in a scratch clone if you want a literal before/after pair, but a careful
     visual read against the unchanged selectors is enough given this is a pure declaration move
     with no value change.
2. **Kill gate (from the plan):** if anything in the screenshots differs beyond antialiasing
   noise, stop, revert the CSS move, and escalate to the coordinator with the specific selector
   and property — do not push through it.
3. **`coordinated-wrap-up`:** once the proof is in hand, clean tree check, push (after re-running
   the pre-push trio if you touched anything else), open the PR, fill in the PR template's
   "Release note" section (this is user-visible only in a subtle way — a CSS-only cascade-position
   change with no visual difference; judge Category, likely `Category: N/A` since nothing visible
   changes, but read the template's own guidance before deciding), post the before/after
   screenshots and an honest statement of what proof this is (manual screenshot comparison, not
   automated UAT) on the PR, then report the PR + evidence to the coordinator. Do not touch the
   board, milestones, or merge.

## Non-goals (unchanged from the plan)

No selector rename, no markup change, no token value change, no touching `styles.css`,
`kit-today*.css`, `assistant-surface.css`, or any other #1427 child's files. No change to
`check-ui-classes.ts` (child E). No guard graduation (child G).
