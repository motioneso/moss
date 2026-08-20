# Structured State + Write-back (Slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `packages/structured-state` module — the three canonical agent-state record types (`commitments`, `entities`, `preferences`) with owner-or-share RLS, and a `VaultWriteBackService` that keeps a vault People-note's YAML frontmatter in sync with the corresponding `entities` DB row while never touching the human-authored prose body.

**Architecture:** `CommitmentsRepository`, `EntitiesRepository`, and `PreferencesRepository` are DataContextDb-only repositories with full owner-or-share RLS (sharing via the existing `app.shares` table). `VaultWriteBackService` takes a `VaultContext` + entity record, serializes fields as YAML frontmatter, reads the existing body, and writes `---\n<frontmatter>---\n<body>` — the single write path for machine-owned frontmatter. Re-indexing (calling `MemoryIngestPipeline`) is the caller's responsibility; `packages/structured-state` does not depend on `packages/memory`. Every record carries `provenance ∈ volunteered | inferred | confirmed`.

**Tech Stack:** Node.js TypeScript; Kysely raw SQL; Vitest integration tests (Postgres + temp vault required).

**Prerequisites:** Slice 2 (`packages/vault`) and Slice 3 (`packages/memory` / pgvector Postgres image) must be complete.

---

## File Structure

**Create:**

- `packages/structured-state/package.json`
- `packages/structured-state/tsconfig.json`
- `packages/structured-state/src/index.ts`
- `packages/structured-state/src/manifest.ts`
- `packages/structured-state/src/types.ts` — shared type aliases + enums
- `packages/structured-state/src/commitments-repository.ts`
- `packages/structured-state/src/entities-repository.ts`
- `packages/structured-state/src/preferences-repository.ts`
- `packages/structured-state/src/write-back.ts`
- `packages/structured-state/sql/0001_structured_state.sql`
- `tests/integration/structured-state.test.ts`

**Modify:**

- `packages/db/src/types.ts` — add `CommitmentsTable`, `EntitiesTable`, `PreferencesTable`, `JarvisDatabase` entries, and `Selectable` aliases
- `packages/module-registry/src/index.ts` — register structured-state module
- `packages/module-registry/package.json` — add `@jarv1s/structured-state` dependency
- `tsconfig.json` — add `@jarv1s/structured-state` path alias
- `vitest.config.ts` — add resolver alias
- `package.json` — add `test:structured-state` script

---

### Task 1: SQL schema + DB types

**Files:**

- Create: `packages/structured-state/sql/0001_structured_state.sql`
- Modify: `packages/db/src/types.ts`

- [ ] **Step 1: Create `packages/structured-state/sql/0001_structured_state.sql`**

```sql
-- Provenance tracks how Jarvis came to believe something.
CREATE TYPE IF NOT EXISTS app.provenance_kind AS ENUM
  ('volunteered', 'inferred', 'confirmed');

-- Commitments use a drift-aware lifecycle; recovery states are first-class.
CREATE TYPE IF NOT EXISTS app.commitment_status AS ENUM
  ('open', 'at_risk', 'slipped', 'done', 'renegotiated', 'dismissed');

CREATE TYPE IF NOT EXISTS app.commitment_source_kind AS ENUM
  ('manual', 'inferred', 'email', 'calendar');

-- Entity types supported in this slice.
CREATE TYPE IF NOT EXISTS app.entity_type AS ENUM
  ('person', 'organization', 'account');

-- ── Commitments ───────────────────────────────────────────────────────────────
-- Open loops: something Jarvis noticed the user is on the hook for.
-- Distinct from Tasks (user-chosen) — Jarvis infers or confirms these.

CREATE TABLE IF NOT EXISTS app.commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  counterparty text,
  due_at timestamptz,
  status app.commitment_status NOT NULL DEFAULT 'open',
  provenance app.provenance_kind NOT NULL,
  source_kind app.commitment_source_kind NOT NULL DEFAULT 'manual',
  source_ref text,
  surfaced_state text,
  life_area text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commitments_owner_idx ON app.commitments (owner_user_id);
CREATE INDEX IF NOT EXISTS commitments_status_idx ON app.commitments (owner_user_id, status);

ALTER TABLE app.commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.commitments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commitments_select ON app.commitments;
CREATE POLICY commitments_select ON app.commitments
  FOR SELECT TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('commitment', id, 'view')
  );

DROP POLICY IF EXISTS commitments_insert ON app.commitments;
CREATE POLICY commitments_insert ON app.commitments
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS commitments_update ON app.commitments;
CREATE POLICY commitments_update ON app.commitments
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS commitments_delete ON app.commitments;
CREATE POLICY commitments_delete ON app.commitments
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.commitments TO jarvis_app_runtime;

-- ── Entities ──────────────────────────────────────────────────────────────────
-- People, orgs, and accounts the agent knows about.
-- vault_note_path links the DB row to a People-note file for write-back.

CREATE TABLE IF NOT EXISTS app.entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  type app.entity_type NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  attributes jsonb NOT NULL DEFAULT '{}',
  provenance app.provenance_kind NOT NULL,
  vault_note_path text,
  connector_refs jsonb,
  life_area text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entities_owner_idx ON app.entities (owner_user_id);
CREATE INDEX IF NOT EXISTS entities_type_idx ON app.entities (owner_user_id, type);

ALTER TABLE app.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.entities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entities_select ON app.entities;
CREATE POLICY entities_select ON app.entities
  FOR SELECT TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('entity', id, 'view')
  );

DROP POLICY IF EXISTS entities_insert ON app.entities;
CREATE POLICY entities_insert ON app.entities
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS entities_update ON app.entities;
CREATE POLICY entities_update ON app.entities
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS entities_delete ON app.entities;
CREATE POLICY entities_delete ON app.entities
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.entities TO jarvis_app_runtime;

-- ── Preferences ───────────────────────────────────────────────────────────────
-- Typed per-user agent/persona settings. Owner-only — not shareable.
-- Key examples: "persona.name", "persona.tone", "persona.directness".

CREATE TABLE IF NOT EXISTS app.preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(btrim(key)) > 0),
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, key)
);

CREATE INDEX IF NOT EXISTS preferences_owner_idx ON app.preferences (owner_user_id);

ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS preferences_select ON app.preferences;
CREATE POLICY preferences_select ON app.preferences
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS preferences_insert ON app.preferences;
CREATE POLICY preferences_insert ON app.preferences
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS preferences_update ON app.preferences;
CREATE POLICY preferences_update ON app.preferences
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS preferences_delete ON app.preferences;
CREATE POLICY preferences_delete ON app.preferences
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.preferences TO jarvis_app_runtime;
```

