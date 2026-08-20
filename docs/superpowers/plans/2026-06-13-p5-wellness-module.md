# Wellness Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/wellness/` — the first `required:false` / user-toggleable optional module — providing feelings check-ins (Feelings-Wheel modal), medications + dose logging, a generic focus-signal contribution point that re-weights focus, a briefings section via the existing read-tool seam, and a chat recall energy-trend fact, docking through existing seams with the minimum justified core change.

**Architecture:** Wellness follows the full-module template set by `packages/tasks/` (manifest + sql + repository + routes + tools + web). It registers as one entry in `BUILT_IN_MODULES`. Three owner-only RLS tables (`app.wellness_checkins`, `app.medications`, `app.medication_logs`) mirror `app.preferences` (ENABLE+FORCE, owner-only, no share). The ONE generic core change is a `FocusSignal`/`FocusSignalProvider` type + optional `focusSignal` manifest field in `@jarv1s/module-sdk`, aggregated by a generic helper and consumed in the tasks focus route via a provider injected from the composition root — tasks never imports wellness. The aggregator is built from the **per-actor active manifest set** (`resolveActiveModules(actorUserId)`), so a user who disables Wellness gets no Wellness focus contribution. Briefings/chat/recall reuse existing seams with zero or one-line touches. Browser-safe taxonomy (feelings wheel + sensations) lives in `@jarv1s/shared` so the web bundle never imports the server-only `@jarv1s/wellness` index (which pulls `node:url`).

**Grounding note (READ FIRST — the Phase-2 seam has ALREADY landed on this branch):** the module-enablement seam from `docs/superpowers/specs/2026-06-12-p2-module-enablement-seam-docking-ports.md` is **merged on `phase2-portable-deploy`**: `packages/module-registry/src/active-modules-resolver.ts` (`createActiveModulesResolver` / `ActiveModulesResolver = (actorUserId) => Promise<readonly JarvisModuleManifest[]>`), `packages/module-registry/src/route-guard.ts` (404s disabled-module routes), `app.module_enablement` (migration `0065_module_enablement.sql`), `/api/me/modules` + `/api/me/modules/:id` (`MyModuleDto` with `active`/`userDisabled`), and `tests/integration/route-guard.test.ts` exercising it. Therefore per-user disable is REAL NOW — this plan wires Wellness to honor it immediately (active-filtered focus providers, nav hidden when `active===false`, disable tests) rather than deferring to "after Phase-2."

**Tech Stack:** TypeScript (NodeNext ESM), Fastify 5, Kysely 0.29 over Postgres 17 (pgvector image), pg-boss 12, React 18 + React Router + TanStack Query (web), Vitest integration tests against `pnpm db:up` Postgres.

---

## Preflight (run once before Task 1)

- [ ] **Confirm tree freshness and record the commit.**

```bash
pnpm audit:preflight && git rev-parse HEAD
```

Expected: exit 0 (tree current). Record the printed SHA in the PR description as "grounded on `<sha>`". If it exits 1 (behind baseline), STOP — do not build on a stale tree.

- [ ] **Confirm the global migration high-water mark and pick the next free GLOBAL prefixes.**

```bash
find packages -path '*/sql/*.sql' -printf '%f\n' | sort | tail -3
ls infra/postgres/migrations/ | sort | tail -3
```

Expected on `phase2-portable-deploy`: the highest module prefix is `0065` (`packages/settings/sql/0065_module_enablement.sql` — the Phase-2 enablement seam, already landed). **`0065` is therefore TAKEN — this plan uses `0066` (checkins), `0067` (medications), `0068` (medication_logs).** If another in-flight slice has already taken `0066–0068`, bump every migration filename in this plan to the next free global prefixes and keep them contiguous. Re-check immediately before each migration commit.

- [ ] **Start the database.**

```bash
pnpm db:up
```

Expected: Postgres container healthy.

---

## File Structure

### New package: `packages/wellness/`

