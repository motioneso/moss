# Build Handoff — 1038-chat-privacy-leak-test

**Spec (approved):** docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md
(row #1038 in the Architecture and scope table)
**GitHub issue:** #1038 — chat privacy/history endpoint cross-user leak regression test
**Risk tier:** `security` — this PR gets adversarial Opus QA + Ben merge sign-off. Build to that bar.
**Worktree:** ~/Jarv1s/.claude/worktrees/1038-chat-privacy-leak-test
**Branch:** 1038-chat-privacy-leak-test (off origin/main @ bcb3c2765)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74`
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read the spec above BY SECTION — just the #1038 row of the scope table plus the shared
   Context/Goals/Non-goals sections. Do not read the #1037/#1468 rows in depth; they're a different
   lane.
3. Invoke **`coordinated-build`** and follow it end-to-end: plan with **`plan-build`** →
   coordinator approval (do NOT write code before it) → TDD build → **`coordinated-wrap-up`**.

## Exit criteria for this lane

- One focused two-user integration test near the existing #984 chat privacy tests: call chat
  privacy/history list + detail endpoints as actor A; assert actor B's threads/messages never
  appear in any response. The test must fail without the guarantee and pass with it.
- **Tests only** — no production code change unless the test proves an actual leak. If you find a
  real gap, STOP and escalate to the coordinator immediately (tag `[SECURITY]` in your message) —
  that is a finding, not scope creep to silently fix.
- Full gate green on an isolated gate DB. PR open, rebased on `origin/main`.
- Internal-only test change — say so explicitly in the PR instead of live-path proof.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- **Use a distinctly-named test file from #1037's lane** — you both land tests near the same
  existing #984 chat-privacy test area. Do not reuse or rename the shared fixture
  (`test-database.ts`, which already exposes `ids.userA`/`ids.userB`) — just add your own new test
  file with a name specific to the list/detail-endpoint-leak scenario.

## Collision notes (from the coordinator)

- #1037 is building in parallel in a separate worktree, same general test area (two-user chat
  privacy). Zero file overlap by design as long as you each pick a distinct new test filename — see
  ban above. No need to coordinate directly; both rebase independently on `origin/main`.
- #1279 and #1468 are also building in parallel, in unrelated packages (`module-registry` and
  `scripts/*.ts` respectively) — no overlap.