- [ ] **Step 2: Add Kysely table types and `JarvisDatabase` entries to `packages/db/src/types.ts`**

Add these three interfaces before the `JarvisDatabase` interface (after `BriefingRunsTable`):

```typescript
export interface CommitmentsTable {
  id: string;
  owner_user_id: string;
  title: string;
  counterparty: string | null;
  due_at: NullableTimestampColumn;
  status: "open" | "at_risk" | "slipped" | "done" | "renegotiated" | "dismissed";
  provenance: "volunteered" | "inferred" | "confirmed";
  source_kind: "manual" | "inferred" | "email" | "calendar";
  source_ref: string | null;
  surfaced_state: string | null;
  life_area: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface EntitiesTable {
  id: string;
  owner_user_id: string;
  type: "person" | "organization" | "account";
  name: string;
  attributes: JsonColumn;
  provenance: "volunteered" | "inferred" | "confirmed";
  vault_note_path: string | null;
  connector_refs: JsonColumn | null;
  life_area: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface PreferencesTable {
  id: string;
  owner_user_id: string;
  key: string;
  value_json: JsonColumn;
  updated_at: TimestampColumn;
}
```

Add to the `JarvisDatabase` interface (after `"app.briefing_runs"`):

```typescript
"app.commitments": CommitmentsTable;
"app.entities": EntitiesTable;
"app.preferences": PreferencesTable;
```

Add Selectable aliases after the existing ones at the bottom of the file:

```typescript
export type Commitment = Selectable<CommitmentsTable>;
export type Entity = Selectable<EntitiesTable>;
export type Preference = Selectable<PreferencesTable>;
```

- [ ] **Step 3: Run db:migrate to apply the new schema**

```bash
pnpm db:migrate
```

