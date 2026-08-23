# Relay 2: #1500 / #1427-D — shared web form visuals into @moss/ui

Context-meter 70% relay trigger during `coordinated-wrap-up`'s final gate run. Everything before
the gate is done and verified. What's left: get one clean full gate run, push, open the PR, post
the live-path proof, report to coordinator.

Previous relay doc (superseded, for history only):
`docs/superpowers/handoffs/2026-08-22-1500-css-web-forms-relay.md`.

Plan (full decisions): `docs/superpowers/plans/2026-08-22-1500-css-web-forms.md`. Approved by the
coordinator — do not re-ask. Handoff doc with coordinator/scope/collision info:
`docs/coordination/1834-handoff-1500-shared-web-forms.md` — untracked local file in this worktree
(coordinator-owned directory, do not commit it). If missing, re-fetch with:
`git show 3ec1813fe:docs/coordination/1834-handoff-1500-shared-web-forms.md`.

## Done (commits on branch `1500-shared-web-forms`)

- `f6aa258ba` — the CSS move itself (56 banned visual declarations moved from
  `apps/web/src/styles/components-forms.css` into `packages/ui/src/styles/components-forms.css`).
- `1739152ec` — prettier fix for the plan doc (format:check caught asterisk-italics + a stray
  blank line introduced when the plan was written).
- Pre-push trio (format:check, lint, typecheck) all green. Already up to date with origin/main —
  no rebase needed (confirmed `git log --oneline HEAD..origin/main` = 0 commits).
- Plan-owed checks all green: `check:ui-classes`, `check:file-size`, `check:design-tokens`,
  `pnpm exec vitest run tests/unit/check-design-tokens.test.ts` (4 passed).
- **Live-path browser proof — DONE, PASSING.** Ran it manually (not via a fork — a fork attempt
  stalled with zero real work and was stopped). Method: started a second vite dev server from this
  worktree on port 5182 (proxies to the existing API on :3000), and a throwaway `git worktree add`
  from `origin/main` at `/tmp/moss-main-1500-baseline` serving on port 5183 as the "before"
  baseline (already cleaned up — worktree removed, both vite processes killed). Used Playwright
  (`@playwright/test`, already a repo devDependency) to log in and screenshot Settings > Appearance
  at desktop (1280x900) and mobile (390x844) widths, light and dark mode — 4 pairs, all
  **pixel-identical** (confirmed via PIL diff, not eyeballed). Also spot-checked a checkbox
  (wellness export modal) and a switch (settings toggle) — one apparent small diff on the checkbox
  screenshot turned out to be a loading spinner caught at a different animation frame on close
  inspection (cropped and viewed both images side by side), not a real rendering difference. No
  further live-path work needed — just write this up in the PR body/comment.
- Screenshots are in `/tmp/1500-live-proof/` on this machine if you want to re-check them, but
  they're local scratch, not meant to be committed.

## Not yet done — pick up here

1. **Get one clean gate run.** `scripts/run-gate.sh start` then `scripts/run-gate.sh wait`
   (repeatedly — each call can time out after 540s while still running; that's not failure, call
   `wait` again). Two attempts so far both had trouble, **not from the branch**:
   - Attempt 1 died with `rc=143` (SIGTERM) right as `test:unit` started. Box was under heavy
     memory pressure at the time (44GB/62GB used, swap 8/8GB full) — looks like resource
     contention from the many concurrent agent sessions on this box, not a real failure.
   - Attempt 2 was still running `test:unit` after 10+ minutes with no new log output — same
     memory-pressure pattern. Left running in the background as gate DB
     `jarvis_gate_1500_shared_web_forms`; check `scripts/run-gate.sh status` first before starting
     a third attempt, it may have finished.
   - There's also a known, unrelated box-load issue documented in memory:
     `tests/unit/module-sdk-worker.test.ts` and a couple of sibling files fail locally under load
     but pass in CI (see agentmemory note `module-sdk-worker-tests-fail-locally-green-in-ci`, or
     just search agentmemory for "module-sdk-worker"). If a completed run shows exactly those files
     red and CI is green on `origin/main`, that's the box, not this branch — push and let CI
     adjudicate, and say so plainly in the PR.
   - This is a CSS-only change (no `packages/ai/` or `packages/module-sdk/` touched), so if the
     gate keeps failing for load reasons, it's reasonable to push and let CI be the final word
     rather than burning more attempts locally — just be honest about what was and wasn't verified
     locally in the PR body.

2. **Push + open PR** (`coordinated-wrap-up` step 3): pre-push trio was already green as of this
   relay, but re-run `pnpm format:check && pnpm lint && pnpm typecheck` plus
   `git fetch origin main && git rebase origin/main` right before pushing in case time has passed.
   Title like `fix(css): move shared web form visuals into @moss/ui (#1500)` — wait, that's already
   the first commit's message; use something like `docs(css): #1500 web-forms verification +
   live-path proof` is wrong too since this branch already carries the real change — just open the
   PR normally, base `main`, head `1500-shared-web-forms`, body linking `Part of #1427/#1470`, the
   spec/plan path, the gate exit code(s) you actually got, and the live-path proof summary (4
   pixel-identical pairs + checkbox/switch spot-check, method as described above).

3. **Post the live-path proof as a PR comment** (`gh pr comment`) — the 4 pairs' verdict, the
   checkbox/switch spot-check note, and mention it was pixel-diffed with PIL, not eyeballed.

4. **Fill in the Release note section** per CLAUDE.md — this is CSS-only internal cleanup, no
   user-visible behavior change, so `Category: N/A` is very likely correct; confirm against
   `docs/DEVELOPMENT_STANDARDS.md` if unsure, then run
   `node scripts/append-release-note.mjs --pr <number>` from the branch and commit the resulting
   `docs/WHATS_NEW.md` change (explicit path, not `git add -A` — shared checkout).

5. **Report to coordinator** (name `coordinator` — confirm still the sole live agent with that
   name via `herdr agent list` before messaging; it was a fresh Codex successor as of this relay,
   pane resolved fresh each time, don't trust a baked-in pane number) via `herdr-pane-message`:
   PR link, gate exit code and what it actually verified (or didn't, if you had to push on box-load
   grounds), live-path proof status, branch pushed/rebased state, teardown confirmation (nothing
   left running — the two vite dev servers and the throwaway baseline worktree from this relay's
   live-path proof were already cleaned up before this relay). Then stop — do not merge, close the
   issue, or move the board.

## Collision / scope notes (still binding)

- Order in chain: child 4 of 7. #1499 (child C) already merged. #1501 is waiting on this PR.
- Stay in scope — do not absorb #1501/#1502/#1503.
- Do not touch `docs/coordination/` or run repo-wide `pnpm format` / broad `git add`.
- Shared checkout: never `git add -A`/bare-commit; commit by explicit path (see `shared-checkout`
  skill).
