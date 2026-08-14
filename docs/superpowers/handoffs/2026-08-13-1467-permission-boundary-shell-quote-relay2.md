# Relay 2 — #1467 permission-boundary-shell-quote

**Status: Fable APPROVED (with 2 mechanical corrections, both applied). Tasks 1 & 2 built,
tested, committed. Task 3 not started. No blockers.**

## Where things stand

- Branch: `1467-permission-boundary-shell-quote`, this worktree. Shared checkout — use
  `shared-checkout` skill before any commit.
- Plan: `docs/superpowers/plans/2026-08-13-1467-permission-boundary-shell-quote.md`, amended per
  Fable's corrections and committed at `afd134ff2`.
- Commits so far: `80c0cdf58` (Task 1 — `resolveVaultRoots()` extracted, 18 tests green),
  `ea7bdfa45` (Task 2 — `vaultRootsEnvEntry()` injected into both hook command lines, 51 tests
  green including 2 real shell-executed end-to-end tests per Fable's build note — command string
  built via `writeClaude*PermissionHook`, run through `spawn("sh", ["-c", command], ...)` with
  `JARVIS_NOTES_ROOTS` stripped from the child env, proving injection via command line not
  inherited env).
- Verify command (corrected, cwd = repo root):
  `pnpm exec vitest run tests/unit/claude-permission-hook.test.ts tests/unit/vault-allowlist.test.ts`
  — currently green, 51/51.

## What's left

1. **Task 3** (plan section "Task 3 — user-visible string"): edit
   `apps/web/src/settings/settings-vault-chooser.tsx:156`, change
   `set JARVIS_NOTES_ROOTS, and recreate the container.` →
   `set MOSS_NOTES_ROOTS, and recreate the container.` No test needed (copy-only, no
   render/snapshot test touches this string). Commit by explicit path.
2. Run the full verify command above once more to confirm nothing regressed.
3. Proceed via `coordinated-build` skill for PR lifecycle, then `coordinated-wrap-up`. Live-path
   proof required per plan's amended "Verification" section: **no screenshot** (banned
   post-`2852a12c3`) — record as a `gh pr comment` with UAT run on live dev + exit code +
   assertions (notes read pre-approved, no permission card, vs. today's deny).
4. Full gate (`verify-gate` skill, isolated DB) at wrap-up.

## Traps already resolved (don't re-hit)

- `pnpm --filter @moss/chat exec vitest ...` fails — the test files are at repo-root `tests/unit/`,
  not under `packages/chat`. Use the corrected command above (cwd = repo root).
- Screenshot-on-PR is stale guidance; `DEVELOPMENT_STANDARDS.md` bans it post-`2852a12c3`. Use a
  `gh pr comment` instead.
- Test case 5 (end-to-end) must build the full command string via `writeClaude*PermissionHook` and
  execute it through a shell — passing `env` directly to `spawn` doesn't prove command-line
  injection (already fixed in the committed tests; don't regress this if touching them further).
- This is a shared checkout — commit by explicit path only, verify `git diff` shows only your
  changes and `git show --name-only HEAD` matches expectations before and after each commit.
- Fable confirmed: the three `vaultReadOnlyToolPatterns()` consumers are exactly the three
  `writeClaude*PermissionHook` callers (persistent-runtime, cli-launch-commands,
  print-chat-engine) — settings-allowlist and injected-roots can't drift apart after Task 1.

## No open questions

Task 3 is a pure copy fix with a known exact line/string — no ambiguity.