Expected: `applied 0001_structured_state.sql`. All other migrations are skipped.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/structured-state/sql/0001_structured_state.sql packages/db/src/types.ts
git commit -m "feat(structured-state): commitments/entities/preferences schema + RLS + DB types"
```

---

### Task 2: Package scaffold + tooling

**Files:**

- Create: `packages/structured-state/package.json`
- Create: `packages/structured-state/tsconfig.json`
- Create: `packages/structured-state/src/index.ts`
- Modify: `tsconfig.json`, `vitest.config.ts`, `package.json`

- [ ] **Step 1: Create `packages/structured-state/package.json`**

```json
{
  "name": "@jarv1s/structured-state",
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
    "@jarv1s/vault": "workspace:*",
    "kysely": "^0.29.2"
  }
}
```

- [ ] **Step 2: Create `packages/structured-state/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/structured-state/src/index.ts`** (empty barrel)

```typescript
export {};
```

- [ ] **Step 4: Add alias to `tsconfig.json`**

In the `"paths"` block:

```json
"@jarv1s/structured-state": ["packages/structured-state/src/index.ts"]
```

- [ ] **Step 5: Add alias to `vitest.config.ts`**

In the `resolve.alias` array:

```typescript
{
  find: "@jarv1s/structured-state",
  replacement: fileURLToPath(new URL("./packages/structured-state/src/index.ts", import.meta.url))
},
```

- [ ] **Step 6: Add script to `package.json`**

```json
"test:structured-state": "vitest run tests/integration/structured-state.test.ts"
```

- [ ] **Step 7: Install**

```bash
pnpm install
```

- [ ] **Step 8: Commit**

```bash
git add packages/structured-state/ tsconfig.json vitest.config.ts package.json
git commit -m "feat(structured-state): scaffold @jarv1s/structured-state package"
```

---

### Task 3: `types.ts` + `CommitmentsRepository`

**Files:**

- Create: `packages/structured-state/src/types.ts`
- Create: `packages/structured-state/src/commitments-repository.ts`
- Modify: `packages/structured-state/src/index.ts`
- Create: `tests/integration/structured-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/structured-state.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import {
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type JarvisDatabase
} from "@jarv1s/db";
import { VaultContextRunner, readVaultFile, vaultFileExists, writeVaultFile } from "@jarv1s/vault";
import {
  CommitmentsRepository,
  EntitiesRepository,
  PreferencesRepository,
  VaultWriteBackService
} from "@jarv1s/structured-state";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000021";
const otherUserId = "00000000-0000-4000-8000-000000000022";

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "req:structured-state-test" };
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
       VALUES ($1, 'ss-a@example.test', false),
              ($2, 'ss-b@example.test', false)`,
      [userId, otherUserId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb.destroy();
});

// ── CommitmentsRepository ─────────────────────────────────────────────────────

describe("CommitmentsRepository", () => {
  const repo = new CommitmentsRepository();

  it("owner can create and list their own commitments", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.create(scopedDb, {
        ownerUserId: userId,
        title: "Call Alice back",
        provenance: "volunteered"
      });
      const list = await repo.listVisible(scopedDb);
      expect(list.some((c) => c.title === "Call Alice back")).toBe(true);
    });
  });

  it("other user cannot see owner's commitment (private by default)", async () => {
    let title: string;
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      title = `Private-${randomUUID()}`;
      await repo.create(scopedDb, { ownerUserId: userId, title, provenance: "volunteered" });
    });
    const list = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.listVisible(scopedDb)
    );
    expect(list.every((c) => c.title !== title!)).toBe(true);
  });

  it("app.shares view grant makes commitment visible to grantee", async () => {
    let commitmentId: string;
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const c = await repo.create(scopedDb, {
        ownerUserId: userId,
        title: `Shared-${randomUUID()}`,
        provenance: "volunteered"
      });
      commitmentId = c.id;
      await sql`
        INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
        VALUES ('commitment', ${commitmentId}::uuid, ${userId}::uuid, ${otherUserId}::uuid, 'view')
      `.execute(scopedDb.db);
    });
    const list = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.listVisible(scopedDb)
    );
    expect(list.some((c) => c.id === commitmentId!)).toBe(true);
  });

  it("revoking a share removes grantee visibility", async () => {
    let commitmentId: string;
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const c = await repo.create(scopedDb, {
        ownerUserId: userId,
        title: `Revoked-${randomUUID()}`,
        provenance: "volunteered"
      });
      commitmentId = c.id;
      await sql`
        INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
        VALUES ('commitment', ${commitmentId}::uuid, ${userId}::uuid, ${otherUserId}::uuid, 'view')
      `.execute(scopedDb.db);
      await sql`
        DELETE FROM app.shares
        WHERE resource_id = ${commitmentId}::uuid AND grantee_user_id = ${otherUserId}::uuid
      `.execute(scopedDb.db);
    });
    const list = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.listVisible(scopedDb)
    );
    expect(list.every((c) => c.id !== commitmentId!)).toBe(true);
  });

  it("owner can update status of their commitment", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const c = await repo.create(scopedDb, {
        ownerUserId: userId,
        title: "Track status",
        provenance: "volunteered"
      });
      await repo.update(scopedDb, c.id, { status: "done" });
      const updated = await repo.get(scopedDb, c.id);
      expect(updated?.status).toBe("done");
    });
  });
});

// ── EntitiesRepository, PreferencesRepository, VaultWriteBackService describe blocks
// added in Tasks 4–6
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test:structured-state
```

Expected: FAIL — `does not provide an export named 'CommitmentsRepository'`.

- [ ] **Step 3: Create `packages/structured-state/src/types.ts`**

```typescript
export type ProvenanceKind = "volunteered" | "inferred" | "confirmed";
export type CommitmentStatus =
  | "open"
  | "at_risk"
  | "slipped"
  | "done"
  | "renegotiated"
  | "dismissed";
export type CommitmentSourceKind = "manual" | "inferred" | "email" | "calendar";
export type EntityType = "person" | "organization" | "account";
```

- [ ] **Step 4: Create `packages/structured-state/src/commitments-repository.ts`**

