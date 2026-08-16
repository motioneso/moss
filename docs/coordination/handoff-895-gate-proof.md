# Build Handoff — finish-895-gate-proof

**Spec (approved):** docs/superpowers/specs/2026-08-15-895-required-status-checks.md
**GitHub issue:** #895 — required, already open, labelled `task`.
**Risk tier:** `routine` (per spec's own "Risk tier" section — one CI workflow job, no migration,
no cross-module contract, no auth/RLS/secret/network surface. The ruleset application itself is
NOT in scope for this lane — see "Out of scope" below.)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/finish-895-gate-proof
**Branch:** finish-895-gate-proof (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `0f106e24-3006-41c7-b21a-2638bb889ee1` (immutable authority; label is
only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## What's already done (context, do not redo)

The agent-buildable half of #895 already landed: PR #1635 merged (`e7ac4bef3`) — added the
`ci-gate` aggregate-status job (`name: CI gate`) to `.github/workflows/ci.yml`. It has now run to
completion on `main` at least once. Ordering constraint (spec "Ordering" section) is satisfied.

## Your job: the three remaining agent-buildable exit criteria

Read the spec's **"Exit criteria"** section in full (only that section, plus "Fork 2" for the job
contract if you need it) — do NOT read the whole spec. Execute exit criteria **2, 4, and 5**:

1. **Exit criterion 2 — empirical proof, both directions:**
   - Open a deliberately-red throwaway PR against `main` (e.g. an unformatted markdown file,
     reproducing #893's exact `format:check` failure). Confirm the `CI gate` check run shows
     **failure** and the PR is unmergeable. Record the check-run conclusion (URL + conclusion) as
     a comment on #895.
   - Open a docs-only PR (touches only files that make `Verify foundation and app`,
     `Compose deployment smoke`, and `Prod compose deployment smoke` skip). Confirm `CI gate`
     shows **success** (the deadlock check — proves the aggregate job doesn't wait forever on
     skipped jobs). Record the check-run conclusion as a comment on #895.
   - **Close both PRs without merging.** They are proof artifacts only.
2. **Exit criterion 4:** correct or annotate-as-superseded the two committed plan warnings about
   `gh pr merge --auto`:
   - `docs/superpowers/plans/2026-07-18-fin-06-tables-migration.md:751`
   - `docs/superpowers/plans/2026-07-18-1167-module-db-query.md:1122`
   They currently say never to use `--auto`; that becomes wrong once a required check exists. Note:
   this lane does NOT apply the ruleset — the coordinator is getting Ben's sign-off on that in
   parallel. Phrase the correction as "safe once the `CI gate` required-status-check ruleset is
   applied (#895)" rather than asserting it's already safe now.
3. **Exit criterion 5:** review `.claude/skills/coordinate/SKILL.md:329` against the same new
   reality (the `gh pr merge --squash --delete-branch` merge command, not `--auto` — check the
   actual current line number, it drifts) and update it or record why not, same caveat as above.

Post a summary comment on #895 covering all three criteria's evidence when done.

## Out of scope — do NOT do this

- **Do not apply the branch-protection ruleset** (`gh api repos/motioneso/moss/rulesets`, exit
  criterion 3). That is a privileged, repo-wide, admin-level action gated on Ben's explicit
  sign-off, being sought directly by the coordinator in parallel with this lane. Folding it into
  this lane is explicitly banned by the spec's own "Buildability" section.
- Do not touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge
  your own PR.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. This lane is unusual — its deliverable is mostly proof artifacts and doc corrections, not a
   coded feature, so `plan-build`'s full TDD ceremony is lighter-weight here. Still write a short
   plan (what the two throwaway PRs will contain, the two doc edits) and get coordinator approval
   before opening PRs, per `coordinated-build`.
3. Follow `coordinated-build` for the doc-correction PR (the two plan-file + SKILL.md edits can
   ship as one small PR, separate from the two throwaway proof PRs). Live-path gate does not bind
   (spec's own "Risk tier" section — nothing user-facing).

## Exit criteria for this lane

- #895 comment posted recording exit criteria 2's two check-run conclusions (URLs).
- Both throwaway PRs closed unmerged.
- One small PR open for the doc corrections (criteria 4 + 5), rebased on `origin/main`, CI green.
- Report back to the coordinator with: the #895 comment link, the two closed-PR links, and the
  doc-correction PR number.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Do not apply the ruleset (see "Out of scope").

## Collision notes (from the coordinator)

- No file overlap with #1589 or #1013 per the spec's own "Relationship to other work" section. No
  other lane is running right now — queue was empty at spawn time.
