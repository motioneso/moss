# Slice 1c-core — Calendar, Email, Connectors, AI → Owner-or-Share / Owner-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the four "no-design-risk" modules from the legacy workspace-visibility access model to the new model — **calendar** (`app.calendar_events`) and **email** (`app.email_messages`) to **owner-or-share** (`app.has_share`), and **connectors** (`app.connector_accounts`) + **ai** (`app.ai_assistant_action_requests`) to **plain owner-only** (they hold encrypted credentials and are deliberately NOT shareable) — with the full `pnpm verify:foundation` gate staying green.

**Architecture:** Each conversion is a single new versioned SQL migration that `DROP`s and re-`CREATE`s the table's RLS policies so they no longer consult `visibility` / `workspace_id` / `is_workspace_member` / `current_workspace_id`. Calendar/email read `owner_user_id = app.current_actor_user_id() OR app.has_share('<type>', id, '<level>')`; connectors/ai read `owner_user_id = app.current_actor_user_id()` with **no share arm**. No schema columns are dropped and `AccessContext.workspaceId` is untouched — those leftovers stay inert until Slice 1f. Integration tests that asserted workspace-visibility access are rewritten to the new model (calendar/email cross-user reads become explicit `app.shares` grants; the `ai-tools` cross-cutting workspace assertions drop to "no longer visible", mirroring the Slice 1b fix).

**Tech Stack:** Postgres RLS (raw versioned SQL), Kysely, Vitest integration tests against the Docker Postgres from `pnpm db:up`.

---

## Decisions Locked (from brainstorming, do not re-litigate)

- **Scope = these four modules only.** Notifications, chat, briefings are a SEPARATE later plan
  (`slice-1c-1d-structural`) — they need parent-child share inheritance and (notifications) a
  no-`owner_user_id` redesign. Do **not** touch them here.
- **Calendar + email are shareable** (owner-or-share, levels `view`/`manage`). **Connectors and AI
  are owner-only and NOT shareable** — `connector_accounts`, `ai_provider_configs`,
  `ai_configured_models`, and `ai_assistant_action_requests` hold or relate to encrypted
  credentials; the "secrets never shared" invariant means we add **no `app.has_share` arm** to them.
  We only strip their dead workspace logic.
- **`ai_provider_configs` and `ai_configured_models` need NO migration.** The audit confirmed their
  policies are already pure `owner_user_id = app.current_actor_user_id()` with zero
  `visibility`/`workspace_id`/`is_workspace_member` references. Leave them entirely alone. The only
  AI table with workspace coupling is `ai_assistant_action_requests` (its INSERT policy).
- **`connector_definitions` needs NO conversion** — it is a static catalog (any authenticated user
  may read; instance-admin metadata policy is separate). Leave its policies alone.
- **Leave inert until Slice 1f:** all `visibility` / `workspace_id` columns, the
  `*_visibility` enums, `app.is_workspace_member`, `app.current_workspace_id`,
  `AccessContext.workspaceId`, and the module routes/DTOs/shared-API workspace fields. Do **not**
  prune them here.
- **No new share endpoints.** Shares are created directly via `SharesRepository`/SQL inside tests.

## Read First (the executor has zero context)

- `docs/superpowers/specs/2026-06-06-memory-data-model-design.md` — §"Sharing — `shares`",
  §"Changes to the Existing Scaffold". `app.has_share` answers the **share half only**, so RLS
  policies OR it with `owner_user_id = app.current_actor_user_id()`.
- `infra/postgres/migrations/0017_shares.sql` — `app.has_share(text, uuid, text)` (STABLE SECURITY
  DEFINER; granted to `jarvis_app_runtime` AND `jarvis_worker_runtime`) + `app.share_level_rank`.
- `packages/tasks/sql/0019_tasks_owner_or_share.sql` — the PROVEN owner-or-share template from
  Slice 1b. Mirror its shape.