```typescript
import { sql } from "kysely";

import type { Commitment, DataContextDb } from "@jarv1s/db";
import type { CommitmentSourceKind, CommitmentStatus, ProvenanceKind } from "./types.js";

export interface CreateCommitmentInput {
  readonly ownerUserId: string;
  readonly title: string;
  readonly provenance: ProvenanceKind;
  readonly counterparty?: string;
  readonly dueAt?: Date;
  readonly sourceKind?: CommitmentSourceKind;
  readonly sourceRef?: string;
  readonly lifeArea?: string;
}

export interface UpdateCommitmentInput {
  readonly title?: string;
  readonly status?: CommitmentStatus;
  readonly counterparty?: string | null;
  readonly dueAt?: Date | null;
  readonly surfacedState?: string | null;
  readonly lifeArea?: string | null;
  readonly provenance?: ProvenanceKind;
}

export class CommitmentsRepository {
  async create(scopedDb: DataContextDb, input: CreateCommitmentInput): Promise<Commitment> {
    const result = await scopedDb.db
      .insertInto("app.commitments")
      .values({
        owner_user_id: input.ownerUserId,
        title: input.title,
        provenance: input.provenance,
        counterparty: input.counterparty ?? null,
        due_at: input.dueAt ?? null,
        source_kind: input.sourceKind ?? "manual",
        source_ref: input.sourceRef ?? null,
        life_area: input.lifeArea ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return result as Commitment;
  }

  async listVisible(scopedDb: DataContextDb): Promise<Commitment[]> {
    const rows = await scopedDb.db
      .selectFrom("app.commitments")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows as Commitment[];
  }

  async get(scopedDb: DataContextDb, id: string): Promise<Commitment | undefined> {
    const row = await scopedDb.db
      .selectFrom("app.commitments")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row as Commitment | undefined;
  }

  async update(
    scopedDb: DataContextDb,
    id: string,
    input: UpdateCommitmentInput
  ): Promise<Commitment | undefined> {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (input.title !== undefined) updates["title"] = input.title;
    if (input.status !== undefined) updates["status"] = input.status;
    if (input.counterparty !== undefined) updates["counterparty"] = input.counterparty;
    if (input.dueAt !== undefined) updates["due_at"] = input.dueAt;
    if (input.surfacedState !== undefined) updates["surfaced_state"] = input.surfacedState;
    if (input.lifeArea !== undefined) updates["life_area"] = input.lifeArea;
    if (input.provenance !== undefined) updates["provenance"] = input.provenance;

    const row = await scopedDb.db
      .updateTable("app.commitments")
      .set(updates)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row as Commitment | undefined;
  }

  async delete(scopedDb: DataContextDb, id: string): Promise<void> {
    await scopedDb.db.deleteFrom("app.commitments").where("id", "=", id).execute();
  }
}
```

- [ ] **Step 5: Update `packages/structured-state/src/index.ts`**

```typescript
export type {
  CommitmentStatus,
  CommitmentSourceKind,
  EntityType,
  ProvenanceKind
} from "./types.js";
export type { CreateCommitmentInput, UpdateCommitmentInput } from "./commitments-repository.js";
export { CommitmentsRepository } from "./commitments-repository.js";
```

- [ ] **Step 6: Run tests**

```bash
pnpm test:structured-state
```

Expected: 5 CommitmentsRepository tests pass. EntitiesRepository/Preferences/WriteBack tests fail — expected.

- [ ] **Step 7: Commit**

```bash
git add packages/structured-state/src/types.ts \
  packages/structured-state/src/commitments-repository.ts \
  packages/structured-state/src/index.ts \
  tests/integration/structured-state.test.ts
git commit -m "feat(structured-state): CommitmentsRepository with owner-or-share RLS"
```

---

### Task 4: `EntitiesRepository`

**Files:**

- Create: `packages/structured-state/src/entities-repository.ts`
- Modify: `packages/structured-state/src/index.ts`
- Modify: `tests/integration/structured-state.test.ts`

- [ ] **Step 1: Add failing entity tests**

Add to the @jarv1s/structured-state import at the top of `tests/integration/structured-state.test.ts`:

```typescript
// Change:
import {
  CommitmentsRepository,
  EntitiesRepository,
  PreferencesRepository,
  VaultWriteBackService
} from "@jarv1s/structured-state";
// (already imported — these will be satisfied as each task completes)
```

Append the following describe block to the end of `tests/integration/structured-state.test.ts`:

```typescript
// ── EntitiesRepository ────────────────────────────────────────────────────────

describe("EntitiesRepository", () => {
  const repo = new EntitiesRepository();

  it("owner can create and list their own entities", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.create(scopedDb, {
        ownerUserId: userId,
        type: "person",
        name: "Alice Smith",
        provenance: "volunteered"
      });
      const list = await repo.listVisible(scopedDb);
      expect(list.some((e) => e.name === "Alice Smith")).toBe(true);
    });
  });

  it("other user cannot see owner's entity (private by default)", async () => {
    let entityId: string;
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const e = await repo.create(scopedDb, {
        ownerUserId: userId,
        type: "person",
        name: `Private-${randomUUID()}`,
        provenance: "volunteered"
      });
      entityId = e.id;
    });
    const list = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.listVisible(scopedDb)
    );
    expect(list.every((e) => e.id !== entityId!)).toBe(true);
  });

  it("app.shares view grant makes entity visible to grantee", async () => {
    let entityId: string;
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const e = await repo.create(scopedDb, {
        ownerUserId: userId,
        type: "organization",
        name: `Shared-Org-${randomUUID()}`,
        provenance: "volunteered"
      });
      entityId = e.id;
      await sql`
        INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
        VALUES ('entity', ${entityId}::uuid, ${userId}::uuid, ${otherUserId}::uuid, 'view')
      `.execute(scopedDb.db);
    });
    const list = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.listVisible(scopedDb)
    );
    expect(list.some((e) => e.id === entityId!)).toBe(true);
  });

  it("attributes are stored as JSONB and returned correctly", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const e = await repo.create(scopedDb, {
        ownerUserId: userId,
        type: "person",
        name: "Bob Jones",
        provenance: "volunteered",
        attributes: { email: "bob@example.test", role: "engineer" }
      });
      const fetched = await repo.get(scopedDb, e.id);
      expect(fetched?.attributes).toMatchObject({ email: "bob@example.test", role: "engineer" });
    });
  });

  it("vault_note_path is stored and returned", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const e = await repo.create(scopedDb, {
        ownerUserId: userId,
        type: "person",
        name: "Carol",
        provenance: "volunteered",
        vaultNotePath: "People/carol.md"
      });
      expect(e.vault_note_path).toBe("People/carol.md");
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test:structured-state
```

