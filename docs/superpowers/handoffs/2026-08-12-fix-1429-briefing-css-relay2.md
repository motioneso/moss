# #1429 briefing-action-rows CSS — relay continuation (relay 2)

**Relay trigger:** context meter hit 70% warning mid live-path-proof work. Superseding
`2026-08-12-fix-1429-briefing-css-relay.md` — read THIS doc, not that one (that one's plan is now
partly executed; don't redo).

## Where things stand

- **Issue:** #1429. **Branch/worktree:** `fix-1429-briefing-css`, this worktree, clean, all build
  commits in. **PR:** #1594 — https://github.com/motioneso/moss/pull/1594.
- **Coordinator:** agent name `coord-relay9` — **re-resolve fresh via `herdr pane list` before
  messaging** (label/pane drift expected). Session id `0bb9f516-c026-454f-bc97-dc9faf43bd20` is
  authority if label drifted further.
- **Task:** produce genuine live-path proof (screenshot of `.loose-row` rendering on a live dev
  instance), post as new PR comment on #1594, reply to coordinator. QA's exact instruction is in
  relay-1's doc (git history) if needed — short version: headless test transcripts were
  disqualified, need a real browser against a real running instance.

## What's done this relay (don't redo)

1. **Discovered `jarv1s-postgres` (dev DB container, port 55433) was fully recreated today** —
   container+volume both created 2026-08-12T21:10:09Z, 0 tables. Not something I caused; flag to
   coordinator if asked, but not a blocker — the recipe's `pnpm db:migrate` step fixes it.
2. **Ran `pnpm db:migrate` from repo root** — succeeded, `app` schema now has 93 tables. Safe to
   rerun (idempotent) if needed.
3. **Seeded a real loginable dev user** (pattern copied from `tests/uat/seed/admin.ts`
   `seedLoginableUser`, hash via `better-auth/crypto`'s `hashPassword` — do NOT hand-roll):
   - `app.users` row: email `ben@ben.com`, id **`e432589a-456a-4431-80fe-53dbc4b7fca7`** (also
     saved to this worktree's scratchpad `seed-user-id.txt`, but that's a session-specific tmp
     path — treat the id in this doc as authoritative).
   - `app.auth_accounts` row: `provider_id='credential'`, `account_id=<same uuid>`,
     `password` = scrypt hash for **`jarvistest123!`** (Ben's standard throwaway dev password per
     [[dev-instance-lan-spinup-trusted-origins]] memory).
   - Verified both rows exist (`select` came back non-empty after insert).
4. **Important tooling trap hit and solved:** `docker exec jarv1s-postgres psql -U postgres -d
   jarv1s -v uid=... -c "..."` — psql `-v`/`:'var'` interpolation **silently fails with a syntax
   error when using `-c`** in this container's psql (17.10). It DOES work via stdin:
   `docker exec -i jarv1s-postgres psql -U postgres -d jarv1s -v uid="$X" <<'SQL' ... SQL`
   (note the `-i` flag on `docker exec`, and heredoc). Use this form for all remaining seed SQL.

## Immediate next steps (not started)

1. **Create `app.task_lists` row** for owner `e432589a-456a-4431-80fe-53dbc4b7fca7` (any `name`,
   e.g. `"Inbox"`). Capture the returned `id` (`RETURNING id`).
2. **Create `app.tasks` row** — schema confirmed via `\d app.tasks`, guard confirmed by reading
   `rowsFromSuggestedTasks()` at `apps/web/src/today/briefing-action-rows.tsx:271-310` (still
   accurate, just re-read it this relay). Required for the row to render as a `.loose-row`:
   - `owner_user_id` = the seeded user id above
   - `list_id` = the task_lists id from step 1
   - `status = 'suggested'`
   - `source = 'manual'`, `source_ref = 'seed-1429-proof'` (must be non-null/non-empty)
   - `title` = anything non-empty, e.g. `'Live-path proof #1429'`
   - `suggestion_metadata` jsonb, matching `TaskSuggestionMetadataV1` shape
     (`packages/shared/src/briefing-action-rows.ts` ~line 1-34):
     ```json
     {"version":1,"category":"needs_action","sourceLabel":"Test Source","sourceHref":"https://example.com/seed-1429","cacheMessageId":"seed-cache-1429","subjectSignature":"seed-1429","computedAt":"<iso now>","resurfaceReason":null}
     ```
     **Use a non-null `sourceHref` this time** (relay-1's doc had planned `null` — changed on
     review: with `category:"needs_action"` and non-empty `meta.sourceHref`, `primaryAction`
     becomes `{kind:"view", href}` per `briefing-action-rows.tsx:293-298`, so `PrimaryControl`
     actually renders a button — this is the more meaningful proof of the PR's actual fix
     ("PrimaryControl reads primaryAction, not sourceHref", commit `594f537d8`) than a row with no
     primary action at all.
   - `id` — let it default (`gen_random_uuid()`) or supply one; capture whichever id is used, for
     teardown.
3. **Check ports before starting anything**: `ss -ltnp | grep -E ':(3000|3099|5173|5197|5199)\b'`
   — as of this relay, `:5173` held by another worktree (pid 1550288, not mine) and `:5197` by an
   old `@jarv1s/web` process (pid 2371847, not mine). `:3099`/`:5199` were free — use those
   (matches PR #1494 precedent, see [[pr1494-e2e-glob-fix-and-livepath-status]] memory). Re-check
   fresh, don't trust this snapshot if much time has passed.
4. **Start throwaway dev API `:3099` + web `:5199`** in this worktree, per
   [[host-dev-install-seam-env-pair]] + [[dev-instance-lan-spinup-trusted-origins]] memories:
   ```
   JARVIS_PGPORT unset (default 55433 is correct, matches DB above)
   JARVIS_AUTH_TRUSTED_ORIGINS="http://localhost:3099,http://localhost:5199,http://localhost:3000"
   BETTER_AUTH_SECRET="<any-stable-dev-string>"
   JARVIS_API_PROXY_TARGET="http://localhost:3099"
   JARVIS_CLI_RUNNER_SOCKET="/tmp/throwaway-1429-cli.sock"   (placeholder, never dialed)
   JARVIS_CLI_RUNNER_RPC_SECRET="throwaway-1429-secret"       (placeholder, must be set too — half
                                                                the pair crashes API boot)
   NODE_ENV unset (do NOT set — breaks credential decryption)
   PORT=3099 for API, web dev server on 5199 (check apps/web dev script / vite --port flag)
   ```
   Run both via `run_in_background` (never poll in-context — use `until curl -sf
   http://localhost:3099/... ; do sleep 1; done` bounded wait, or Monitor). **Record exact PIDs**
   for teardown (`prod-worker-looks-like-a-dev-orphan-in-ps` memory: never kill by name pattern).
5. **Drive real UI** with an ad hoc Playwright script (inside this worktree, `@playwright/test`,
   wait on `domcontentloaded` not `networkidle` per memory) — POST `/api/auth/sign-in/email` with
   `ben@ben.com` / `jarvistest123!` first to confirm 200 (delete the response, it holds a session
   token), then drive the browser: sign in via UI, navigate `/today`, wait for `.jds-brief` /
   `.loose-row`, screenshot to a scratchpad path.
6. **Verify screenshot via cropped-region reads only** — never pull a full-page screenshot into
   context (box-wide CLAUDE.md rule).
7. **Teardown**: delete the `app.tasks` row, the `app.task_lists` row, the `app.auth_accounts` row,
   and the `app.users` row (in that FK order, or just delete the user — `ON DELETE CASCADE` covers
   auth_accounts/task_lists/tasks via owner FK, confirm with the `\d` output above which cascades
   are real before relying on it blindly). Kill API/web processes by exact recorded PID. Re-check
   `ss -ltnp` shows `:3099`/`:5199` free after.
8. **Post proof comment on PR #1594** — format precedent: PR #1494's accepted comment
   (https://github.com/motioneso/moss/pull/1494#issuecomment-5236804138) describes screenshot
   content precisely rather than embedding an image (no working inline-image mechanism via `gh`
   CLI in this fleet). If QA rejects a description-only comment a second time, escalate to
   coordinator — don't loop on it solo.
9. **Reply to coordinator** (re-resolve pane fresh via `herdr pane list` first) once posted.

## Guardrails carried forward (unchanged)
- Do not touch `tests/integration/ai-tools.test.ts` (pre-existing DB-contention flake,
  root-caused, coordinator's explicit instruction to leave alone).
- Do not move the board, close the issue, or merge — coordinator's job.
- Never `git add -A`.
- Never poll in-context: bound waits with `run_in_background` + `until`, or Monitor.
- Dev DB (`jarv1s-postgres` :55433) is shared — insert/delete by exact id only, never a reset.
- Never touch prod (`/home/ben/JarvisProd`, port 1533, `:edge` image).
