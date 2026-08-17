# Relay — 1139-E export resume

**Issue:** Part of #1522. **Branch/worktree:** `1139-e-export-resume` (this worktree, unchanged).
**Coordinator:** agent name `coordinator-take25` (session `11cf8264-55a8-4fa4-b32b-c8d086469f74`),
label `Coordinator` — re-resolve via `herdr pane list`/`herdr agent list`, never trust a cached
pane number.

## Status — build DONE, gate re-verify + wrap-up remaining

Build is complete and committed:
- `6ff05582d` — `feat(#1522): resume data export across Settings remount (1139-E)` — the full
  TDD RED→GREEN implementation (storage helpers + `DataExport` changes +
  `tests/e2e/settings-shell.spec.ts` new test `"data export resumes across remount and clears on
  new/expired job"`). Focused Playwright command green, full `settings-shell.spec.ts` suite green
  (6/6), `pnpm --filter web typecheck` and `pnpm check:file-size` both green.
- `7303046b2` — `docs(#1522): prettier-format 1139-E plan doc` — mechanical `prettier --write` fix
  to `docs/superpowers/plans/2026-08-16-1139-e-export-resume.md` (pre-existing format issue from
  the plan-author commit `163405eb6`, not part of this build's surface, but it was failing
  `pnpm format:check` and thus blocking the full `verify:foundation` gate). Confirmed via
  `herdr pane list` no concurrent session was editing that file before touching it. Content-only
  diff: added semicolons in a `ts` code block + blank lines after code fences, no decisions
  changed.

**Tree is clean** (`git status --porcelain` empty) as of this doc.

## What's NOT done yet — pick up here

1. **Re-run the isolated gate** (was never confirmed green after the `7303046b2` fix — the one
   prior gate run failed with rc=1 for exactly the format:check reason now fixed, so that log is
   stale/superseded, not evidence):
   ```bash
   scripts/run-gate.sh start
   scripts/run-gate.sh wait
   scripts/run-gate.sh status
   ```
   Confirm `### FINAL rc=0` in the log itself — never trust a wrapper echo or a piped exit code.
2. **Pre-push trio + fresh rebase** (do this even if step 1 was already green once — time passes,
   origin/main moves):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
3. **Push + open PR**:
   ```bash
   git push -u origin 1139-e-export-resume
   gh pr create --base main --head 1139-e-export-resume \
     --title "feat(#1522): resume data export across Settings remount (1139-E)" \
     --body "<scope shipped, spec/plan link, VF_EXIT evidence, note the plan-doc format fix as a
     small included fix>"
   ```
4. **Live-path proof — mandatory, this is a user-facing Settings UI change.** Resolve UAT triggers
   and run:
   ```bash
   gh pr diff <PR> --name-only | .claude/skills/coordinate/resolve-uat-triggers.sh
   pnpm test:uat -- "<resolved spec>"
   gh pr comment <PR> --body "Live-path proof: ..."
   ```
   If genuinely unable to produce it (no live instance reachable), report honestly as
   **code-complete, unverified** — do not claim done.
5. **Report to coordinator** (label `Coordinator`, re-resolve pane fresh — do not trust any pane
   number baked into this doc) via `herdr-pane-message`, terse and result-first, normal English:
   PR link, VF_EXIT evidence, live-path status, rebase state, deferred scope (none expected),
   teardown (no dev instance/seed rows were started by any session in this lane so far — note
   "none started" unless the successor starts one for live-path proof, in which case it must stop
   it and say so).
6. Do NOT move the board, close the issue, or merge — coordinator's call.

## Confirmed design fact (don't re-derive)

`apps/web/src/settings/settings-page.tsx:346` — `const Pane = activeSection.Pane;` renders
`<Pane />` by component-identity swap per active section — full unmount/remount of `DataExport` on
nav-away/nav-back, not a display:none toggle. Already exploited correctly in the committed test.

## Reminders from the run

- `git add`/`git commit` by explicit path only — no `-A`, no bare commit (shared checkout).
- Never touch `docs/coordination/` — coordinator-only.
- Relay trigger is the meter's 70% warning, same threshold for you too — don't invent a higher
  personal bar. If it fires before you've pushed/opened the PR, commit whatever's green (it
  already is, as of this doc) and relay anyway, noting it plainly.
- The plan doc's pre-existing format issue is now fixed (`7303046b2`) — do not re-flag it.
