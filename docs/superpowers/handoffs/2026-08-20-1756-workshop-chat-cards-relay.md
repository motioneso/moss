# Relay — #1756 Workshop chat cards (Group E) — update 2

**Read `docs/coordination/handoff-1756-workshop-chat-cards.md` first** (spec, mockups, plan
section, exit criteria — unchanged since the original handoff).

**Worktree:** `~/Jarv1s/.claude/worktrees/1756-workshop-chat-cards`, branch
`1756-workshop-chat-cards`. `node_modules` already installed — skip `pnpm install`.

## All four Group E tasks are done and committed

- `5657153e1` — Task 25, the plan-approval card (`apps/web/src/chat/plan-approval-card.tsx`).
- `21147d411` — a docs-only relay checkpoint from earlier in this run (superseded by this file).
- `d92636334` — Task 26, the running-draft banner (`apps/web/src/chat/draft-banner.tsx`).
  `discardDraft` backend intentionally NOT built: `app.external_modules` is admin-only today with
  no draft/owner column (that's #1753's schema). Banner UI shell only, noted in the commit.
- `e4ab036c5` — Task 27, docked chat drawer mode (`chat-drawer.tsx`'s new `docked` prop, CSS
  fallback to overlay under 720px) + `classifyDraftChangeRequest`
  (`packages/ai/src/module-build/classify-draft-change.ts`). Step 5 ("put the last change back")
  deliberately not built — searched `scripts/module-install.ts` and neighbors for a swap/park/
  backup/rollback/archive mechanism, confirmed none exists (only a 4-phase install, no version
  history). Flagged in the commit message rather than inventing a parallel mechanism.
- Task 28, the invented-class audit — **run, clean, nothing to fix.** Command used:
  `grep -rhoE "jds-[a-zA-Z0-9_-]+" apps/web/src/chat/plan-approval-card.tsx apps/web/src/chat/draft-banner.tsx apps/web/src/chat/chat-drawer.tsx | sort -u`
  compared against every real jds- class defined across `apps/web/src/styles/` AND
  `packages/ui/src/styles/` (the audit script in the design-system skill only checks the first
  directory — must check both, `packages/ui/src/styles/components-moss-today.css` is where
  `jds-card__meta` and some others actually live). No empty `comm -23` output → no fix commit
  needed for Task 28.

## What's left before this can be marked done

1. **The gate is running right now in the background**, started this session:
   - `export JARVIS_PGDATABASE=jarvis_gate_1756e` (already an isolated, freshly-created DB, per
     the `verify-gate` skill — do NOT reuse it without DROP+CREATE again if it's stale).
   - Log file: `/tmp/vf-1756.log`, command was
     `pnpm verify:foundation > /tmp/vf-1756.log 2>&1; echo "### FINAL rc=$?" >> /tmp/vf-1756.log`.
   - **Check `/tmp/vf-1756.log` for the `### FINAL rc=` line first.** If it's not there yet, the
     gate may still be running (check `ps aux | grep verify` ) — if it died without the sentinel,
     re-run it fresh (DROP+CREATE the gate DB again first, per the skill).
   - If green: proceed to step 2. If red: read the failure, fix, re-run — don't guess.

2. **Push the branch and open the PR.** Draft PR body already written at
   `/tmp/pr-1756-body.md` — read it, fill in the gate result (currently has a
   `PLACEHOLDER_GATE_RESULT` marker), and use it verbatim via `gh pr create --body-file`.
   Branch is already rebased on `origin/main` (confirmed this session via
   `git merge-base --is-ancestor origin/main HEAD`).

3. **Live-path proof is genuinely not possible yet, and that's fine — say so, don't fake it.**
   None of Groups A-D (#1752/#1753/#1754, module-build backend) have landed in this worktree.
   These new components (plan-approval card, draft banner, docked drawer, classifier) have no
   live route in the running app today — nothing mounts them. Per
   `docs/DEVELOPMENT_STANDARDS.md`'s Live-Path Gate section: "No artifact means you may not merge
   and may not mark the issue or epic Done. The correct status is code-complete, unverified — say
   that plainly." Do exactly that in the PR body (the draft already says this) — do not attempt to
   fabricate a live-path proof by mounting these components somewhere artificial just to screenshot
   them; that would misrepresent the feature as reachable when it isn't.

4. **Never merge** (run-specific ban, still in force). Open the PR referencing #1756 and stop
   there.

5. Confirm the release-note step: this PR is new UI, so it needs a real Category/Title/Description
   in the PR template's Release note section, then
   `node scripts/append-release-note.mjs --pr <number>` run from the branch, with the resulting
   `docs/WHATS_NEW.md` change committed onto this same branch (see project CLAUDE.md's Process
   gates section for the exact wording) — but note the feature isn't actually usable yet (see point
   3), so the honest description is something like "a first piece of the upcoming workshop feature,
   not yet visible anywhere" — don't oversell it as a working feature in the note.

## Ground truth carried over from the previous relay (still true, don't re-derive)

- Groups A-C schema/backend genuinely absent from this worktree — confirmed by grep, not
  assumption.
- Real jds primitives used here are all confirmed to exist: `jds-card`, `jds-card--raised`,
  `jds-eyebrow(--gold/--muted)`, `jds-btn(--primary/--secondary/--quiet/--sm)`,
  `jds-indicator(--ready/--live)`, `jds-rail`/`jds-rail-row`/`jds-rail--gold`,
  `jds-card-title(--heavy)`, `jds-card__meta` (this one lives in
  `packages/ui/src/styles/components-moss-today.css`, not `apps/web/src/styles/` — earlier in
  this run I incorrectly flagged it as missing before finding that file).
- Component test convention in this repo: `react-test-renderer` + `act`, no
  `@testing-library/react`. Some files run under `// @vitest-environment jsdom` (plan-approval-card,
  draft-banner), others run under this repo's default node environment with a stubbed
  `window` global (chat-drawer tests) — match whichever pattern the file you're touching already
  uses; check a sibling test file first.
- Coordinator pane: label `Coordinator`, live session id (re-resolve by label, don't trust a
  cached one) was `fbacd483-baf3-47c8-aacf-66a51c6ebd7b` as of this run's last check via
  `herdr pane list`. My own pane: label `1756 Workshop chat cards`, pane `w1:pH3`, session
  `a8c91b0d-26b9-415c-8e9d-bcb2ec8379b9`.
- Parallel work: `1755-workshop-page` worktree (pane `w1:pH5`) building the Workshop page in
  parallel — different surface, no observed file collision.

## Shared-checkout discipline (still in force)

Before any git action here: check `herdr pane list`, diff before committing, commit by explicit
path only, `git show --name-only HEAD` after every commit to confirm exactly the intended files
landed. Every commit in this worktree so far has been clean (verified each time).