- The **current** policies you are replacing:
  - `packages/calendar/sql/0011_calendar_module.sql` (lines ~98–162): `calendar_events_select` /
    `_insert` / `_update`.
  - `packages/email/sql/0012_email_module.sql` (lines ~97–161): `email_messages_select` / `_insert`
    / `_update`.
  - `packages/connectors/sql/0009_connectors_module.sql` (lines ~162–219):
    `connector_accounts_select` / `_insert` / `_update`.
  - `packages/ai/sql/0016_ai_assistant_actions.sql` (lines ~120–156):
    `ai_assistant_action_requests_select` / `_insert` / `_update` (only `_insert` changes).
- `tests/integration/shares.test.ts` — canonical `SharesRepository` + `withDataContext` usage.
- The test files you will edit: `tests/integration/calendar-email.test.ts`,
  `tests/integration/connectors.test.ts`, `tests/integration/ai-tools.test.ts`,
  `tests/integration/foundation.test.ts` (migration-list assertion). Note the exact `it(...)` titles
  called out below before editing.

## Environment

- `export PATH="$HOME/.local/bin:$PATH"` (corepack pnpm shim) — or `corepack pnpm <script>`.
- `pnpm db:up` before any integration test. `pnpm db:reset` for a clean reset.
- **Run a single test file directly** — `pnpm test:integration -- <path>` does NOT filter (it runs
  all files). Use: `npx vitest run tests/integration/<file>.test.ts` (add `-t "<name>"` to filter by
  test name within the file).
- Gate: `pnpm verify:foundation` (lint, format:check, check:file-size, typecheck, db:migrate,
  test:integration). Must end green.

## File Structure

- **Create** `packages/calendar/sql/0020_calendar_owner_or_share.sql` — calendar policies → owner-or-share.
- **Create** `packages/email/sql/0021_email_owner_or_share.sql` — email policies → owner-or-share.
- **Create** `packages/connectors/sql/0022_connectors_owner_only.sql` — connector_accounts → owner-only.
- **Create** `packages/ai/sql/0023_ai_action_requests_owner_only.sql` — action-requests INSERT → owner-only.
- **Modify** `tests/integration/calendar-email.test.ts` — convert calendar+email workspace-visibility cases to shares.
- **Modify** `tests/integration/connectors.test.ts` — convert the workspace-scoped account case to owner-only reality.
- **Modify** `tests/integration/ai-tools.test.ts` — drop the workspace-visibility assertions for calendar/email (and re-seed those rows the new way), mirroring the Slice 1b `bWorkspace` fix.
- **Modify** `tests/integration/foundation.test.ts` — append `0020`/`0021`/`0022`/`0023` to the migration-list assertion.

**Migration numbering:** the migration-list assertion in `foundation.test.ts` is ordered by
**version number** (it currently ends at `0019`), so new migrations only need numbers higher than all
existing and are **appended** in numeric order. Each new file also must sort after the existing files
in its own module dir (`0020 > 0011` calendar ✓, `0021 > 0012` email ✓, `0022 > 0010` connectors ✓,
`0023 > 0016` ai ✓). Both facts are recorded in the single `app.schema_migrations` table.

**Why calendar + email are ONE task:** they are tested in the SAME file
(`tests/integration/calendar-email.test.ts`) and share the same `ai-tools.test.ts` assertions, so
splitting them would serialize on those files anyway. Convert them together.

---

### Task 1: Convert Calendar + Email to owner-or-share

**Files:**

- Create: `packages/calendar/sql/0020_calendar_owner_or_share.sql`
- Create: `packages/email/sql/0021_email_owner_or_share.sql`
- Test: `tests/integration/calendar-email.test.ts` (modify)
- Test: `tests/integration/ai-tools.test.ts` (modify)
- Test: `tests/integration/foundation.test.ts` (migration-list, +0020 +0021)

- [ ] **Step 1: Write the failing shares-based calendar + email tests**

