# #1533 chat surface build — relay10 handoff

Supersedes relay9. Same worktree/branch: `build/1533-chat-surface-routing`.

## State

- Phase 3: DONE (unchanged from relay9). Commits `fc301f113` (tests), `b680da8ea` (lint fix).
- Phase 4, gate sub-step: **DONE — full gate CONFIRMED GREEN.**
  Latest commit on branch: `80f01f537` (prettier fix). Log:
  `/tmp/jarv1s-gate/1533_chat_surface_build-20260811-020533.log` —
  `### FINAL rc=0`, `Test Files 187 passed (187)`, `Tests 1877 passed | 2 skipped (1879)`,
  gate DB `jarvis_gate_1533_chat_surface_build` dropped clean on success.
- Phase 4 remaining sub-steps: **all still NOT STARTED** (live-path proof, sensitive-tier
  check, draft PR). See "Next" below.

## What relay9 left broken, now fixed

Two real gate blockers found and fixed after relay9's lint fix, both diff-reviewed and
committed via shared-checkout discipline (explicit paths, `git show --name-only HEAD`
confirmed each time):

1. **`format:check` (prettier) failure** on 3 files: the plan doc, `chat-api-client.test.ts`,
   `chat-model-pill-surface.test.tsx`. Fixed with `prettier --write` on exactly those 3 files —
   pure whitespace/quote-style, no semantic change (confirmed by full diff review). Re-ran
   eslint + focused vitest on the two test files, both EXIT=0. Commit `80f01f537`.
2. **`test:integration` failure** — `release-hardening.test.ts` hit Postgres
   `tuple concurrently updated` inside `resetEmptyFoundationDatabase`. This is the exact
   signature in the `multi-agent-pg-contention` memory (concurrent `verify:foundation` runs
   from sibling sessions hitting the shared `jarv1s-postgres` instance — `JARVIS_PGDATABASE`
   isolates the DB name only, not the instance/locks). Confirmed via `docker ps` (healthy) and
   `herdr pane list` (3+ concurrent sibling gate runs at the time: #1121, #1560, #1557). No code
   fix — re-ran the gate once and it passed clean. **Not a regression, not a #1533 bug.**

Memory saved this session (project "jarv1s", type "bug", id `mem_msoesjwm_b8866440c757`):
lint-vs-typecheck/vitest coverage gap (`pnpm lint` catches things tsc/vitest never flag).

## Next (Phase 4, per plan lines 292-313 and spec lines 296-319)

1. **Live-path proof** — spec doc lines 296-319, 7-step procedure through job-search's
   "Change in chat" action. No dev instance up yet for this worktree. Port recon so far (from
   `ss -ltnp`): 3000/3001/3003/3005/3025/3030-3032/3096/3098/3099/3111-3113/3120/3143/5173/
   5174/5197 all taken by other sessions; 3002/3004 look free. `apps/web/vite.config.ts`
   defaults dev server to 5173 (taken — needs `--port` override), preview to 4173. **API
   server's port env var still not identified** — a grep for `process.env.PORT` /
   `process.env.JARVIS_PORT` in `apps/api/src/server.ts` found nothing; look harder (check for
   a config/env module import) before standing up a dev instance. 1533 (numeric) is **prod** —
   never target it for anything.
2. Sensitive-tier check: `git diff --stat main...HEAD`, confirm no AccessContext/RLS/
   persistence/gateway-contract files touched.
3. `coordinated-wrap-up` skill → draft PR (not merge), citing live-path evidence explicitly.

## Standing instructions (from boot brief, still governing)

- Coordinator: re-resolve fresh via `herdr pane list`/`herdr agent list` before messaging —
  `SendMessage` to a herdr-registered name FAILS ("no agent reachable"); use
  `herdr agent prompt <name> "..."` instead (confirmed working this relay).
- Relay again at the next 70% context warning or immediately on any compaction summary — do
  not wait for a felt %, never end turn mid-procedure.
- Use `scripts/run-gate.sh`, never bare `pnpm verify:foundation`.