- `packages/wellness/package.json` — workspace package; deps `@jarv1s/db`, `@jarv1s/module-sdk`, `@jarv1s/shared`, `fastify`, `kysely`. **NOT** `@jarv1s/tasks`. (pg-boss added only when the reminder worker activates — deferred.)
- `packages/wellness/src/index.ts` — public exports (manifest, sql dir, repository, route registrar, tools, focus provider).
- `packages/wellness/src/manifest.ts` — `wellnessModuleManifest` (`required:false`, `supportsUserDisable:true`), `WELLNESS_MODULE_ID`, sql dir, deferred reminder queue constant.
- `packages/wellness/src/repository.ts` — `WellnessRepository` (check-in + medication + dose CRUD; `DataContextDb` only). (The feelings taxonomy + body-sensations + `isValidFeelingPath` live in `@jarv1s/shared`, NOT here, so the web bundle stays node-free.)
- `packages/wellness/src/schedule.ts` — pure schedule computation over `frequency_type` + `schedule_times` + a date.
- `packages/wellness/src/focus-signal.ts` — Wellness's `FocusSignalProvider` (readiness from recent check-ins + adherence).
- `packages/wellness/src/recall-context.ts` — derived energy-trend fact text + writer (uses memory's public `ChatMemoryFactsRepository`).
- `packages/wellness/src/routes.ts` — `registerWellnessRoutes` (REST, mirrors `registerTasksRoutes`).
- `packages/wellness/src/tools.ts` — `wellnessRecentCheckInsExecute`, `wellnessMedicationAdherenceExecute`.
- `packages/wellness/src/serialize.ts` — row → DTO mappers.
- `packages/wellness/sql/0066_wellness_checkins.sql`
- `packages/wellness/sql/0067_wellness_medications.sql`
- `packages/wellness/sql/0068_wellness_medication_logs.sql`

### New shared contract

- `packages/shared/src/wellness-api.ts` — DTOs + JSON-schemas (browser-bundled; NO `node:*`).

### New web surface: `apps/web/src/wellness/`

- `apps/web/src/wellness/wellness-page.tsx` — tabbed Feelings / Medications surface.
- `apps/web/src/wellness/feelings-picker.tsx` — BASIC `FeelingsPicker` (plain dependent selects; no colored wheel — polish deferred to a Ben UI session).
- `apps/web/src/wellness/feelings-checkin-modal.tsx` — the check-in modal.
- `apps/web/src/wellness/medications-view.tsx` — add/edit + list.
- `apps/web/src/wellness/medication-schedule.tsx` — today's schedule + dose logging.

### New mockup

- `docs/brand/mockups/feelings-wheel-modal.html` — static HTML mockup of the modal flow.

### New test

- `tests/integration/wellness.test.ts`

### Modified core files (the exact ledger — NO other core edits)

- `packages/module-sdk/src/index.ts` — add `FocusSignal`, `FocusSignalProvider`, `RegisteredFocusSignal`, `aggregateFocusSignals` (+ sanitized `onProviderError`), and `focusSignal?` on `JarvisModuleManifest`.
- `packages/db/src/types.ts` — add three table interfaces + `JarvisDatabase` entries + `Selectable` exports.
- `packages/module-registry/src/index.ts` — one `BUILT_IN_MODULES` entry + imports; add `focusSignalProvidersFor(manifests)` + thread `focusSignals` through `BuiltInRouteDependencies`.
- `packages/tasks/src/routes.ts` — focus route consumes injected `focusSignals` (generic; no wellness import).
- `packages/shared/src/tasks-api.ts` — additive `signals` field on the focus response schema (`tasks/manifest.ts` is NOT touched — it references `focusTasksRouteSchema`, which we update in shared).
- `apps/api/src/server.ts` — build a per-actor, active-filtered focus-signal aggregator (via the already-present `resolveActiveModules` + `dataContext`) and inject it.
- `apps/web/src/app.tsx` — add `<Route path="/wellness" ... />` (the documented caveat) + fetch `/api/me/modules` and pass `disabledModuleIds` to the shell.
- `apps/web/src/shell/app-shell.tsx` — add `HeartPulse` icon; `readNavigation` hides nav for the actor's disabled modules (`disabledModuleIds`).
- `apps/web/src/api/query-keys.ts` + `apps/web/src/api/client.ts` — wellness query keys + typed client fns + `getMyModules()` / `myModules` key.
- `packages/shared/src/index.ts` — `export * from "./wellness-api.js"`.
- `tsconfig.json` — add `@jarv1s/wellness` path mapping.
- `package.json` — add `test:wellness` script.

---

## Stage 1 — Package scaffold, tables + RLS, db types

### Task 1: Create the `@jarv1s/wellness` package scaffold + path mapping + test script

**Files:**

- Create: `packages/wellness/package.json`
- Create: `packages/wellness/src/index.ts`
- Create: `packages/wellness/src/manifest.ts`
- Modify: `tsconfig.json` (add path mapping after the `@jarv1s/tasks` entry)
- Modify: `package.json` (add `test:wellness` after the `test:tasks-tools` script)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/wellness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { wellnessModuleManifest, WELLNESS_MODULE_ID } from "@jarv1s/wellness";

describe("Wellness module — manifest", () => {
  it("is the first required:false / user-toggleable module", () => {
    expect(WELLNESS_MODULE_ID).toBe("wellness");
    expect(wellnessModuleManifest.lifecycle).toBe("user-toggleable");
    expect(wellnessModuleManifest.availability?.defaultEnabled).toBe(true);
    expect(wellnessModuleManifest.availability?.required).toBe(false);
    expect(wellnessModuleManifest.availability?.supportsUserDisable).toBe(true);
    expect(wellnessModuleManifest.compatibility.jarv1s).toBe(">=0.0.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `Cannot find module '@jarv1s/wellness'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/package.json`:

```json
{
  "name": "@jarv1s/wellness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@jarv1s/db": "workspace:*",
    "@jarv1s/module-sdk": "workspace:*",
    "@jarv1s/shared": "workspace:*",
    "fastify": "^5.6.2",
    "kysely": "^0.29.2"
  }
}
```

Create `packages/wellness/src/manifest.ts`:

```ts
import { fileURLToPath } from "node:url";

import type { JarvisModuleManifest } from "@jarv1s/module-sdk";

export const WELLNESS_MODULE_ID = "wellness";
export const WELLNESS_MEDICATION_REMINDER_QUEUE = "wellness-medication-reminder";
export const wellnessModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const wellnessModuleManifest = {
  id: WELLNESS_MODULE_ID,
  name: "Wellness",
  version: "0.1.0",
  publisher: "jarv1s",
  lifecycle: "user-toggleable",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: false,
    supportsUserDisable: true
  }
} satisfies JarvisModuleManifest;
```

Create `packages/wellness/src/index.ts`:

```ts
export {
  WELLNESS_MODULE_ID,
  WELLNESS_MEDICATION_REMINDER_QUEUE,
  wellnessModuleManifest,
  wellnessModuleSqlMigrationDirectory
} from "./manifest.js";
```

In `tsconfig.json`, add after the `"@jarv1s/structured-state"` line (keep valid JSON — add a comma to the prior line):

```json
      "@jarv1s/wellness": ["packages/wellness/src/index.ts"]
```

In `package.json`, add after the `"test:tasks-tools": ...` line:

```json
    "test:wellness": "vitest run tests/integration/wellness.test.ts",
```

- [ ] **Step 4: Install the new workspace package, then run the test**

Run: `pnpm install && vitest run tests/integration/wellness.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/package.json packages/wellness/src/index.ts packages/wellness/src/manifest.ts tsconfig.json package.json pnpm-lock.yaml tests/integration/wellness.test.ts
git commit -m "feat(wellness): scaffold @jarv1s/wellness package + manifest (Stage 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: Create `app.wellness_checkins` table + RLS (migration 0066) + db types

**Files:**

- Create: `packages/wellness/sql/0066_wellness_checkins.sql`
- Modify: `packages/db/src/types.ts` (add `WellnessCheckinsTable`, `JarvisDatabase` entry, `Selectable` export)
- Modify: `packages/wellness/src/manifest.ts` (add `database` block; register sql dir on the manifest)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (add the imports at top of file alongside existing ones):

```ts
import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";

import {
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type JarvisDatabase
} from "@jarv1s/db";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000041";
const otherUserId = "00000000-0000-4000-8000-000000000042";

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "req:wellness-test" };
}

let appDb: Kysely<JarvisDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-a@example.test', false), ($2, 'well-b@example.test', false)`,
      [userId, otherUserId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("wellness_checkins table + RLS", () => {
  it("owner can insert multiple check-ins same day; lists own only; RLS blocks other user", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      for (let i = 0; i < 2; i++) {
        await scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            feeling_core: "scared",
            feeling_secondary: "anxious",
            sensations: sql<string[]>`ARRAY['tight chest']::text[]`,
            intensity: 4,
            note: `note-${i.toString()}`
          })
          .execute();
      }
    });

    const ownRows = await dataContext.withDataContext(ctx(userId), (scopedDb) =>
      scopedDb.db.selectFrom("app.wellness_checkins").selectAll().execute()
    );
    expect(ownRows.length).toBe(2);
    expect(ownRows[0]?.wheel_version).toBe("willcox-1982");

    const otherRows = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      scopedDb.db.selectFrom("app.wellness_checkins").selectAll().execute()
    );
    expect(otherRows.length).toBe(0);
  });

  it("rejects a feeling_core outside the enum", async () => {
    await expect(
      dataContext.withDataContext(ctx(userId), (scopedDb) =>
        scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            feeling_core: "not-a-feeling" as never
          })
          .execute()
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — relation `app.wellness_checkins` does not exist (the migration is not yet created/registered).

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/sql/0066_wellness_checkins.sql`:

```sql
-- Feelings check-ins. Multiple rows per day are expected (timestamped, NOT one-per-day).
-- Owner-only (no share, no admin data read), mirroring app.preferences.

DO $$ BEGIN
  CREATE TYPE app.wellness_feeling_core AS ENUM
    ('mad', 'sad', 'scared', 'joyful', 'powerful', 'peaceful');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS app.wellness_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  feeling_core app.wellness_feeling_core NOT NULL,
  feeling_secondary text,
  feeling_tertiary text,
  wheel_version text NOT NULL DEFAULT 'willcox-1982',
  sensations text[] NOT NULL DEFAULT '{}',
  -- `intensity` = how STRONG the feeling is (1–5). It is NOT a readiness/energy proxy.
  intensity smallint CHECK (intensity BETWEEN 1 AND 5),
  -- `energy` = self-rated readiness/energy (1 = depleted, 5 = energized). This is the
  -- ONLY field the focus-signal readiness derivation reads; a low-intensity calm feeling
  -- must NOT imply low readiness (Codex R1 finding: do not conflate emotion with energy).
  energy smallint CHECK (energy BETWEEN 1 AND 5),
  note text,
  identified_via text NOT NULL DEFAULT 'wheel'
    CHECK (identified_via IN ('wheel', 'assisted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wellness_checkins_owner_time_idx
  ON app.wellness_checkins (owner_user_id, checked_in_at DESC);

ALTER TABLE app.wellness_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.wellness_checkins FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wellness_checkins_select ON app.wellness_checkins;
CREATE POLICY wellness_checkins_select ON app.wellness_checkins
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS wellness_checkins_insert ON app.wellness_checkins;
CREATE POLICY wellness_checkins_insert ON app.wellness_checkins
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS wellness_checkins_update ON app.wellness_checkins;
CREATE POLICY wellness_checkins_update ON app.wellness_checkins
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS wellness_checkins_delete ON app.wellness_checkins;
CREATE POLICY wellness_checkins_delete ON app.wellness_checkins
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.wellness_checkins TO jarvis_app_runtime;
```

In `packages/db/src/types.ts`, add this interface after `PreferencesTable` (before `JarvisDatabase`):

```ts
export interface WellnessCheckinsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  checked_in_at: TimestampColumn;
  feeling_core: "mad" | "sad" | "scared" | "joyful" | "powerful" | "peaceful";
  feeling_secondary: string | null;
  feeling_tertiary: string | null;
  wheel_version: ColumnType<string, string | undefined, string>;
  sensations: TextArrayColumn;
  intensity: number | null;
  energy: number | null;
  note: string | null;
  identified_via: ColumnType<
    "wheel" | "assisted",
    "wheel" | "assisted" | undefined,
    "wheel" | "assisted"
  >;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}
```

In the `JarvisDatabase` interface add (after `"app.preferences": PreferencesTable;`):

```ts
  "app.wellness_checkins": WellnessCheckinsTable;
```

At the end of the file add:

```ts
export type WellnessCheckin = Selectable<WellnessCheckinsTable>;
```

In `packages/wellness/src/manifest.ts`, add the `database` block to the manifest object (after `availability`):

```ts
  database: {
    migrations: ["sql/0066_wellness_checkins.sql"],
    migrationDirectories: ["packages/wellness/sql"],
    ownedTables: ["app.wellness_checkins"]
  },
```

- [ ] **Step 4: Register the wellness SQL dir EARLY (so `resetEmptyFoundationDatabase` creates the table)**

Why this comes before running the test (resolves the red/green sequencing — Codex R1): the test's `resetEmptyFoundationDatabase()` DROPS and recreates the `app` schema, then re-applies every SQL dir returned by `getBuiltInSqlMigrationDirectories()`, which globs only the dirs registered in `BUILT_IN_MODULES`. If wellness is not yet registered, the reset would recreate the schema WITHOUT `app.wellness_checkins` and the RLS test would fail for the wrong reason. So we do a MINIMAL partial registration now (manifest + sql dir only; full route/tool wiring lands in Task 9).

In `packages/module-registry/src/index.ts`, add the import (with the other module imports):

```ts
import { wellnessModuleManifest, wellnessModuleSqlMigrationDirectory } from "@jarv1s/wellness";
```

Add a registry entry at the END of the `BUILT_IN_MODULES` array (after the structured-state entry):

```ts
  ,
  {
    manifest: wellnessModuleManifest,
    sqlMigrationDirectories: [wellnessModuleSqlMigrationDirectory],
    queueDefinitions: []
  }
```

- [ ] **Step 4b: Apply migrations + run the test (now truly red→green)**

Run: `pnpm db:migrate && vitest run tests/integration/wellness.test.ts`
Expected: `pnpm db:migrate` prints `applied 0066_wellness_checkins.sql`; the suite PASSES (manifest test + both checkin RLS tests), because `resetEmptyFoundationDatabase()` now recreates `app.wellness_checkins` from the newly-registered dir.

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/sql/0066_wellness_checkins.sql packages/db/src/types.ts packages/wellness/src/manifest.ts packages/module-registry/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): wellness_checkins table + owner-only RLS + db types (Stage 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Create `app.medications` + `app.medication_logs` (migrations 0067, 0068) + db types

**Files:**

- Create: `packages/wellness/sql/0067_wellness_medications.sql`
- Create: `packages/wellness/sql/0068_wellness_medication_logs.sql`
- Modify: `packages/db/src/types.ts` (two table interfaces, `JarvisDatabase` entries, `Selectable` exports)
- Modify: `packages/wellness/src/manifest.ts` (extend `database.migrations` + `ownedTables`)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts`:

```ts
describe("medications + medication_logs tables + RLS", () => {
  it("owner can create a med + a log; denormalized owner; RLS blocks other user", async () => {
    let medId = "";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await scopedDb.db
        .insertInto("app.medications")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          name: "Sertraline",
          dosage: "50 mg",
          frequency_type: "once_daily",
          schedule_times: sql<string[]>`ARRAY['08:00']::time[]`
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      medId = med.id;

      await scopedDb.db
        .insertInto("app.medication_logs")
        .values({
          medication_id: medId,
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          status: "taken",
          dose: "50 mg",
          // Scheduled (non-PRN) logs must carry scheduled_for (DB CHECK).
          scheduled_for: sql<Date>`now()`
        })
        .execute();
    });

    const otherMeds = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      scopedDb.db.selectFrom("app.medications").selectAll().execute()
    );
    expect(otherMeds.length).toBe(0);

    const otherLogs = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      scopedDb.db.selectFrom("app.medication_logs").selectAll().execute()
    );
    expect(otherLogs.length).toBe(0);
  });

  it("rejects a medication_log whose owner differs from the parent medication's owner", async () => {
    let medId = "";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await scopedDb.db
        .insertInto("app.medications")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          name: "Test Med",
          frequency_type: "as_needed"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      medId = med.id;
    });

    // otherUser attempts to log against userId's medication: RLS INSERT WITH CHECK
    // requires owner_user_id = current actor, and the trigger requires it to equal the
    // parent med owner — so this must fail.
    await expect(
      dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
        scopedDb.db
          .insertInto("app.medication_logs")
          .values({
            medication_id: medId,
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            status: "prn",
            prn_reason: "headache"
          })
          .execute()
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — relation `app.medications` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/sql/0067_wellness_medications.sql`:

```sql
-- Medications. Owner-only (no share). Discriminated frequency_type with type-specific
-- fields. DB CHECKs enforce the discriminator contract (defense-in-depth alongside the
-- route-layer validation, which gives friendly 400s); the DB is the last line so a bad
-- write from any path is rejected (Codex R1: schema was too weak).

CREATE TABLE IF NOT EXISTS app.medications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  dosage text,
  form text,
  frequency_type text NOT NULL CHECK (frequency_type IN
    ('once_daily', 'times_per_day', 'specific_weekdays', 'every_n_hours', 'as_needed', 'cyclical')),
  times_per_day smallint CHECK (times_per_day IS NULL OR times_per_day BETWEEN 1 AND 24),
  interval_hours smallint CHECK (interval_hours IS NULL OR interval_hours BETWEEN 1 AND 24),
  weekdays smallint[],
  schedule_times time[],
  cycle_days_on smallint CHECK (cycle_days_on IS NULL OR cycle_days_on >= 1),
  cycle_days_off smallint CHECK (cycle_days_off IS NULL OR cycle_days_off >= 0),
  cycle_anchor_date date,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Discriminator: required field per frequency_type.
  CONSTRAINT medications_times_per_day_present
    CHECK (frequency_type <> 'times_per_day' OR times_per_day IS NOT NULL),
  CONSTRAINT medications_interval_hours_present
    CHECK (frequency_type <> 'every_n_hours' OR interval_hours IS NOT NULL),
  CONSTRAINT medications_weekdays_present
    CHECK (frequency_type <> 'specific_weekdays'
      OR (weekdays IS NOT NULL AND array_length(weekdays, 1) >= 1)),
  -- ISO weekday range (1=Mon..7=Sun) enforced at the DB, not just the route (Codex R2).
  -- NOTE: a CHECK constraint cannot contain a subquery (Codex R3) — use the array containment
  -- operator `<@` against the allowed set instead of `SELECT bool_and(...) FROM unnest(...)`.
  CONSTRAINT medications_weekdays_range
    CHECK (weekdays IS NULL
      OR (array_length(weekdays, 1) >= 1
          AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[])),
  -- Scheduled families need at least one clock time to produce slots.
  CONSTRAINT medications_schedule_times_present
    CHECK (frequency_type NOT IN ('once_daily', 'times_per_day', 'specific_weekdays', 'cyclical')
      OR (schedule_times IS NOT NULL AND array_length(schedule_times, 1) >= 1)),
  -- times_per_day must enumerate exactly that many clock times (computeSchedule emits one slot
  -- per time, so the count must agree — Codex R2).
  CONSTRAINT medications_times_per_day_count
    CHECK (frequency_type <> 'times_per_day'
      OR (schedule_times IS NOT NULL AND array_length(schedule_times, 1) = times_per_day)),
  -- Cyclical needs its anchor + on-days to compute on/off windows.
  CONSTRAINT medications_cycle_fields_present
    CHECK (frequency_type <> 'cyclical'
      OR (cycle_anchor_date IS NOT NULL AND cycle_days_on IS NOT NULL)),
  -- as_needed (PRN) is unscheduled: it must NOT carry ANY scheduling/cycle field.
  CONSTRAINT medications_as_needed_unscheduled
    CHECK (frequency_type <> 'as_needed'
      OR (schedule_times IS NULL AND times_per_day IS NULL AND interval_hours IS NULL
          AND weekdays IS NULL AND cycle_anchor_date IS NULL
          AND cycle_days_on IS NULL AND cycle_days_off IS NULL))
);

CREATE INDEX IF NOT EXISTS medications_owner_idx
  ON app.medications (owner_user_id);

ALTER TABLE app.medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.medications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS medications_select ON app.medications;
CREATE POLICY medications_select ON app.medications
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS medications_insert ON app.medications;
CREATE POLICY medications_insert ON app.medications
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS medications_update ON app.medications;
CREATE POLICY medications_update ON app.medications
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS medications_delete ON app.medications;
CREATE POLICY medications_delete ON app.medications
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.medications TO jarvis_app_runtime;
```

Create `packages/wellness/sql/0068_wellness_medication_logs.sql`:

```sql
-- Dose events. owner_user_id is denormalized for a simple owner-only RLS predicate;
-- a trigger enforces it equals the parent medication's owner.

CREATE TABLE IF NOT EXISTS app.medication_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id uuid NOT NULL REFERENCES app.medications(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('taken', 'skipped', 'prn')),
  dose text,
  prn_reason text,
  scheduled_for timestamptz,
  logged_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- PRN doses must record a reason; scheduled doses must not masquerade as PRN.
  CONSTRAINT medication_logs_prn_reason
    CHECK (status <> 'prn' OR (prn_reason IS NOT NULL AND length(btrim(prn_reason)) > 0)),
  -- A scheduled (non-PRN) log must reference the slot it satisfies.
  CONSTRAINT medication_logs_scheduled_for_present
    CHECK (status = 'prn' OR scheduled_for IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS medication_logs_owner_time_idx
  ON app.medication_logs (owner_user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS medication_logs_med_idx
  ON app.medication_logs (medication_id);

-- Idempotency: at most ONE scheduled log per (medication, slot instant). PRN logs
-- (scheduled_for IS NULL) are unconstrained. A double-submit of the same slot hits this
-- unique index and the route maps it to 409 (Codex R1: dose-log double-submit race).
CREATE UNIQUE INDEX IF NOT EXISTS medication_logs_scheduled_unique
  ON app.medication_logs (medication_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_medication_log_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  parent_owner uuid;
BEGIN
  SELECT owner_user_id INTO parent_owner FROM app.medications WHERE id = NEW.medication_id;
  IF parent_owner IS NULL OR parent_owner <> NEW.owner_user_id THEN
    RAISE EXCEPTION 'medication_log owner_user_id must equal the parent medication owner';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.enforce_medication_log_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enforce_medication_log_owner() TO jarvis_app_runtime;

DROP TRIGGER IF EXISTS medication_logs_enforce_owner ON app.medication_logs;
CREATE TRIGGER medication_logs_enforce_owner
BEFORE INSERT OR UPDATE ON app.medication_logs
FOR EACH ROW
EXECUTE FUNCTION app.enforce_medication_log_owner();

ALTER TABLE app.medication_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.medication_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS medication_logs_select ON app.medication_logs;
CREATE POLICY medication_logs_select ON app.medication_logs
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS medication_logs_insert ON app.medication_logs;
CREATE POLICY medication_logs_insert ON app.medication_logs
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS medication_logs_update ON app.medication_logs;
CREATE POLICY medication_logs_update ON app.medication_logs
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS medication_logs_delete ON app.medication_logs;
CREATE POLICY medication_logs_delete ON app.medication_logs
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.medication_logs TO jarvis_app_runtime;
```

In `packages/db/src/types.ts`, add a nullable text-array helper near the top type aliases (after `TextArrayColumn`):

```ts
type NullableTextArrayColumn = ColumnType<
  string[] | null,
  readonly string[] | string[] | null | undefined,
  readonly string[] | string[] | null
>;
type NullableNumberArrayColumn = ColumnType<
  number[] | null,
  readonly number[] | number[] | null | undefined,
  readonly number[] | number[] | null
>;
```

Add after `WellnessCheckinsTable`:

```ts
export type MedicationFrequencyType =
  | "once_daily"
  | "times_per_day"
  | "specific_weekdays"
  | "every_n_hours"
  | "as_needed"
  | "cyclical";
export type MedicationLogStatus = "taken" | "skipped" | "prn";

export interface MedicationsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  name: string;
  dosage: string | null;
  form: string | null;
  frequency_type: MedicationFrequencyType;
  times_per_day: number | null;
  interval_hours: number | null;
  weekdays: NullableNumberArrayColumn;
  schedule_times: NullableTextArrayColumn;
  cycle_days_on: number | null;
  cycle_days_off: number | null;
  cycle_anchor_date: ColumnType<string | null, string | null | undefined, string | null>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  notes: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface MedicationLogsTable {
  id: ColumnType<string, string | undefined, string>;
  medication_id: string;
  owner_user_id: string;
  status: MedicationLogStatus;
  dose: string | null;
  prn_reason: string | null;
  scheduled_for: NullableTimestampColumn;
  logged_at: TimestampColumn;
  created_at: TimestampColumn;
}
```

In `JarvisDatabase` add (after the wellness_checkins entry):

```ts
  "app.medications": MedicationsTable;
  "app.medication_logs": MedicationLogsTable;
```

At the end of the file add:

```ts
export type Medication = Selectable<MedicationsTable>;
export type MedicationLog = Selectable<MedicationLogsTable>;
```

In `packages/wellness/src/manifest.ts`, update the `database` block to:

```ts
  database: {
    migrations: [
      "sql/0066_wellness_checkins.sql",
      "sql/0067_wellness_medications.sql",
      "sql/0068_wellness_medication_logs.sql"
    ],
    migrationDirectories: ["packages/wellness/sql"],
    ownedTables: ["app.wellness_checkins", "app.medications", "app.medication_logs"]
  },
```

- [ ] **Step 4: Run migrations + test**

Run: `pnpm db:migrate && vitest run tests/integration/wellness.test.ts`
Expected: PASS (all wellness tests). `pnpm db:migrate` prints `applied 0067_wellness_medications.sql` and `applied 0068_wellness_medication_logs.sql`.

- [ ] **Step 5: Verify idempotency**

Run: `pnpm db:migrate`
Expected: `no SQL migrations applied; N already current` (no hash errors).

- [ ] **Step 6: Commit**

```bash
git add packages/wellness/sql/0067_wellness_medications.sql packages/wellness/sql/0068_wellness_medication_logs.sql packages/db/src/types.ts packages/wellness/src/manifest.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): medications + medication_logs tables, RLS, owner-enforce trigger, db types (Stage 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Stage 2 — Shared contract + check-ins API (repository, routes, tool)

### Task 4: Shared wellness API contract (`packages/shared/src/wellness-api.ts`)

**Files:**

- Create: `packages/shared/src/wellness-api.ts`
- Modify: `packages/shared/src/index.ts` (add the export)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (add `WELLNESS_FEELING_CORES`, `createCheckinRequestSchema` to an import from `@jarv1s/shared`):

```ts
import { WELLNESS_FEELING_CORES, createCheckinRequestSchema } from "@jarv1s/shared";

describe("wellness shared contract", () => {
  it("exposes the six Willcox cores and a create-checkin request schema", () => {
    expect(WELLNESS_FEELING_CORES).toEqual([
      "mad",
      "sad",
      "scared",
      "joyful",
      "powerful",
      "peaceful"
    ]);
    expect(createCheckinRequestSchema.required).toContain("feelingCore");
    expect(createCheckinRequestSchema.additionalProperties).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `WELLNESS_FEELING_CORES` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/wellness-api.ts`:

```ts
// Wellness REST contract. Part of the Vite-bundled @jarv1s/shared package — NO node:* imports.
import { errorResponseSchema, nullableStringSchema } from "./schema-fragments.js";

export const WELLNESS_FEELING_CORES = [
  "mad",
  "sad",
  "scared",
  "joyful",
  "powerful",
  "peaceful"
] as const;
export type WellnessFeelingCore = (typeof WELLNESS_FEELING_CORES)[number];

export const MEDICATION_FREQUENCY_TYPES = [
  "once_daily",
  "times_per_day",
  "specific_weekdays",
  "every_n_hours",
  "as_needed",
  "cyclical"
] as const;
export type MedicationFrequencyTypeApi = (typeof MEDICATION_FREQUENCY_TYPES)[number];

export const MEDICATION_LOG_STATUSES = ["taken", "skipped", "prn"] as const;
export type MedicationLogStatusApi = (typeof MEDICATION_LOG_STATUSES)[number];

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface CheckinDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly checkedInAt: string | null;
  readonly feelingCore: WellnessFeelingCore;
  readonly feelingSecondary: string | null;
  readonly feelingTertiary: string | null;
  readonly wheelVersion: string;
  readonly sensations: readonly string[];
  readonly intensity: number | null;
  readonly energy: number | null;
  readonly note: string | null;
  readonly identifiedVia: "wheel" | "assisted";
  readonly createdAt: string | null;
}

export interface CreateCheckinRequest {
  readonly feelingCore: WellnessFeelingCore;
  readonly feelingSecondary?: string | null;
  readonly feelingTertiary?: string | null;
  readonly sensations?: readonly string[];
  readonly intensity?: number | null;
  readonly energy?: number | null;
  readonly note?: string | null;
  readonly identifiedVia?: "wheel" | "assisted";
}

export interface CreateCheckinResponse {
  readonly checkin: CheckinDto;
}
export interface ListCheckinsResponse {
  readonly checkins: readonly CheckinDto[];
}

export interface MedicationDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly dosage: string | null;
  readonly form: string | null;
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay: number | null;
  readonly intervalHours: number | null;
  readonly weekdays: readonly number[] | null;
  readonly scheduleTimes: readonly string[] | null;
  readonly cycleDaysOn: number | null;
  readonly cycleDaysOff: number | null;
  readonly cycleAnchorDate: string | null;
  readonly active: boolean;
  readonly notes: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface CreateMedicationRequest {
  readonly name: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay?: number | null;
  readonly intervalHours?: number | null;
  readonly weekdays?: readonly number[] | null;
  readonly scheduleTimes?: readonly string[] | null;
  readonly cycleDaysOn?: number | null;
  readonly cycleDaysOff?: number | null;
  readonly cycleAnchorDate?: string | null;
  readonly notes?: string | null;
}

// Update is intentionally limited to non-schedule fields this slice (Codex R3): editing
// schedule_times without re-validating the whole frequency discriminator could trip the DB
// CHECK as a 500. Schedule editing is deferred (delete + recreate the med, or a later slice
// that re-validates the full discriminator on update).
export interface UpdateMedicationRequest {
  readonly name?: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly active?: boolean;
  readonly notes?: string | null;
}

export interface MedicationResponse {
  readonly medication: MedicationDto;
}
export interface ListMedicationsResponse {
  readonly medications: readonly MedicationDto[];
}

export interface MedicationLogDto {
  readonly id: string;
  readonly medicationId: string;
  readonly status: MedicationLogStatusApi;
  readonly dose: string | null;
  readonly prnReason: string | null;
  readonly scheduledFor: string | null;
  readonly loggedAt: string | null;
}

export interface CreateMedicationLogRequest {
  readonly status: MedicationLogStatusApi;
  readonly dose?: string | null;
  readonly prnReason?: string | null;
  readonly scheduledFor?: string | null;
}
export interface CreateMedicationLogResponse {
  readonly log: MedicationLogDto;
}

export interface ScheduleSlotDto {
  readonly medicationId: string;
  readonly name: string;
  readonly scheduledFor: string | null;
  readonly asNeeded: boolean;
  readonly status: "pending" | "taken" | "skipped";
}
export interface MedicationScheduleResponse {
  readonly date: string;
  readonly slots: readonly ScheduleSlotDto[];
}

// ── JSON schemas ────────────────────────────────────────────────────────────

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const nullableIntensitySchema = {
  anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }]
} as const;

export const feelingCoreSchema = { type: "string", enum: WELLNESS_FEELING_CORES } as const;
export const medicationFrequencyTypeSchema = {
  type: "string",
  enum: MEDICATION_FREQUENCY_TYPES
} as const;
export const medicationLogStatusSchema = {
  type: "string",
  enum: MEDICATION_LOG_STATUSES
} as const;

export const checkinDtoSchema = {
  type: "object",
  required: [
    "id",
    "ownerUserId",
    "checkedInAt",
    "feelingCore",
    "feelingSecondary",
    "feelingTertiary",
    "wheelVersion",
    "sensations",
    "intensity",
    "energy",
    "note",
    "identifiedVia",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    checkedInAt: nullableStringSchema,
    feelingCore: feelingCoreSchema,
    feelingSecondary: nullableStringSchema,
    feelingTertiary: nullableStringSchema,
    wheelVersion: { type: "string" },
    sensations: stringArraySchema,
    intensity: { anyOf: [{ type: "number" }, { type: "null" }] },
    energy: { anyOf: [{ type: "number" }, { type: "null" }] },
    note: nullableStringSchema,
    identifiedVia: { type: "string", enum: ["wheel", "assisted"] },
    createdAt: nullableStringSchema
  }
} as const;

export const createCheckinRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feelingCore"],
  properties: {
    feelingCore: feelingCoreSchema,
    feelingSecondary: nullableStringSchema,
    feelingTertiary: nullableStringSchema,
    sensations: stringArraySchema,
    intensity: nullableIntensitySchema,
    energy: nullableIntensitySchema,
    note: nullableStringSchema,
    identifiedVia: { type: "string", enum: ["wheel", "assisted"] }
  }
} as const;

export const createCheckinResponseSchema = {
  type: "object",
  required: ["checkin"],
  properties: { checkin: checkinDtoSchema }
} as const;

export const listCheckinsResponseSchema = {
  type: "object",
  required: ["checkins"],
  properties: { checkins: { type: "array", items: checkinDtoSchema } }
} as const;

export const medicationDtoSchema = {
  type: "object",
  required: [
    "id",
    "ownerUserId",
    "name",
    "dosage",
    "form",
    "frequencyType",
    "timesPerDay",
    "intervalHours",
    "weekdays",
    "scheduleTimes",
    "cycleDaysOn",
    "cycleDaysOff",
    "cycleAnchorDate",
    "active",
    "notes",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    name: { type: "string" },
    dosage: nullableStringSchema,
    form: nullableStringSchema,
    frequencyType: medicationFrequencyTypeSchema,
    timesPerDay: { anyOf: [{ type: "number" }, { type: "null" }] },
    intervalHours: { anyOf: [{ type: "number" }, { type: "null" }] },
    weekdays: { anyOf: [{ type: "array", items: { type: "number" } }, { type: "null" }] },
    scheduleTimes: { anyOf: [stringArraySchema, { type: "null" }] },
    cycleDaysOn: { anyOf: [{ type: "number" }, { type: "null" }] },
    cycleDaysOff: { anyOf: [{ type: "number" }, { type: "null" }] },
    cycleAnchorDate: nullableStringSchema,
    active: { type: "boolean" },
    notes: nullableStringSchema,
    createdAt: nullableStringSchema,
    updatedAt: nullableStringSchema
  }
} as const;

export const createMedicationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "frequencyType"],
  properties: {
    name: { type: "string" },
    dosage: nullableStringSchema,
    form: nullableStringSchema,
    frequencyType: medicationFrequencyTypeSchema,
    timesPerDay: { anyOf: [{ type: "integer", minimum: 1, maximum: 24 }, { type: "null" }] },
    intervalHours: { anyOf: [{ type: "integer", minimum: 1, maximum: 24 }, { type: "null" }] },
    weekdays: {
      anyOf: [
        { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } },
        { type: "null" }
      ]
    },
    scheduleTimes: { anyOf: [stringArraySchema, { type: "null" }] },
    cycleDaysOn: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    cycleDaysOff: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    cycleAnchorDate: nullableStringSchema,
    notes: nullableStringSchema
  }
} as const;

export const updateMedicationRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    dosage: nullableStringSchema,
    form: nullableStringSchema,
    active: { type: "boolean" },
    notes: nullableStringSchema
  }
} as const;

export const medicationResponseSchema = {
  type: "object",
  required: ["medication"],
  properties: { medication: medicationDtoSchema }
} as const;

export const listMedicationsResponseSchema = {
  type: "object",
  required: ["medications"],
  properties: { medications: { type: "array", items: medicationDtoSchema } }
} as const;

export const createMedicationLogRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: medicationLogStatusSchema,
    dose: nullableStringSchema,
    prnReason: nullableStringSchema,
    scheduledFor: nullableStringSchema
  }
} as const;

export const medicationLogDtoSchema = {
  type: "object",
  required: ["id", "medicationId", "status", "dose", "prnReason", "scheduledFor", "loggedAt"],
  properties: {
    id: { type: "string" },
    medicationId: { type: "string" },
    status: medicationLogStatusSchema,
    dose: nullableStringSchema,
    prnReason: nullableStringSchema,
    scheduledFor: nullableStringSchema,
    loggedAt: nullableStringSchema
  }
} as const;

export const createMedicationLogResponseSchema = {
  type: "object",
  required: ["log"],
  properties: { log: medicationLogDtoSchema }
} as const;

export const scheduleSlotDtoSchema = {
  type: "object",
  required: ["medicationId", "name", "scheduledFor", "asNeeded", "status"],
  properties: {
    medicationId: { type: "string" },
    name: { type: "string" },
    scheduledFor: nullableStringSchema,
    asNeeded: { type: "boolean" },
    status: { type: "string", enum: ["pending", "taken", "skipped"] }
  }
} as const;

export const medicationScheduleResponseSchema = {
  type: "object",
  required: ["date", "slots"],
  properties: {
    date: { type: "string" },
    slots: { type: "array", items: scheduleSlotDtoSchema }
  }
} as const;

// ── Route schemas (Fastify {request?, response} envelopes) ───────────────────