Expected: 5 CommitmentsRepository tests pass, 5 entity tests fail.

- [ ] **Step 3: Create `packages/structured-state/src/entities-repository.ts`**

```typescript
import type { DataContextDb, Entity } from "@jarv1s/db";
import type { EntityType, ProvenanceKind } from "./types.js";

export interface CreateEntityInput {
  readonly ownerUserId: string;
  readonly type: EntityType;
  readonly name: string;
  readonly provenance: ProvenanceKind;
  readonly attributes?: Record<string, unknown>;
  readonly vaultNotePath?: string;
  readonly connectorRefs?: Record<string, unknown>;
  readonly lifeArea?: string;
}

export interface UpdateEntityInput {
  readonly name?: string;
  readonly attributes?: Record<string, unknown>;
  readonly provenance?: ProvenanceKind;
  readonly vaultNotePath?: string | null;
  readonly connectorRefs?: Record<string, unknown> | null;
  readonly lifeArea?: string | null;
}

export class EntitiesRepository {
  async create(scopedDb: DataContextDb, input: CreateEntityInput): Promise<Entity> {
    const row = await scopedDb.db
      .insertInto("app.entities")
      .values({
        owner_user_id: input.ownerUserId,
        type: input.type,
        name: input.name,
        provenance: input.provenance,
        attributes: JSON.stringify(input.attributes ?? {}),
        vault_note_path: input.vaultNotePath ?? null,
        connector_refs: input.connectorRefs ? JSON.stringify(input.connectorRefs) : null,
        life_area: input.lifeArea ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as Entity;
  }

  async listVisible(scopedDb: DataContextDb): Promise<Entity[]> {
    const rows = await scopedDb.db
      .selectFrom("app.entities")
      .selectAll()
      .orderBy("name", "asc")
      .execute();
    return rows as Entity[];
  }

  async get(scopedDb: DataContextDb, id: string): Promise<Entity | undefined> {
    const row = await scopedDb.db
      .selectFrom("app.entities")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row as Entity | undefined;
  }

  async update(
    scopedDb: DataContextDb,
    id: string,
    input: UpdateEntityInput
  ): Promise<Entity | undefined> {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (input.name !== undefined) updates["name"] = input.name;
    if (input.attributes !== undefined) updates["attributes"] = JSON.stringify(input.attributes);
    if (input.provenance !== undefined) updates["provenance"] = input.provenance;
    if (input.vaultNotePath !== undefined) updates["vault_note_path"] = input.vaultNotePath;
    if (input.connectorRefs !== undefined)
      updates["connector_refs"] = input.connectorRefs ? JSON.stringify(input.connectorRefs) : null;
    if (input.lifeArea !== undefined) updates["life_area"] = input.lifeArea;

    const row = await scopedDb.db
      .updateTable("app.entities")
      .set(updates)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row as Entity | undefined;
  }

  async delete(scopedDb: DataContextDb, id: string): Promise<void> {
    await scopedDb.db.deleteFrom("app.entities").where("id", "=", id).execute();
  }
}
```

- [ ] **Step 4: Update `packages/structured-state/src/index.ts`**

```typescript
export type {
  CommitmentStatus,
  CommitmentSourceKind,
  EntityType,
  ProvenanceKind
} from "./types.js";
export type { CreateCommitmentInput, UpdateCommitmentInput } from "./commitments-repository.js";
export { CommitmentsRepository } from "./commitments-repository.js";
export type { CreateEntityInput, UpdateEntityInput } from "./entities-repository.js";
export { EntitiesRepository } from "./entities-repository.js";
```

- [ ] **Step 5: Run tests**

```bash
pnpm test:structured-state
```

Expected: 5 + 5 = 10 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/structured-state/src/entities-repository.ts packages/structured-state/src/index.ts tests/integration/structured-state.test.ts
git commit -m "feat(structured-state): EntitiesRepository with owner-or-share RLS + JSONB attributes"
```

---

### Task 5: `PreferencesRepository`

**Files:**

- Create: `packages/structured-state/src/preferences-repository.ts`
- Modify: `packages/structured-state/src/index.ts`
- Modify: `tests/integration/structured-state.test.ts`

- [ ] **Step 1: Add failing preferences tests**

Append to `tests/integration/structured-state.test.ts`:

```typescript
// ── PreferencesRepository ─────────────────────────────────────────────────────

