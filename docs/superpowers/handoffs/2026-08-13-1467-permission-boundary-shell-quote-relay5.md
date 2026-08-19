# Relay 5 — #1467 permission-boundary-shell-quote

**Status: PR #1610 open, code/tests fully green. Live-path-proof mechanism now decided
(see below). relay4 could not self-spawn a successor — `herdr agent start` was denied twice
by the local permission classifier ("Blocked by classifier", no detail). Coordinator was
notified and asked to spawn relay5 if it has different permissions.**

## Where things stand

- PR: https://github.com/motioneso/moss/pull/1610 — open, rebased clean, pre-push trio +
  51/51 unit tests green.
- Branch/worktree: `1467-permission-boundary-shell-quote`, this worktree. Shared checkout —
  `shared-checkout` skill before any git action.
- Coordinator label `Coordinator` (resolve fresh via `herdr pane list`).

## Live-path proof — decision made, not yet executed

Ruled out the scripted-provider UAT chat-script mechanism (`tests/uat/fixtures/scripted-provider/`):
`grep -rn NOTES_ROOTS` across `tests/uat/` returns **nothing** — `JARVIS_NOTES_ROOTS` is not
plumbed into the UAT provisioner/compose at all (it's a prod-only override,
`infra/docker-compose.notes.yml`). Wiring it in would be new UAT infra, out of scope for this fix.

**Chosen path: manual live dev-instance proof**, per `dev-preview-recipe` memory:
1. Source-run dev in this worktree (fix already present): `pnpm db:migrate` against dev postgres
   (`jarv1s-postgres`, `:55433`, db `jarv1s`, schema `app`) → `pnpm dev:api` (:3000) +
   `pnpm dev:web` (:5173/5197-ish, check free port — `2371847`/`1550288` already hold `:5197` and
   `5173` from other worktrees, pick another free port with `--port`).
   **Do not touch the :1533 container — that's prod.**
2. Set `JARVIS_NOTES_ROOTS=/tmp/.../uat-1467-proof` (or `MOSS_NOTES_ROOTS` — check `resolveMossEnv`
   precedence in `packages/shared`) on the dev API process env before starting it; create one small
   file under that root.
3. Sign in as dev admin, open chat, ask (real message) to read that file.
4. Observe: **no permission card**, content returned — this is the "after" proof.
5. For contrast ("today's card/deny"): either (a) cite Task 2's unit test case 2 (`omits
   JARVIS_NOTES_ROOTS ... when no root is configured`) as the proven pre-fix mechanism, or (b) if
   time allows, repeat steps 2-4 against `origin/main` in a **separate scratch worktree** (never
   stash/checkout this shared branch) and show the card/ask does appear there.
6. Record as a `gh pr comment` on #1610: commands run, exit codes, and the specific
   observation/assertion — no screenshot (banned post-`2852a12c3`).

## What's left after the proof

1. Full gate via `verify-gate` skill (isolated gate DB).
2. Security tier: adversarial cross-model QA (AGY, not Fable, not gemini-cli) + Ben's explicit
   merge sign-off.
3. `coordinated-wrap-up` on merge: comment on #1467 + update project board (project 2).

## Traps

- `Moss`/prod container on :1533 — never touch.
- Ports 5173/5197 already held by other worktrees' dev servers — pick a free one.
- Commit by explicit path only; `git show --name-only HEAD` after each commit.
- If `herdr agent start` (self-spawn) is denied again, don't retry — message Coordinator to spawn
  instead, and keep working directly rather than stalling.
