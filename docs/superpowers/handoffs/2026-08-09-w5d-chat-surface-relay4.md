# w5d-chat-surface relay #4 — 2026-08-09

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md`, lane D.
**Plan:** `docs/superpowers/plans/2026-08-09-fix-1255-1451-chat-drawer-availability-persona-prefetch.md`
— read by SECTION only. You need just the "Evidence" section (§~139) for the live-path proof.
**Issues:** #1255, #1451. Worktree/branch: this worktree, `w5d-chat-surface`.
**Coordinator:** re-resolve fresh via `herdr agent list` — do not trust a name/session baked into
this doc. As of this relay it was agent name `waves36-coord5`, session
`f264f1c7-0a33-493d-bd33-07a88a5c4733`, but it may have relayed forward again by the time you read
this.

## Status: PR open. Only the live-path proof + coordinator report remain.

**PR: https://github.com/motioneso/moss/pull/1482** — pushed, rebased on `origin/main` (no
conflicts), both tasks' commits + a prettier-fix commit (`d4d722867`) on top.

Verified and stated in the PR body:
- Unit tests green (16 passed).
- format/lint clean.
- `typecheck` and full gate (`pnpm verify:foundation`, isolated DB `jarvis_gate_w5d_chat_surface`
  via `scripts/run-gate.sh`) are **RED**, but confirmed (fresh, this relay — not just trusting the
  prior relay's claim) to be the *same 13 pre-existing* `chat-drawer.tsx` TS2835/TS7006 errors that
  exist verbatim on unmodified `origin/main` (checked via `git show origin/main:apps/web/src/chat/chat-drawer.tsx`
  — identical unextended relative imports at the flagged lines). Root cause: root `tsconfig.json`
  uses `moduleResolution: NodeNext`, `apps/web/tsconfig.json` overrides to `Bundler`. Out of scope
  for this lane (owned files: `chat-drawer.tsx`, `use-assistant-name.ts`, plus touches to
  `app.tsx`/`client.ts`). All other gate steps (file-size, design-tokens, ui-classes,
  migrated-sections, ui-catalogue, ambient-dates, package-deps, format) passed. Gate DB was
  dropped after confirming (`jarvis_gate_w5d_chat_surface`, no longer exists).

## Next step

1. Re-resolve the coordinator's current pane fresh.
2. **Live-path proof for #1451** (spec exit criterion §133 explicitly rejects a unit test — plan's
   Evidence section, same requirement). On a live dev instance: Settings → AI persona → set a
   custom assistant name → reload/re-sign-in → confirm via real UI + screenshot/recording that no
   frame ever shows the default name before the custom one, on every surface `useAssistantName()`
   feeds (drawer header, composer placeholder). Post the proof as a PR comment on #1482 per
   Live-Path Gate (`gh pr comment 1482 --body "..."`).
   - There's an existing UAT spec, `tests/uat/specs/moss-assistant-name.uat.spec.ts`
     (`uat-trigger-map.tsv` maps `apps/web/src/api/use-assistant-name.ts` to it), that proves the
     assistant name threads through surfaces correctly — but it does **not** test the boot-time
     flash scenario specifically (no reload/hard-refresh assertion). Running it is good regression
     evidence but does not by itself satisfy the flash-proof requirement; you likely still need a
     manual live walkthrough (`pnpm test:uat -- moss-assistant-name` as a baseline, plus a manual
     screenshot sequence around reload).
   - **Dev instance port note:** `:5173` is currently occupied by an unrelated worktree
     (`batch1-chat-approvals`'s Vite) — do not touch it. `:3000` (API) was free at last check.
     Use non-standard ports for your own instance (recipe + trusted-origins trap in memory
     `dev-instance-lan-spinup-trusted-origins` / `dev-preview-recipe`) — e.g. API `:3098`, web
     `:5198` (verify free first: `ss -ltnp | grep -E ':3098|:5198'`). Remember
     `JARVIS_AUTH_TRUSTED_ORIGINS` must include the rewritten origin or Better Auth 403s login.
     Ben's dev login: `ben@ben.com` / `jarvistest123!`.
3. Report to the coordinator: PR link, verification summary (including the honest RED-gate/
   pre-existing-cause explanation above), live-path proof link/status. Do not merge, close the
   issue, or move the board — that's the coordinator's.
4. Tear down whatever dev instance you stand up (explicit PIDs, not name-pattern kills) before
   reporting done.

## Reminders

- Relay trigger is the meter's 70% warning — don't invent a higher personal threshold.
- Never `git add -A`/bare-commit in this shared worktree; commit by explicit path (see
  `shared-checkout` skill) — though at this point there should be no more code changes needed,
  only the PR comment.