describe("PreferencesRepository", () => {
  const repo = new PreferencesRepository();

  it("upsert sets a preference and get returns it", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsert(scopedDb, userId, "persona.name", "Jarvis");
      const value = await repo.get(scopedDb, "persona.name");
      expect(value).toBe("Jarvis");
    });
  });

  it("upsert overwrites an existing preference", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsert(scopedDb, userId, "persona.tone", "formal");
      await repo.upsert(scopedDb, userId, "persona.tone", "casual");
      const value = await repo.get(scopedDb, "persona.tone");
      expect(value).toBe("casual");
    });
  });

  it("get returns null for a key that has not been set", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const value = await repo.get(scopedDb, "non.existent.key");
      expect(value).toBeNull();
    });
  });

  it("preferences are owner-only: other user cannot read them", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsert(scopedDb, userId, "persona.directness", "high");
    });
    await dataContext.withDataContext(ctx(otherUserId), async (scopedDb) => {
      const value = await repo.get(scopedDb, "persona.directness");
      expect(value).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test:structured-state
```

Expected: 10 pass, 4 preferences tests fail.

- [ ] **Step 3: Create `packages/structured-state/src/preferences-repository.ts`**

```typescript
import type { DataContextDb } from "@jarv1s/db";

export class PreferencesRepository {
  async upsert(
    scopedDb: DataContextDb,
    ownerUserId: string,
    key: string,
    value: unknown
  ): Promise<void> {
    await scopedDb.db
      .insertInto("app.preferences")
      .values({
        owner_user_id: ownerUserId,
        key,
        value_json: JSON.stringify(value),
        updated_at: new Date()
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "key"]).doUpdateSet({
          value_json: JSON.stringify(value),
          updated_at: new Date()
        })
      )
      .execute();
  }

  async get(scopedDb: DataContextDb, key: string): Promise<unknown> {
    const row = await scopedDb.db
      .selectFrom("app.preferences")
      .select("value_json")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value_json ?? null;
  }

  async list(scopedDb: DataContextDb): Promise<Record<string, unknown>> {
    const rows = await scopedDb.db
      .selectFrom("app.preferences")
      .select(["key", "value_json"])
      .execute();
    return Object.fromEntries(rows.map((r) => [r.key, r.value_json]));
  }

  async delete(scopedDb: DataContextDb, key: string): Promise<void> {
    await scopedDb.db.deleteFrom("app.preferences").where("key", "=", key).execute();
  }
}
```

- [ ] **Step 4: Update `packages/structured-state/src/index.ts`**

```typescript
export type {
  CommitmentStatus,
  CommitmentSourceKind,
  EntityType,
  ProvenanceKind
} from "./types.js";
export type { CreateCommitmentInput, UpdateCommitmentInput } from "./commitments-repository.js";
export { CommitmentsRepository } from "./commitments-repository.js";
export type { CreateEntityInput, UpdateEntityInput } from "./entities-repository.js";
export { EntitiesRepository } from "./entities-repository.js";
export { PreferencesRepository } from "./preferences-repository.js";
```

- [ ] **Step 5: Run tests**

```bash
pnpm test:structured-state
```

Expected: 10 + 4 = 14 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/structured-state/src/preferences-repository.ts packages/structured-state/src/index.ts tests/integration/structured-state.test.ts
git commit -m "feat(structured-state): PreferencesRepository — owner-only key/value settings"
```

---

### Task 6: `VaultWriteBackService` — frontmatter sync with body preservation

**Files:**

- Create: `packages/structured-state/src/write-back.ts`
- Modify: `packages/structured-state/src/index.ts`
- Modify: `tests/integration/structured-state.test.ts`

The write-back contract: serialize entity fields as YAML frontmatter, read any existing body, write `---\n<frontmatter>---\n<body>`. The prose body is never touched. Re-indexing is the caller's responsibility.

- [ ] **Step 1: Add failing write-back tests**

Add to the module-level setup in `tests/integration/structured-state.test.ts` (before the first describe block, alongside the existing `afterAll`):

```typescript
// vault setup for write-back tests (add alongside existing afterAll)
const vaultBase = join(tmpdir(), `jarv1s-ss-vault-${randomUUID()}`);
const vaultRunner = new VaultContextRunner(vaultBase);

afterAll(async () => {
  await rm(vaultBase, { recursive: true, force: true });
});
```

Then append the describe block:

```typescript
// ── VaultWriteBackService ─────────────────────────────────────────────────────

describe("VaultWriteBackService", () => {
  const entityRepo = new EntitiesRepository();
  const writeBack = new VaultWriteBackService();

  it("syncEntityToVault creates a vault file with YAML frontmatter for the entity", async () => {
    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        const entity = await entityRepo.create(scopedDb, {
          ownerUserId: userId,
          type: "person",
          name: "Diana Prince",
          provenance: "volunteered",
          vaultNotePath: "People/diana.md"
        });
        await writeBack.syncEntityToVault(vaultCtx, entity);
        const content = await readVaultFile(vaultCtx, "People/diana.md");
        expect(content).toContain("jarvis_type: person");
        expect(content).toContain("name:");
        expect(content).toContain("Diana Prince");
        expect(content).toContain("provenance: volunteered");
      });
    });
  });

  it("syncEntityToVault preserves existing human-authored prose body", async () => {
    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      // Simulate user writing prose after initial sync
      await writeVaultFile(
        vaultCtx,
        "People/eve.md",
        `---\njarvis_id: old-id\n---\n\n# Eve\n\nEve is a security researcher.\n`
      );

      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        const entity = await entityRepo.create(scopedDb, {
          ownerUserId: userId,
          type: "person",
          name: "Eve Adams",
          provenance: "confirmed",
          vaultNotePath: "People/eve.md"
        });
        await writeBack.syncEntityToVault(vaultCtx, entity);
        const content = await readVaultFile(vaultCtx, "People/eve.md");
        // Machine-owned: updated frontmatter reflects new entity
        expect(content).toContain("Eve Adams");
        // Human-owned: user prose is preserved verbatim
        expect(content).toContain("Eve is a security researcher.");
        // Old frontmatter is replaced (not left alongside new)
        expect(content.indexOf("---")).not.toBe(content.lastIndexOf("---") - 3);
      });
    });
  });

  it("syncEntityToVault is a no-op when vault_note_path is null", async () => {
    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        const entity = await entityRepo.create(scopedDb, {
          ownerUserId: userId,
          type: "person",
          name: "Frank No-Vault",
          provenance: "inferred"
          // no vaultNotePath
        });
        await writeBack.syncEntityToVault(vaultCtx, entity);
        // No file should have been created
        expect(await vaultFileExists(vaultCtx, "People/frank.md")).toBe(false);
      });
    });
  });

  it("updated entity name is reflected in frontmatter after re-sync (body unchanged)", async () => {
    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        const entity = await entityRepo.create(scopedDb, {
          ownerUserId: userId,
          type: "person",
          name: "Grace Hopper",
          provenance: "volunteered",
          vaultNotePath: "People/grace.md"
        });
        await writeBack.syncEntityToVault(vaultCtx, entity);

        // Simulate user adding prose
        const current = await readVaultFile(vaultCtx, "People/grace.md");
        await writeVaultFile(vaultCtx, "People/grace.md", current + "\n\nGrace invented COBOL.\n");

        // Update entity name
        const updated = await entityRepo.update(scopedDb, entity.id, {
          name: "Grace Murray Hopper"
        });
        await writeBack.syncEntityToVault(vaultCtx, updated!);

        const final = await readVaultFile(vaultCtx, "People/grace.md");
        expect(final).toContain("Grace Murray Hopper");
        expect(final).toContain("Grace invented COBOL.");
      });
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test:structured-state
```

Expected: 14 pass, 4 write-back tests fail.

- [ ] **Step 3: Create `packages/structured-state/src/write-back.ts`**

```typescript
import { readVaultFile, vaultFileExists, writeVaultFile } from "@jarv1s/vault";
import type { VaultContext } from "@jarv1s/vault";
import type { Entity } from "@jarv1s/db";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function yamlStr(value: string): string {
  // Always double-quote string values to handle colons, special chars safely.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeFrontmatter(entity: Entity): string {
  const lines: string[] = [
    `jarvis_id: ${entity.id}`,
    `jarvis_type: ${entity.type}`,
    `name: ${yamlStr(entity.name)}`,
    `provenance: ${entity.provenance}`
  ];
  if (entity.life_area) lines.push(`life_area: ${yamlStr(entity.life_area)}`);
  if (entity.vault_note_path) lines.push(`vault_note_path: ${yamlStr(entity.vault_note_path)}`);
  lines.push(`updated_at: ${entity.updated_at.toISOString()}`);
  return lines.join("\n") + "\n";
}