In `tests/integration/calendar-email.test.ts`, read the file's existing helpers first (it has a
`DataContextRunner`, a `userAContext(workspaceId?)` helper, an `ids` import with `userA`/`userB`,
calendar/email repositories, and the seeded ids `calendarEventIds.bWorkspace` /
`emailMessageIds.bWorkspace` which are owned by `ids.userB`). Add a `SharesRepository` to the
`@jarv1s/db` import and construct it once. Add a `userBContext()` helper if absent
(`{ actorUserId: ids.userB, requestId: "request:calendar-email-test" }`).

Add two cases inside the top-level describe (adapt repo/runner names to the file's reals):

```ts
it("allows calendar event read through a view share", async () => {
  // bWorkspace is owned by userB. Share 'view' to userA, then userA reads it.
  await runner.withDataContext(userBContext(), (scopedDb) =>
    sharesRepository.grant(scopedDb, {
      resourceType: "calendar_event",
      resourceId: calendarEventIds.bWorkspace,
      ownerUserId: ids.userB,
      granteeUserId: ids.userA,
      level: "view"
    })
  );
  const visibleToA = await runner.withDataContext(userAContext(), (scopedDb) =>
    calendarRepository.getById(scopedDb, calendarEventIds.bWorkspace)
  );
  expect(visibleToA?.id).toBe(calendarEventIds.bWorkspace);
});

it("allows email message read through a view share", async () => {
  await runner.withDataContext(userBContext(), (scopedDb) =>
    sharesRepository.grant(scopedDb, {
      resourceType: "email_message",
      resourceId: emailMessageIds.bWorkspace,
      ownerUserId: ids.userB,
      granteeUserId: ids.userA,
      level: "view"
    })
  );
  const visibleToA = await runner.withDataContext(userAContext(), (scopedDb) =>
    emailRepository.getById(scopedDb, emailMessageIds.bWorkspace)
  );
  expect(visibleToA?.id).toBe(emailMessageIds.bWorkspace);
});
```

> If the repo's read method isn't `getById`, use the file's real read method (e.g.
> `getCachedEventById` / a `listVisible`-style call filtered to the id). The point: a userB-owned row
> shared `'view'` to userA must be readable by userA.

- [ ] **Step 2: Run them to verify they FAIL**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm db:up && npx vitest run tests/integration/calendar-email.test.ts -t "view share"`
Expected: FAIL — the current `calendar_events_select` / `email_messages_select` policies don't
consult `app.shares`, so userA cannot read userB's row via a share.

- [ ] **Step 3: Write the calendar conversion migration**

Create `packages/calendar/sql/0020_calendar_owner_or_share.sql`:

```sql
-- Slice 1c: convert Calendar access from workspace-visibility to the owner-or-share
-- model (app.has_share). The visibility/workspace_id columns remain on
-- app.calendar_events but are no longer consulted for access; they are dropped in
-- Slice 1f. The connector-account integrity EXISTS check in the INSERT policy is a
-- data-integrity guard (not a visibility gate) and is preserved.

DROP POLICY IF EXISTS calendar_events_select ON app.calendar_events;
DROP POLICY IF EXISTS calendar_events_insert ON app.calendar_events;
DROP POLICY IF EXISTS calendar_events_update ON app.calendar_events;

CREATE POLICY calendar_events_select
ON app.calendar_events
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('calendar_event', id, 'view')
  )
);

CREATE POLICY calendar_events_insert
ON app.calendar_events
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
  AND EXISTS (
    SELECT 1
    FROM app.connector_accounts accounts
    JOIN app.connector_definitions definitions
      ON definitions.provider_id = accounts.provider_id
    WHERE accounts.id = connector_account_id
      AND accounts.owner_user_id = app.current_actor_user_id()
      AND definitions.provider_type = 'calendar'
  )
);

