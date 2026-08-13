# Relay 4 — #1467 permission-boundary-shell-quote

**Status: PR open. Build was already complete when this relay started. Relaying at the
context-meter 70% checkpoint before starting the live-path proof.**

## Where things stand

- Branch `1467-permission-boundary-shell-quote`, this worktree. Shared checkout — `shared-checkout`
  skill before any git action.
- **PR #1610 is open:** https://github.com/motioneso/moss/pull/1610 — body references #1467, marks
  live-path proof / gate / QA / sign-off as still-pending checkboxes.
- Rebased clean onto `origin/main` (was 0c1856190 at rebase time). Pre-push trio
  (`format:check`/`lint`/`typecheck`) all green post-rebase. 51/51 unit tests green
  post-rebase (`pnpm exec vitest run tests/unit/claude-permission-hook.test.ts tests/unit/vault-allowlist.test.ts`).
- One extra commit this relay made beyond relay3's handoff: `53425bc48` — prettier formatting fix
  on the plan doc itself (`format:check` was red on it before push; pure whitespace, no content
  change).
- Coordinator label: `Coordinator` (herdr pane, resolve fresh by label — do not reuse a pane-id).
  Already notified of PR open and of this relay.

## What's left (in order)

1. **Live-path proof — not yet done, needs a decision.** Handoff requirement: "a real notes read
   through the actual UI, pre-approved with no permission card, contrasted with today's card/deny,"
   recorded as a `gh pr comment` (no screenshot, banned post-`2852a12c3`). The plan's determinism
   boundary says **N/A — no model turn needed**, which points at the deterministic path below
   rather than a real-LLM browser walkthrough:
   - **Found:** `tests/uat/fixtures/scripted-provider/` (#1121) is a deterministic stand-in `claude`
     CLI that drives the *real* MCP `tools/call` → real permission-hook (`ConfirmationRegistry`)
     pipeline with zero LLM involved — see the header comment in `claude-main.ts`. This is likely
     the intended live-path mechanism: real tmux fork, real sanitized env, real hook subprocess,
     scripted tool calls instead of a model deciding them.
   - Chat scripts are declared in `tests/uat/seed/types.ts` (`UatChatScript` = `"phase1-smoke" |
     "1533-surface-probe"` today) and their fixture data loads from
     `tests/uat/fixtures/chat-scripts/*.json` per `script-schema.ts` (`FIXTURE_DIR`) — **I have not
     yet read those two existing fixture files** to confirm the exact JSON shape before deciding
     whether to add a new one.
   - **Next step:** read `tests/uat/fixtures/chat-scripts/phase1-smoke.json` (or whatever it's
     actually named — confirm via `ls`) to see the turn/call/reply shape, then decide: (a) add a
     minimal new chat-script fixture whose one turn calls `Read` on a path under a seeded vault
     root and assert the MCP result is a normal read (not a permission-denied/ask response) — that
     IS the live proof, no card because pre-approved; or (b) if that's too much new surface for a
     bug-fix PR, fall back to a manual proof: stand up the dev instance per the `dev-preview-recipe`
     memory (source-run in this worktree, NOT the `Moss`/prod container on :1533), configure a real
     vault root, and drive an actual chat turn through the browser, contrasting behavior with/without
     the fix (e.g. `git stash` the fix temporarily on a **throwaway** checkout, never on this shared
     worktree's tracked branch).
   - Do **not** hand-roll a dev instance against the shared `jarv1s-postgres` for this — prefer the
     existing `pnpm test:uat` harness (ephemeral, isolated Compose + seeded data) over improvising.
   - Whichever path: record proof as `gh pr comment` on #1610 with command run, exit code, and the
     specific assertion (no card / auto-allow) contrasted with the pre-fix behavior.

2. **Full gate via `verify-gate` skill** (isolated gate DB) — never run `pnpm verify:foundation`
   unscoped.
3. **Security tier: adversarial cross-model QA** (not Fable — she already approved the plan; this
   is a build-review pass. Use AGY, never gemini-cli, per `cross-model-lens-must-be-agy` memory) +
   **Ben's explicit merge sign-off** required before merge.
4. **`coordinated-wrap-up`** on merge: comment on issue #1467 + update project board (project 2,
   "Issue and Roadmap Work").

## Traps already resolved (don't re-hit)

- Verify command runs from repo root (`pnpm exec vitest run ...`), not `pnpm --filter @moss/chat`.
- No screenshots on the PR — `gh pr comment` text proof instead.
- Task 2's end-to-end unit tests already build the real command string and execute it through a
  real shell (`spawn("sh", ["-c", command], ...)` with `JARVIS_NOTES_ROOTS` stripped from the child
  env) — this is strong mechanism-level evidence already in the PR; the live-path proof above is
  the additional UI/runtime-level evidence the gate requires, not a replacement for it.
- Commit by explicit path only in this shared checkout; `git show --name-only HEAD` after each
  commit to confirm scope.
- `Moss` docker container on :1533 is **prod** — never touch/restart it for a dev preview.

## No open questions on the code itself

The fix is correct and fully tested at the unit level. The only open item is *how* to satisfy the
live-path proof mechanism — pick (a) or (b) above and execute; don't re-litigate the fix.
