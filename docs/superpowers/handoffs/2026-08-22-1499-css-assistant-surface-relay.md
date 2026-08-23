# Relay: #1499 — assistant-surface CSS registration

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, child C (line 143 table row,
"Other residue" line 86). Plan: `docs/superpowers/plans/2026-08-22-1499-css-assistant-surface.md`.
Issue #1499, part of #1427/#1470. Worktree: `.claude/worktrees/1499-css-assistant-surface`.
Branch: `1499-css-assistant-surface`. Coordinator: agent name `coordinator`
(session 7b8957b3-93f9-44ee-81cc-a6a436514031) — re-resolve by name/session id, not pane number.

Plan approved by coordinator. Relaying at the context-meter 70% trigger, not a blocker.

## Done (all committed)

Commit `15cf0b189` — "fix(css): finish assistant-surface CSS registration (#1499)":

- Moved the 9 banned declarations out of
  `apps/web/src/chat/assistant-surface/assistant-surface.css` into
  `packages/ui/src/styles/components-chat.css` (new block at file end, tagged
  `/* from apps/web/src/chat/assistant-surface/assistant-surface.css */`).
- Deleted the now-empty `.assistant-surface__composer textarea:focus-visible` rule from the app
  file (both its declarations moved).
- Registered `apps/web/src/chat/assistant-surface/assistant-surface.css` in
  `MIGRATED_SECTION_CSS_FILES` in `scripts/check-design-tokens.ts`.

Verified green this session (all exit 0): `checkBannedProperties` against the file alone (count 0),
`pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm check:file-size`,
`pnpm exec vitest run tests/unit/check-design-tokens.test.ts`, `pnpm format:check`,
`pnpm exec playwright test tests/e2e/assistant-surface.spec.ts`.

**Browser proof already done, not just planned:** captured before/after screenshots of the
embedded assistant surface in light and dark mode (mocked-API Playwright run, same setup as
`tests/e2e/assistant-surface.spec.ts`, before = `git show HEAD~1` content of the two CSS files,
after = the committed state). Compared with PIL pixel diff — the only differences are in the
`.assistant-surface__typing` three-dot animation (a few dozen pixels, timing noise between two
separate runs of an animated element I never touched); the classes I actually changed
(`__identity`, `__composer textarea`, `__composer textarea:focus-visible`) show zero pixel
difference. Screenshots were temp files under `/tmp` and are gone now — if the coordinator or QA
wants the same proof reproduced, re-run the same before/after capture (temp Playwright spec
reusing `mockApi` + `mockAssistantSurfaceWebModule` from `tests/e2e/`, toggle
`document.documentElement.setAttribute("data-color-mode", "light"|"dark")`, screenshot
`.assistant-surface`) — 10 minutes of work, not a re-plan.

Tree is clean (`git status` empty) as of this doc.

## Left to do

1. Pre-push trio + rebase (plan step, not yet run this session):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
   (`format:check` already passed above; `lint`/`typecheck` not yet run this session — run them.)
2. `coordinated-wrap-up` skill: full gate (has its own gate-DB recipe, don't improvise), push, open
   PR titled around "Finish assistant-surface CSS registration (#1499)", body says `Part of
   #1427/#1470`.
3. Release note: run `node scripts/append-release-note.mjs --pr <number>` — this is a
   guard/internal-cleanup change, so `Category: N/A` is almost certainly correct (no user-visible
   behavior or visual change intended); confirm against the actual PR template before committing
   `docs/WHATS_NEW.md`.
4. Post the live-path proof as a `gh pr comment` on the PR: the e2e pass output plus a plain-English
   description of the before/after screenshot comparison above (or re-capture it fresh if the
   coordinator wants literal PNGs attached rather than a description — ask if unsure).
5. Report the PR + evidence to the coordinator (name `coordinator`, re-resolve by name/session id).
   Then stop — merge/board/close are the coordinator's.

## Notes for the successor

- Do NOT re-run `pnpm install` — `node_modules` already exists in this worktree.
- Read the spec/plan doc **by section**, not front-to-back — you have a fresh budget, spend it on
  building/finishing, not re-reading ground already covered above.
- Scope is locked to the 3 files already touched (assistant-surface.css, components-chat.css,
  check-design-tokens.ts) plus whatever `coordinated-wrap-up` needs (PR body, release note). Do not
  absorb #1500-#1503 sibling scope.
- No product/architecture fork was hit. No blocker was hit. This relay is purely the context-meter
  countable trigger, nothing more.