CREATE POLICY calendar_events_update
ON app.calendar_events
FOR UPDATE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('calendar_event', id, 'manage')
  )
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('calendar_event', id, 'manage')
  )
);
```

> Role stays `TO jarvis_app_runtime` only (calendar has no worker path — confirm against `0011`).
> This also fixes the pre-existing USING/WITH-CHECK asymmetry on UPDATE (both sides are now symmetric).

- [ ] **Step 4: Write the email conversion migration**

Create `packages/email/sql/0021_email_owner_or_share.sql` — identical shape, with `'email_message'`
and `provider_type = 'email'`:

```sql
-- Slice 1c: convert Email access from workspace-visibility to the owner-or-share
-- model (app.has_share). visibility/workspace_id columns remain but are no longer
-- consulted (dropped in Slice 1f). The connector-account integrity EXISTS check in
-- INSERT is preserved.

DROP POLICY IF EXISTS email_messages_select ON app.email_messages;
DROP POLICY IF EXISTS email_messages_insert ON app.email_messages;
DROP POLICY IF EXISTS email_messages_update ON app.email_messages;

CREATE POLICY email_messages_select
ON app.email_messages
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('email_message', id, 'view')
  )
);

CREATE POLICY email_messages_insert
ON app.email_messages
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
  AND EXISTS (
    SELECT 1
    FROM app.connector_accounts accounts
    JOIN app.connector_definitions definitions
      ON definitions.provider_id = accounts.provider_id
    WHERE accounts.id = connector_account_id
      AND accounts.owner_user_id = app.current_actor_user_id()
      AND definitions.provider_type = 'email'
  )
);

