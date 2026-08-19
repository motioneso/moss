# Relay handoff — sports-cleanup (#837)

**Trigger:** context-meter 70% warning (hit 77%). No compaction seen. Relaying per
`coordinated-build` step 3.

## Where things stand

- **Issue:** #837 (task, sev:cosmetic) — "Sports broadsheet post-merge cleanup: retained sp-fc raw
  literals, FollowedCard placement, dead empty-state rule"
- **Spec:** `docs/superpowers/specs/2026-07-05-sports-editorial-redesign.md` (parent #726)
- **Worktree/branch:** this worktree, branch `837-sports-postmerge-cleanup`, base `origin/main` @
  `616b9ed1` (confirmed 0 commits ahead/behind origin/main at relay time)
- **Original handoff doc (uncommitted, lives in a DIFFERENT worktree):**
  `/home/ben/Jarv1s/.claude/worktrees/coord-2026-06-30-rfa-fleet/docs/coordination/handoffs/2026-07-06-837-sports-postmerge-cleanup.md`
  — read that first if this doc is ever missing context; it has the run-specific bans and collision
  notes (verbatim below for convenience since it's not in this worktree's tree).
- **Coordinator:** label `Coordinator`, session id `f64fd971-3fad-4880-a2fd-6dbb7aba935e` (per
  original handoff) — **but re-resolve fresh by label at read time**, never trust a cached pane
  number. Last confirmed via `herdr pane list`: pane `w1:p80`, agent_session.value
  `6b766f7c-577d-4e32-b5b8-b441e6788036`, cwd `coord-2026-06-30-rfa-fleet`. (Session id differs
  from the original handoff's — likely the coordinator itself relayed since that doc was written;
  trust the *label* match + freshly-read session id, not either historical id.)
- **Heads-up (from original handoff):** a separate agent (`829-sports-broadsheet` branch, pane
  label was `829-sports-broadsheet`, now shows as unlabeled/idle pane `w1:p8Y` in
  `~/Jarv1s/.claude/worktrees/829-sports-broadsheet`) is independently doing sports work and may
  touch overlapping files. If you find target lines already changed, re-verify against current
  file state before continuing — don't trust line numbers blindly (I already did this once; see
  plan doc's "Reference: verified current file state" section, which corrected the issue body's
  stale "line 962" claim to the actual 732-736).

## What's done

- Read handoff, issue #837 (via `gh api repos/motioneso/jarv1s/issues/837 --jq .body` — plain
  `gh issue view` fails on this repo with a Projects-classic GraphQL error; always use `--json` or
  the api form), and spec, all in full.
- Verified spec premises against actual branch state (step ½ of `coordinated-build`): all three
  findings are still real and unfixed. Line numbers in the issue body are stale (sp-fc block is
  actually at `sports-1.css:340-476`, not what "~18 rules" implied a specific location for; dead
  rule is at `sports-1.css:732-736`, not "near line 962" — file is 736 lines total, not 985, since
  #839 already split out `sports-4-grid.css`/`sports-5-editorial.css`).
- Confirmed `FollowedCard` (currently `sports-page.tsx:205-256`) has exactly one consumer
  repo-wide: `today-widget.tsx`. No circular-import risk moving it there (checked
  sports-parts/sports-news/sports-ticker import graph — moving it into `sports-parts.tsx` instead
  WOULD create a cycle since `sports-ticker.tsx` already imports from `sports-parts.tsx`; today-widget.tsx is the safe destination).
- Confirmed `check-design-tokens.ts` only scans `apps/web/src`, never `packages/sports` — explains
  why the raw-px block was never CI-caught; not a script bug, out of scope to fix.
- **Wrote the full implementation plan:** `docs/superpowers/plans/2026-07-06-sports-postmerge-cleanup.md`
  — 4 tasks, complete before/after code for every CSS/TSX edit, exact nearest-token mapping table
  with tie-break reasoning documented, and a called-out gap (no existing Playwright capture
  actually exercises the `sp-fc` card — `"capture: today + chat drawer"` never mocks sports
  follows, so the broad browser suite alone won't verify Task 2's tokenization; Task 4
  Step 3 has a plan for a manual scratch-only capture to close that gap).
- **NOT yet committed** — plan file is new/untracked in the worktree. Commit it as part of your
  first action (see Next steps).
- **Messaged the coordinator** (`herdr pane run w1:p80 "sports-cleanup(#837): plan ready..."`) with
  the plan path and a note that I was relaying due to context. Coordinator was mid-task (busy) —
  message landed as queued input, not yet acknowledged/approved as of this write.

## What's NOT done (next steps, in order)

1. `git add docs/superpowers/plans/2026-07-06-sports-postmerge-cleanup.md && git commit` this plan
   file (it was never committed before relay — do this first so it survives).
2. **PLAN ALREADY APPROVED.** Ben (in-session, echoing the coordinator's decision) approved all 3
   tasks verbatim before this relay completed: "Approved — all 3 tasks (FollowedCard relocation,
   sp-fc tokenization, dead media-query removal) are in scope for #837, and good catch verifying
   premises against drifted line numbers." You do NOT need to wait for a separate coordinator
   pane reply — proceed straight to Task 1. (Still worth a one-line status ping to the
   `Coordinator` label when you start Task 4/wrap-up, per normal escalation habits, but it is not
   a blocking gate here.)
3. Execute the plan's Tasks 1-4 **using `superpowers:test-driven-development`** as
   the build skill (coordinated-build's own execution-skill directive), task by task, committing
   green after each (commit messages are already drafted verbatim in the plan).
4. Task 4 Step 3 (manual visual check of the tokenized `sp-fc` card) needs judgment — the plan
   explains exactly how to jury-rig a one-off capture since no committed test exercises this
   component. Don't skip it silently; if you decide it's not worth the scratch-test setup, say so
   explicfunctionicitly in the wrap-up report rather than claiming "visually verified via
   browser suite" when the existing suite doesn't actually cover it.
5. Close out with **`coordinated-wrap-up`** (clean tree, own full gate, pre-push trio +
   rebase, push, open PR, report PR + evidence to the coordinator). Do not merge, touch the board,
   or touch `docs/coordination/` yourself.

## Run-specific bans (from original handoff, still binding)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Verification commands (from the plan, for quick reference)

```bash
pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit
pnpm test:e2e
pnpm format:check && pnpm lint && pnpm typecheck && git fetch origin main && git rebase origin/main   # pre-push trio
```
