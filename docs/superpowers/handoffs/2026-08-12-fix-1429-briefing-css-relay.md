# #1429 briefing-action-rows CSS — relay continuation

**Relay trigger:** compaction summary observed in prior session context (relay skill: relay
immediately on sight, don't wait for felt degradation).

## Where things stand

- **Issue:** #1429 (briefing action-row CSS defect, split off #1327).
- **Branch/worktree:** `fix-1429-briefing-css`, this worktree. Tree is clean, all 5 build tasks
  committed, gate was green, PR is open.
- **PR:** #1594 — https://github.com/motioneso/moss/pull/1594
- **Coordinator:** agent name `coord-relay9` (was pane `w1:p7P` as of last contact — **re-resolve
  fresh via `herdr pane list` before messaging, do not reuse that pane id**). Session id
  `0bb9f516-c026-454f-bc97-dc9faf43bd20` is authority if the label/pane drifted.

## What's already resolved (don't redo)

1. **CI red herring — root-caused and closed.** PR #1594's "Verify foundation and app" job failed
   with `tests/integration/ai-tools.test.ts` DB-contention flake (30s timeout at line 416,
   `expected 500 to be 200` at line 615). Proved pre-existing by reproducing the identical two
   signatures on `main` itself (run `31577733205`, same day, before this branch's diff). Coordinator
   independently verified, agreed, reran CI (`gh run rerun --failed` on run `31650367397`).
   **Do not touch `ai-tools.test.ts`** — explicit coordinator instruction.
2. **QA verdict: RED, single blocker.** Everything else clean (0 blocking findings, diff matches
   plan, tests pass, CI green, audit clean). Sole issue: my earlier proof comment
   (https://github.com/motioneso/moss/pull/1594#issuecomment-5273988721) was two headless-test
   transcripts (UAT masthead spec + mocked `:4173` e2e config) — QA correctly disqualified this as
   NOT live-path proof per `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate (a passing headless
   test alone is explicitly insufficient). QA's full verdict:
   https://github.com/motioneso/moss/pull/1594#issuecomment-5274577717

## The one remaining task

**Produce genuine live-path proof and post it as a new PR comment on #1594**, then reply to the
coordinator, per QA's exact instruction: *"spin up/use a live dev instance, manually walk the
Today page so the `.loose-row` layout / briefing-action-rows changes actually render, capture
screenshot(s), post them as a new PR comment on #1594."*

### Established plan (investigated, not yet executed)

1. **Rendering path to seed:** `rowsFromSuggestedTasks()` in
   `apps/web/src/today/briefing-action-rows.tsx:271-310` renders real `.loose-row` items from a
   `TaskDto` directly — no full briefings-pipeline run needed. Guard conditions (all must hold):
   `task.status === "suggested"`, `task.suggestionMetadata.version === 1`,
   non-empty `suggestionMetadata.cacheMessageId` (trimmed), non-null/non-empty `task.sourceRef`.
2. **Seed target:** one `app.tasks` row (schema reconstructed from `packages/tasks/sql/0003_*.sql`,
   `0039_*.sql`, `0178_task_suggestion_metadata.sql`):
   - `owner_user_id` — a real user id on the dev DB (use existing seeded user, e.g. `ben@ben.com`
     per PR #1494 precedent, or check `tests/uat/seed/admin.js` for creds).
   - `list_id` — NOT NULL FK to `app.task_lists`; use/create one for that owner.
   - `status = 'suggested'`
   - `source = 'manual'`, `source_ref = 'seed-1429-proof'` (non-empty, satisfies guard)
   - `suggestion_metadata` jsonb matching `TaskSuggestionMetadataV1`
     (`packages/shared/src/briefing-action-rows.ts` ~line 1-34):
     `{"version":1,"category":"needs_action","sourceLabel":"Test Source","sourceHref":null,"cacheMessageId":"seed-cache-1429","subjectSignature":"seed-1429","computedAt":"<iso now>","resurfaceReason":null}`
     (cacheMessageId just needs to be non-empty — `needs_action` category doesn't use it for the
     primary action, `needs_reply` would).
3. **No existing UAT seed/fixture covers this** — confirmed via `grep -rln "briefing"
   tests/uat/seed tests/uat/specs` (zero hits). Seeding is manual/ad hoc SQL insert, not a reusable
   script.
4. **Dev instance:** do NOT reuse other worktrees' running instances — confirmed port `5173`
   (Vite) is held by a different worktree (`batch1-chat-approvals`, pid `1550288`) and port `5197`
   by an older/possibly long-lived `@jarv1s/web` process (pid `2371847`, running since Aug 5) —
   neither is mine. Port `55433` (dev Postgres, shared, `jarv1s-postgres` container, DB `jarv1s`,
   schema `app`) is up and fine to connect to. **Before starting anything, re-check with a clean
   `ss -ltnp | grep -E ':(3000|3099|5173|5199)\b'`** — prior check didn't get a definitive read on
   3000/3099/5199 specifically. Follow `dev-preview-recipe` memory but on throwaway, non-conflicting
   ports (PR #1494 precedent used `:3099` API / `:5199` web) — never touch prod
   (`/home/ben/JarvisProd`, port 1533, `:edge` image).
5. **Drive real UI:** headless Playwright script (ad hoc, not the mocked `tests/e2e/*.spec.ts`
   config) against the throwaway instance — sign in as the seeded owner, navigate to `/today`, wait
   for `.jds-brief`/`.loose-row` to render, screenshot to disk.
6. **Verify screenshot via cropped-region reads only** (CLAUDE.md: never pull a full-page
   screenshot into context).
7. **Teardown:** stop the throwaway instance by exact recorded PID (never by name pattern — prod's
   worker looks like a stray dev process in `ps`), delete the seeded task/list rows by exact id.
8. **Post proof comment on PR #1594** — format precedent: PR #1494's accepted comment
   (https://github.com/motioneso/moss/pull/1494#issuecomment-5236804138) describes screenshot
   content precisely rather than embedding an actual image — confirmed repo-wide that this fleet
   has no working mechanism to embed real inline GitHub images via `gh` CLI (only 1 hit across all
   PR/issue comments repo-wide, and it looks like Ben's own manual paste). If QA rejects a
   description-only comment a second time, that needs to go back to the coordinator — don't loop
   on it solo.
9. **Reply to coordinator** (re-resolve pane fresh via `herdr pane list` first) once posted.

### Not yet started
Starting the dev instance, seeding the row, driving the browser, screenshotting, and posting the
comment — none of this has been executed yet. Everything above is investigation/planning only.

## Guardrails carried forward
- Do not touch `tests/integration/ai-tools.test.ts`.
- Do not move the board, close the issue, or merge — coordinator's job.
- Never `git add -A`; this worktree may still see stray unrelated file touches (a #1412 evidence
  PNG got modified by some prior test run and was reverted this session — not related to #1429,
  don't re-touch it).
- Box-wide CLAUDE.md: never poll in-context: bound waits with `run_in_background` + `until`, or
  Monitor.