async function readExistingBody(vaultCtx: VaultContext, path: string): Promise<string> {
  if (!(await vaultFileExists(vaultCtx, path))) return "";
  const content = await readVaultFile(vaultCtx, path);
  const match = FRONTMATTER_RE.exec(content);
  return match ? content.slice(match[0].length) : content;
}

export class VaultWriteBackService {
  async syncEntityToVault(vaultCtx: VaultContext, entity: Entity): Promise<void> {
    if (!entity.vault_note_path) return;

    const body = await readExistingBody(vaultCtx, entity.vault_note_path);
    const frontmatter = serializeFrontmatter(entity);
    const content = `---\n${frontmatter}---\n${body}`;

    await writeVaultFile(vaultCtx, entity.vault_note_path, content);
  }
}
```

- [ ] **Step 4: Update `packages/structured-state/src/index.ts`** (final state)

```typescript
export type {
  CommitmentStatus,
  CommitmentSourceKind,
  EntityType,
  ProvenanceKind
} from "./types.js";
export type { CreateCommitmentInput, UpdateCommitmentInput } from "./commitments-repository.js";
export { CommitmentsRepository } from "./commitments-repository.js";
export type { CreateEntityInput, UpdateEntityInput } from "./entities-repository.js";
export { EntitiesRepository } from "./entities-repository.js";
export { PreferencesRepository } from "./preferences-repository.js";
export { VaultWriteBackService } from "./write-back.js";
```

- [ ] **Step 5: Run all tests**

```bash
pnpm test:structured-state
```

Expected: All 18 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/structured-state/src/write-back.ts packages/structured-state/src/index.ts tests/integration/structured-state.test.ts
git commit -m "feat(structured-state): VaultWriteBackService — frontmatter sync preserves human prose"
```

---

### Task 7: Module manifest + registry registration