export const createCheckinRouteSchema = {
  body: createCheckinRequestSchema,
  response: { 201: createCheckinResponseSchema, 400: errorResponseSchema }
} as const;
export const listCheckinsRouteSchema = {
  response: { 200: listCheckinsResponseSchema }
} as const;
export const createMedicationRouteSchema = {
  body: createMedicationRequestSchema,
  response: { 201: medicationResponseSchema, 400: errorResponseSchema }
} as const;
export const listMedicationsRouteSchema = {
  response: { 200: listMedicationsResponseSchema }
} as const;
export const updateMedicationRouteSchema = {
  body: updateMedicationRequestSchema,
  response: { 200: medicationResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema }
} as const;
export const medicationScheduleRouteSchema = {
  response: { 200: medicationScheduleResponseSchema }
} as const;
export const createMedicationLogRouteSchema = {
  body: createMedicationLogRequestSchema,
  response: {
    201: createMedicationLogResponseSchema,
    400: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

// ── Browser-safe reference taxonomy ──────────────────────────────────────────
// Lives in @jarv1s/shared (NOT @jarv1s/wellness) so the web bundle never imports the
// server-only wellness index, whose manifest pulls `node:url` (Codex R1: bundle bloat/break).
// Reference data — NOT user-editable, NOT a table. Adapted SUBSET of the Willcox (1982)
// Feeling Wheel (not the exhaustive wheel — labeled as a subset, Codex R1).

export const WHEEL_VERSION = "willcox-1982";

export interface FeelingsWheelSecondary {
  readonly name: string;
  readonly tertiary: readonly string[];
}
export interface FeelingsWheelCore {
  readonly core: WellnessFeelingCore;
  readonly secondary: readonly FeelingsWheelSecondary[];
}

export const FEELINGS_WHEEL: readonly FeelingsWheelCore[] = [
  {
    core: "mad",
    secondary: [
      { name: "hurt", tertiary: ["embarrassed", "devastated"] },
      { name: "hostile", tertiary: ["irritated", "resentful"] },
      { name: "angry", tertiary: ["furious", "frustrated"] },
      { name: "critical", tertiary: ["skeptical", "dismissive"] }
    ]
  },
  {
    core: "sad",
    secondary: [
      { name: "lonely", tertiary: ["isolated", "abandoned"] },
      { name: "depressed", tertiary: ["empty", "hopeless"] },
      { name: "guilty", tertiary: ["ashamed", "remorseful"] },
      { name: "tired", tertiary: ["sleepy", "drained"] }
    ]
  },
  {
    core: "scared",
    secondary: [
      { name: "anxious", tertiary: ["overwhelmed", "worried"] },
      { name: "insecure", tertiary: ["inadequate", "inferior"] },
      { name: "rejected", tertiary: ["excluded", "persecuted"] },
      { name: "confused", tertiary: ["bewildered", "discouraged"] }
    ]
  },
  {
    core: "joyful",
    secondary: [
      { name: "excited", tertiary: ["energetic", "eager"] },
      { name: "content", tertiary: ["satisfied", "grateful"] },
      { name: "proud", tertiary: ["confident", "successful"] },
      { name: "playful", tertiary: ["cheerful", "creative"] }
    ]
  },
  {
    core: "powerful",
    secondary: [
      { name: "respected", tertiary: ["valued", "appreciated"] },
      { name: "confident", tertiary: ["worthy", "capable"] },
      { name: "hopeful", tertiary: ["optimistic", "inspired"] },
      { name: "faithful", tertiary: ["intimate", "courageous"] }
    ]
  },
  {
    core: "peaceful",
    secondary: [
      { name: "content", tertiary: ["thoughtful", "relaxed"] },
      { name: "thankful", tertiary: ["loving", "trusting"] },
      { name: "secure", tertiary: ["calm", "at ease"] },
      { name: "responsive", tertiary: ["engaged", "present"] }
    ]
  }
];

/** Curated interoception "body check" list (static reference data, NOT a table). */
export const BODY_SENSATIONS: readonly string[] = [
  "Tight chest",
  "Racing heart",
  "Lump in throat",
  "Clenched jaw",
  "Stiff shoulders",
  "Butterflies / fluttering stomach",
  "Sweating",
  "Dry mouth",
  "Shallow breathing",
  "Heaviness / fatigue",
  "Restlessness",
  "Temperature change (hot/cold)"
];

/**
 * Validate a (core, secondary?, tertiary?) selection against FEELINGS_WHEEL. Returns true
 * for a bare core, a core+valid-secondary, or a core+secondary+valid-tertiary. Browser-safe
 * (no node:*). This is the path-validation helper referenced by the data model.
 */
export function isValidFeelingPath(
  core: WellnessFeelingCore,
  secondary?: string | null,
  tertiary?: string | null
): boolean {
  const coreNode = FEELINGS_WHEEL.find((c) => c.core === core);
  if (!coreNode) return false;
  if (secondary == null) return tertiary == null;
  const secNode = coreNode.secondary.find((s) => s.name === secondary);
  if (!secNode) return false;
  if (tertiary == null) return true;
  return secNode.tertiary.includes(tertiary);
}
```

In `packages/shared/src/index.ts`, add after `export * from "./tasks-view.js";`:

```ts
export * from "./wellness-api.js";
```

- [ ] **Step 4: Run the test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (shared contract test green).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/wellness-api.ts packages/shared/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): shared REST contract DTOs + JSON schemas (Stage 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: `WellnessRepository` + serializers (check-ins, medications, dose logs)

**Files:**

- Create: `packages/wellness/src/serialize.ts`
- Create: `packages/wellness/src/repository.ts`
- Modify: `packages/wellness/src/index.ts` (export the repository + input types)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (add `WellnessRepository` to the `@jarv1s/wellness` import):

```ts
import { WellnessRepository } from "@jarv1s/wellness";

describe("WellnessRepository", () => {
  const repo = new WellnessRepository();

  it("createCheckin persists the full wheel path + sensations; listCheckins is owner-scoped", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.createCheckin(scopedDb, {
        feelingCore: "scared",
        feelingSecondary: "anxious",
        feelingTertiary: "overwhelmed",
        sensations: ["tight chest", "racing heart"],
        intensity: 4,
        note: "deadline",
        identifiedVia: "assisted"
      });
      const list = await repo.listCheckins(scopedDb, { limit: 10 });
      const latest = list[0];
      expect(latest?.feeling_core).toBe("scared");
      expect(latest?.feeling_tertiary).toBe("overwhelmed");
      expect(latest?.sensations).toEqual(["tight chest", "racing heart"]);
      expect(latest?.identified_via).toBe("assisted");
    });
  });

  it("createMedication + logDose; getSchedule marks a slot taken from a same-day log", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const med = await repo.createMedication(scopedDb, {
        name: "Levothyroxine",
        frequencyType: "once_daily",
        scheduleTimes: ["08:00"]
      });
      const today = new Date();
      const scheduledFor = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0)
      ).toISOString();
      await repo.logDose(scopedDb, med.id, {
        status: "taken",
        scheduledFor
      });
      const log = await repo.listRecentLogs(scopedDb, { sinceDays: 1 });
      expect(log.some((l) => l.medication_id === med.id && l.status === "taken")).toBe(true);
    });
  });

  it("createCheckin throws on an unbranded handle (DataContextDb guard)", async () => {
    await expect(
      repo.createCheckin(appDb as unknown as never, { feelingCore: "joyful" })
    ).rejects.toThrow("Repository access requires withDataContext");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `WellnessRepository` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/src/serialize.ts`:

```ts
import type { Medication, MedicationLog, WellnessCheckin } from "@jarv1s/db";
import type { CheckinDto, MedicationDto, MedicationLogDto } from "@jarv1s/shared";

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function serializeCheckin(row: WellnessCheckin): CheckinDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    checkedInAt: toIso(row.checked_in_at),
    feelingCore: row.feeling_core,
    feelingSecondary: row.feeling_secondary,
    feelingTertiary: row.feeling_tertiary,
    wheelVersion: row.wheel_version,
    sensations: row.sensations,
    intensity: row.intensity,
    energy: row.energy,
    note: row.note,
    identifiedVia: row.identified_via,
    createdAt: toIso(row.created_at)
  };
}

export function serializeMedication(row: Medication): MedicationDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    dosage: row.dosage,
    form: row.form,
    frequencyType: row.frequency_type,
    timesPerDay: row.times_per_day,
    intervalHours: row.interval_hours,
    weekdays: row.weekdays,
    scheduleTimes: row.schedule_times,
    cycleDaysOn: row.cycle_days_on,
    cycleDaysOff: row.cycle_days_off,
    cycleAnchorDate: row.cycle_anchor_date,
    active: row.active,
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function serializeMedicationLog(row: MedicationLog): MedicationLogDto {
  return {
    id: row.id,
    medicationId: row.medication_id,
    status: row.status,
    dose: row.dose,
    prnReason: row.prn_reason,
    scheduledFor: toIso(row.scheduled_for),
    loggedAt: toIso(row.logged_at)
  };
}
```

Create `packages/wellness/src/repository.ts`:

```ts
import { sql } from "kysely";

import {
  assertDataContextDb,
  type DataContextDb,
  type Medication,
  type MedicationLog,
  type WellnessCheckin
} from "@jarv1s/db";
import type {
  MedicationFrequencyTypeApi,
  MedicationLogStatusApi,
  WellnessFeelingCore
} from "@jarv1s/shared";

export interface CreateCheckinInput {
  readonly feelingCore: WellnessFeelingCore;
  readonly feelingSecondary?: string | null;
  readonly feelingTertiary?: string | null;
  readonly sensations?: readonly string[];
  readonly intensity?: number | null;
  readonly energy?: number | null;
  readonly note?: string | null;
  readonly identifiedVia?: "wheel" | "assisted";
}

export interface ListCheckinsOptions {
  readonly since?: Date;
  readonly limit?: number;
}

export interface CreateMedicationInput {
  readonly name: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay?: number | null;
  readonly intervalHours?: number | null;
  readonly weekdays?: readonly number[] | null;
  readonly scheduleTimes?: readonly string[] | null;
  readonly cycleDaysOn?: number | null;
  readonly cycleDaysOff?: number | null;
  readonly cycleAnchorDate?: string | null;
  readonly notes?: string | null;
}

export interface UpdateMedicationInput {
  readonly name?: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly active?: boolean;
  readonly notes?: string | null;
}

export interface LogDoseInput {
  readonly status: MedicationLogStatusApi;
  readonly dose?: string | null;
  readonly prnReason?: string | null;
  readonly scheduledFor?: string | null;
}

export class WellnessRepository {
  // ── Check-ins ──────────────────────────────────────────────────────────
  async createCheckin(
    scopedDb: DataContextDb,
    input: CreateCheckinInput
  ): Promise<WellnessCheckin> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.wellness_checkins")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        feeling_core: input.feelingCore,
        feeling_secondary: input.feelingSecondary ?? null,
        feeling_tertiary: input.feelingTertiary ?? null,
        sensations: [...(input.sensations ?? [])],
        intensity: input.intensity ?? null,
        energy: input.energy ?? null,
        note: input.note ?? null,
        identified_via: input.identifiedVia ?? "wheel"
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as WellnessCheckin;
  }

  async listCheckins(
    scopedDb: DataContextDb,
    options: ListCheckinsOptions = {}
  ): Promise<WellnessCheckin[]> {
    assertDataContextDb(scopedDb);
    let query = scopedDb.db
      .selectFrom("app.wellness_checkins")
      .selectAll()
      .orderBy("checked_in_at", "desc");
    if (options.since) query = query.where("checked_in_at", ">=", options.since);
    query = query.limit(options.limit ?? 50);
    const rows = await query.execute();
    return rows as WellnessCheckin[];
  }

  // ── Medications ────────────────────────────────────────────────────────
  async createMedication(
    scopedDb: DataContextDb,
    input: CreateMedicationInput
  ): Promise<Medication> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.medications")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        name: input.name,
        dosage: input.dosage ?? null,
        form: input.form ?? null,
        frequency_type: input.frequencyType,
        times_per_day: input.timesPerDay ?? null,
        interval_hours: input.intervalHours ?? null,
        weekdays: input.weekdays ? [...input.weekdays] : null,
        schedule_times: input.scheduleTimes ? [...input.scheduleTimes] : null,
        cycle_days_on: input.cycleDaysOn ?? null,
        cycle_days_off: input.cycleDaysOff ?? null,
        cycle_anchor_date: input.cycleAnchorDate ?? null,
        notes: input.notes ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as Medication;
  }

  async listMedications(scopedDb: DataContextDb): Promise<Medication[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.medications")
      .selectAll()
      .orderBy("active", "desc")
      .orderBy("name", "asc")
      .execute();
    return rows as Medication[];
  }

  async getMedication(scopedDb: DataContextDb, id: string): Promise<Medication | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.medications")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row as Medication | undefined;
  }

  async updateMedication(
    scopedDb: DataContextDb,
    id: string,
    input: UpdateMedicationInput
  ): Promise<Medication | undefined> {
    assertDataContextDb(scopedDb);
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (input.name !== undefined) updates["name"] = input.name;
    if (input.dosage !== undefined) updates["dosage"] = input.dosage;
    if (input.form !== undefined) updates["form"] = input.form;
    if (input.active !== undefined) updates["active"] = input.active;
    if (input.notes !== undefined) updates["notes"] = input.notes;
    // schedule_times is NOT updatable in this slice (would need full discriminator re-validation).
    const row = await scopedDb.db
      .updateTable("app.medications")
      .set(updates)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row as Medication | undefined;
  }

  // ── Dose logs ──────────────────────────────────────────────────────────
  async logDose(
    scopedDb: DataContextDb,
    medicationId: string,
    input: LogDoseInput
  ): Promise<MedicationLog> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.medication_logs")
      .values({
        medication_id: medicationId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        status: input.status,
        dose: input.dose ?? null,
        prn_reason: input.prnReason ?? null,
        scheduled_for: input.scheduledFor ? new Date(input.scheduledFor) : null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as MedicationLog;
  }

  async listRecentLogs(
    scopedDb: DataContextDb,
    options: { readonly sinceDays?: number } = {}
  ): Promise<MedicationLog[]> {
    assertDataContextDb(scopedDb);
    const sinceDays = options.sinceDays ?? 7;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const rows = await scopedDb.db
      .selectFrom("app.medication_logs")
      .selectAll()
      .where("logged_at", ">=", since)
      .orderBy("logged_at", "desc")
      .execute();
    return rows as MedicationLog[];
  }

  /**
   * Logs that satisfy a SCHEDULED slot on `date` — filtered by `scheduled_for` (the slot
   * instant), NOT `logged_at` (Codex R2). A dose logged late/early (e.g. just after midnight)
   * still matches its slot's civil day. PRN logs (scheduled_for IS NULL) are excluded: they
   * are unscheduled and computeSchedule never matches them to a slot.
   */
  async listLogsForDate(scopedDb: DataContextDb, date: Date): Promise<MedicationLog[]> {
    assertDataContextDb(scopedDb);
    const dayStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0)
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const rows = await scopedDb.db
      .selectFrom("app.medication_logs")
      .selectAll()
      .where("scheduled_for", ">=", dayStart)
      .where("scheduled_for", "<", dayEnd)
      .execute();
    return rows as MedicationLog[];
  }
}
```

Update `packages/wellness/src/index.ts` to add:

```ts
export { WellnessRepository } from "./repository.js";
export type {
  CreateCheckinInput,
  ListCheckinsOptions,
  CreateMedicationInput,
  UpdateMedicationInput,
  LogDoseInput
} from "./repository.js";
export { serializeCheckin, serializeMedication, serializeMedicationLog } from "./serialize.js";
```

- [ ] **Step 4: Run the test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (repository CRUD + guard tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/src/repository.ts packages/wellness/src/serialize.ts packages/wellness/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): WellnessRepository + serializers (check-ins, meds, dose logs) (Stage 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 6: Pure schedule computation (`schedule.ts`)

**Files:**

- Create: `packages/wellness/src/schedule.ts`
- Modify: `packages/wellness/src/index.ts` (export `computeSchedule`)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (add `computeSchedule` to the `@jarv1s/wellness` import):

```ts
import { computeSchedule } from "@jarv1s/wellness";
import type { Medication, MedicationLog } from "@jarv1s/db";

