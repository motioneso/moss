# Build Handoff — deterministic Google schedule-root test (#1453)

**Spec (approved):** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md`
**GitHub issue:** #1453
**Risk tier:** routine, test-only
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-1453-google-schedule-root`
**Branch:** `fix-1453-google-schedule-root` off `origin/main`
**Coordinator label/session:** `Coordinator` / `019fe36a-3d6c-7cd3-9338-3ed739fca2f1`

## Scope and exit criteria

- Change only `tests/integration/connectors-google-schedule-root.test.ts` unless a directly required
  test helper must change; no production change and do not absorb #1454.
- Replace the fixed negative-timing sleep with direct singleton/dedup proof: hold the first job
  active, attempt the duplicate using the same singleton key, and assert pg-boss returns `null`.
- Preserve the schedule-row singleton assertion and prove the focused integration file repeatedly.
- Full isolated gate, clean rebase, pushed PR, no live-path proof (test-only).

## Process

Invoke `coordinated-build`, obtain coordinator plan approval before editing, then use
`coordinated-wrap-up`. Work only in this worktree. Never touch `docs/coordination/`, the board,
milestones, or merge. Add/commit explicit paths only; never repo-wide format or `git add -A`.
Escalate to the sole `Coordinator` label and relay at the context threshold.

## Collision notes

This lane is brought forward from approved Wave 2 solely to unblock Wave 1 PR #1473's twice-failed
CI check. Its intended file is disjoint from active Wave 1 diffs. Do not modify or rebase any Wave 1
branch.
