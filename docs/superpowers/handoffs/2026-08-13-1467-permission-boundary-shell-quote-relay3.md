# Relay 3 — #1467 permission-boundary-shell-quote

**Status: all 3 plan tasks built, tested, committed. 51/51 unit tests green. Nothing left to
build. Next phase is PR + live-path proof + coordinated-build lifecycle.**

## Where things stand

- Branch: `1467-permission-boundary-shell-quote`, this worktree. Shared checkout — use
  `shared-checkout` skill before any commit.
- Plan (amended per Fable's approval corrections, committed `afd134ff2`):
  `docs/superpowers/plans/2026-08-13-1467-permission-boundary-shell-quote.md`.
- Commits: `80c0cdf58` (Task 1), `ea7bdfa45` (Task 2), `a1e7e297a` (Task 3). Handoffs at
  `b2e779074` (relay2) and this one.
- Verify: `pnpm exec vitest run tests/unit/claude-permission-hook.test.ts tests/unit/vault-allowlist.test.ts`
  → `EXIT=0`, 51/51 passing (confirmed fresh at time of this handoff).

## What's left

1. Open the PR (`coordinated-build` skill for the lifecycle). Reference #1467 in the body.
2. **Live-path proof required, no screenshot** (banned post-`2852a12c3`): UAT on live dev — a real
   notes read through the actual UI, pre-approved with no permission card, contrasted with
   today's card/deny. Record as a `gh pr comment`: what was run, exit code, assertions checked.
3. Full gate via `verify-gate` skill (isolated gate DB) — never run `pnpm verify:foundation`
   unscoped/directly.
4. Security tier: adversarial cross-model QA (not Fable again — she already approved the plan;
   this is a build-review pass) + Ben's explicit merge sign-off required before merge.
5. `coordinated-wrap-up` at the finish line: comment on issue #1467 + update the project board
   (project 2, "Issue and Roadmap Work") on merge.

## Traps already resolved (don't re-hit)

- Verify command must run from repo root (`pnpm exec vitest run ...`), not
  `pnpm --filter @moss/chat exec ...` — the test files live in root-level `tests/unit/`.
- No screenshots on the PR — record live-path proof as a `gh pr comment` instead.
- Task 2's end-to-end tests build the real command string via `writeClaude*PermissionHook` and
  execute through a shell (`spawn("sh", ["-c", command], ...)` with `JARVIS_NOTES_ROOTS` stripped
  from the child env) — don't let a future edit regress this back to passing `env` directly to
  `spawn`, which would silently stop proving command-line injection.
- Commit by explicit path only in this shared checkout; `git diff`/`git show --name-only HEAD`
  after each commit to confirm scope.

## No open questions

Build is complete and matches the approved (amended) plan exactly. Nothing to re-derive.