describe("computeSchedule (pure)", () => {
  const date = new Date("2026-06-15T00:00:00.000Z"); // Monday

  function med(overrides: Partial<Medication>): Medication {
    return {
      id: "m1",
      owner_user_id: userId,
      name: "Med",
      dosage: null,
      form: null,
      frequency_type: "once_daily",
      times_per_day: null,
      interval_hours: null,
      weekdays: null,
      schedule_times: null,
      cycle_days_on: null,
      cycle_days_off: null,
      cycle_anchor_date: null,
      active: true,
      notes: null,
      created_at: date,
      updated_at: date,
      ...overrides
    } as Medication;
  }

  it("once_daily with schedule_times yields a slot per time", () => {
    const slots = computeSchedule([med({ schedule_times: ["08:00", "20:00"] })], [], date);
    expect(slots.filter((s) => !s.asNeeded).length).toBe(2);
    expect(slots[0]?.status).toBe("pending");
  });

  it("specific_weekdays only yields slots on a matching weekday", () => {
    const onMonday = computeSchedule(
      [med({ frequency_type: "specific_weekdays", weekdays: [1], schedule_times: ["09:00"] })],
      [],
      date // Monday = ISO 1
    );
    expect(onMonday.filter((s) => !s.asNeeded).length).toBe(1);
    const onTuesday = computeSchedule(
      [med({ frequency_type: "specific_weekdays", weekdays: [2], schedule_times: ["09:00"] })],
      [],
      date
    );
    expect(onTuesday.filter((s) => !s.asNeeded).length).toBe(0);
  });

  it("as_needed yields a single asNeeded affordance, no fixed slot", () => {
    const slots = computeSchedule([med({ frequency_type: "as_needed" })], [], date);
    expect(slots.length).toBe(1);
    expect(slots[0]?.asNeeded).toBe(true);
  });

  it("a matching same-day log marks the slot taken", () => {
    const m = med({ id: "mx", schedule_times: ["08:00"] });
    const scheduledFor = new Date("2026-06-15T08:00:00.000Z");
    const log: MedicationLog = {
      id: "l1",
      medication_id: "mx",
      owner_user_id: userId,
      status: "taken",
      dose: null,
      prn_reason: null,
      scheduled_for: scheduledFor,
      logged_at: scheduledFor,
      created_at: scheduledFor
    } as MedicationLog;
    const slots = computeSchedule([m], [log], date);
    expect(slots.find((s) => !s.asNeeded)?.status).toBe("taken");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `computeSchedule` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/src/schedule.ts`:

```ts
import type { Medication, MedicationLog } from "@jarv1s/db";
import type { ScheduleSlotDto } from "@jarv1s/shared";

/**
 * Pure: given the actor's medications, their same-day dose logs, and a target date,
 * produce an ordered list of schedule slots. Scheduled (non-PRN) meds emit one slot per
 * schedule_time that applies on `date`; as_needed meds emit a single asNeeded affordance.
 * A slot is "taken"/"skipped" if a same-day log has a matching scheduled_for (same clock
 * minute) for that medication, else "pending".
 *
 * Timezone model (deliberate, documented — Codex R1): this uses NAIVE CIVIL time. The
 * caller (web) sends its OWN LOCAL civil date (`YYYY-MM-DD`) as `?date=`; the server parses
 * it as a UTC midnight anchor and builds each slot by attaching the med's civil clock time
 * (`schedule_times`, a `time[]`) to that anchor IN UTC. Because both the slot instant and
 * the matched log's `scheduled_for` are constructed the same civil-as-UTC way, the
 * minute-level match is correct, and the displayed `HH:MM` (via `.slice(11,16)`) shows the
 * civil clock time the user entered. The only requirement is that the client sends its LOCAL
 * date (not a UTC date) so a near-midnight check lands on the right civil day. True
 * per-user-timezone scheduling (DST-aware absolute instants) is explicitly out of scope.
 */
export function computeSchedule(
  medications: readonly Medication[],
  logs: readonly MedicationLog[],
  date: Date
): ScheduleSlotDto[] {
  const slots: ScheduleSlotDto[] = [];
  const isoWeekday = isoWeekdayOf(date);

  for (const med of medications) {
    if (!med.active) continue;

    if (med.frequency_type === "as_needed") {
      slots.push({
        medicationId: med.id,
        name: med.name,
        scheduledFor: null,
        asNeeded: true,
        status: "pending"
      });
      continue;
    }

    if (med.frequency_type === "specific_weekdays") {
      const weekdays = med.weekdays ?? [];
      if (!weekdays.includes(isoWeekday)) continue;
    }

    if (med.frequency_type === "cyclical" && !isCyclicalOnDay(med, date)) {
      continue;
    }

    const times = med.schedule_times ?? [];
    for (const time of times) {
      const scheduledFor = combineDateAndTime(date, time);
      slots.push({
        medicationId: med.id,
        name: med.name,
        scheduledFor: scheduledFor.toISOString(),
        asNeeded: false,
        status: slotStatusFromLogs(med.id, scheduledFor, logs)
      });
    }
  }

  return slots.sort((a, b) => {
    if (a.asNeeded !== b.asNeeded) return a.asNeeded ? 1 : -1;
    return (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "");
  });
}

function isoWeekdayOf(date: Date): number {
  const day = date.getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

function combineDateAndTime(date: Date, time: string): Date {
  const [hh, mm] = time.split(":");
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      Number(hh ?? 0),
      Number(mm ?? 0),
      0
    )
  );
}

function slotStatusFromLogs(
  medicationId: string,
  scheduledFor: Date,
  logs: readonly MedicationLog[]
): "pending" | "taken" | "skipped" {
  const target = scheduledFor.getTime();
  for (const log of logs) {
    if (log.medication_id !== medicationId) continue;
    if (!log.scheduled_for) continue;
    const logged =
      log.scheduled_for instanceof Date ? log.scheduled_for : new Date(log.scheduled_for);
    if (Math.abs(logged.getTime() - target) < 60_000) {
      if (log.status === "taken") return "taken";
      if (log.status === "skipped") return "skipped";
    }
  }
  return "pending";
}

function isCyclicalOnDay(med: Medication, date: Date): boolean {
  if (!med.cycle_anchor_date || !med.cycle_days_on) return true;
  const anchor = new Date(`${med.cycle_anchor_date}T00:00:00.000Z`);
  const cycleLength = med.cycle_days_on + (med.cycle_days_off ?? 0);
  if (cycleLength <= 0) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsed = Math.floor((date.getTime() - anchor.getTime()) / dayMs);
  if (elapsed < 0) return false;
  return elapsed % cycleLength < med.cycle_days_on;
}
```

Update `packages/wellness/src/index.ts` to add:

```ts
export { computeSchedule } from "./schedule.js";
```

- [ ] **Step 4: Run the test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (all schedule cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/src/schedule.ts packages/wellness/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): pure schedule computation over frequency_type + schedule_times (Stage 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 7: REST routes (`registerWellnessRoutes`)

**Files:**

- Create: `packages/wellness/src/routes.ts`
- Modify: `packages/wellness/src/index.ts` (export `registerWellnessRoutes` + `WellnessRoutesDependencies`)
- Test: `tests/integration/wellness.test.ts`

The routes mirror `registerTasksRoutes`: every handler resolves the access context, runs work under `withDataContext`, and wraps in `try/catch → handleRouteError`. Validation throws `HttpError(400, ...)` from `@jarv1s/module-sdk`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts`. This boots a Fastify app with only the wellness routes and a stub access context (mirrors how route tests inject `resolveAccessContext`):

```ts
import Fastify from "fastify";
import { registerWellnessRoutes } from "@jarv1s/wellness";

describe("wellness REST routes", () => {
  async function buildApp(actorUserId: string) {
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "req:route-test" }),
      dataContext
    });
    await app.ready();
    return app;
  }

  it("POST /api/wellness/checkins creates; GET lists owner-scoped", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: { feelingCore: "joyful", intensity: 5, sensations: ["warmth"] }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().checkin.feelingCore).toBe("joyful");

      const listed = await app.inject({ method: "GET", url: "/api/wellness/checkins?limit=5" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().checkins.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("POST a check-in with a feeling path mismatch is rejected 400", async () => {
    const app = await buildApp(userId);
    try {
      // tertiary is not a leaf of the secondary under this core → invalid path.
      const bad = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: {
          feelingCore: "scared",
          feelingSecondary: "anxious",
          feelingTertiary: "not-a-leaf"
        }
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST a PRN dose log without prn_reason is rejected 400", async () => {
    const app = await buildApp(userId);
    try {
      const med = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Ibuprofen", frequencyType: "as_needed" }
      });
      const medId = med.json().medication.id as string;

      const bad = await app.inject({
        method: "POST",
        url: `/api/wellness/medications/${medId}/logs`,
        payload: { status: "prn" }
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("GET /api/wellness/medications/schedule returns slots for today", async () => {
    const app = await buildApp(userId);
    try {
      await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Vitamin D", frequencyType: "once_daily", scheduleTimes: ["09:00"] }
      });
      const today = new Date().toISOString().slice(0, 10);
      const sched = await app.inject({
        method: "GET",
        url: `/api/wellness/medications/schedule?date=${today}`
      });
      expect(sched.statusCode).toBe(200);
      expect(sched.json().date).toBe(today);
      expect(Array.isArray(sched.json().slots)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `registerWellnessRoutes` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/src/routes.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@jarv1s/db";
import { HttpError, handleRouteError } from "@jarv1s/module-sdk";
import {
  createCheckinRouteSchema,
  createMedicationLogRouteSchema,
  createMedicationRouteSchema,
  listCheckinsRouteSchema,
  listMedicationsRouteSchema,
  medicationScheduleRouteSchema,
  updateMedicationRouteSchema,
  WELLNESS_FEELING_CORES,
  MEDICATION_FREQUENCY_TYPES,
  MEDICATION_LOG_STATUSES,
  isValidFeelingPath,
  type MedicationFrequencyTypeApi,
  type MedicationLogStatusApi,
  type WellnessFeelingCore
} from "@jarv1s/shared";

import type {
  CreateCheckinInput,
  CreateMedicationInput,
  LogDoseInput,
  UpdateMedicationInput
} from "./repository.js";
import { WellnessRepository } from "./repository.js";
import { computeSchedule } from "./schedule.js";
import { serializeCheckin, serializeMedication, serializeMedicationLog } from "./serialize.js";

export interface WellnessRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: WellnessRepository;
}

interface MedParams {
  readonly id: string;
}

export function registerWellnessRoutes(
  server: FastifyInstance,
  dependencies: WellnessRoutesDependencies
): void {
  const repo = dependencies.repository ?? new WellnessRepository();

  // ── Check-ins ────────────────────────────────────────────────────────────
  server.post(
    "/api/wellness/checkins",
    { schema: createCheckinRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseCheckinBody(request.body);
        const checkin = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.createCheckin(scopedDb, input)
        );
        return reply.code(201).send({ checkin: serializeCheckin(checkin) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/wellness/checkins",
    { schema: listCheckinsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const query = request.query as Record<string, unknown>;
        const since = parseSince(query["since"]);
        const limit = parseLimit(query["limit"]);
        const checkins = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.listCheckins(scopedDb, { since, limit })
        );
        return { checkins: checkins.map(serializeCheckin) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // ── Medications ──────────────────────────────────────────────────────────
  server.get(
    "/api/wellness/medications",
    { schema: listMedicationsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const meds = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.listMedications(scopedDb)
        );
        return { medications: meds.map(serializeMedication) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/wellness/medications",
    { schema: createMedicationRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseCreateMedicationBody(request.body);
        const med = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.createMedication(scopedDb, input)
        );
        return reply.code(201).send({ medication: serializeMedication(med) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: MedParams }>(
    "/api/wellness/medications/:id",
    { schema: updateMedicationRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseUpdateMedicationBody(request.body);
        const med = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.updateMedication(scopedDb, request.params.id, input)
        );
        if (!med) return reply.code(404).send({ error: "Medication not found" });
        return { medication: serializeMedication(med) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/wellness/medications/schedule",
    { schema: medicationScheduleRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const query = request.query as Record<string, unknown>;
        const dateStr = parseDateParam(query["date"]);
        const date = new Date(`${dateStr}T00:00:00.000Z`);
        const { meds, logs } = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => ({
            meds: await repo.listMedications(scopedDb),
            logs: await repo.listLogsForDate(scopedDb, date)
          })
        );
        return { date: dateStr, slots: computeSchedule(meds, logs, date) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: MedParams }>(
    "/api/wellness/medications/:id/logs",
    { schema: createMedicationLogRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseLogDoseBody(request.body);
        const result = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const med = await repo.getMedication(scopedDb, request.params.id);
            if (!med) return null;
            return repo.logDose(scopedDb, request.params.id, input);
          }
        );
        if (!result) return reply.code(404).send({ error: "Medication not found" });
        return reply.code(201).send({ log: serializeMedicationLog(result) });
      } catch (error) {
        // A repeat log of the same scheduled slot trips the partial unique index
        // (medication_logs_scheduled_unique) — map it to an idempotent 409, not a 500.
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "This scheduled dose is already logged" });
        }
        return handleRouteError(error, reply);
      }
    }
  );
}

function isUniqueViolation(error: unknown): boolean {
  // Postgres unique_violation. The driver surfaces `.code` on the error object.
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

// ── Body parsers ─────────────────────────────────────────────────────────────

function parseCheckinBody(body: unknown): CreateCheckinInput {
  const value = requireObject(body);
  const feelingCore = value["feelingCore"];
  if (!isFeelingCore(feelingCore)) {
    throw new HttpError(400, `feelingCore must be one of ${WELLNESS_FEELING_CORES.join(", ")}`);
  }
  const intensity = value["intensity"];
  if (intensity !== undefined && intensity !== null) {
    if (
      typeof intensity !== "number" ||
      !Number.isInteger(intensity) ||
      intensity < 1 ||
      intensity > 5
    ) {
      throw new HttpError(400, "intensity must be an integer from 1 to 5");
    }
  }
  const energy = value["energy"];
  if (energy !== undefined && energy !== null) {
    if (typeof energy !== "number" || !Number.isInteger(energy) || energy < 1 || energy > 5) {
      throw new HttpError(400, "energy must be an integer from 1 to 5");
    }
  }
  const identifiedVia = value["identifiedVia"];
  if (identifiedVia !== undefined && identifiedVia !== "wheel" && identifiedVia !== "assisted") {
    throw new HttpError(400, "identifiedVia must be wheel or assisted");
  }
  const feelingSecondary = optionalNullableString(value["feelingSecondary"], "feelingSecondary");
  const feelingTertiary = optionalNullableString(value["feelingTertiary"], "feelingTertiary");
  // Validate the (core, secondary?, tertiary?) PATH against the taxonomy — not just each field
  // individually (Codex R2): reject e.g. a tertiary that isn't a leaf of its secondary, or a
  // tertiary supplied without its secondary. `undefined`/`null`/`""` normalize to no selection.
  if (!isValidFeelingPath(feelingCore, feelingSecondary ?? null, feelingTertiary ?? null)) {
    throw new HttpError(
      400,
      "feelingSecondary/feelingTertiary must form a valid path under feelingCore"
    );
  }
  return {
    feelingCore,
    feelingSecondary,
    feelingTertiary,
    sensations: parseStringArray(value["sensations"], "sensations"),
    intensity: intensity === undefined ? undefined : (intensity as number | null),
    energy: energy === undefined ? undefined : (energy as number | null),
    note: optionalNullableString(value["note"], "note"),
    identifiedVia: identifiedVia as "wheel" | "assisted" | undefined
  };
}

function parseCreateMedicationBody(body: unknown): CreateMedicationInput {
  const value = requireObject(body);
  const name = requiredString(value["name"], "name");
  const frequencyType = value["frequencyType"];
  if (!isFrequencyType(frequencyType)) {
    throw new HttpError(
      400,
      `frequencyType must be one of ${MEDICATION_FREQUENCY_TYPES.join(", ")}`
    );
  }
  if (frequencyType === "times_per_day" && value["timesPerDay"] == null) {
    throw new HttpError(400, "timesPerDay is required for times_per_day");
  }
  if (frequencyType === "every_n_hours" && value["intervalHours"] == null) {
    throw new HttpError(400, "intervalHours is required for every_n_hours");
  }
  if (frequencyType === "specific_weekdays") {
    if (!isNonEmptyArray(value["weekdays"])) {
      throw new HttpError(400, "weekdays is required for specific_weekdays");
    }
    if ((value["weekdays"] as number[]).some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new HttpError(400, "weekdays must be ISO weekday integers 1 (Mon) to 7 (Sun)");
    }
  }
  // Scheduled families must carry at least one clock time (matches the DB CHECK).
  const scheduledFamilies = ["once_daily", "times_per_day", "specific_weekdays", "cyclical"];
  if (scheduledFamilies.includes(frequencyType) && !isNonEmptyArray(value["scheduleTimes"])) {
    throw new HttpError(400, `scheduleTimes is required for ${frequencyType}`);
  }
  // times_per_day must enumerate exactly that many clock times (matches the DB CHECK).
  if (
    frequencyType === "times_per_day" &&
    isNonEmptyArray(value["scheduleTimes"]) &&
    (value["scheduleTimes"] as unknown[]).length !== value["timesPerDay"]
  ) {
    throw new HttpError(400, "scheduleTimes length must equal timesPerDay");
  }
  if (
    frequencyType === "cyclical" &&
    (value["cycleAnchorDate"] == null || value["cycleDaysOn"] == null)
  ) {
    throw new HttpError(400, "cycleAnchorDate and cycleDaysOn are required for cyclical");
  }
  // as_needed (PRN) is unscheduled — reject scheduling/cycle fields (matches the DB CHECK).
  if (frequencyType === "as_needed") {
    for (const f of [
      "scheduleTimes",
      "timesPerDay",
      "intervalHours",
      "weekdays",
      "cycleAnchorDate",
      "cycleDaysOn",
      "cycleDaysOff"
    ]) {
      if (value[f] != null) throw new HttpError(400, `${f} is not allowed for as_needed`);
    }
  }
  return {
    name,
    dosage: optionalNullableString(value["dosage"], "dosage"),
    form: optionalNullableString(value["form"], "form"),
    frequencyType,
    timesPerDay: optionalNumber(value["timesPerDay"]),
    intervalHours: optionalNumber(value["intervalHours"]),
    weekdays: optionalNumberArray(value["weekdays"]),
    scheduleTimes: optionalStringArrayOrNull(value["scheduleTimes"], "scheduleTimes"),
    cycleDaysOn: optionalNumber(value["cycleDaysOn"]),
    cycleDaysOff: optionalNumber(value["cycleDaysOff"]),
    cycleAnchorDate: optionalNullableString(value["cycleAnchorDate"], "cycleAnchorDate"),
    notes: optionalNullableString(value["notes"], "notes")
  };
}

function parseUpdateMedicationBody(body: unknown): UpdateMedicationInput {
  const value = requireObject(body);
  const active = value["active"];
  if (active !== undefined && typeof active !== "boolean") {
    throw new HttpError(400, "active must be a boolean");
  }
  return {
    name: value["name"] === undefined ? undefined : requiredString(value["name"], "name"),
    dosage: optionalNullableString(value["dosage"], "dosage"),
    form: optionalNullableString(value["form"], "form"),
    active: active as boolean | undefined,
    notes: optionalNullableString(value["notes"], "notes")
  };
}

function parseLogDoseBody(body: unknown): LogDoseInput {
  const value = requireObject(body);
  const status = value["status"];
  if (!isLogStatus(status)) {
    throw new HttpError(400, `status must be one of ${MEDICATION_LOG_STATUSES.join(", ")}`);
  }
  const prnReason = optionalNullableString(value["prnReason"], "prnReason");
  if (status === "prn" && !prnReason) {
    throw new HttpError(400, "prnReason is required when status is prn");
  }
  const scheduledFor = optionalNullableString(value["scheduledFor"], "scheduledFor");
  // Non-PRN logs satisfy a scheduled slot — reject at the route (friendly 400) rather than
  // letting the DB CHECK surface a 500 (Codex R2).
  if (status !== "prn" && !scheduledFor) {
    throw new HttpError(400, "scheduledFor is required for taken/skipped doses");
  }
  return {
    status,
    dose: optionalNullableString(value["dose"], "dose"),
    prnReason,
    scheduledFor
  };
}

function isFeelingCore(value: unknown): value is WellnessFeelingCore {
  return typeof value === "string" && (WELLNESS_FEELING_CORES as readonly string[]).includes(value);
}
function isFrequencyType(value: unknown): value is MedicationFrequencyTypeApi {
  return (
    typeof value === "string" && (MEDICATION_FREQUENCY_TYPES as readonly string[]).includes(value)
  );
}
function isLogStatus(value: unknown): value is MedicationLogStatusApi {
  return (
    typeof value === "string" && (MEDICATION_LOG_STATUSES as readonly string[]).includes(value)
  );
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}
function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  return value.trim();
}
function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number") throw new HttpError(400, "expected a number");
  return value;
}
function optionalNumberArray(value: unknown): number[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number")) {
    throw new HttpError(400, "expected an array of numbers");
  }
  return value as number[];
}
function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  return value as string[];
}
function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
function optionalStringArrayOrNull(value: unknown, field: string): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseStringArray(value, field);
}
function parseSince(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "since must be an ISO timestamp");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "since must be an ISO timestamp");
  return date;
}
function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, "limit must be 1–500");
  return n;
}
function parseDateParam(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "date must be an ISO date (YYYY-MM-DD)");
  }
  return value;
}
```

Update `packages/wellness/src/index.ts` to add:

```ts
export { registerWellnessRoutes } from "./routes.js";
export type { WellnessRoutesDependencies } from "./routes.js";
```

- [ ] **Step 4: Run the test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (all route tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/src/routes.ts packages/wellness/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): REST routes for check-ins, medications, schedule, dose logs (Stage 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Stage 3 — AI tools, full manifest, registry wiring (briefings + chat surfacing)

### Task 8: AI read tools + complete the manifest (nav, permissions, routes, jobs, assistantTools)

**Files:**

- Create: `packages/wellness/src/tools.ts`
- Modify: `packages/wellness/src/manifest.ts` (add nav, permissions, routes, jobs, assistantTools)
- Modify: `packages/wellness/src/index.ts` (export the tool executes)
- Test: `tests/integration/wellness.test.ts`

The two read tools mirror `taskListExecute`: `assertDataContextDb` first, owner-scoped query, `risk:"read"`. `wellness.medicationAdherence` returns **counts/status only** (no full med list) per the privacy posture.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (add the tool imports + `ToolContext` type):

```ts
import type { ToolContext } from "@jarv1s/module-sdk";
import {
  wellnessRecentCheckInsExecute,
  wellnessMedicationAdherenceExecute
} from "@jarv1s/wellness";

describe("wellness AI read tools", () => {
  function toolCtx(actorUserId: string): ToolContext {
    return { actorUserId, requestId: "tool-req", chatSessionId: "" };
  }

  it("wellness.recentCheckIns returns owner-scoped check-ins and is declared read", async () => {
    const tool = wellnessModuleManifest.assistantTools?.find(
      (t) => t.name === "wellness.recentCheckIns"
    );
    expect(tool?.risk).toBe("read");
    expect(tool?.execute).toBeDefined();

    await dataContext.withDataContext(ctx(userId), (db) =>
      new WellnessRepository().createCheckin(db, { feelingCore: "peaceful", intensity: 4 })
    );
    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessRecentCheckInsExecute(db, {}, toolCtx(userId))
    );
    const items = result.data.items as Array<{ feelingCore: string }>;
    expect(items.length).toBeGreaterThan(0);
  });

  it("wellness.medicationAdherence returns counts only (no full med list)", async () => {
    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessMedicationAdherenceExecute(db, {}, toolCtx(userId))
    );
    expect(result.data).toHaveProperty("scheduled");
    expect(result.data).toHaveProperty("taken");
    expect(result.data).not.toHaveProperty("medications");
    expect(result.data).not.toHaveProperty("items");
  });

  it("every manifest route corresponds to a declared permission", () => {
    const permissionIds = new Set((wellnessModuleManifest.permissions ?? []).map((p) => p.id));
    for (const route of wellnessModuleManifest.routes ?? []) {
      if (route.permissionId) expect(permissionIds.has(route.permissionId)).toBe(true);
    }
  });

  it("declares a metadata-only deferred reminder queue but no active queueDefinitions", () => {
    const job = (wellnessModuleManifest.jobs ?? [])[0];
    expect(job?.queueName).toBe("wellness-medication-reminder");
    expect(job?.metadataOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — the tool executes / `assistantTools` are not yet defined.

- [ ] **Step 3: Write minimal implementation**

Create `packages/wellness/src/tools.ts`:

```ts
import { assertDataContextDb } from "@jarv1s/db";
import type { ToolExecute, ToolResult } from "@jarv1s/module-sdk";

import { WellnessRepository } from "./repository.js";
import { serializeCheckin } from "./serialize.js";

const repository = new WellnessRepository();

export const wellnessRecentCheckInsExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const checkins = await repository.listCheckins(scopedDb, { limit: 20 });
  return {
    data: {
      items: checkins.map((c) => {
        const dto = serializeCheckin(c);
        return {
          checkedInAt: dto.checkedInAt,
          feelingCore: dto.feelingCore,
          feelingSecondary: dto.feelingSecondary,
          intensity: dto.intensity
        };
      })
    },
    columnOrder: ["checkedInAt", "feelingCore", "feelingSecondary", "intensity"]
  };
};

export const wellnessMedicationAdherenceExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  // Counts/status only — never a full medication list (privacy posture).
  const logs = await repository.listRecentLogs(scopedDb, { sinceDays: 7 });
  const taken = logs.filter((l) => l.status === "taken").length;
  const skipped = logs.filter((l) => l.status === "skipped").length;
  const prn = logs.filter((l) => l.status === "prn").length;
  const scheduled = taken + skipped;
  return {
    data: {
      windowDays: 7,
      scheduled,
      taken,
      skipped,
      prn,
      adherenceRate: scheduled > 0 ? Math.round((taken / scheduled) * 100) / 100 : null
    }
  };
};
```

Now rewrite `packages/wellness/src/manifest.ts` in full (add the imports + nav/permissions/routes/jobs/assistantTools blocks):

```ts
import { fileURLToPath } from "node:url";

import type { JarvisModuleManifest } from "@jarv1s/module-sdk";
import {
  createCheckinRequestSchema,
  createCheckinResponseSchema,
  createMedicationLogRequestSchema,
  createMedicationLogResponseSchema,
  createMedicationRequestSchema,
  listCheckinsResponseSchema,
  listMedicationsResponseSchema,
  medicationResponseSchema,
  medicationScheduleResponseSchema,
  updateMedicationRequestSchema
} from "@jarv1s/shared";

import { wellnessMedicationAdherenceExecute, wellnessRecentCheckInsExecute } from "./tools.js";

export const WELLNESS_MODULE_ID = "wellness";
export const WELLNESS_MEDICATION_REMINDER_QUEUE = "wellness-medication-reminder";
export const wellnessModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const wellnessModuleManifest = {
  id: WELLNESS_MODULE_ID,
  name: "Wellness",
  version: "0.1.0",
  publisher: "jarv1s",
  lifecycle: "user-toggleable",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: false,
    supportsUserDisable: true
  },
  database: {
    migrations: [
      "sql/0066_wellness_checkins.sql",
      "sql/0067_wellness_medications.sql",
      "sql/0068_wellness_medication_logs.sql"
    ],
    migrationDirectories: ["packages/wellness/sql"],
    ownedTables: ["app.wellness_checkins", "app.medications", "app.medication_logs"]
  },
  navigation: [
    {
      id: "wellness",
      label: "Wellness",
      path: "/wellness",
      icon: "heart-pulse",
      order: 40,
      permissionId: "wellness.view"
    }
  ],
  permissions: [
    {
      id: "wellness.view",
      label: "View wellness",
      description: "Read the active actor's own wellness check-ins and medications.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "wellness.create",
      label: "Log wellness",
      description: "Create check-ins, medications, and dose logs owned by the active actor.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "wellness.update",
      label: "Update wellness",
      description: "Update the active actor's own medications.",
      scope: "user",
      actions: ["update"]
    }
  ],
  routes: [
    {
      method: "POST",
      path: "/api/wellness/checkins",
      requestSchema: createCheckinRequestSchema,
      responseSchema: createCheckinResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "GET",
      path: "/api/wellness/checkins",
      responseSchema: listCheckinsResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "GET",
      path: "/api/wellness/medications",
      responseSchema: listMedicationsResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/medications",
      requestSchema: createMedicationRequestSchema,
      responseSchema: medicationResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "PATCH",
      path: "/api/wellness/medications/:id",
      requestSchema: updateMedicationRequestSchema,
      responseSchema: medicationResponseSchema,
      permissionId: "wellness.update"
    },
    {
      method: "GET",
      path: "/api/wellness/medications/schedule",
      responseSchema: medicationScheduleResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/medications/:id/logs",
      requestSchema: createMedicationLogRequestSchema,
      responseSchema: createMedicationLogResponseSchema,
      permissionId: "wellness.create"
    }
  ],
  jobs: [
    {
      // Designed seam; NO worker registered until the Phase-3 scheduler lands (deferred).
      queueName: WELLNESS_MEDICATION_REMINDER_QUEUE,
      metadataOnly: true,
      permissionId: "wellness.view"
    }
  ],
  assistantTools: [
    {
      name: "wellness.recentCheckIns",
      description:
        "List the actor's recent feelings check-ins (most recent first): timestamp, core feeling, secondary feeling, and intensity. Read-only.",
      permissionId: "wellness.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: wellnessRecentCheckInsExecute
    },
    {
      name: "wellness.medicationAdherence",
      description:
        "Summarize the actor's medication adherence over the last 7 days as counts (scheduled, taken, skipped, PRN) and an adherence rate. Returns counts only, never a medication list. Read-only.",
      permissionId: "wellness.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: wellnessMedicationAdherenceExecute
    }
  ]
} satisfies JarvisModuleManifest;
```

Update `packages/wellness/src/index.ts` to add:

```ts
export { wellnessRecentCheckInsExecute, wellnessMedicationAdherenceExecute } from "./tools.js";
```

NOTE on the `heart-pulse` icon: it is added to the web shell `iconMap` in Task 18 — `lucide-react` exports `HeartPulse`. Until then nav falls back to the generic `Layers3` icon, which is harmless.

- [ ] **Step 4: Run the test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (tool + manifest tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/src/tools.ts packages/wellness/src/manifest.ts packages/wellness/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): AI read tools + complete manifest (nav, perms, routes, jobs, tools) (Stage 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 9: Register Wellness in `BUILT_IN_MODULES` with routes (full registry wiring)

**Files:**

- Modify: `packages/module-registry/src/index.ts` (upgrade the Task 2b partial entry to include `registerRoutes`)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts`:

```ts
import { getBuiltInModuleManifests } from "@jarv1s/module-registry";

describe("wellness registry integration", () => {
  it("wellness is registered exactly once in BUILT_IN_MODULES and is the only required:false module", () => {
    const manifests = getBuiltInModuleManifests();
    const wellness = manifests.filter((m) => m.id === "wellness");
    expect(wellness.length).toBe(1);
    expect(wellness[0]?.availability?.required).toBe(false);

    const optional = manifests.filter((m) => m.availability?.required === false);
    expect(optional.map((m) => m.id)).toEqual(["wellness"]);
  });

  it("wellness routes are reachable through registerBuiltInApiRoutes (briefings can resolve its tools)", () => {
    const manifest = getBuiltInModuleManifests().find((m) => m.id === "wellness");
    const toolNames = (manifest?.assistantTools ?? []).map((t) => t.name);
    expect(toolNames).toContain("wellness.recentCheckIns");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL on the "only required:false module" assertion if any OTHER module is already `required:false`; otherwise the routes-wiring assertion may still pass on manifest alone — run to confirm the registry entry needs `registerRoutes`. (If both pass already because Task 2b registered the manifest, proceed — Step 3 still adds `registerRoutes`, required for Task 11's route reachability.)

- [ ] **Step 3: Write minimal implementation**

In `packages/module-registry/src/index.ts`, update the wellness import to also bring in the route registrar:

```ts
import {
  registerWellnessRoutes,
  wellnessModuleManifest,
  wellnessModuleSqlMigrationDirectory
} from "@jarv1s/wellness";
```

Replace the partial wellness entry (from Task 2b) at the end of `BUILT_IN_MODULES` with:

```ts
  ,
  {
    manifest: wellnessModuleManifest,
    sqlMigrationDirectories: [wellnessModuleSqlMigrationDirectory],
    queueDefinitions: [],
    registerRoutes: (server, deps) =>
      registerWellnessRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext
      })
  }