**Files:**

- Create: `packages/structured-state/src/manifest.ts`
- Modify: `packages/structured-state/src/index.ts`
- Modify: `packages/module-registry/src/index.ts`
- Modify: `packages/module-registry/package.json`

- [ ] **Step 1: Create `packages/structured-state/src/manifest.ts`**

```typescript
import { fileURLToPath } from "node:url";

import type { JarvisModuleManifest } from "@jarv1s/module-sdk";

export const STRUCTURED_STATE_MODULE_ID = "structured-state";
export const structuredStateSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const structuredStateModuleManifest: JarvisModuleManifest = {
  id: STRUCTURED_STATE_MODULE_ID,
  name: "Structured State",
  version: "0.1.0",
  publisher: "jarv1s",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true
  },
  database: {
    migrations: ["sql/0001_structured_state.sql"],
    migrationDirectories: ["packages/structured-state/sql"],
    ownedTables: ["app.commitments", "app.entities", "app.preferences"]
  },
  shareableResources: [
    { resourceType: "commitment", grantLevels: ["view", "contribute", "manage"] },
    { resourceType: "entity", grantLevels: ["view", "contribute", "manage"] }
  ]
};
```

- [ ] **Step 2: Update `packages/structured-state/src/index.ts`** — add manifest exports

```typescript
export type {
  CommitmentStatus,
  CommitmentSourceKind,
  EntityType,
  ProvenanceKind
} from "./types.js";
export type { CreateCommitmentInput, UpdateCommitmentInput } from "./commitments-repository.js";
export { CommitmentsRepository } from "./commitments-repository.js";
export type { CreateEntityInput, UpdateEntityInput } from "./entities-repository.js";
export { EntitiesRepository } from "./entities-repository.js";
export { PreferencesRepository } from "./preferences-repository.js";
export { VaultWriteBackService } from "./write-back.js";
export {
  structuredStateModuleManifest,
  structuredStateSqlMigrationDirectory,
  STRUCTURED_STATE_MODULE_ID
} from "./manifest.js";
```

- [ ] **Step 3: Add `@jarv1s/structured-state` to `packages/module-registry/package.json`**

Add in the `dependencies` object:

```json
"@jarv1s/structured-state": "workspace:*"
```

- [ ] **Step 4: Register in `packages/module-registry/src/index.ts`**

Add the import alongside the other module imports:

```typescript
import {
  structuredStateModuleManifest,
  structuredStateSqlMigrationDirectory
} from "@jarv1s/structured-state";
```

Add to the `BUILT_IN_MODULES` array:

```typescript
{
  manifest: structuredStateModuleManifest,
  sqlMigrationDirectories: [structuredStateSqlMigrationDirectory],
  queueDefinitions: [],
},
```

- [ ] **Step 5: Install + verify migration is idempotent**

```bash
pnpm install
pnpm db:migrate
```

Expected: "no SQL migrations applied; 29 already current" (structured-state migration was applied in Task 1 Step 3; registry now discovers it for future fresh installs).

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/structured-state/src/manifest.ts \
  packages/structured-state/src/index.ts \
  packages/module-registry/src/index.ts \
  packages/module-registry/package.json
git commit -m "feat(structured-state): module manifest + module-registry registration"
```

---

### Task 8: Foundation gate

**Files:** none

- [ ] **Step 1: Run lint + format**

```bash
pnpm lint && pnpm format:check
```

Fix any issues with `pnpm format`.

- [ ] **Step 2: Run the full gate**

```bash
pnpm verify:foundation
```

Expected:

```
lint, format:check, file-size, typecheck pass
no SQL migrations applied; 29 already current
Integration Test Files  15 passed (15)
Integration Tests       178 passed (178)
```

(14 pre-existing test files → 15 with structured-state.test.ts; +18 structured-state tests.)

- [ ] **Step 3: Commit any format-only changes**

```bash
git add -A
git commit -m "chore: format after structured-state module addition"
```

---

## Verification Commands

```bash
pnpm test:structured-state          # 18 tests: commitments, entities, preferences, write-back
pnpm test:vault                     # Slice 2 still green
pnpm test:memory                    # Slice 3 still green
pnpm verify:foundation              # full gate
```

## Notes for Implementer

- **`CREATE TYPE IF NOT EXISTS`** syntax requires Postgres 9.5+. If the migration fails with "type already exists", check whether enum types were partially created — drop and recreate cleanly via `pnpm db:reset`.
- **`app.has_share` in RLS** is the same function installed by `0017_shares.sql`. The policy references the function by name; no JOIN is needed in the application layer — RLS evaluates it for every row automatically.
- **Write-back does NOT re-index.** The caller (future routes, agent tools, or job handlers) is responsible for calling `MemoryIngestPipeline.ingestFile()` after a write-back so the memory index stays current. This keeps `packages/structured-state` free of a dependency on `packages/memory`.
- **Preferences `value_json` stores JSON**: calling `repo.get()` returns the already-deserialized value (Kysely returns JSONB columns as parsed JavaScript values). No additional `JSON.parse()` needed.
- **life_area** columns exist in the schema for future briefing/focus filtering but no filtering logic is built in this slice. They are nullable text and ignored by all queries here.
