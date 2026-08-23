# Relay: #1500 / #1427-D — shared web form visuals into @moss/ui

Context-meter 70% relay trigger. The CSS move itself is done and committed; what's left is
verification, live-path proof, and wrap-up.

Handoff doc (read this first, it has coordinator/scope/collision info):
`docs/coordination/1834-handoff-1500-shared-web-forms.md` — **not committed on this branch**
(that directory is coordinator-owned, per CLAUDE.md "do not touch docs/coordination"); it exists
as an untracked local file in this worktree, copied verbatim from commit `3ec1813fe` on branch
`coord-1834-relay11-handoff`. If it's ever missing, re-fetch with:
`git show 3ec1813fe:docs/coordination/1834-handoff-1500-shared-web-forms.md`.

Plan (full decisions, exact CSS moved): `docs/superpowers/plans/2026-08-22-1500-css-web-forms.md`.
**Plan is approved by the coordinator** — do not re-ask.

## Done (commit `f6aa258ba` on branch `1500-shared-web-forms`)

- Moved the 56 banned visual declarations from `apps/web/src/styles/components-forms.css` into
  the existing `packages/ui/src/styles/components-forms.css`. Layout-only declarations stay in the
  app file. No selector/markup/token changes.
- Registered `apps/web/src/styles/components-forms.css` in `MIGRATED_SECTION_CSS_FILES` in
  `scripts/check-design-tokens.ts`.
- Verified: `pnpm check:design-tokens` exit 0. A throwaway script confirms 0 banned declarations
  remain in the app file (recreate if needed — see plan's Verification section for the exact
  `checkBannedProperties` call).

## Not yet done — pick up here

1. **Pre-push trio + rebase** (plan's Verification section, and `coordinated-build` step 3b):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
   Also still owed from the plan: `pnpm check:ui-classes`, `pnpm check:file-size`,
   `pnpm exec vitest run tests/unit/check-design-tokens.test.ts` — all expect exit 0.

2. **Live-path browser proof** — Settings → Appearance pane (`/settings`, Appearance tab), desktop
   width + mobile width, light + dark mode — 4 screenshot pairs, before (main) vs after (this
   branch), compared for pixel-identical result. This is the plan's Task 3 and the handoff's
   explicit width-axis requirement (#1499 missed the mobile pass and had to add it after the fact
   — don't repeat that).
   **Coordinator's added note (from plan approval):** the Appearance pane only exercises 4 of 6
   form-control families (input, textarea, select, segmented) — no checkbox or switch. Give those a
   quick look somewhere too, e.g. `apps/web/src/wellness/export-modal.tsx` (checkbox) or a settings
   pane using `packages/ui/src/switch.tsx`. Doesn't need to be exhaustive, just a sanity check that
   the moved checkbox/switch declarations render identically.
   Dev instance: `http://192.168.50.36:5173` (start with `pnpm dev:api` + `pnpm dev:web` from
   `~/Jarv1s` if not already running — check first, don't blindly restart). Login `ben@ben.com` /
   `jarvistest123!`.
   **Kill gate (plan):** if any post-move screenshot differs beyond antialiasing noise, stop,
   revert the CSS move, escalate to the coordinator with the specific selector/property — do not
   open the PR.

3. **`coordinated-wrap-up`** — once the gate and proof are clean: push, open PR (`Part of
   #1427/#1470`, body links spec + plan), post the 4 screenshot pairs + gate output as a PR
   comment, fill in the Release note section per `CLAUDE.md` (this is CSS-only internal cleanup,
   no user-visible behavior change — likely `Category: N/A`, confirm against
   `docs/DEVELOPMENT_STANDARDS.md` if unsure), report the PR + evidence to the coordinator. Do not
   merge, close the issue, or move the board — that's the coordinator's.

## Collision / scope notes (from the original handoff, still binding)

- Order in chain: child 4 of 7. #1499 (child C) already merged. #1501 is waiting on this PR.
- Stay in scope — do not absorb #1501/#1502/#1503 (siblings E/F/G).
- Do not touch `docs/coordination/` or run repo-wide `pnpm format` / broad `git add`.

Coordinator: agent name `coordinator` (confirm still the sole live agent with that name via
`herdr agent list` before messaging — don't trust this doc's snapshot).