```

- [ ] **Step 4: Run the test + a broad typecheck**

Run: `vitest run tests/integration/wellness.test.ts && pnpm --filter @jarv1s/module-registry typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/module-registry/src/index.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): register module in BUILT_IN_MODULES with routes (Stage 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 10: Briefings "Wellness" section via the existing read-tool seam (zero briefings-package change)

**Files:**

- Test: `tests/integration/wellness.test.ts` (assert `generateRun` resolves the wellness tool with NO briefings edit)

This task proves the seam — it adds NO production code. `generateRun` resolves a definition's `selected_tool_names` against `input.moduleManifests` and calls `manifestTool.execute`. We assert a briefing definition selecting `wellness.recentCheckIns` renders a section.

ENABLEMENT CAVEAT (Codex R2/R3 — adjudicated; DEFERRED, not silently ignored): the briefings
package resolves selectable/executable tools against whatever `moduleManifests` the CALLER passes.
Production passes the FULL registered set, NOT the per-actor active set, in three places:
`packages/module-registry/src/index.ts` (the briefings entry → `getBuiltInModuleManifests()`),
`packages/briefings/src/routes.ts:77/96` (`listModuleManifests()` for create/update validation),
and `packages/briefings/src/jobs.ts:84` (`options.moduleManifests` at run time). So a briefing can
select/execute a read tool from a module the OWNER has user-disabled — for EVERY tool-bearing
module, not Wellness specifically.

Arbiter ruling (why this does NOT block this slice):

- It is NOT a Hard-Invariant breach. The wellness read tools run under `withDataContext`
  (owner-scoped RLS); a disabled-module briefing can only ever read the OWNER'S OWN data inside the
  OWNER'S OWN briefing — no cross-user leak, no admin bypass, no secret exposure.
- It is a pre-existing, module-agnostic ENABLEMENT-completeness gap owned by the briefings +
  module-enablement seam. The correct fix threads `resolveActiveModules(definition.owner_user_id)`
  through `generateRun`/jobs/routes (sync→async manifest resolution) — a cross-cutting briefings
  refactor that affects every module. Doing that inside a "wellness" slice would re-architect
  another module and violate the scope/isolation discipline ("do not re-architect another module").
- The genuinely security-sensitive surfaces (AI chat tools via the MCP/REST gateway, REST routes,
  nav, focus) ARE active-filtered already (Tasks 12, 18 + the landed route-guard + the AI gateway's
  existing `resolveActiveModules`).

ACTION (required, in this PR's wrap-up): file a tracking issue "briefings: resolve assistant tools
via resolveActiveModules(definition.owner_user_id) so user-disabled modules cannot run via a
briefing" against the briefings/enablement owner, and link it from the PR. When that lands, NO
Wellness change is needed. Do NOT edit the briefings package in this slice.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (add the briefings import):

```ts
import { BriefingsRepository } from "@jarv1s/briefings";

describe("briefings Wellness section (existing read-tool seam, zero briefings change)", () => {
  it("a briefing definition selecting wellness.recentCheckIns renders a section", async () => {
    const briefings = new BriefingsRepository();

    // Seed a check-in so the tool has data.
    await dataContext.withDataContext(ctx(userId), (db) =>
      new WellnessRepository().createCheckin(db, { feelingCore: "sad", intensity: 2 })
    );

    const definition = await dataContext.withDataContext(ctx(userId), (db) =>
      briefings.createDefinition(db, {
        title: "Daily Wellness",
        cadence: "manual",
        selectedToolNames: ["wellness.recentCheckIns"]
      })
    );

    const run = await dataContext.withDataContext(ctx(userId), (db) =>
      briefings.generateRun(db, definition.id, {
        runKind: "manual",
        moduleManifests: getBuiltInModuleManifests()
      })
    );

    expect(run?.status).toBe("succeeded");
    const tools =
      (run?.source_metadata as { tools?: Array<{ name: string; status: string }> }).tools ?? [];
    expect(tools.some((t) => t.name === "wellness.recentCheckIns" && t.status !== "failed")).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: This SHOULD PASS immediately if the briefings `generateRun`/`createDefinition` signatures match. If the method names differ, inspect `packages/briefings/src/repository.ts` and `packages/briefings/src/index.ts` for the exact exported method names + input shapes, and adjust the test call sites ONLY (do NOT edit the briefings package). The assertion that matters: the wellness tool resolves and runs with zero briefings-package edits.

- [ ] **Step 3: (No implementation — seam-only)**

If Step 2 passed, there is nothing to implement — that is the point (the read-tool seam already handles unknown tools via `summarizeUnknownResult`/`displayToolName`). If the test needed call-site shape fixes, those live in the test file only.

- [ ] **Step 4: Re-run**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/wellness.test.ts
git commit -m "test(wellness): briefings renders Wellness section via existing read-tool seam (zero briefings change) (Stage 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 11: Chat recall energy-trend fact (fallback path: memory module's public `ChatMemoryFactsRepository`)

This plan uses the **fallback** path from the spec (Component 5) — write a real `profile` fact via the memory module's PUBLIC `ChatMemoryFactsRepository` — to keep the generic-core-change count at exactly ONE (the focus-signal seam, Stage 4). The fact text is the abstracted trend ONLY (never raw feelings).

**Files:**

- Create: `packages/wellness/src/recall-context.ts`
- Modify: `packages/wellness/package.json` (add `@jarv1s/memory` dependency)
- Modify: `packages/wellness/src/index.ts` (export `deriveEnergyTrend`, `WellnessRecallContributor`)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts`:

```ts
import { ChatMemoryFactsRepository } from "@jarv1s/memory";
import { deriveEnergyTrend, WellnessRecallContributor } from "@jarv1s/wellness";

describe("wellness chat recall energy-trend fact", () => {
  it("deriveEnergyTrend produces an abstracted, non-clinical trend string (no raw feelings)", () => {
    const trend = deriveEnergyTrend([
      { energy: 2, feeling_core: "sad" } as never,
      { energy: 1, feeling_core: "scared" } as never,
      { energy: 2, feeling_core: "sad" } as never
    ]);
    expect(trend).not.toBeNull();
    expect(trend?.toLowerCase()).toContain("energy");
    // Must NOT contain a raw feeling word.
    expect(trend?.toLowerCase()).not.toContain("sad");
    expect(trend?.toLowerCase()).not.toContain("scared");
  });

  it("deriveEnergyTrend returns null when there are no recent check-ins", () => {
    expect(deriveEnergyTrend([])).toBeNull();
  });

  it("contributor upserts a profile fact that listActiveFacts picks up", async () => {
    const contributor = new WellnessRecallContributor();
    const facts = new ChatMemoryFactsRepository();

    await dataContext.withDataContext(ctx(userId), async (db) => {
      await new WellnessRepository().createCheckin(db, {
        feelingCore: "sad",
        intensity: 1,
        energy: 1
      });
      await new WellnessRepository().createCheckin(db, {
        feelingCore: "scared",
        intensity: 2,
        energy: 2
      });
      await contributor.refreshEnergyTrendFact(db, userId);
      const active = await facts.listActiveFacts(db, userId);
      expect(
        active.some((f) => f.category === "profile" && f.content.toLowerCase().includes("energy"))
      ).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `deriveEnergyTrend` / `WellnessRecallContributor` not exported (and `@jarv1s/memory` not yet a dep).

- [ ] **Step 3: Write minimal implementation**

Add `@jarv1s/memory` to `packages/wellness/package.json` dependencies (alphabetical, after `@jarv1s/db`):

```json
    "@jarv1s/memory": "workspace:*",
```

Then run `pnpm install`.

Create `packages/wellness/src/recall-context.ts`:

```ts
import { assertDataContextDb, type DataContextDb, type WellnessCheckin } from "@jarv1s/db";
import { ChatMemoryFactsRepository } from "@jarv1s/memory";

const ENERGY_TREND_TAG = "[wellness:energy-trend]";

/**
 * Abstracted, non-clinical energy trend derived from recent self-rated ENERGY (1–5), NOT
 * emotion intensity (Codex R1 — do not conflate the two). Returns null when no recent
 * check-in carries an energy rating. The string MUST NOT contain raw feeling words — only
 * an energy-level abstraction (privacy posture / no health-content leakage).
 */
export function deriveEnergyTrend(
  recent: ReadonlyArray<Pick<WellnessCheckin, "energy" | "feeling_core">>
): string | null {
  const energies = recent.map((c) => c.energy).filter((n): n is number => typeof n === "number");
  if (energies.length === 0) return null;

  const avg = energies.reduce((sum, n) => sum + n, 0) / energies.length;
  const days = energies.length;
  let level: string;
  if (avg <= 2) level = "low";
  else if (avg >= 4) level = "high";
  else level = "moderate";

  return `${ENERGY_TREND_TAG} Energy has trended ${level} over the last ${days.toString()} recent check-ins.`;
}

export class WellnessRecallContributor {
  constructor(
    private readonly facts: ChatMemoryFactsRepository = new ChatMemoryFactsRepository()
  ) {}

  /**
   * Recompute the energy-trend and store it as a single owner profile fact. Supersedes
   * any prior wellness energy-trend fact so only the latest is active. Uses the memory
   * module's PUBLIC API only — never imports memory internals (module-isolation).
   */
  async refreshEnergyTrendFact(scopedDb: DataContextDb, ownerUserId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    const recent = await scopedDb.db
      .selectFrom("app.wellness_checkins")
      .select(["energy", "feeling_core"])
      .orderBy("checked_in_at", "desc")
      .limit(7)
      .execute();

    const trend = deriveEnergyTrend(
      recent as Array<Pick<WellnessCheckin, "energy" | "feeling_core">>
    );

    const active = await this.facts.listActiveFacts(scopedDb, ownerUserId);
    for (const fact of active) {
      if (fact.category === "profile" && fact.content.includes(ENERGY_TREND_TAG)) {
        await this.facts.supersedeFact(scopedDb, fact.id);
      }
    }

    if (trend) {
      await this.facts.insertFact(scopedDb, ownerUserId, {
        category: "profile",
        content: trend,
        importance: 0.6
      });
    }
  }
}
```

Update `packages/wellness/src/index.ts` to add:

```ts
export { deriveEnergyTrend, WellnessRecallContributor } from "./recall-context.js";
```

NOTE: `refreshEnergyTrendFact` is invoked on each check-in create from the route layer. Add this call inside the check-in POST handler in `packages/wellness/src/routes.ts` — after the `createCheckin` succeeds, within the SAME `withDataContext` block. Modify the POST handler body to:

```ts
server.post(
  "/api/wellness/checkins",
  { schema: createCheckinRouteSchema },
  async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const input = parseCheckinBody(request.body);
      const checkin = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          const created = await repo.createCheckin(scopedDb, input);
          await recallContributor.refreshEnergyTrendFact(scopedDb, accessContext.actorUserId);
          return created;
        }
      );
      return reply.code(201).send({ checkin: serializeCheckin(checkin) });
    } catch (error) {
      return handleRouteError(error, reply);
    }
  }
);
```

Add the contributor to `routes.ts` — import it and construct it at the top of `registerWellnessRoutes`:

```ts
import { WellnessRecallContributor } from "./recall-context.js";
```

```ts
const recallContributor = new WellnessRecallContributor();
```

- [ ] **Step 4: Run the test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (energy-trend fact tests + the prior route tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/wellness/src/recall-context.ts packages/wellness/src/routes.ts packages/wellness/src/index.ts packages/wellness/package.json pnpm-lock.yaml tests/integration/wellness.test.ts
git commit -m "feat(wellness): chat recall energy-trend profile fact via memory public API (Stage 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Stage 4 — The ONE generic core change: focus-signal contribution point + prioritization

### Task 12: `FocusSignal`/`FocusSignalProvider` in module-sdk + Wellness provider + tasks-focus consumer

This is the **single justified generic core change** (spec Component 3, acceptance criterion 6). It touches `module-sdk` (type + manifest field + a generic aggregator), `module-registry`/`server.ts` (wire an aggregated provider into route deps), and `tasks` focus route (consume a generic `FocusSignal[]` — NEVER importing wellness). Wellness implements the provider in-package.

**Files:**

- Modify: `packages/module-sdk/src/index.ts` (add `FocusSignal`, `FocusSignalProvider`, `focusSignal?` field, `aggregateFocusSignals`)
- Create: `packages/wellness/src/focus-signal.ts`
- Modify: `packages/wellness/src/manifest.ts` (add `focusSignal: wellnessFocusSignal`)
- Modify: `packages/wellness/src/index.ts` (export `wellnessFocusSignal`)
- Modify: `packages/module-registry/src/index.ts` (`BuiltInRouteDependencies.focusSignals` + build aggregator)
- Modify: `apps/api/src/server.ts` (construct + inject the aggregator)
- Modify: `packages/shared/src/tasks-api.ts` (additive `signals` on the focus response schema + DTO)
- Modify: `packages/tasks/src/routes.ts` (focus route attaches injected `signals` + readiness-capped order)
- Modify: `packages/tasks/src/routes.ts` `TasksRoutesDependencies` (add optional `focusSignals`)
- Modify: `packages/module-registry/src/index.ts` tasks entry (pass `focusSignals` to `registerTasksRoutes`)
- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts`:

```ts
import { aggregateFocusSignals, type FocusSignal } from "@jarv1s/module-sdk";
import { wellnessFocusSignal } from "@jarv1s/wellness";

describe("focus-signal contribution point", () => {
  it("wellness provider returns null with no check-ins", async () => {
    const fresh = "00000000-0000-4000-8000-000000000043";
    const client2 = new Client({ connectionString: connectionStrings.bootstrap });
    await client2.connect();
    try {
      await client2.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1,'fresh@example.test',false)
         ON CONFLICT (id) DO NOTHING`,
        [fresh]
      );
    } finally {
      await client2.end();
    }
    const signal = await dataContext.withDataContext(ctx(fresh), (db) =>
      wellnessFocusSignal(db, { actorUserId: fresh, requestId: "req:focus" })
    );
    expect(signal).toBeNull();
  });

  it("wellness provider yields low readiness after low-ENERGY check-ins", async () => {
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const repo = new WellnessRepository();
      await repo.createCheckin(db, { feelingCore: "sad", intensity: 1, energy: 1 });
      await repo.createCheckin(db, { feelingCore: "scared", intensity: 1, energy: 1 });
    });
    const signal = await dataContext.withDataContext(ctx(userId), (db) =>
      wellnessFocusSignal(db, { actorUserId: userId, requestId: "req:focus" })
    );
    expect(signal).not.toBeNull();
    expect(signal!.moduleId).toBe("wellness");
    expect(signal!.readiness).toBeLessThan(0.5);
    expect(signal!.summary.toLowerCase()).toContain("energy");
  });

  it("aggregateFocusSignals fails soft: a throwing provider is treated as no signal", async () => {
    const throwing = async () => {
      throw new Error("boom");
    };
    const result = await dataContext.withDataContext(ctx(userId), (db) =>
      aggregateFocusSignals(
        [
          { moduleId: "wellness", provider: wellnessFocusSignal },
          { moduleId: "broken", provider: throwing as never }
        ],
        db,
        { actorUserId: userId, requestId: "req:focus" }
      )
    );
    expect(result.some((s) => s.moduleId === "wellness")).toBe(true);
    expect(result.some((s) => (s as FocusSignal).moduleId === "broken")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: FAIL — `aggregateFocusSignals` / `FocusSignal` / `wellnessFocusSignal` not exported.

- [ ] **Step 3: Write minimal implementation — module-sdk (the generic seam)**

In `packages/module-sdk/src/index.ts`, add after the `ToolSummarize` type (the type is generic — NO Wellness naming):

```ts
/** A normalized readiness/energy signal contributed by ANY module to the focus path. */
export interface FocusSignal {
  /** Stable id of the contributing module, e.g. "wellness". */
  readonly moduleId: string;
  /** Normalized readiness in [0,1]; 1 = fully ready/energized, 0 = depleted. */
  readonly readiness: number;
  /** Short, non-sensitive human label, e.g. "energy trended low". */
  readonly summary: string;
}

/**
 * A focus-signal provider. `scopedDb` is a DataContextDb supplied under withDataContext;
 * it is typed `unknown` to avoid a module-sdk -> db dependency (the owning module narrows
 * it via assertDataContextDb, exactly like ToolExecute). Returns null = no signal for this
 * actor (e.g. no recent data).
 */
export type FocusSignalProvider = (
  scopedDb: unknown,
  ctx: { readonly actorUserId: string; readonly requestId: string }
) => Promise<FocusSignal | null>;

export interface RegisteredFocusSignal {
  readonly moduleId: string;
  readonly provider: FocusSignalProvider;
}

/** Sanitized observability hook for a failed/dropped provider. */
export interface FocusSignalAggregateOptions {
  /**
   * Called when a provider throws or returns a malformed value. Receives ONLY the contributing
   * moduleId + the error's name (never the error message, stack, or any payload/health data) —
   * so a readiness outage is observable without leaking sensitive content (Codex R1).
   */
  readonly onProviderError?: (moduleId: string, errorName: string) => void;
}

/**
 * Run every registered provider for an actor and collect the non-null signals. Generic and
 * uniform: it knows nothing about any specific module. A provider that throws or returns a
 * malformed value is treated as "no signal" (fail soft — focus must never break), but the
 * drop is reported via `onProviderError` (sanitized) so outages are not silent.
 */
export async function aggregateFocusSignals(
  providers: readonly RegisteredFocusSignal[],
  scopedDb: unknown,
  ctx: { readonly actorUserId: string; readonly requestId: string },
  options: FocusSignalAggregateOptions = {}
): Promise<FocusSignal[]> {
  const results = await Promise.all(
    providers.map(async ({ moduleId, provider }) => {
      try {
        const signal = await provider(scopedDb, ctx);
        if (
          signal &&
          typeof signal.moduleId === "string" &&
          typeof signal.readiness === "number" &&
          Number.isFinite(signal.readiness) &&
          typeof signal.summary === "string"
        ) {
          return {
            moduleId: signal.moduleId,
            readiness: Math.min(1, Math.max(0, signal.readiness)),
            summary: signal.summary
          } satisfies FocusSignal;
        }
        // Non-null but malformed → treat as a provider error (observability).
        if (signal !== null) options.onProviderError?.(moduleId, "MalformedFocusSignal");
        return null;
      } catch (error) {
        const name = error instanceof Error ? error.name : "UnknownError";
        options.onProviderError?.(moduleId, name);
        return null;
      }
    })
  );
  return results.filter((s): s is FocusSignal => s !== null);
}
```

Add the optional manifest field to `JarvisModuleManifest` (after `assistantTools`):

```ts
  readonly focusSignal?: FocusSignalProvider;
```

- [ ] **Step 4: Write Wellness's provider**

Create `packages/wellness/src/focus-signal.ts`:

```ts
import { assertDataContextDb } from "@jarv1s/db";
import type { FocusSignalProvider } from "@jarv1s/module-sdk";

import { WellnessRepository } from "./repository.js";

const repository = new WellnessRepository();

/**
 * Derive a normalized readiness in [0,1] from recent self-rated ENERGY (1–5 → 0–1) — NOT
 * from emotion intensity (a calm low-intensity feeling is not low readiness; Codex R1).
 * Only check-ins that recorded an explicit `energy` value contribute. Returns null when no
 * recent check-in carries an energy rating, so the focus path is unaffected for users who
 * never rate energy. The summary is abstracted ("energy trended low") — never raw feelings/meds.
 */
export const wellnessFocusSignal: FocusSignalProvider = async (scopedDb, _ctx) => {
  assertDataContextDb(scopedDb);
  const recent = await repository.listCheckins(scopedDb, { limit: 7 });
  const energies = recent.map((c) => c.energy).filter((n): n is number => typeof n === "number");
  if (energies.length === 0) return null;

  const avg = energies.reduce((sum, n) => sum + n, 0) / energies.length;
  const readiness = Math.min(1, Math.max(0, (avg - 1) / 4)); // energy 1→0, 5→1
  const level = readiness <= 0.35 ? "low" : readiness >= 0.7 ? "high" : "moderate";
  return {
    moduleId: "wellness",
    readiness,
    summary: `Energy trended ${level} over recent check-ins.`
  };
};
```

In `packages/wellness/src/manifest.ts`, import the provider and add the manifest field. Add to the top imports:

```ts
import { wellnessFocusSignal } from "./focus-signal.js";
```

Add as the LAST property of the manifest object (after `assistantTools`):

```ts
  ,
  focusSignal: wellnessFocusSignal
```

In `packages/wellness/src/index.ts` add:

```ts
export { wellnessFocusSignal } from "./focus-signal.js";
```

- [ ] **Step 5: Run the seam tests**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (provider + aggregator tests green).

- [ ] **Step 6: Wire the aggregated provider into the tasks focus route (consumer; generic)**

In `packages/shared/src/tasks-api.ts`, add a focus-signal DTO + extend the focus response schema. After `listTasksResponseSchema` add:

```ts
export const focusSignalDtoSchema = {
  type: "object",
  required: ["moduleId", "readiness", "summary"],
  properties: {
    moduleId: { type: "string" },
    readiness: { type: "number" },
    summary: { type: "string" }
  }
} as const;

export interface FocusSignalDto {
  readonly moduleId: string;
  readonly readiness: number;
  readonly summary: string;
}

export const focusTasksResponseSchema = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: { type: "array", items: taskDtoSchema },
    signals: { type: "array", items: focusSignalDtoSchema }
  }
} as const;

export interface FocusTasksResponse {
  readonly tasks: readonly TaskDto[];
  readonly signals?: readonly FocusSignalDto[];
}
```

Replace the existing `focusTasksRouteSchema` (response 200 currently `listTasksResponseSchema`) with:

```ts
export const focusTasksRouteSchema = {
  response: {
    200: focusTasksResponseSchema
  }
} as const;
```

In `packages/tasks/src/routes.ts`, add to `TasksRoutesDependencies`:

```ts
  /**
   * Generic focus-signal source injected from the composition root. Tasks consumes an
   * opaque FocusSignal[] and never knows which modules produced them (module isolation).
   * It does NOT take `scopedDb`: the source opens its OWN per-actor withDataContext(s) —
   * exactly like the AI route surfaces' `resolveActiveModules` (packages/ai/src/routes.ts) —
   * so it is NOT nested inside the focus query's transaction (avoids pool-nesting hazards).
   */
  readonly focusSignals?: (
    ctx: { readonly actorUserId: string; readonly requestId: string }
  ) => Promise<readonly { moduleId: string; readiness: number; summary: string }[]>;
```

Replace the `/api/tasks/focus` handler with one that attaches signals and caps the list when aggregate readiness is low. Resolve signals FIRST (its own context), THEN read the focus tasks in a separate withDataContext — never nest the two:

```ts
server.get("/api/tasks/focus", { schema: focusTasksRouteSchema }, async (request, reply) => {
  try {
    const accessContext = await dependencies.resolveAccessContext(request);
    // Step 1: signals (the source opens its own per-actor contexts; not nested below).
    const signals = dependencies.focusSignals
      ? await dependencies.focusSignals({
          actorUserId: accessContext.actorUserId,
          requestId: accessContext.requestId ?? "focus"
        })
      : [];
    // Step 2: the focus tasks, in their own transaction.
    const tasks = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
      driftRepository.getFocus(scopedDb)
    );

    // Generic readiness re-weighting: when aggregate readiness is low, surface fewer,
    // lighter items. Tasks does not know WHY readiness is low — only the number.
    const ordered = applyReadinessCap(tasks.map(serializeTask), signals);

    return { tasks: ordered, signals };
  } catch (error) {
    return handleRouteError(error, reply);
  }
});
```

Add this helper at the bottom of `packages/tasks/src/routes.ts` (it is generic — operates on the numeric signal only):

```ts
function applyReadinessCap(
  tasks: ReturnType<typeof serializeTask>[],
  signals: readonly { readiness: number }[]
): ReturnType<typeof serializeTask>[] {
  if (signals.length === 0) return tasks;
  const aggregate = signals.reduce((sum, s) => sum + s.readiness, 0) / signals.length;
  if (aggregate >= 0.5) return tasks;
  // Low readiness: cap to the top 3 highest-priority items so a depleted day surfaces less.
  const cap = aggregate <= 0.25 ? 3 : 5;
  return tasks.slice(0, cap);
}
```

Add `focusTasksRouteSchema` is already imported in `routes.ts`; ensure `focusTasksResponseSchema` is NOT needed there (the route schema reference is enough).

- [ ] **Step 7: Wire the composition root to build + inject the aggregator**

In `packages/module-registry/src/index.ts`, extend the existing module-sdk TYPE import (do NOT import the runtime `aggregateFocusSignals` here — it is only called in `server.ts`; importing it unused would fail lint, Codex R1 finding 14):

```ts
import type { JarvisModuleManifest, RegisteredFocusSignal } from "@jarv1s/module-sdk";
```

(Replace the existing `import type { JarvisModuleManifest } from "@jarv1s/module-sdk";` line with the combined type import above.)

Add a helper after `getBuiltInModuleManifests` that builds providers from a GIVEN manifest set — so the caller can pass the PER-ACTOR active set (Codex R1 finding 4: a user who disabled Wellness must get no Wellness focus contribution):

```ts
/**
 * Build the focus-signal provider list from a manifest set. Pass the per-actor ACTIVE
 * manifests (resolveActiveModules(actorUserId)) so a per-user-disabled module is excluded.
 * Generic: any module that declares `focusSignal` participates; no module is special-cased.
 */
export function focusSignalProvidersFor(
  manifests: readonly JarvisModuleManifest[]
): RegisteredFocusSignal[] {
  return manifests.flatMap((manifest) =>
    manifest.focusSignal ? [{ moduleId: manifest.id, provider: manifest.focusSignal }] : []
  );
}
```

Add `focusSignals` to `BuiltInRouteDependencies` (no `scopedDb` — the aggregator opens its own per-actor contexts):

```ts
  /**
   * Per-request, per-actor focus-signal aggregator. The composition root resolves the
   * actor's ACTIVE modules first, builds providers from them, runs each in its own
   * withDataContext, then aggregates — so a disabled module contributes nothing. Tasks
   * consumes an opaque FocusSignal[].
   */
  readonly focusSignals?: (
    ctx: { readonly actorUserId: string; readonly requestId: string }
  ) => Promise<readonly { moduleId: string; readiness: number; summary: string }[]>;
```

In the tasks `BUILT_IN_MODULES` entry, pass it through. The tasks entry currently uses the bare `registerRoutes: registerTasksRoutes` form — replace it with an arrow that forwards `focusSignals`:

```ts
    registerRoutes: (server, deps) =>
      registerTasksRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        boss: deps.boss,
        focusSignals: deps.focusSignals
      }),
```

In `apps/api/src/server.ts`, import the new helper alongside the existing module-registry imports (the registry already exports `createActiveModulesResolver`, used below):

```ts
  focusSignalProvidersFor,
```

And import the aggregator from `@jarv1s/module-sdk` at the top of `server.ts`:

```ts
import { aggregateFocusSignals } from "@jarv1s/module-sdk";
```

`server.ts` already constructs `resolveActiveModules` (the `createActiveModulesResolver(...)` call) and `dataContext` (the `DataContextRunner`). Pass an active-filtered, sanitized-logging aggregator into `registerBuiltInApiRoutes`'s dependency object (add this field next to the existing `resolveActiveModules` field). It opens ONE short per-actor `withDataContext` for all providers — separate from, and not nested inside, the tasks focus query:

```ts
      focusSignals: async (ctx) => {
        // 1) Resolve THIS actor's active manifests (honors per-user/instance disable) — its
        //    own short context, exactly like the AI route surfaces do. A disabled module is
        //    excluded, so it contributes no focus signal.
        const activeManifests = await resolveActiveModules(ctx.actorUserId);
        const providers = focusSignalProvidersFor(activeManifests);
        if (providers.length === 0) return [];
        // 2) Run every provider inside ONE actor-scoped read transaction, then aggregate.
        return dataContext.withDataContext(
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          (scopedDb) =>
            aggregateFocusSignals(providers, scopedDb, ctx, {
              onProviderError: (moduleId, errorName) =>
                // Sanitized: moduleId + error NAME only — never message/stack/payload.
                server.log.warn({ moduleId, errorName }, "focus-signal provider failed (soft)")
            })
        );
      },
```

NOTE on isolation/nesting: both `resolveActiveModules(actorUserId)` and this aggregator's `withDataContext` are invoked from the tasks focus route BEFORE its own `withDataContext` for the task query (the route resolves signals first, then reads tasks — see Step 6). So there is never a `withDataContext` nested inside another, matching the existing AI route-surface pattern (`packages/ai/src/routes.ts`).

- [ ] **Step 8: Add an integration assertion for the consumer cap**

Append to `tests/integration/wellness.test.ts`:

```ts
import { TasksRepository } from "@jarv1s/tasks";
import { registerTasksRoutes } from "@jarv1s/tasks";

describe("focus consumer down-weights when readiness is low (generic)", () => {
  it("caps the focus list when the injected aggregate readiness is low", async () => {
    // Seed many high-priority overdue tasks for the actor.
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const repo = new TasksRepository();
      const past = new Date(Date.now() - 86_400_000);
      for (let i = 0; i < 6; i++) {
        await repo.create(db, {
          title: `urgent-${i.toString()}`,
          status: "todo",
          priority: 5,
          dueAt: past
        });
      }
    });

    const app = Fastify();
    registerTasksRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:focus" }),
      dataContext,
      boss: undefined as never,
      focusSignals: async () => [
        { moduleId: "wellness", readiness: 0.1, summary: "Energy trended low." }
      ]
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/tasks/focus" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tasks.length).toBeLessThanOrEqual(3);
      expect(body.signals[0].readiness).toBe(0.1);
    } finally {
      await app.close();
    }
  });
});

describe("focus providers honor per-user enablement (Phase-2 seam is LANDED)", () => {
  it("focusSignalProvidersFor(active) excludes a module the actor disabled", async () => {
    const { createActiveModulesResolver, focusSignalProvidersFor, getBuiltInModuleManifests } =
      await import("@jarv1s/module-registry");
    const { SettingsRepository } = await import("@jarv1s/settings");

    const resolveActive = createActiveModulesResolver({
      dataContext,
      manifests: getBuiltInModuleManifests()
    });

    // Before disabling: wellness is active and contributes a provider.
    const before = focusSignalProvidersFor(await resolveActive(userId));
    expect(before.some((p) => p.moduleId === "wellness")).toBe(true);

    // Disable wellness for this actor via the settings deny-list (the seam's own writer).
    // setUserModuleDisabled writes the deny row for input.actorUserId (the acting user).
    await dataContext.withDataContext(ctx(userId), (db) =>
      new SettingsRepository().setUserModuleDisabled(db, {
        moduleId: "wellness",
        disabled: true,
        actorUserId: userId,
        requestId: "req:wellness-test"
      })
    );

    const after = focusSignalProvidersFor(await resolveActive(userId));
    expect(after.some((p) => p.moduleId === "wellness")).toBe(false);

    // Re-enable so later tests see wellness active again (clean state).
    await dataContext.withDataContext(ctx(userId), (db) =>
      new SettingsRepository().setUserModuleDisabled(db, {
        moduleId: "wellness",
        disabled: false,
        actorUserId: userId,
        requestId: "req:wellness-test"
      })
    );
  });
});
```

NOTE: `setUserModuleDisabled(scopedDb, { moduleId, disabled, actorUserId, requestId })` is the
deny-list writer that `/api/me/modules/:id` PATCH calls; verify the import path/shape against
`packages/settings/src/repository.ts` and adjust this TEST call site only — never change the
settings package. The assertion that matters: a per-user-disabled module yields no focus provider.

NOTE: `boss` is required by `TasksRoutesDependencies` but the focus route does not use it — passing `undefined as never` is acceptable for this focused test since `/api/tasks/focus` never touches `boss`. If `TasksRepository.create` signature differs, adjust the call site against `packages/tasks/src/repository.ts` (test-only).

- [ ] **Step 9: Run the test + targeted typechecks**

Run: `vitest run tests/integration/wellness.test.ts && pnpm --filter @jarv1s/tasks typecheck && pnpm --filter @jarv1s/module-registry typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/module-sdk/src/index.ts packages/wellness/src/focus-signal.ts packages/wellness/src/manifest.ts packages/wellness/src/index.ts packages/shared/src/tasks-api.ts packages/tasks/src/routes.ts packages/module-registry/src/index.ts apps/api/src/server.ts tests/integration/wellness.test.ts
git commit -m "feat(wellness): generic FocusSignal contribution point + readiness-capped focus (Stage 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Stage 5 — Web UI (mockup first, then components)

### Task 13: EARLY mockup of the FeelingsWheel modal flow (for morning review)

This is intentionally early in the web stage so Ben has a taste artifact to review in the morning. It is a static HTML file — no build step, no React.

**Files:**

- Create: `docs/brand/mockups/feelings-wheel-modal.html`

- [ ] **Step 1: Create the static mockup**

Create `docs/brand/mockups/feelings-wheel-modal.html` — a static, NON-SHIPPING taste artifact for Ben's morning review (the SHIPPED React UI in Task 14/16 is intentionally basic plain controls; this mockup only shows the desired future direction). It shows the four flow states side by side: (1) wheel + body-sensations checklist, (2) "I don't know what I feel" → embedded chat, (3) details form (intensity, energy, note), (4) Save / Save & discuss buttons. Use inline CSS; render the six cores as colored buttons and a sample secondary/tertiary drill-in. Concrete starter content:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wellness — Feelings Wheel modal flow (mockup)</title>
    <style>
      :root {
        --bg: #0f1115;
        --panel: #1a1d24;
        --ink: #e8eaf0;
        --muted: #9aa0ad;
        --accent: #7c9cff;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font:
          15px/1.5 system-ui,
          sans-serif;
      }
      h1 {
        font-size: 18px;
        padding: 20px 24px 0;
      }
      p.sub {
        color: var(--muted);
        padding: 0 24px;
        margin-top: 4px;
      }
      .flow {
        display: grid;
        grid-template-columns: repeat(2, minmax(320px, 1fr));
        gap: 20px;
        padding: 24px;
      }
      .card {
        background: var(--panel);
        border: 1px solid #262a33;
        border-radius: 14px;
        padding: 18px;
      }
      .card h2 {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
        margin: 0 0 12px;
      }
      .wheel {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      .core {
        border: none;
        border-radius: 10px;
        padding: 14px 8px;
        color: #10131a;
        font-weight: 600;
        cursor: pointer;
      }
      .mad {
        background: #ff8b8b;
      }
      .sad {
        background: #8bb6ff;
      }
      .scared {
        background: #c79bff;
      }
      .joyful {
        background: #ffe08b;
      }
      .powerful {
        background: #ffb86b;
      }
      .peaceful {
        background: #8bf0c4;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .chip {
        border: 1px solid #333;
        border-radius: 999px;
        padding: 6px 12px;
        color: var(--ink);
        background: #12151c;
        cursor: pointer;
      }
      .chat {
        background: #12151c;
        border-radius: 10px;
        padding: 12px;
        min-height: 120px;
      }
      .bubble {
        background: #222633;
        border-radius: 10px;
        padding: 8px 12px;
        margin: 6px 0;
        max-width: 80%;
      }
      .bubble.me {
        background: var(--accent);
        color: #0b0e14;
        margin-left: auto;
      }
      label {
        display: block;
        margin: 12px 0 4px;
        color: var(--muted);
        font-size: 13px;
      }
      input,
      textarea,
      select {
        width: 100%;
        box-sizing: border-box;
        background: #12151c;
        color: var(--ink);
        border: 1px solid #2a2f3a;
        border-radius: 8px;
        padding: 8px;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 16px;
      }
      .btn {
        border: none;
        border-radius: 9px;
        padding: 10px 16px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn.primary {
        background: var(--accent);
        color: #0b0e14;
      }
      .btn.ghost {
        background: transparent;
        color: var(--ink);
        border: 1px solid #2a2f3a;
      }
    </style>
  </head>
  <body>
    <h1>Wellness — Feelings check-in modal flow</h1>
    <p class="sub">
      Static, NON-SHIPPING taste artifact for Ben's morning review only. The shipped React UI in
      this slice is intentionally BASIC (plain buttons/chips/selects, no colored wheel) — the
      polished feelings-wheel is deferred to a dedicated Ben UI session.
    </p>
    <div class="flow">
      <section class="card" aria-label="Step 1">
        <h2>1 · Pick a feeling + body check</h2>
        <div class="wheel">
          <button class="core mad">Mad</button>
          <button class="core sad">Sad</button>
          <button class="core scared">Scared</button>
          <button class="core joyful">Joyful</button>
          <button class="core powerful">Powerful</button>
          <button class="core peaceful">Peaceful</button>
        </div>
        <p style="color:var(--muted);margin:14px 0 4px">Scared → Anxious → Overwhelmed</p>
        <div class="chips" aria-label="Body sensations">
          <span class="chip">Tight chest</span><span class="chip">Racing heart</span>
          <span class="chip">Lump in throat</span><span class="chip">Clenched jaw</span>
          <span class="chip">Shallow breathing</span>
        </div>
      </section>
      <section class="card" aria-label="Step 2">
        <h2>2 · "I don't know what I feel" → talk to Jarvis</h2>
        <div class="chat">
          <div class="bubble me">I'm not sure what I'm feeling right now.</div>
          <div class="bubble">Let's figure it out. What happened just before this?</div>
          <div class="bubble me">A deadline got moved up.</div>
          <div class="bubble">That sounds like it could be anxiety. Does "overwhelmed" fit?</div>
        </div>
      </section>
      <section class="card" aria-label="Step 3">
        <h2>3 · Details</h2>
        <label>Intensity (1–5)</label>
        <select>
          <option>4</option>
        </select>
        <label>Note / context</label>
        <textarea rows="3">Deadline moved up; chest is tight.</textarea>
      </section>
      <section class="card" aria-label="Step 4">
        <h2>4 · Save</h2>
        <p style="color:var(--muted)">
          Save the check-in, or save and bring it into a Jarvis conversation.
        </p>
        <div class="actions">
          <button class="btn ghost">Save</button>
          <button class="btn primary">Save &amp; discuss</button>
        </div>
      </section>
    </div>
  </body>
</html>
```

- [ ] **Step 2: Verify it opens (no build needed)**

Run: `test -f docs/brand/mockups/feelings-wheel-modal.html && echo OK`
Expected: `OK`. (Optionally open in a browser to eyeball; not required for the gate.)

- [ ] **Step 3: Commit**

```bash
git add docs/brand/mockups/feelings-wheel-modal.html
git commit -m "docs(wellness): static FeelingsWheel modal-flow mockup for review (Stage 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 14: Assert the shared taxonomy + a BASIC feelings picker (plain controls, no colored wheel)

The taxonomy + body-sensations + `isValidFeelingPath` now live in `@jarv1s/shared` (added in Task 4) so the browser bundle never imports the server-only `@jarv1s/wellness` index (Codex R1). This task (a) asserts that shared data/helper and (b) builds a deliberately BASIC picker — plain `<select>` for core/secondary/tertiary plus chip buttons — NOT a polished colored wheel. The polished feelings-wheel is deferred to a dedicated Ben UI session (per the slice's "UI basic/functional" constraint). No new `packages/wellness` taxonomy files are created.

**Files:**

- Create: `apps/web/src/wellness/feelings-picker.tsx` (basic, plain controls; imports taxonomy from `@jarv1s/shared`)
- Test: `tests/integration/wellness.test.ts` (assert shared taxonomy + path validation) + web typecheck

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/wellness.test.ts` (import from `@jarv1s/shared`, NOT `@jarv1s/wellness`):

```ts
import { FEELINGS_WHEEL, BODY_SENSATIONS, isValidFeelingPath } from "@jarv1s/shared";

describe("feelings taxonomy (browser-safe, in @jarv1s/shared)", () => {
  it("has the six cores, each with secondary→tertiary leaves", () => {
    expect(FEELINGS_WHEEL.map((c) => c.core)).toEqual([
      "mad",
      "sad",
      "scared",
      "joyful",
      "powerful",
      "peaceful"
    ]);
    for (const core of FEELINGS_WHEEL) {
      expect(core.secondary.length).toBeGreaterThan(0);
      for (const sec of core.secondary) {
        expect(typeof sec.name).toBe("string");
        expect(Array.isArray(sec.tertiary)).toBe(true);
      }
    }
  });

  it("body-sensations is a non-empty curated list", () => {
    expect(BODY_SENSATIONS.length).toBeGreaterThanOrEqual(8);
    expect(BODY_SENSATIONS).toContain("Tight chest");
  });

  it("isValidFeelingPath accepts valid paths and rejects mismatches", () => {
    expect(isValidFeelingPath("scared")).toBe(true);
    expect(isValidFeelingPath("scared", "anxious")).toBe(true);
    expect(isValidFeelingPath("scared", "anxious", "overwhelmed")).toBe(true);
    expect(isValidFeelingPath("scared", "anxious", "not-a-leaf")).toBe(false);
    expect(isValidFeelingPath("scared", "not-a-secondary")).toBe(false);
    // a tertiary without its secondary is invalid
    expect(isValidFeelingPath("scared", null, "overwhelmed")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS already (the taxonomy + `isValidFeelingPath` were added to `@jarv1s/shared` in Task 4). If it fails, you skipped the Task-4 taxonomy block — add it there, never duplicate it into `@jarv1s/wellness`.

- [ ] **Step 3: Write the BASIC picker (plain controls — NO colored wheel)**

Create `apps/web/src/wellness/feelings-picker.tsx`:

```tsx
import { FEELINGS_WHEEL, WELLNESS_FEELING_CORES } from "@jarv1s/shared";
import type { WellnessFeelingCore } from "@jarv1s/shared";

export interface FeelingsSelection {
  readonly core: WellnessFeelingCore;
  readonly secondary: string | null;
  readonly tertiary: string | null;
}

interface FeelingsPickerProps {
  readonly value: FeelingsSelection | null;
  readonly onChange: (selection: FeelingsSelection) => void;
}

/**
 * BASIC, functional feelings picker — three dependent <select>s (core → secondary →
 * tertiary). Deliberately NOT a polished colored wheel (deferred to a Ben UI session). Data
 * comes from the browser-safe @jarv1s/shared taxonomy, so restyling never touches logic.
 */
export function FeelingsPicker(props: FeelingsPickerProps) {
  const coreNode = props.value
    ? (FEELINGS_WHEEL.find((c) => c.core === props.value!.core) ?? null)
    : null;
  const secNode =
    coreNode && props.value?.secondary
      ? (coreNode.secondary.find((s) => s.name === props.value!.secondary) ?? null)
      : null;

  return (
    <div className="feelings-picker">
      <label className="field-label">
        Feeling
        <select
          value={props.value?.core ?? ""}
          onChange={(e) =>
            props.onChange({
              core: e.target.value as WellnessFeelingCore,
              secondary: null,
              tertiary: null
            })
          }
          aria-label="Core feeling"
        >
          <option value="" disabled>
            Choose…
          </option>
          {WELLNESS_FEELING_CORES.map((core) => (
            <option key={core} value={core}>
              {capitalize(core)}
            </option>
          ))}
        </select>
      </label>

      {coreNode ? (
        <label className="field-label">
          More specific (optional)
          <select
            value={props.value?.secondary ?? ""}
            onChange={(e) =>
              props.onChange({
                core: coreNode.core,
                secondary: e.target.value || null,
                tertiary: null
              })
            }
            aria-label="Secondary feeling"
          >
            <option value="">—</option>
            {coreNode.secondary.map((sec) => (
              <option key={sec.name} value={sec.name}>
                {capitalize(sec.name)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {secNode ? (
        <label className="field-label">
          Even more specific (optional)
          <select
            value={props.value?.tertiary ?? ""}
            onChange={(e) =>
              props.onChange({
                core: coreNode!.core,
                secondary: secNode.name,
                tertiary: e.target.value || null
              })
            }
            aria-label="Tertiary feeling"
          >
            <option value="">—</option>
            {secNode.tertiary.map((t) => (
              <option key={t} value={t}>
                {capitalize(t)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
```

- [ ] **Step 4: Run the test + web typecheck**

Run: `vitest run tests/integration/wellness.test.ts && pnpm --filter @jarv1s/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/wellness/feelings-picker.tsx tests/integration/wellness.test.ts
git commit -m "feat(wellness): assert shared taxonomy + basic feelings picker (plain selects, no colored wheel) (Stage 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 15: Typed web client + query keys + `openChatWith` shell helper

**Files:**

- Modify: `apps/web/src/api/query-keys.ts` (add `wellness` keys)
- Modify: `apps/web/src/api/client.ts` (add wellness client fns)
- Modify: `apps/web/src/shell/app-shell.tsx` (lift an `openChatWith(prompt)` helper + a context provider)
- Create: `apps/web/src/shell/chat-controls-context.ts` (context for `openChatWith`)
- Test: web typecheck (this is a wiring task; behavior is covered by the Playwright/web smoke in Task 18)

- [ ] **Step 1: Add query keys**

In `apps/web/src/api/query-keys.ts`, add a `wellness` block after `tasks`:

```ts
  ,
  wellness: {
    checkins: ["wellness", "checkins"] as const,
    medications: ["wellness", "medications"] as const,
    schedule: (date: string) => ["wellness", "schedule", date] as const
  }
```

(Adjust the preceding `tasks` block to end with a comma so the object stays valid.)

- [ ] **Step 2: Add typed client functions**

In `apps/web/src/api/client.ts`, add (near the other module client fns; import the DTO/request types from `@jarv1s/shared`):

```ts
export async function listWellnessCheckins(): Promise<ListCheckinsResponse> {
  return requestJson<ListCheckinsResponse>("/api/wellness/checkins?limit=50");
}

export async function createWellnessCheckin(
  input: CreateCheckinRequest
): Promise<CreateCheckinResponse> {
  return requestJson<CreateCheckinResponse>("/api/wellness/checkins", {
    method: "POST",
    body: input
  });
}

export async function listMedications(): Promise<ListMedicationsResponse> {
  return requestJson<ListMedicationsResponse>("/api/wellness/medications");
}

export async function createMedication(
  input: CreateMedicationRequest
): Promise<MedicationResponse> {
  return requestJson<MedicationResponse>("/api/wellness/medications", {
    method: "POST",
    body: input
  });
}

export async function updateMedication(
  id: string,
  input: UpdateMedicationRequest
): Promise<MedicationResponse> {
  return requestJson<MedicationResponse>(`/api/wellness/medications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function getMedicationSchedule(date: string): Promise<MedicationScheduleResponse> {
  return requestJson<MedicationScheduleResponse>(
    `/api/wellness/medications/schedule?date=${encodeURIComponent(date)}`
  );
}

export async function logMedicationDose(
  medicationId: string,
  input: CreateMedicationLogRequest
): Promise<CreateMedicationLogResponse> {
  return requestJson<CreateMedicationLogResponse>(
    `/api/wellness/medications/${encodeURIComponent(medicationId)}/logs`,
    { method: "POST", body: input }
  );
}
```

Add the types to the existing `@jarv1s/shared` import in `client.ts`:

```ts
import type {
  CreateCheckinRequest,
  CreateCheckinResponse,
  CreateMedicationLogRequest,
  CreateMedicationLogResponse,
  CreateMedicationRequest,
  ListCheckinsResponse,
  ListMedicationsResponse,
  MedicationResponse,
  MedicationScheduleResponse,
  UpdateMedicationRequest
} from "@jarv1s/shared";
```

(If `client.ts` already has a single grouped `import type { ... } from "@jarv1s/shared"`, merge these names into it rather than adding a second import.)

- [ ] **Step 3: Add the chat-controls context + `openChatWith` shell helper**

Create `apps/web/src/shell/chat-controls-context.ts`:

```ts
import { createContext, useContext } from "react";

export interface ChatControls {
  /** Open the chat drawer and send `prompt` as a turn. */
  readonly openChatWith: (prompt: string) => void;
}

const ChatControlsContext = createContext<ChatControls | null>(null);

export const ChatControlsProvider = ChatControlsContext.Provider;

export function useChatControls(): ChatControls {
  const ctx = useContext(ChatControlsContext);
  if (!ctx) {
    throw new Error("useChatControls must be used within ChatControlsProvider");
  }
  return ctx;
}
```

In `apps/web/src/shell/app-shell.tsx`, import the provider + `sendChatTurn`:

```ts
import { listNotifications, sendChatTurn, signOut } from "../api/client";
import { ChatControlsProvider } from "./chat-controls-context";
import { useCallback } from "react";
```

Inside `AppShell`, add the helper (after `const [chatOpen, setChatOpen] = useState(false);`):

```ts
const openChatWith = useCallback((prompt: string) => {
  setChatOpen(true);
  void sendChatTurn(prompt);
}, []);
```

Wrap the returned tree's `<main className="content-surface">{props.children}</main>` so the provider spans the children:

```tsx
<main className="content-surface">
  <ChatControlsProvider value={{ openChatWith }}>{props.children}</ChatControlsProvider>
</main>
```

- [ ] **Step 4: Web typecheck**

Run: `pnpm --filter @jarv1s/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/query-keys.ts apps/web/src/api/client.ts apps/web/src/shell/app-shell.tsx apps/web/src/shell/chat-controls-context.ts
git commit -m "feat(wellness): web client fns, query keys, openChatWith shell seam (Stage 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 16: Feelings check-in modal (`feelings-checkin-modal.tsx`)

**Files:**

- Create: `apps/web/src/wellness/feelings-checkin-modal.tsx`
- Test: web typecheck + the Playwright smoke (Task 18)

The modal composes the BASIC `FeelingsPicker` (plain selects), the body-sensations checklist, an embedded Jarvis chat for "I don't know," a details form (intensity + energy + note), and Save / Save & discuss. The embedded chat reuses `useChatStream` (subscribes to the live transcript) and `sendChatTurn` (sends a turn) — a thin reuse of the chat-drawer machinery, NOT a second engine.

- [ ] **Step 1: Write the component**

Create `apps/web/src/wellness/feelings-checkin-modal.tsx`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { BODY_SENSATIONS } from "@jarv1s/shared";
import type { CreateCheckinRequest } from "@jarv1s/shared";

import { createWellnessCheckin, sendChatTurn } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useChatStream } from "../chat/use-chat-stream";
import { useChatControls } from "../shell/chat-controls-context";
import { FeelingsPicker, type FeelingsSelection } from "./feelings-picker";

interface FeelingsCheckinModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function FeelingsCheckinModal(props: FeelingsCheckinModalProps) {
  const queryClient = useQueryClient();
  const { openChatWith } = useChatControls();
  const [selection, setSelection] = useState<FeelingsSelection | null>(null);
  const [sensations, setSensations] = useState<string[]>([]);
  const [intensity, setIntensity] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [assistInput, setAssistInput] = useState("");
  const { records } = useChatStream();

  const createMutation = useMutation({
    mutationFn: (input: CreateCheckinRequest) => createWellnessCheckin(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.wellness.checkins });
    }
  });

  if (!props.open) return null;

  function buildRequest(): CreateCheckinRequest | null {
    if (!selection) return null;
    return {
      feelingCore: selection.core,
      feelingSecondary: selection.secondary,
      feelingTertiary: selection.tertiary,
      sensations,
      intensity,
      energy,
      note: note.trim() ? note.trim() : null,
      identifiedVia: assisting ? "assisted" : "wheel"
    };
  }

  async function handleSave(discuss: boolean) {
    const request = buildRequest();
    if (!request) return;
    await createMutation.mutateAsync(request);
    if (discuss) {
      const summary = `I just logged feeling ${request.feelingTertiary ?? request.feelingSecondary ?? request.feelingCore}${
        request.intensity ? ` (intensity ${request.intensity.toString()})` : ""
      }${sensations.length ? `, with ${sensations.join(", ").toLowerCase()}` : ""}. Help me think through it.`;
      openChatWith(summary);
    }
    props.onClose();
  }

  function toggleSensation(name: string) {
    setSensations((current) =>
      current.includes(name) ? current.filter((s) => s !== name) : [...current, name]
    );
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Log how you feel">
      <div className="modal-panel wellness-checkin-modal">
        <header className="modal-header">
          <h2>How are you feeling?</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>

        <FeelingsPicker value={selection} onChange={setSelection} />

        <button
          type="button"
          className="ghost-button assisted-toggle"
          onClick={() => setAssisting((v) => !v)}
        >
          {assisting ? "Pick on the wheel instead" : "I don't know what I feel — talk it through"}
        </button>

        {assisting ? (
          <div className="assisted-chat">
            <div className="assisted-transcript">
              {records.slice(-6).map((r, i) => (
                <p key={i} className={`assisted-line ${r.kind}`}>
                  {r.text}
                </p>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (assistInput.trim()) {
                  void sendChatTurn(assistInput.trim());
                  setAssistInput("");
                }
              }}
            >
              <input
                value={assistInput}
                onChange={(e) => setAssistInput(e.target.value)}
                placeholder="Tell Jarvis what's going on..."
                aria-label="Message Jarvis"
              />
            </form>
          </div>
        ) : null}

        <fieldset className="sensations-field">
          <legend>Body check (optional)</legend>
          <div className="chips">
            {BODY_SENSATIONS.map((name) => (
              <button
                key={name}
                type="button"
                className={`feelings-chip ${sensations.includes(name) ? "active" : ""}`}
                onClick={() => toggleSensation(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="field-label">
          Intensity (how strong, 1–5)
          <select
            value={intensity ?? ""}
            onChange={(e) => setIntensity(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label className="field-label">
          Energy (depleted 1 → energized 5)
          <select
            value={energy ?? ""}
            onChange={(e) => setEnergy(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label className="field-label">
          Note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </label>

        <footer className="modal-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={!selection || createMutation.isPending}
            onClick={() => void handleSave(false)}
          >
            Save
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!selection || createMutation.isPending}
            onClick={() => void handleSave(true)}
          >
            Save &amp; discuss
          </button>
        </footer>
        {createMutation.error ? (
          <p className="form-error">{readError(createMutation.error)}</p>
        ) : null}
      </div>
    </div>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save check-in";
}
```

- [ ] **Step 2: Web typecheck**

Run: `pnpm --filter @jarv1s/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/wellness/feelings-checkin-modal.tsx
git commit -m "feat(wellness): feelings check-in modal (wheel, sensations, assisted chat, Save & discuss) (Stage 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 17: Medications views (`medications-view.tsx`, `medication-schedule.tsx`)

**Files:**

- Create: `apps/web/src/wellness/medications-view.tsx`
- Create: `apps/web/src/wellness/medication-schedule.tsx`
- Test: web typecheck + Playwright smoke (Task 18)

- [ ] **Step 1: Write the schedule view**

Create `apps/web/src/wellness/medication-schedule.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getMedicationSchedule, logMedicationDose } from "../api/client";
import { queryKeys } from "../api/query-keys";

function todayIso(): string {
  // LOCAL civil date (NOT UTC) — the server treats this as the civil day to schedule.
  // Using toISOString() here would roll to the wrong day near midnight (Codex R1).
  const now = new Date();
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function MedicationSchedule() {
  const queryClient = useQueryClient();
  const date = todayIso();
  const scheduleQuery = useQuery({
    queryKey: queryKeys.wellness.schedule(date),
    queryFn: () => getMedicationSchedule(date)
  });

  const logMutation = useMutation({
    mutationFn: (input: {
      medicationId: string;
      status: "taken" | "skipped" | "prn";
      scheduledFor: string | null;
      prnReason?: string;
    }) =>
      logMedicationDose(input.medicationId, {
        status: input.status,
        scheduledFor: input.scheduledFor,
        prnReason: input.prnReason ?? null
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.wellness.schedule(date) });
    }
  });

  if (scheduleQuery.isLoading) return <p>Loading schedule…</p>;
  const slots = scheduleQuery.data?.slots ?? [];

  return (
    <section className="medication-schedule" aria-label="Today's medications">
      <h3>Today</h3>
      {slots.length === 0 ? <p className="muted">No medications scheduled.</p> : null}
      <ul className="schedule-list">
        {slots.map((slot, i) => (
          <li
            key={`${slot.medicationId}-${i.toString()}`}
            className={`schedule-slot ${slot.status}`}
          >
            <span className="slot-name">{slot.name}</span>
            <span className="slot-time">
              {slot.asNeeded ? "As needed" : (slot.scheduledFor?.slice(11, 16) ?? "")}
            </span>
            <span className="slot-actions">
              {slot.asNeeded ? (
                <button
                  type="button"
                  onClick={() => {
                    const reason = window.prompt("Reason for this PRN dose?") ?? "";
                    if (reason.trim()) {
                      logMutation.mutate({
                        medicationId: slot.medicationId,
                        status: "prn",
                        scheduledFor: null,
                        prnReason: reason.trim()
                      });
                    }
                  }}
                >
                  Log as needed
                </button>
              ) : slot.status === "pending" ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      logMutation.mutate({
                        medicationId: slot.medicationId,
                        status: "taken",
                        scheduledFor: slot.scheduledFor
                      })
                    }
                  >
                    Taken
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      logMutation.mutate({
                        medicationId: slot.medicationId,
                        status: "skipped",
                        scheduledFor: slot.scheduledFor
                      })
                    }
                  >
                    Skip
                  </button>
                </>
              ) : (
                <span className="slot-status">{slot.status}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Create `apps/web/src/wellness/medications-view.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import type { CreateMedicationRequest, MedicationFrequencyTypeApi } from "@jarv1s/shared";

import { createMedication, listMedications, updateMedication } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { MedicationSchedule } from "./medication-schedule";

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: MedicationFrequencyTypeApi; label: string }> = [
  { value: "once_daily", label: "Once daily" },
  { value: "times_per_day", label: "N times per day" },
  { value: "specific_weekdays", label: "Specific weekdays" },
  { value: "every_n_hours", label: "Every N hours" },
  { value: "as_needed", label: "As needed (PRN)" },
  { value: "cyclical", label: "Cyclical" }
];

export function MedicationsView() {
  const queryClient = useQueryClient();
  const medsQuery = useQuery({
    queryKey: queryKeys.wellness.medications,
    queryFn: listMedications
  });
  const [name, setName] = useState("");
  const [dosage, setDosage] = useState("");
  const [frequencyType, setFrequencyType] = useState<MedicationFrequencyTypeApi>("once_daily");
  const [scheduleTimes, setScheduleTimes] = useState("08:00");

  const createMutation = useMutation({
    mutationFn: (input: CreateMedicationRequest) => createMedication(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.wellness.medications });
      setName("");
      setDosage("");
    }
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      updateMedication(input.id, { active: input.active }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.wellness.medications });
    }
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const times = scheduleTimes
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    createMutation.mutate({
      name: name.trim(),
      dosage: dosage.trim() ? dosage.trim() : null,
      frequencyType,
      scheduleTimes: frequencyType === "as_needed" ? null : times,
      timesPerDay: frequencyType === "times_per_day" ? times.length || 1 : null
    });
  }

  return (
    <div className="medications-view">
      <MedicationSchedule />

      <section aria-label="Medications">
        <h3>Medications</h3>
        <form className="medication-form" onSubmit={submit}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Sertraline)"
            aria-label="Medication name"
          />
          <input
            value={dosage}
            onChange={(e) => setDosage(e.target.value)}
            placeholder="Dosage (e.g. 50 mg)"
            aria-label="Dosage"
          />
          <select
            value={frequencyType}
            onChange={(e) => setFrequencyType(e.target.value as MedicationFrequencyTypeApi)}
            aria-label="Frequency"
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {frequencyType !== "as_needed" ? (
            <input
              value={scheduleTimes}
              onChange={(e) => setScheduleTimes(e.target.value)}
              placeholder="Times (e.g. 08:00, 20:00)"
              aria-label="Schedule times"
            />
          ) : null}
          <button type="submit" className="primary-button" disabled={createMutation.isPending}>
            Add
          </button>
        </form>

        <ul className="medication-list">
          {(medsQuery.data?.medications ?? []).map((med) => (
            <li key={med.id} className={`medication-item ${med.active ? "" : "inactive"}`}>
              <span>
                {med.name}
                {med.dosage ? ` · ${med.dosage}` : ""}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => toggleActiveMutation.mutate({ id: med.id, active: !med.active })}
              >
                {med.active ? "Deactivate" : "Reactivate"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Web typecheck**

Run: `pnpm --filter @jarv1s/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/wellness/medications-view.tsx apps/web/src/wellness/medication-schedule.tsx
git commit -m "feat(wellness): medications view + today's schedule with dose logging (Stage 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 18: Wellness page + app.tsx route caveat + nav-visibility-when-disabled + Playwright smoke

**Files:**

- Create: `apps/web/src/wellness/wellness-page.tsx`
- Modify: `apps/web/src/app.tsx` (the `/wellness` `<Route>` caveat + fetch `/api/me/modules` for active flags and pass them to `AppShell`)
- Modify: `apps/web/src/api/client.ts` (add `getMyModules()` — `/api/me/modules`, already-shipped endpoint)
- Modify: `apps/web/src/api/query-keys.ts` (add `myModules` key)
- Modify: `apps/web/src/shell/app-shell.tsx` (add `HeartPulse` to `iconMap`; accept `disabledModuleIds` and hide their nav)
- Create: `tests/e2e/wellness.spec.ts` (Playwright smoke; mirror existing e2e mock pattern)
- Test: web typecheck + `pnpm test:e2e`

NOTE (grounding): the Phase-2 enablement seam is ALREADY landed — `/api/me/modules` returns
`MyModuleDto[]` with an `active` flag (`packages/shared/src/platform-api.ts`), and the route
guard already 404s a disabled module's routes. `MyModuleDto` carries enablement flags but NOT
`navigation`; the nav entries still come from `/api/modules` (`ModuleDto.navigation`). So the
shell fetches BOTH and hides nav for any module the actor has disabled. Do NOT add `active` to
`ModuleDto` (that would duplicate the seam's source of truth).

- [ ] **Step 1: Write the wellness page**

Create `apps/web/src/wellness/wellness-page.tsx`:

```tsx
import { useState } from "react";

import { FeelingsCheckinModal } from "./feelings-checkin-modal";
import { MedicationsView } from "./medications-view";

type Tab = "feelings" | "medications";

export function WellnessPage() {
  const [tab, setTab] = useState<Tab>("feelings");
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <section className="page-stack" aria-labelledby="wellness-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Wellness</p>
          <h1 id="wellness-title">Wellness</h1>
        </div>
        <div className="segmented-control" role="group" aria-label="Wellness view">
          <button
            type="button"
            className={tab === "feelings" ? "active" : ""}
            onClick={() => setTab("feelings")}
          >
            Feelings
          </button>
          <button
            type="button"
            className={tab === "medications" ? "active" : ""}
            onClick={() => setTab("medications")}
          >
            Medications
          </button>
        </div>
      </div>

      {tab === "feelings" ? (
        <div className="wellness-feelings">
          <button type="button" className="primary-button" onClick={() => setModalOpen(true)}>
            Log how you feel
          </button>
          <FeelingsCheckinModal open={modalOpen} onClose={() => setModalOpen(false)} />
        </div>
      ) : (
        <MedicationsView />
      )}
    </section>
  );
}
```

- [ ] **Step 2: Add the app.tsx route (the documented caveat)**

In `apps/web/src/app.tsx`, import the page:

```ts
import { WellnessPage } from "./wellness/wellness-page";
```

Add the route inside `<Routes>` (after the `/briefings` route):

```tsx
<Route path="/wellness" element={<WellnessPage />} />
```

- [ ] **Step 3: Add the icon + hide nav for the actor's disabled modules (consuming the LANDED `/api/me/modules`)**

First, add the typed client + query key for the already-shipped endpoint.

In `apps/web/src/api/client.ts`, add (import `ListMyModulesResponse` from `@jarv1s/shared`):

```ts
export async function getMyModules(): Promise<ListMyModulesResponse> {
  return requestJson<ListMyModulesResponse>("/api/me/modules");
}
```

In `apps/web/src/api/query-keys.ts`, add `myModules: ["me", "modules"] as const,` next to the existing `modules` key.

In `apps/web/src/app.tsx`, fetch the per-actor module set and derive the disabled ids:

```ts
import { getModules, getMyModules } from "./api/client";
```

```ts
const myModulesQuery = useQuery({
  enabled: meQuery.isSuccess,
  queryKey: queryKeys.myModules,
  queryFn: () => getMyModules(),
  retry: false
});
const disabledModuleIds =
  myModulesQuery.data?.modules.filter((m) => !m.active).map((m) => m.id) ?? [];
```

Pass it to `AppShell`:

```tsx
      <AppShell
        me={meQuery.data}
        modules={modulesQuery.data?.modules ?? []}
        modulesLoading={modulesQuery.isLoading}
        disabledModuleIds={disabledModuleIds}
      >
```

In `apps/web/src/shell/app-shell.tsx`, add `HeartPulse` to the lucide import and the `iconMap`:

```ts
import {
  Bell,
  CalendarDays,
  CheckSquare,
  FileText,
  HeartPulse,
  Layers3,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Newspaper,
  Settings,
  UserCircle
} from "lucide-react";
```

```ts
  "heart-pulse": HeartPulse,
```

Add `disabledModuleIds` to `AppShellProps` and thread it into `readNavigation`:

```ts
  readonly disabledModuleIds?: readonly string[];
```

```ts
const navigation = useMemo(
  () => readNavigation(props.modules, props.disabledModuleIds ?? []),
  [props.modules, props.disabledModuleIds]
);
```

Update `readNavigation` to drop nav for any module the actor disabled. A module absent from
`disabledModuleIds` (the common case, incl. before any data loads) stays visible — only an
explicit disable hides it (fail-OPEN on missing data so the shell never blanks the nav):

```ts
function readNavigation(
  modules: readonly ModuleDto[],
  disabledModuleIds: readonly string[]
): ModuleNavigationEntryDto[] {
  const disabled = new Set(disabledModuleIds);
  return modules
    .filter((module) => !disabled.has(module.id))
    .flatMap((module) => module.navigation)
    .sort((left, right) => {
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;

      return leftOrder - rightOrder || left.label.localeCompare(right.label);
    });
}
```

This consumes the REAL seam: when the actor disables Wellness via `/api/me/modules/:id`,
`getMyModules()` returns `active:false` for it, its nav disappears, AND the route guard already
404s `/api/wellness/*` server-side. No `ModuleDto` change is needed.

- [ ] **Step 4: Write the Playwright smoke**

Inspect an existing e2e spec (e.g. `tests/e2e/` for the mock pattern — `tests/e2e/mock-*.ts`, especially `mock-modules.ts`) and mirror it. Create `tests/e2e/wellness.spec.ts` that: mocks `GET /api/modules` (nav entry), `GET /api/me/modules` (wellness active), `GET /api/wellness/checkins` (empty) and `POST /api/wellness/checkins` (201), navigates to `/wellness`, opens the modal, selects a core feeling via the picker `<select>`, clicks Save, and asserts the POST fired. Concrete skeleton (adapt selectors/mock helpers to the repo's existing e2e harness):

```ts
import { expect, test } from "@playwright/test";

test("wellness page renders and a check-in can be saved", async ({ page }) => {
  await page.route("**/api/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          {
            id: "wellness",
            name: "Wellness",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            navigation: [
              {
                id: "wellness",
                label: "Wellness",
                path: "/wellness",
                icon: "heart-pulse",
                order: 40
              }
            ],
            settings: []
          }
        ]
      }
    })
  );
  // The shell now also fetches /api/me/modules for active flags — mock it so wellness stays visible.
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          {
            id: "wellness",
            name: "Wellness",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true
          }
        ]
      }
    })
  );
  await page.route("**/api/wellness/checkins**", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        json: {
          checkin: {
            id: "c1",
            ownerUserId: "u1",
            checkedInAt: new Date().toISOString(),
            feelingCore: "joyful",
            feelingSecondary: null,
            feelingTertiary: null,
            wheelVersion: "willcox-1982",
            sensations: [],
            intensity: null,
            energy: null,
            note: null,
            identifiedVia: "wheel",
            createdAt: new Date().toISOString()
          }
        }
      });
    }
    return route.fulfill({ json: { checkins: [] } });
  });

  // Reuse the repo's existing auth/me mocks from tests/e2e/mock-*.ts as the other specs do.
  await page.goto("/wellness");
  await expect(page.getByRole("heading", { name: "Wellness" })).toBeVisible();
  await page.getByRole("button", { name: "Log how you feel" }).click();
  // The picker is a plain <select> (basic UI) — choose the core feeling by value.
  await page.getByLabel("Core feeling").selectOption("joyful");
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/wellness/checkins") && r.method() === "POST"),
    page.getByRole("button", { name: "Save", exact: true }).click()
  ]);
  expect(request.method()).toBe("POST");
});
```

If the existing e2e harness centralizes auth/me mocks (it does — see `tests/e2e/mock-*.ts`), import and apply them exactly as the other specs do so `/wellness` renders past the auth gate.

- [ ] **Step 5: Web typecheck + e2e**

Run: `pnpm --filter @jarv1s/web typecheck && pnpm build:web && pnpm test:e2e`
Expected: PASS. If the e2e harness requires a running dev server / specific fixtures, follow the pattern the other specs use (Playwright config handles the web server). If the smoke is flaky due to harness specifics, ensure the auth/me mocks match the other specs; the wellness-specific mocks above are correct.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/wellness/wellness-page.tsx apps/web/src/app.tsx apps/web/src/shell/app-shell.tsx apps/web/src/api/client.ts apps/web/src/api/query-keys.ts tests/e2e/wellness.spec.ts
git commit -m "feat(wellness): wellness page, app.tsx route, nav hidden for actor-disabled modules (via /api/me/modules), e2e smoke (Stage 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Stage 6 — Isolation assertions, self-review, and the final gate

### Task 19: Module-isolation assertions (tasks ⇄ wellness must not import each other)

**Files:**

- Test: `tests/integration/wellness.test.ts`

- [ ] **Step 1: Write the failing/guard test**

Append to `tests/integration/wellness.test.ts` (add `readFileSync` + path imports at the top of the file alongside existing imports):

```ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("module isolation: wellness ⇄ tasks", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it("@jarv1s/wellness package.json does NOT depend on @jarv1s/tasks", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "packages/wellness/package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@jarv1s/tasks");
  });

  it("@jarv1s/tasks package.json does NOT depend on @jarv1s/wellness", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/tasks/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@jarv1s/wellness");
  });

  it("no wellness source file imports @jarv1s/tasks", () => {
    const files = [
      "manifest.ts",
      "repository.ts",
      "routes.ts",
      "tools.ts",
      "focus-signal.ts",
      "recall-context.ts",
      "schedule.ts",
      "serialize.ts"
    ];
    for (const file of files) {
      const src = readFileSync(join(repoRoot, "packages/wellness/src", file), "utf8");
      expect(src.includes("@jarv1s/tasks")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test**

Run: `vitest run tests/integration/wellness.test.ts`
Expected: PASS (if any assertion fails, a forbidden cross-import was introduced — fix the source, never the assertion).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/wellness.test.ts
git commit -m "test(wellness): assert tasks ⇄ wellness module isolation (Stage 6)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 20: Self-Review (run yourself — do not dispatch a subagent)

Work through this checklist against the spec with fresh eyes. Fix anything inline; add a task if a spec requirement has no implementation.

- [ ] **Spec §-by-§ coverage** — confirm each maps to a landed task:
  - Component 1 (Feelings check-ins: data + REST + AI tool + modal) → Tasks 2, 4, 5, 7, 8, 14, 16, 18.
  - Component 2 (Medications: data + REST + AI tool + UI; reminder seam deferred) → Tasks 3, 4, 5, 6, 7, 8 (manifest `jobs[]` metadata-only, no worker), 17.
  - Component 3 (Active prioritization via ONE generic focus-signal point) → Task 12.
  - Component 4 (Briefings section via existing read-tool seam, zero briefings change) → Task 10.
  - Component 5 (Chat recall energy-trend fact, fallback path via memory public API) → Task 11.
  - Component 6 (Web app + app.tsx caveat + nav-visibility-when-disabled + mockup) → Tasks 13, 14, 15, 16, 17, 18.
  - Component 7 (Chat-drawer "copy a summary into a conversation" seam) → Task 15 (`openChatWith`) + Task 16 (Save & discuss).
  - Security/invariants: owner-only RLS ENABLE+FORCE, no share, no admin read (Tasks 2, 3); DataContextDb-only + `assertDataContextDb` first (Tasks 5, 8, 11, 12); AccessContext `{actorUserId, requestId}` only (everywhere); metadata-only deferred job (Task 8); provider-agnostic AI (no provider hardcoded — embedded chat reuses existing router via `sendChatTurn`); module SQL in `packages/wellness/sql/`, global-ordered, never edited (Tasks 2, 3); secrets/health content never in logs/payloads/prompts beyond the user's chosen summary + abstracted trend/readiness (Tasks 8, 11, 12); focus aggregator's `onProviderError` logs moduleId + error NAME only (Task 12).
  - Acceptance criteria 1–13: net-new package (Task 1); manifest flags (Task 1, 8); migrations + db types (Tasks 2, 3); check-in e2e (Tasks 5, 7, 16, 18); medications e2e (Tasks 5, 6, 7, 17); focus-signal point — active-filtered per actor (Task 12); briefings section (Task 10); chat recall (Task 11); core-change ledger (this Self-Review + Task 19); per-user disable — REAL NOW (Phase-2 seam landed): nav hidden via `/api/me/modules` + focus provider dropped + route guard 404 + Task 12 disable test; privacy posture (Tasks 2, 3, 8, 11, 12); mockup + component on branch (Tasks 13, 14); final gate (Task 21).

- [ ] **Core-change ledger audit** — run `git diff --name-only origin/phase2-portable-deploy...HEAD` and confirm the ONLY changed files outside `packages/wellness/`, `packages/shared/` (`wellness-api.ts` + `index.ts` + additive `tasks-api.ts`), `packages/db/src/types.ts`, `apps/web/src/wellness/`, `tests/`, `docs/`, and config (`tsconfig.json`, `package.json`, `pnpm-lock.yaml`) are: `packages/module-sdk/src/index.ts`, `packages/module-registry/src/index.ts`, `packages/tasks/src/routes.ts` (focus consumer), `apps/api/src/server.ts`, `apps/web/src/app.tsx`, `apps/web/src/shell/app-shell.tsx`, `apps/web/src/shell/chat-controls-context.ts`, `apps/web/src/api/{client,query-keys}.ts`. NOTE: `packages/tasks/src/manifest.ts` and `packages/shared/src/platform-api.ts` must NOT change (tasks manifest references `focusTasksRouteSchema`, updated in shared; per-user disable consumes the existing `MyModuleDto.active`, no new field). If any OTHER core file changed, justify or revert it.

- [ ] **Placeholder scan** — grep the diff for `TODO`, `TBD`, `FIXME`, `implement later`, `any /* `, and empty `{}` handlers. Expected: none in production source (the deferred reminder worker is intentionally absent — that is documented, not a placeholder).

```bash
git diff origin/phase2-portable-deploy...HEAD -- packages/wellness apps/web/src/wellness | grep -nE "TODO|TBD|FIXME|implement later" || echo "no placeholders"
```

- [ ] **Type consistency** — verify names match across tasks: `WellnessRepository` methods (`createCheckin`, `listCheckins`, `createMedication`, `listMedications`, `getMedication`, `updateMedication`, `logDose`, `listRecentLogs`, `listLogsForDate`); `computeSchedule`; `wellnessFocusSignal`; `aggregateFocusSignals`; `deriveEnergyTrend` / `WellnessRecallContributor.refreshEnergyTrendFact`; DTO field names (`feelingCore`, `frequencyType`, `scheduleTimes`, `prnReason`, `scheduledFor`) consistent between `wellness-api.ts`, `serialize.ts`, routes, and web. The focus response field is `signals` (DTO `FocusSignalDto` with `moduleId`/`readiness`/`summary`) everywhere.

- [ ] **Fix inline** any gap found; re-run `vitest run tests/integration/wellness.test.ts` after any fix.

### Task 21: Final verification gate

- [ ] **Step 1: Re-confirm migration numbers are still free immediately before the final push**

```bash
find packages -path '*/sql/*.sql' -printf '%f\n' | sort | tail -6
```

Expected: `0066_wellness_checkins.sql`, `0067_wellness_medications.sql`, `0068_wellness_medication_logs.sql` are the wellness files and no OTHER package also claims 0066–0068 (recall `0065_module_enablement.sql` is the Phase-2 seam already on the branch). If a collision appeared (another slice landed), rename the wellness migrations to the next free contiguous global prefixes, update `manifest.ts` `database.migrations`, `pnpm db:reset`, and re-run the suite before continuing.

- [ ] **Step 2: Run the full foundation gate**

```bash
pnpm verify:foundation
```

Expected: GREEN — `lint` (0 warnings), `format:check`, `check:file-size` (no source file >1000 lines; if `wellness-api.ts`, `routes.ts`, or a web file approaches the limit, decompose — e.g. split route handlers or DTO schemas — and re-run), `typecheck` (api + web), `test:unit`, `db:migrate` (idempotent), `test:integration` (includes `wellness.test.ts`).

- [ ] **Step 3: Run release-hardening**

```bash
pnpm audit:release-hardening
```

Expected: GREEN (owner-only RLS tables introduce no new secret-exposure or grant regressions).

- [ ] **Step 4: Run the e2e smoke**

```bash
pnpm build:web && pnpm test:e2e
```

Expected: GREEN (includes `tests/e2e/wellness.spec.ts`).

- [ ] **Step 5: Final commit (only if any Self-Review fixes were made and not yet committed)**

```bash
git add -- packages/wellness packages/shared packages/db packages/module-sdk packages/module-registry packages/tasks apps/api apps/web tests docs tsconfig.json package.json pnpm-lock.yaml
git commit -m "chore(wellness): self-review fixes + final gate green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

NOTE: Use the explicit path list above — NEVER `git add -A` / `git add .` (another session may share the tree).

---

## Deferred / out of scope (carried from the spec — do NOT build)

- Active medication reminders/notifications (the metadata-only queue + `registerWellnessJobWorkers` are designed; the worker is NOT registered until the Phase-3 native per-definition pg-boss cron + notifications module land).
- Structured dose quantity/unit, drug-interaction warnings, refill tracking, pharmacy/barcode integration.
- Sharing wellness data with another household user (deliberately owner-only; a caregiver view needs its own spec + RLS classification).
- Editing/curating the Feelings Wheel taxonomy (static reference data).
- Symptom/mood journaling beyond feelings check-ins; trends/analytics dashboards (the focus-signal seam is generic so future inputs can feed it).
- `defaultEnabled:false` (off-by-default) modules (Phase-2 store is deny-only).

## Phase-2 dependency note (per-user disable behavior) — SEAM IS LANDED; WIRED NOW

Per-user disable (acceptance criterion 10) is REAL on this branch — the Phase-2 module-enablement
seam (`docs/superpowers/specs/2026-06-12-p2-module-enablement-seam-docking-ports.md`) is already
**merged on `phase2-portable-deploy`**. This plan therefore wires Wellness to honor it NOW, not
later. When an actor disables Wellness via `PATCH /api/me/modules/wellness`:

- the async `resolveActiveModules(actorUserId)` drops the Wellness manifest for that actor;
- the route guard 404s `/api/wellness/*` (already implemented in `route-guard.ts`);
- the tool surface drops `wellness.*` (the AI surfaces already filter by `resolveActiveModules`);
- the focus aggregator skips Wellness's provider — because `server.ts` builds providers from
  `focusSignalProvidersFor(await resolveActiveModules(actorUserId))` (Task 12, Step 7);
- the web nav hides Wellness — because the shell reads `/api/me/modules` and filters by `active`
  (Task 18, Step 3).

Tests proving this live in Task 12 (`focusSignalProvidersFor(active)` excludes a disabled module)
and in the existing `tests/integration/route-guard.test.ts`. No deferral remains for criterion 10.