CREATE POLICY email_messages_update
ON app.email_messages
FOR UPDATE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('email_message', id, 'manage')
  )
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('email_message', id, 'manage')
  )
);
```

- [ ] **Step 5: Append the migration-list entries (+0020 +0021)**

In `tests/integration/foundation.test.ts`, find the `{ version, name }` array in the "applies
versioned SQL migrations from an empty database" test (currently ending at `0019`). Append, in order:

```ts
{ version: "0020", name: "0020_calendar_owner_or_share.sql" },
{ version: "0021", name: "0021_email_owner_or_share.sql" },
```

- [ ] **Step 6: Rewrite the obsolete calendar/email workspace-visibility cases**

In `tests/integration/calendar-email.test.ts`, the following cases use workspace-visibility for
cross-user / cross-context access and must be reworked (read each before editing; titles per the
audit):

- `it("shows workspace rows only with active joined workspace context", …)` → **rewrite to shares.**
  userB owns `calendarEventIds.bWorkspace` / `emailMessageIds.bWorkspace`; grant `'view'` to userA
  via `sharesRepository`, then assert userA can read both **regardless of workspace context** (shares
  are not workspace-scoped). Drop the "invisible without workspace header / invisible to non-member"
  framing — replace the cross-user positive assertions with the share path. (This may overlap Step 1's
  new tests; if so, fold this case into them and delete the now-duplicate.)
- `it("requires active workspace context for workspace-visible cache rows", …)` → **reframe.** Under
  owner-or-share, INSERT no longer requires workspace context (it is owner-only). Keep a create that
  succeeds for the owner and asserts the row persists; drop the "requires active workspace context"
  expectation. If the test seeded `visibility: 'workspace'`, the create still succeeds (the column is
  inert) — assert on the returned row id/owner rather than workspace gating.
- `it("serves read-only Calendar and Email APIs from session and workspace context", …)` → the
  workspace-context API assertions that expect `calendarEventIds.bWorkspace` / `emailMessageIds.bWorkspace`
  to appear (status 200 + list contains) now return 404 / absent for userA (userB's rows, unshared via
  the API). Either (a) seed a `'view'` share for userA so the API returns them (preferred — keeps API
  coverage), or (b) change the assertions to the owner's own rows. Keep the **session-context**
  (owner) assertions unchanged.

> Keep every no-bypass / private-isolation case unchanged (e.g. a user cannot read another user's
> **private** unshared row, admin-by-role gets nothing). Do not weaken them.

- [ ] **Step 7: Fix the cross-cutting `ai-tools.test.ts` calendar + email assertions**

In `tests/integration/ai-tools.test.ts`, the single test `it("executes declared read tools through
RLS-scoped module repositories", …)` asserts (around lines 207–208 and 213–214) that the
workspace-context tool results **contain** `calendarEventIds.workspace` and `emailMessageIds.workspace`
(both owned by `ids.userB`, seeded `visibility = 'workspace'`). Mirror the Slice 1b `bWorkspace` fix:

- Do **NOT** share these rows to userA (sharing would also make them appear in the personal-context
  `toEqual([... aPrivate])` assertions and break those — exactly the trap from 1b).
- Replace the workspace-context `toContain(calendarEventIds.workspace)` and
  `toContain(emailMessageIds.workspace)` assertions with the new reality: calendar/email are
  owner-or-share only (not workspace-scoped), so userA does not see userB's unshared rows. Assert
  `not.toContain(...)` (or that the workspace result equals the personal result for these modules),
  with a short comment.
- Leave the **notifications** workspace assertion and the **notes** workspace assertion in this same
  test UNCHANGED — those modules are not converted in this plan.
- The seed `seedConnectorBackedRows()` / `seedTasks`-style functions: leave the `visibility: 'workspace'`
  calendar/email seed rows as-is (the column is inert); you only change assertions.

- [ ] **Step 8: Run calendar-email + ai-tools + foundation to verify GREEN**

Run: `export PATH="$HOME/.local/bin:$PATH" && npx vitest run tests/integration/calendar-email.test.ts tests/integration/ai-tools.test.ts tests/integration/foundation.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/calendar/sql/0020_calendar_owner_or_share.sql packages/email/sql/0021_email_owner_or_share.sql tests/integration/calendar-email.test.ts tests/integration/ai-tools.test.ts tests/integration/foundation.test.ts
git commit -m "feat(calendar,email): convert RLS to owner-or-share via app.has_share

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Convert Connectors to owner-only

**Files:**

- Create: `packages/connectors/sql/0022_connectors_owner_only.sql`
- Test: `tests/integration/connectors.test.ts` (modify)
- Test: `tests/integration/foundation.test.ts` (migration-list, +0022)

- [ ] **Step 1: Write/adjust the failing test (workspace-scoped account no longer needs context)**

In `tests/integration/connectors.test.ts`, the case `it("requires active workspace context for
workspace-scoped connector accounts", …)` currently creates a connector account with
`workspaceId: ids.workspaceAlpha` and asserts it is listable **only** with the workspace header.
Under owner-only, the owner sees their account regardless of workspace context, and it is never
shared. Rewrite the assertion to: the owner (userA) lists the account in BOTH contexts (with and
without the workspace header), and a different user (userB) never sees it. Run it first to confirm it
fails against the current policy (the current policy hides a `workspace_id`-set account when no
workspace context is active):

Run: `export PATH="$HOME/.local/bin:$PATH" && npx vitest run tests/integration/connectors.test.ts -t "workspace"`
Expected: FAIL under the current policy (owner without workspace context cannot see the
workspace-scoped account).

> If the file has no userB helper, reuse its existing cross-user pattern (the suite already has a
> second identity for negative cases). Keep the negative assertion (another user cannot see it).

- [ ] **Step 2: Write the connectors conversion migration**

Create `packages/connectors/sql/0022_connectors_owner_only.sql`:

```sql
-- Slice 1c: convert connector_accounts access from owner + workspace-scoping to
-- plain owner-only. connector_accounts hold AES-encrypted credentials and are NOT
-- shareable (the "secrets never shared" invariant) — no app.has_share arm is added.
-- The workspace_id column remains but is no longer consulted for access; it is
-- dropped in Slice 1f. connector_definitions (catalog) policies are unchanged.

DROP POLICY IF EXISTS connector_accounts_select ON app.connector_accounts;
DROP POLICY IF EXISTS connector_accounts_insert ON app.connector_accounts;
DROP POLICY IF EXISTS connector_accounts_update ON app.connector_accounts;

CREATE POLICY connector_accounts_select
ON app.connector_accounts
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY connector_accounts_insert
ON app.connector_accounts
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY connector_accounts_update
ON app.connector_accounts
FOR UPDATE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
```

- [ ] **Step 3: Append the migration-list entry (+0022)**

In `tests/integration/foundation.test.ts`, append after the `0021` entry:

```ts
{ version: "0022", name: "0022_connectors_owner_only.sql" },
```

- [ ] **Step 4: Run connectors + foundation to verify GREEN**

Run: `export PATH="$HOME/.local/bin:$PATH" && npx vitest run tests/integration/connectors.test.ts tests/integration/foundation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/sql/0022_connectors_owner_only.sql tests/integration/connectors.test.ts tests/integration/foundation.test.ts
git commit -m "feat(connectors): convert connector_accounts RLS to owner-only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Convert AI assistant action requests INSERT to owner-only

**Files:**

- Create: `packages/ai/sql/0023_ai_action_requests_owner_only.sql`
- Test: `tests/integration/foundation.test.ts` (migration-list, +0023)

> `ai_provider_configs` and `ai_configured_models` are already owner-only with no workspace logic —
> do **not** create migrations for them. Only `ai_assistant_action_requests` INSERT carries a
> workspace-membership guard, and that is all this task removes. The audit + fallout map confirm
> **no integration test asserts cross-user action-request access**, so removing the guard (which only
> makes INSERT slightly less restrictive — still owner-only) breaks nothing. SELECT/UPDATE are
> already owner-only and untouched.

- [ ] **Step 1: Write the conversion migration**

Create `packages/ai/sql/0023_ai_action_requests_owner_only.sql`:

```sql
-- Slice 1c: remove the workspace-membership guard from the assistant action
-- requests INSERT policy (workspace context is being torn down). SELECT and UPDATE
-- are already owner-only and unchanged. ai_provider_configs / ai_configured_models
-- are already owner-only with no workspace logic and need no migration. None of
-- these tables are shareable (they hold or relate to encrypted credentials), so no
-- app.has_share arm is added. The workspace_id column on
-- app.ai_assistant_action_requests remains but is no longer consulted; dropped in
-- Slice 1f.

DROP POLICY IF EXISTS ai_assistant_action_requests_insert ON app.ai_assistant_action_requests;

CREATE POLICY ai_assistant_action_requests_insert
ON app.ai_assistant_action_requests
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
```

> Confirm the role list against `0016_ai_assistant_actions.sql` (`jarvis_app_runtime`); mirror it.

- [ ] **Step 2: Append the migration-list entry (+0023)**

In `tests/integration/foundation.test.ts`, append after the `0022` entry:

```ts
{ version: "0023", name: "0023_ai_action_requests_owner_only.sql" },
```

- [ ] **Step 3: Run the ai-tools + foundation suites to verify GREEN**

Run: `export PATH="$HOME/.local/bin:$PATH" && npx vitest run tests/integration/ai-tools.test.ts tests/integration/ai.test.ts tests/integration/foundation.test.ts`
Expected: PASS (the assistant write/confirm flow still works; INSERT is still owner-only).

- [ ] **Step 4: Commit**

```bash
git add packages/ai/sql/0023_ai_action_requests_owner_only.sql tests/integration/foundation.test.ts
git commit -m "feat(ai): drop workspace guard from assistant action requests INSERT (owner-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Full-gate verification on a fresh database

**Files:** none (verification only).

- [ ] **Step 1: Reset the database so all migrations apply from scratch**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm db:reset`
Expected: `Container jarv1s-postgres  Healthy`.

- [ ] **Step 2: Run the full foundation gate**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm verify:foundation`
Expected: lint ✓, format:check ✓, check:file-size ✓, typecheck ✓, db:migrate applies `0020`–`0023`
in order ✓, **all integration tests pass**. If format fails on touched files, run `pnpm format` and
re-run.

- [ ] **Step 3: Confirm no converted policy still references workspace/visibility**

Run: `grep -rn -E "is_workspace_member|current_workspace_id" packages/calendar/sql/0020_calendar_owner_or_share.sql packages/email/sql/0021_email_owner_or_share.sql packages/connectors/sql/0022_connectors_owner_only.sql packages/ai/sql/0023_ai_action_requests_owner_only.sql`
Expected: **no hits** (the new migrations consult neither). The old definitions in `0009`–`0016`
remain in history (overridden at runtime) and the workspace functions stay defined until Slice 1f.

- [ ] **Step 4: Confirm `0020`–`0023` are the final word on their policies**

Run: `grep -rn -E "POLICY .*(calendar_events_|email_messages_|connector_accounts_|ai_assistant_action_requests_)" packages/*/sql infra/postgres/migrations`
Expected: each policy is defined in its original module migration (`0009`/`0011`/`0012`/`0016`) and
re-defined once in the new `0020`–`0023` files — and **no later migration** (in any module) redefines
them. (No cross-module coupling exists for these tables — confirmed during planning.)

---

## What This Plan Deliberately Leaves For Later

- **Notifications, chat, briefings** → `slice-1c-1d-structural` plan (parent-child share inheritance;
  notifications' no-`owner_user_id` redesign; briefings worker grants).
- **Notes module removal** → Slice 1e.
- `visibility` / `workspace_id` columns, `*_visibility` enums, `app.is_workspace_member`,
  `app.current_workspace_id`, `AccessContext.workspaceId`, module routes/DTOs/shared-API workspace
  fields → **Slice 1f**.

---

## Self-Review

**1. Spec coverage.** Spec §"Changes to the Existing Scaffold" → migrate module visibility to the
shares model: calendar/email now read owner-or-`has_share` (Task 1); connectors/ai shed workspace
logic to owner-only (Tasks 2–3), honoring "secrets never shared" by adding no share arm. Spec
§"Testing Strategy" → share grants make a resource visible at the granted level: covered by the
calendar/email view-share tests (Task 1). No-admin-bypass + private-isolation cases retained unchanged.

**2. Placeholder scan.** All migration SQL is complete and literal. Test steps name the exact files
and `it(...)` titles and the conversion approach; the executor adapts to the files' real helper/var
names after reading them (the "Read First" + per-step notes make this explicit), exactly as the
proven Slice 1b plan did. No "TODO"/"handle edge cases" placeholders.

**3. Type/identifier consistency.** Resource-type strings: `'calendar_event'` (per `0011`),
`'email_message'` (per `0012`). Share levels `'view'`/`'manage'` match the `app.shares` CHECK and
`ShareLevel`. `SharesRepository.grant({ resourceType, resourceId, ownerUserId, granteeUserId, level })`
matches `packages/db/src/sharing/shares-repository.ts`. Roles `jarvis_app_runtime` match the source
migrations (none of these four tables grant to the worker). Migration filenames `0020`–`0023` match
the assertion-array entries and each sorts after its module's existing files.

---

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/2026-06-06-slice-1c-core-calendar-email-connectors-ai.md`. Per the project
workflow, execute with **superpowers:subagent-driven-development** — fresh Sonnet implementer per
task, controller reviews (spec compliance + code quality) between tasks, commit per task — and run a
thermo-nuclear / holistic review pass on the diff before merging the slice. **Watch for the same two
1b traps:** (1) after each module's migration, grep that no later migration redefines its policies
(none should, per planning); (2) the `ai-tools.test.ts` cross-cutting assertions are the recurring
fallout point — do not accidentally share workspace rows to userA (it corrupts the personal-context
`toEqual`).

```

```
