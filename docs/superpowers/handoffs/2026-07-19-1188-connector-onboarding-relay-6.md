# Relay 6 — #1188 connector onboarding (real-dev UI evidence remaining)

Context meter hit 71%. Relaying per `relay` skill. PR is open and CI-green except one
pending check; Coordinator added a NEW requirement (real-dev UI assertions) since the
last relay — that is the only work left.

**Spec:** `docs/superpowers/specs/2026-07-19-1188-connector-onboarding-feedback.md`
**Worktree/branch:** same as before, `fix/1188-connector-onboarding-clean` (this worktree,
`feedback-1188-connector-onboarding`).
**PR:** https://github.com/motioneso/Jarv1s/pull/1206 — **DO NOT MERGE.**
**Coordinator:** label `Coordinator` — re-resolve pane fresh by label via `herdr pane list`
(was `w1:pY3`, codex agent, session `019f7d05-a0a6-7742-9dc0-be5c00fbe2e3` — pane number
is ephemeral, re-resolve, don't trust this number).

## What's done (this relay's predecessor)

- Branch rebased onto `origin/main` @ `97b5bd52` (post PR #1201), scope re-proven clean:
  10 commits, only onboarding files + docs touched, no inherited commits.
- Rebase pulled in PR #1201's new `jszip`/`mammoth` deps (packages/chat) — ran `pnpm
  install` to fix; **do not skip install in this worktree going forward**, deps changed.
- Gate green: `VF_EXIT=0` (isolated DB `jarv1s_gate_1188`), `AUDIT_EXIT=0`
  (`pnpm audit:release-hardening`), format/lint/typecheck all exit 0 post-rebase.
- 16/16 e2e green (`tests/e2e/onboarding.spec.ts`) — **but these are fully `mockApi()`
  mocked**, not a real backend. That's exactly why Coordinator is now asking for more.
- PR #1206 opened, pushed, reported to Coordinator. Coordinator responded: gate still
  BLOCKED on two things:
  1. **"Build and publish images" CI check — pending** (not in our control, just poll it):
     `gh pr checks 1206`. All other checks (`Verify foundation and app`, `Compose
     deployment smoke`, `Prod compose deployment smoke`) already **pass**.
  2. **No linked real-dev UI run + assertions/evidence.** Coordinator: "Add durable live-path
     proof; never merge. Route evidence to Coordinator."

## Next concrete steps

1. **Poll CI:** `gh pr checks 1206` — report final status of "Build and publish images"
   to Coordinator either way (pass or fail) when it resolves. Do not block the evidence
   work on this; do it in parallel/either order.

2. **Manual real-dev UI proof** — follow the exact precedent at
   `docs/superpowers/handoffs/2026-07-15-995-uat-evidence/README.md` (a prior, very
   similar IMAP-onboarding feature, #995). Read that README for the format to replicate.

   - **Ports (already scanned free, avoid these live ones: 3000/3001/3900s/3901,
     5173-5178 are all in use by other concurrent sessions):** use **API `3902`**, **web
     `5179`** for this worktree's throwaway dev instance.
   - **DB:** use a **fresh isolated DB**, not the shared `jarv1s` one — avoids the known
     "owner-signup deadlock on stale `app.users`" trap (memory `dev-preview-recipe`,
     issues #853/#854). E.g.:
     ```bash
     docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarv1s_uidemo_1188;"
     docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE jarv1s_uidemo_1188;"
     JARVIS_PGDATABASE=jarv1s_uidemo_1188 pnpm db:migrate
     ```
   - **Start servers** (background, from this worktree root):
     ```bash
     JARVIS_PGDATABASE=jarv1s_uidemo_1188 PORT=3902 pnpm dev:api > /tmp/cb-1188-api.log 2>&1 &
     JARVIS_API_PROXY_TARGET=http://localhost:3902 pnpm --filter @jarv1s/web exec vite --host 0.0.0.0 --port 5179 > /tmp/cb-1188-web.log 2>&1 &
     # poll readiness, don't sleep-guess:
     timeout 30 bash -c 'until curl -sf http://localhost:5179 >/dev/null; do sleep 1; done'
     ```
     Stop when done: `lsof -ti:5179 -sTCP:LISTEN | xargs -r kill; lsof -ti:3902 -sTCP:LISTEN | xargs -r kill`.
   - **Drive with `chromium-cli`** (see `run` skill → `examples/playwright.md` for the
     command grammar: `nav` / `wait-for` / `click` / `fill` /
     `console --errors`). Fresh empty DB → hitting `/` should show the real owner
     bootstrap/signup flow (first user becomes owner) — walk it for real, no mocks.
   - **States to assert** (this is #1188's actual scope — connector onboarding, not
     #995's IMAP-cleanup scope):
     1. Provider picker showing Google and IMAP cards with **equal visual weight**
        (`f822d53d` / `fe2a0c6d` commits' subject).
     2. Add-account picker **not** collapsing back into the connected-account summary
        mid-flow (`c2f56e66` commit's subject — the original bug being fixed).
     3. Google card: click connect, confirm the **one-click consent popup** triggers
        immediately (no extra intermediate confirm step). No real Google OAuth creds in dev is
        fine/expected; note that plainly if
        the popup errors past that point, don't treat it as a #1188 regression.
     4. IMAP path: provider setup steps with the verified per-provider help link, nested
        under the last guide step (`a382c8ac` commit's subject).
     5. `console --errors` after each nav — confirm nothing throws. Note anything found
        even if expected (e.g. missing OAuth client id in dev).
   - Record bounded DOM, network, console, and API assertion results in the PR comment, including
     ports used, DB, PR HEAD SHA, and caveats such as the missing OAuth credentials in dev.
   - Driver script itself is throwaway (like #995's `tests/uat-scratch/uat-manual.mjs`) —
     do not commit it, delete after.

3. **Post the assertion summary in the PR** with `gh pr comment 1206 --body "..."`.

4. **Route the same evidence summary to Coordinator directly** via `herdr-pane-message`
   (label `Coordinator`, re-resolve pane) — link the PR comment, state VF_EXIT/AUDIT_EXIT,
   the CI "Build and publish images" status from step 1, and explicitly restate **not
   merged, awaiting Coordinator**. Then stop.

## Governing instructions (most recent wins, all still active)

1. Report PR URL to Coordinator, **do not merge** — reaffirmed twice now, most recently
   with this evidence request. Treat as absolute.
2. Never redirect gate/audit output to a bare shared path like `/tmp/cb-vf.log` — use a
   session/worktree-unique path (fleet trap, hit this run: `/tmp/cb-vf.log` got clobbered
   by a concurrent `gate_1182` session writing the same path). All logs this session used
   `/tmp/cb-*-1188.log` — keep that convention.
3. Gate lock: do NOT start any NEW full `verify:foundation` run without Coordinator
   release. The dev servers in step 2 are a targeted manual UI check, not a gate rerun —
   fine under the lock. If unsure whether something counts as "new full gate", ask first.

## Self-monitor reminder

Relay again immediately on the next context-meter 70% warning — don't wait to finish all
remaining steps in one session.
