# Build Handoff — 1468-target-identity-guard-extend

**Spec (approved):** docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md
(row #1468 in the Architecture and scope table)
**GitHub issue:** #1468 — extend target-identity guard to three more operator scripts
**Risk tier:** `security` — this PR gets adversarial Opus QA + Ben merge sign-off. Build to that bar.
**Worktree:** ~/Jarv1s/.claude/worktrees/1468-target-identity-guard-extend
**Branch:** 1468-target-identity-guard-extend (off origin/main @ bcb3c2765)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74`
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read the spec above BY SECTION — just the #1468 row of the scope table plus the shared
   Context/Goals/Non-goals sections. Do not read the #1037/#1038 rows; different lane.
3. Read `packages/db/src/target-identity-guard.ts` and the two existing guarded CLIs (from #1383)
   to match their pattern exactly — same `assertOperatorConfirmsTargetOwner` call shape, same
   `--confirm-owner-email` flag plumbing.
4. Invoke **`coordinated-build`** and follow it end-to-end: plan with **`plan-build`** →
   coordinator approval (do NOT write code before it) → TDD build → **`coordinated-wrap-up`**.

## Exit criteria for this lane

- `scripts/rewrap-secrets.ts`, `scripts/module-reconcile.ts`, `scripts/restore-database.ts` each
  call the guard (or a restore-appropriate variant) before their first mutating statement on the
  execute/non-dry-run path only, gated the same way as the two existing guarded CLIs.
- Each script gets a `--confirm-owner-email` flag and a regression test proving the guard blocks a
  mismatched target.
- `restore-database.ts` onto an empty/bootstrap-owner-less target requires an EXPLICIT opt-out flag
  — never a silent bypass of `NoBootstrapOwnerFoundError`. A regression test proves the guard still
  fires without that flag.
- Do NOT change the guard's core semantics (`packages/db/src/target-identity-guard.ts`) or the two
  already-guarded CLIs from #1383 — wire three new callers only.
- Full gate green on an isolated gate DB. PR open, rebased on `origin/main`.
- Internal-only ops-tooling change — say so explicitly in the PR instead of live-path proof.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- You are the only lane touching `scripts/*.ts` and `packages/db/src/target-identity-guard.ts`
  callers this wave — no file overlap with #1037/#1038 (chat test files) or #1279
  (`packages/module-registry/src/external`). No coordination needed with other lanes.
