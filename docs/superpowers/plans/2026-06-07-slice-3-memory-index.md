# Memory Index + Retrieval (Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `packages/memory` module — a pgvector-backed index over vault files that ingests markdown (frontmatter, `[[wikilinks]]`, heading-chunked text) into embeddings, stores them in RLS-scoped tables, and retrieves ranked chunks with provenance (path + line range) so the agent can re-read source content via `VaultContext`.

**Architecture:** `packages/memory` is a required built-in module (registered in `module-registry`, no routes/navigation in this slice). `MemoryRepository` holds all DataContextDb-only DB access. `MemoryIngestPipeline` takes a `VaultContext` + `DataContextDb`, reads vault files, parses + chunks + embeds text, and upserts into `app.memory_chunks`/`app.memory_links`. `MemoryRetriever.retrieve()` embeds the query, does a pgvector cosine-similarity search, and returns chunks with provenance. All tables use `FORCE ROW LEVEL SECURITY`; retrieval is strictly owner-scoped. `EmbeddingProvider` is a pluggable interface; `StubEmbeddingProvider` (deterministic 384-dim vectors) is used in tests.

**Tech Stack:** pgvector (via `pgvector/pgvector:pg17` docker image), Kysely raw SQL for vector ops, Node.js `node:crypto` for content hashing; no external markdown parser needed.

**Prerequisite:** Slice 2 (`packages/vault`) must be complete. `pnpm db:reset` is required after the docker-compose image change.

---

## File Structure

**Create:**

- `infra/postgres/bootstrap/0001_extensions.sql` — `CREATE EXTENSION IF NOT EXISTS vector` (runs as superuser)
- `packages/memory/package.json`
- `packages/memory/tsconfig.json`
- `packages/memory/src/index.ts`
- `packages/memory/src/manifest.ts` — module manifest + SQL migration directory
- `packages/memory/src/embedding-provider.ts` — `EmbeddingProvider` interface + `StubEmbeddingProvider`
- `packages/memory/src/parser.ts` — `parseDocument()` returning `ParsedDocument`
- `packages/memory/src/repository.ts` — `MemoryRepository` (DataContextDb-only)
- `packages/memory/src/ingest.ts` — `MemoryIngestPipeline`
- `packages/memory/src/retrieval.ts` — `MemoryRetriever` + `RetrievedChunk`
- `packages/memory/sql/0001_memory_index.sql` — tables + RLS + grants
- `tests/integration/memory.test.ts`

**Modify:**

- `infra/docker-compose.yml` — swap `postgres:17-alpine` → `pgvector/pgvector:pg17`
- `packages/db/src/types.ts` — add `MemoryChunksTable`, `MemoryLinksTable`, `JarvisDatabase` entries
- `packages/vault/src/vault-ops.ts` — add `listVaultFilesRecursive`
- `packages/vault/src/index.ts` — export `listVaultFilesRecursive`
- `packages/module-registry/src/index.ts` — register memory module
- `tsconfig.json` — add `@jarv1s/memory` path alias
- `vitest.config.ts` — add `@jarv1s/memory` resolver alias
- `package.json` — add `test:memory` script

---

### Task 1: pgvector infrastructure

**Files:**

- Modify: `infra/docker-compose.yml`
- Create: `infra/postgres/bootstrap/0001_extensions.sql`
- Create: `packages/memory/sql/0001_memory_index.sql`
- Modify: `packages/db/src/types.ts`

- [ ] **Step 1: Swap Postgres image in `infra/docker-compose.yml`**

Find the line `image: postgres:17-alpine` and change it to:

```yaml
image: pgvector/pgvector:pg17
```

Only the `postgres` service image changes. All other services remain identical.

- [ ] **Step 2: Create `infra/postgres/bootstrap/0001_extensions.sql`**

```sql
-- Runs as the superuser (postgres) before any migrations.
-- Installs pgvector so the vector type and operators are available to all roles.
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 3: Create `packages/memory/sql/0001_memory_index.sql`**

```sql
-- Memory index: derived, rebuildable. Wiping these tables and re-scanning the
-- vault fully reconstructs them. All rows are strictly private (owner-only RLS).

CREATE TABLE IF NOT EXISTS app.memory_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('vault', 'connector')),
  source_path text NOT NULL,
  line_start integer NOT NULL CHECK (line_start >= 0),
  line_end integer NOT NULL CHECK (line_end >= line_start),
  content_hash text NOT NULL,
  text text NOT NULL,
  embedding vector(384),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_chunks_owner_idx
  ON app.memory_chunks (owner_user_id);

CREATE INDEX IF NOT EXISTS memory_chunks_path_idx
  ON app.memory_chunks (owner_user_id, source_path);

CREATE INDEX IF NOT EXISTS memory_chunks_embedding_idx
  ON app.memory_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.memory_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  from_path text NOT NULL,
  to_path text NOT NULL,
  UNIQUE (owner_user_id, from_path, to_path)
);

CREATE INDEX IF NOT EXISTS memory_links_from_idx
  ON app.memory_links (owner_user_id, from_path);

-- RLS
ALTER TABLE app.memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE app.memory_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_chunks_select ON app.memory_chunks;
CREATE POLICY memory_chunks_select ON app.memory_chunks
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS memory_chunks_insert ON app.memory_chunks;
CREATE POLICY memory_chunks_insert ON app.memory_chunks
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS memory_chunks_update ON app.memory_chunks;
CREATE POLICY memory_chunks_update ON app.memory_chunks
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS memory_chunks_delete ON app.memory_chunks;
CREATE POLICY memory_chunks_delete ON app.memory_chunks
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS memory_links_select ON app.memory_links;
CREATE POLICY memory_links_select ON app.memory_links
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS memory_links_insert ON app.memory_links;
CREATE POLICY memory_links_insert ON app.memory_links
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS memory_links_delete ON app.memory_links;
CREATE POLICY memory_links_delete ON app.memory_links
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

-- Runtime grants (app runtime only; no worker grants — no worker-driven ingestion in this slice)
GRANT SELECT, INSERT, UPDATE, DELETE ON app.memory_chunks TO jarvis_app_runtime;
GRANT SELECT, INSERT, DELETE ON app.memory_links TO jarvis_app_runtime;
```

- [ ] **Step 4: Add Kysely table types to `packages/db/src/types.ts`**

Find the end of the file where `JarvisDatabase` is defined and add the following types before the `JarvisDatabase` interface, then add the new table entries inside it.

Add these interfaces (after the existing table interfaces):

```typescript
export interface MemoryChunksTable {
  id: string;
  owner_user_id: string;
  source_kind: "vault" | "connector";
  source_path: string;
  line_start: number;
  line_end: number;
  content_hash: string;
  text: string;
  embedding: string | null; // pgvector stored as text in Kysely; serialized as "[n,n,...]"
  updated_at: TimestampColumn;
}

export interface MemoryLinksTable {
  id: string;
  owner_user_id: string;
  from_path: string;
  to_path: string;
}
```

Add to the `JarvisDatabase` interface (alongside the existing table entries):

```typescript
"app.memory_chunks": MemoryChunksTable;
"app.memory_links": MemoryLinksTable;
```

- [ ] **Step 5: Restart the database with the new pgvector image**

```bash
pnpm db:reset
```

Expected: `pnpm db:migrate` reports "applied 0001_memory_index.sql" (from the memory module) plus bootstrap runs the extension install. All previously-applied infra and module migrations are skipped.

- [ ] **Step 6: Commit**

```bash
git add infra/docker-compose.yml \
  infra/postgres/bootstrap/0001_extensions.sql \
  packages/memory/sql/0001_memory_index.sql \
  packages/db/src/types.ts
git commit -m "feat(memory): pgvector infra, memory_chunks/memory_links schema + RLS"
```

---

### Task 2: `packages/memory` scaffold + tooling

**Files:**

- Create: `packages/memory/package.json`
- Create: `packages/memory/tsconfig.json`
- Create: `packages/memory/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `packages/memory/package.json`**

```json
{
  "name": "@jarv1s/memory",
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

- [ ] **Step 2: Create `packages/memory/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/memory/src/index.ts`** (empty barrel, filled later)

```typescript
export {};
```

- [ ] **Step 4: Add `@jarv1s/memory` to `tsconfig.json` paths**

In the `"paths"` block:

```json
"@jarv1s/memory": ["packages/memory/src/index.ts"]
```

- [ ] **Step 5: Add `@jarv1s/memory` to `vitest.config.ts` aliases**

In the `resolve.alias` array:

```typescript
{
  find: "@jarv1s/memory",
  replacement: fileURLToPath(new URL("./packages/memory/src/index.ts", import.meta.url))
},
```

- [ ] **Step 6: Add `test:memory` script to `package.json`**

```json
"test:memory": "vitest run tests/integration/memory.test.ts"
```

- [ ] **Step 7: Install to link the new package**

```bash
pnpm install
```

Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/memory/ tsconfig.json vitest.config.ts package.json
git commit -m "feat(memory): scaffold @jarv1s/memory package"
```

---

### Task 3: `EmbeddingProvider` interface + `StubEmbeddingProvider`

**Files:**

- Create: `packages/memory/src/embedding-provider.ts`
- Modify: `packages/memory/src/index.ts`
- Create: `tests/integration/memory.test.ts` (initial skeleton + first describe block)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/memory.test.ts`. Note: imports are added incrementally in Tasks 5–7 as each class is implemented. Only import what exists at this stage.

```typescript
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Kysely } from "kysely";
import pg from "pg";

import {
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type JarvisDatabase
} from "@jarv1s/db";
import { VaultContextRunner, writeVaultFile } from "@jarv1s/vault";
import { StubEmbeddingProvider, parseDocument } from "@jarv1s/memory";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// ── parseDocument ─────────────────────────────────────────────────────────────

describe("parseDocument", () => {
  it("extracts frontmatter text and excludes it from body chunks", () => {
    const content = `---
name: Alice
role: designer
---
## About

Alice works on product.`;
    const doc = parseDocument(content);
    expect(doc.frontmatterText).toContain("name: Alice");
    const bodyChunk = doc.chunks.find((c) => c.text.includes("Alice works on product."));
    expect(bodyChunk).toBeDefined();
    expect(doc.chunks.every((c) => !c.text.startsWith("---"))).toBe(true);
  });

  it("extracts [[wikilinks]] from body", () => {
    const content = `# Note\n\nSee also [[Alice]] and [[Bob|Robert]].`;
    const doc = parseDocument(content);
    expect(doc.wikilinks.sort()).toEqual(["Alice", "Bob"].sort());
  });

  it("chunks document by H2 headings", () => {
    const content = `# Doc\n\n## Section A\n\nText A.\n\n## Section B\n\nText B.`;
    const doc = parseDocument(content);
    const chunkTexts = doc.chunks.map((c) => c.text);
    expect(chunkTexts.some((t) => t.includes("Text A."))).toBe(true);
    expect(chunkTexts.some((t) => t.includes("Text B."))).toBe(true);
  });

  it("treats document with no headings as a single chunk", () => {
    const content = `Just a plain note with no headings.`;
    const doc = parseDocument(content);
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0]?.text).toContain("Just a plain note");
  });

  it("returns empty chunks and no wikilinks for empty document", () => {
    const doc = parseDocument("");
    expect(doc.chunks).toHaveLength(0);
    expect(doc.wikilinks).toHaveLength(0);
  });
});

// ── StubEmbeddingProvider ─────────────────────────────────────────────────────

describe("StubEmbeddingProvider", () => {
  it("returns a vector of the declared dimensions", async () => {
    const provider = new StubEmbeddingProvider();
    const vec = await provider.embed("test text");
    expect(vec).toHaveLength(provider.dimensions);
  });

  it("returns the same vector for the same text (deterministic)", async () => {
    const provider = new StubEmbeddingProvider();
    const a = await provider.embed("hello world");
    const b = await provider.embed("hello world");
    expect(a).toEqual(b);
  });

  it("returns different vectors for different texts", async () => {
    const provider = new StubEmbeddingProvider();
    const a = await provider.embed("apples");
    const b = await provider.embed("quantum physics");
    expect(a).not.toEqual(b);
  });
});

// ── shared DB + vault setup for remaining tests ───────────────────────────────

const vaultBase = join(tmpdir(), `jarv1s-memory-test-${randomUUID()}`);
const vaultRunner = new VaultContextRunner(vaultBase);
const userId = "00000000-0000-4000-8000-000000000011";
const otherUserId = "00000000-0000-4000-8000-000000000012";

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "req:memory-test" };
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
       VALUES ($1, 'memory-a@example.test', false),
              ($2, 'memory-b@example.test', false)`,
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
  await rm(vaultBase, { recursive: true, force: true });
});

// ── MemoryRepository, MemoryIngestPipeline, MemoryRetriever tests follow below ──
// (added in Tasks 5–7)
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test:memory
```

Expected: FAIL — `does not provide an export named 'StubEmbeddingProvider'` (index.ts only exports `{}`; named exports not defined yet).

- [ ] **Step 3: Create `packages/memory/src/embedding-provider.ts`**

```typescript
import { createHash } from "node:crypto";

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;

  async embed(text: string): Promise<number[]> {
    const hash = createHash("sha256").update(text).digest();
    return Array.from({ length: this.dimensions }, (_, i) => {
      const byte = hash[i % hash.length] ?? 0;
      return (byte / 255) * 2 - 1;
    });
  }
}
```

- [ ] **Step 4: Create `packages/memory/src/parser.ts`**

```typescript
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const H2_SPLIT_RE = /(?=^## )/m;

export interface TextChunk {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export interface ParsedDocument {
  frontmatterText: string;
  wikilinks: string[];
  chunks: TextChunk[];
}

export function parseDocument(content: string): ParsedDocument {
  let body = content;
  let frontmatterText = "";

  const fmMatch = FRONTMATTER_RE.exec(content);
  if (fmMatch) {
    frontmatterText = fmMatch[1] ?? "";
    body = content.slice(fmMatch[0].length);
  }

  const wikilinks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    const link = match[1];
    if (link) wikilinks.push(link.trim());
  }

  const chunks = splitIntoChunks(content, body);

  return { frontmatterText, wikilinks, chunks };
}

function splitIntoChunks(fullContent: string, body: string): TextChunk[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  const sections = trimmed.split(H2_SPLIT_RE).filter((s) => s.trim());
  const fmLineCount = countLines(fullContent) - countLines(body);

  const chunks: TextChunk[] = [];
  let runningLine = fmLineCount;

  for (const section of sections) {
    const lineCount = countLines(section);
    chunks.push({
      text: section.trim(),
      lineStart: runningLine,
      lineEnd: runningLine + lineCount - 1
    });
    runningLine += lineCount;
  }

  return chunks;
}

function countLines(text: string): number {
  return (text.match(/\n/g) ?? []).length + 1;
}
```

- [ ] **Step 5: Update `packages/memory/src/index.ts`**

```typescript
export type { EmbeddingProvider } from "./embedding-provider.js";
export { StubEmbeddingProvider } from "./embedding-provider.js";
export type { ParsedDocument, TextChunk } from "./parser.js";
export { parseDocument } from "./parser.js";
```

- [ ] **Step 6: Run the parse + stub tests**

```bash
pnpm test:memory
```

Expected: The 5 `parseDocument` tests and 3 `StubEmbeddingProvider` tests pass (8 total). The rest fail with "MemoryRepository is not exported" — expected at this stage.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/embedding-provider.ts \
  packages/memory/src/parser.ts \
  packages/memory/src/index.ts \
  tests/integration/memory.test.ts
git commit -m "feat(memory): EmbeddingProvider interface, StubEmbeddingProvider, markdown parser"
```

---

### Task 4: `listVaultFilesRecursive` vault operation

**Files:**

- Modify: `packages/vault/src/vault-ops.ts`
- Modify: `packages/vault/src/index.ts`

The ingest pipeline needs to list all markdown files in a vault for rebuild. Add this to `packages/vault` rather than implementing it in the pipeline.

- [ ] **Step 1: Add `listVaultFilesRecursive` to `packages/vault/src/vault-ops.ts`**

Add at the end of the file (after `makeVaultDir`):

```typescript
import { relative } from "node:path";

async function collectFilesRecursive(dir: string, vaultRoot: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFilesRecursive(entryPath, vaultRoot)));
    } else if (entry.isFile()) {
      result.push(relative(vaultRoot, entryPath));
    }
  }
  return result;
}

export async function listVaultFilesRecursive(
  ctx: VaultContext,
  relativeDir: string = "."
): Promise<string[]> {
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativeDir);
  return collectFilesRecursive(fullPath, ctx.vaultRoot);
}
```

Note: add `relative` to the existing `import { ... } from "node:path"` statement at the top of vault-ops.ts. Also add `join` if not already there.

- [ ] **Step 2: Export from `packages/vault/src/index.ts`**

Add `listVaultFilesRecursive` to the existing vault-ops export line:

```typescript
export {
  deleteVaultFile,
  listVaultFiles,
  listVaultFilesRecursive,
  makeVaultDir,
  readVaultFile,
  vaultFileExists,
  writeVaultFile
} from "./vault-ops.js";
```

- [ ] **Step 3: Run vault tests to confirm nothing broke**

```bash
pnpm test:vault
```

Expected: All 19 vault tests still pass.

- [ ] **Step 4: Commit**

```bash
git add packages/vault/src/vault-ops.ts packages/vault/src/index.ts
git commit -m "feat(vault): add listVaultFilesRecursive"
```

---

### Task 5: `MemoryRepository` — database access layer

**Files:**

- Create: `packages/memory/src/repository.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `tests/integration/memory.test.ts` (add MemoryRepository describe block)

- [ ] **Step 1: Add failing MemoryRepository tests to `tests/integration/memory.test.ts`**

First, update the import lines at the top of the file. Add `createHash` to the node:crypto import and add `MemoryRepository` to the @jarv1s/memory import, and add `sql` to the kysely import:

```typescript
// Change:
import { randomUUID } from "node:crypto";
// To:
import { createHash, randomUUID } from "node:crypto";

// Change:
import { type Kysely } from "kysely";
// To:
import { sql, type Kysely } from "kysely";

// Change:
import { StubEmbeddingProvider, parseDocument } from "@jarv1s/memory";
// To:
import { MemoryRepository, StubEmbeddingProvider, parseDocument } from "@jarv1s/memory";
```

Then append the following describe block to the end of the file (after the `afterAll`):

```typescript
// ── MemoryRepository ──────────────────────────────────────────────────────────

describe("MemoryRepository", () => {
  const repo = new MemoryRepository();
  const provider = new StubEmbeddingProvider();

  async function makeChunks(
    sourcePath: string,
    texts: string[]
  ): Promise<
    Array<{
      sourcePath: string;
      lineStart: number;
      lineEnd: number;
      contentHash: string;
      text: string;
      embedding: number[];
    }>
  > {
    return Promise.all(
      texts.map(async (text, i) => ({
        sourcePath,
        lineStart: i * 10,
        lineEnd: i * 10 + 5,
        contentHash: Buffer.from(text).toString("hex"),
        text,
        embedding: await provider.embed(text)
      }))
    );
  }

  it("upsertFileChunks inserts chunks visible to the owner", async () => {
    const path = "notes/repo-test-1.md";
    const chunks = await makeChunks(path, ["Chunk one text", "Chunk two text"]);
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, chunks);
      const stored = await sql<{ text: string }>`
        SELECT text FROM app.memory_chunks
        WHERE source_path = ${path}
        ORDER BY line_start
      `.execute(scopedDb.db);
      expect(stored.rows.map((r) => r.text)).toEqual(["Chunk one text", "Chunk two text"]);
    });
  });

  it("upsertFileChunks replaces all existing chunks for the path", async () => {
    const path = "notes/repo-test-2.md";
    const firstChunks = await makeChunks(path, ["Old content"]);
    const newChunks = await makeChunks(path, ["New content A", "New content B"]);

    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, firstChunks);
      await repo.upsertFileChunks(scopedDb, userId, path, newChunks);
      const stored = await sql<{ text: string }>`
        SELECT text FROM app.memory_chunks WHERE source_path = ${path} ORDER BY line_start
      `.execute(scopedDb.db);
      expect(stored.rows.map((r) => r.text)).toEqual(["New content A", "New content B"]);
    });
  });

  it("vectorSearch returns chunks ranked by similarity (owner-scoped)", async () => {
    const path = "notes/repo-test-3.md";
    const chunks = await makeChunks(path, ["The quick brown fox"]);
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, chunks);
    });

    const queryVec = await provider.embed("The quick brown fox");
    const results = await dataContext.withDataContext(ctx(userId), async (scopedDb) =>
      repo.vectorSearch(scopedDb, queryVec, 10)
    );
    expect(results.some((r) => r.sourcePath === path)).toBe(true);

    // Other user sees no results
    const otherResults = await dataContext.withDataContext(ctx(otherUserId), async (scopedDb) =>
      repo.vectorSearch(scopedDb, queryVec, 10)
    );
    expect(otherResults.every((r) => r.sourcePath !== path)).toBe(true);
  });

  it("deleteFileChunks removes all chunks for a path", async () => {
    const path = "notes/repo-test-4.md";
    const chunks = await makeChunks(path, ["To be deleted"]);
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, chunks);
      await repo.deleteFileChunks(scopedDb, userId, path);
      const stored = await sql<{ id: string }>`
        SELECT id FROM app.memory_chunks WHERE source_path = ${path}
      `.execute(scopedDb.db);
      expect(stored.rows).toHaveLength(0);
    });
  });

  it("deleteAllForUser removes all chunks for the user", async () => {
    const path = "notes/repo-test-5.md";
    const chunks = await makeChunks(path, ["User data"]);
    // Use a fresh user so we don't interfere with other tests
    const freshUserId = "00000000-0000-4000-8000-000000000013";
    const freshClient = new Client({ connectionString: connectionStrings.bootstrap });
    await freshClient.connect();
    try {
      await freshClient.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, 'memory-fresh@example.test', false)`,
        [freshUserId]
      );
    } finally {
      await freshClient.end();
    }

    await dataContext.withDataContext(ctx(freshUserId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, freshUserId, path, chunks);
      await repo.deleteAllForUser(scopedDb, freshUserId);
      const stored = await sql<{ id: string }>`
        SELECT id FROM app.memory_chunks WHERE owner_user_id = ${freshUserId}::uuid
      `.execute(scopedDb.db);
      expect(stored.rows).toHaveLength(0);
    });
  });

  it("replaceFileLinks upserts wikilinks for a path", async () => {
    const fromPath = "notes/repo-links.md";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.replaceFileLinks(scopedDb, userId, fromPath, ["Alice", "Bob"]);
      const stored = await sql<{ to_path: string }>`
        SELECT to_path FROM app.memory_links WHERE from_path = ${fromPath} ORDER BY to_path
      `.execute(scopedDb.db);
      expect(stored.rows.map((r) => r.to_path)).toEqual(["Alice", "Bob"].sort());

      // Replacing with a new set removes old links
      await repo.replaceFileLinks(scopedDb, userId, fromPath, ["Charlie"]);
      const updated = await sql<{ to_path: string }>`
        SELECT to_path FROM app.memory_links WHERE from_path = ${fromPath}
      `.execute(scopedDb.db);
      expect(updated.rows.map((r) => r.to_path)).toEqual(["Charlie"]);
    });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
pnpm test:memory
```

Expected: MemoryRepository tests fail with "MemoryRepository is not exported".

- [ ] **Step 3: Create `packages/memory/src/repository.ts`**

```typescript
import { sql } from "kysely";

import type { DataContextDb } from "@jarv1s/db";

export interface NewChunkData {
  readonly sourcePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly contentHash: string;
  readonly text: string;
  readonly embedding: number[];
}

export interface RetrievedChunk {
  readonly id: string;
  readonly sourcePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  readonly similarity: number;
}

export class MemoryRepository {
  async upsertFileChunks(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePath: string,
    chunks: readonly NewChunkData[]
  ): Promise<void> {
    // Delete all existing chunks for this path, then insert fresh.
    await this.deleteFileChunks(scopedDb, ownerUserId, sourcePath);

    for (const chunk of chunks) {
      const vectorLiteral = `[${chunk.embedding.join(",")}]`;
      await sql`
        INSERT INTO app.memory_chunks
          (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text, embedding)
        VALUES
          (${ownerUserId}::uuid, ${"vault"}, ${chunk.sourcePath}, ${chunk.lineStart},
           ${chunk.lineEnd}, ${chunk.contentHash}, ${chunk.text}, ${vectorLiteral}::vector)
      `.execute(scopedDb.db);
    }
  }

  async deleteFileChunks(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePath: string
  ): Promise<void> {
    await sql`
      DELETE FROM app.memory_chunks
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source_path = ${sourcePath}
    `.execute(scopedDb.db);
  }

  async deleteAllForUser(scopedDb: DataContextDb, ownerUserId: string): Promise<void> {
    await sql`
      DELETE FROM app.memory_chunks WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
    await sql`
      DELETE FROM app.memory_links WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
  }

  async vectorSearch(
    scopedDb: DataContextDb,
    embedding: number[],
    limit: number
  ): Promise<RetrievedChunk[]> {
    const vectorLiteral = `[${embedding.join(",")}]`;
    const result = await sql<{
      id: string;
      source_path: string;
      line_start: number;
      line_end: number;
      text: string;
      similarity: number;
    }>`
      SELECT id, source_path, line_start, line_end, text,
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM app.memory_chunks
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `.execute(scopedDb.db);

    return result.rows.map((r) => ({
      id: r.id,
      sourcePath: r.source_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      text: r.text,
      similarity: r.similarity
    }));
  }

  async replaceFileLinks(
    scopedDb: DataContextDb,
    ownerUserId: string,
    fromPath: string,
    toPaths: readonly string[]
  ): Promise<void> {
    await sql`
      DELETE FROM app.memory_links
      WHERE owner_user_id = ${ownerUserId}::uuid AND from_path = ${fromPath}
    `.execute(scopedDb.db);

    for (const toPath of toPaths) {
      await sql`
        INSERT INTO app.memory_links (owner_user_id, from_path, to_path)
        VALUES (${ownerUserId}::uuid, ${fromPath}, ${toPath})
        ON CONFLICT (owner_user_id, from_path, to_path) DO NOTHING
      `.execute(scopedDb.db);
    }
  }
}
```

- [ ] **Step 4: Update `packages/memory/src/index.ts`**

```typescript
export type { EmbeddingProvider } from "./embedding-provider.js";
export { StubEmbeddingProvider } from "./embedding-provider.js";
export type { ParsedDocument, TextChunk } from "./parser.js";
export { parseDocument } from "./parser.js";
export type { NewChunkData, RetrievedChunk } from "./repository.js";
export { MemoryRepository } from "./repository.js";
```

- [ ] **Step 5: Run tests — all should pass so far**

```bash
pnpm test:memory
```

Expected: 8 (parse/stub) + 6 (repository) = 14 tests pass. IngestPipeline and Retriever tests still fail — expected.

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/repository.ts packages/memory/src/index.ts tests/integration/memory.test.ts
git commit -m "feat(memory): MemoryRepository with upsert, vector search, links, delete"
```

---

### Task 6: `MemoryIngestPipeline`

**Files:**

- Create: `packages/memory/src/ingest.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `tests/integration/memory.test.ts` (add ingest describe block)

- [ ] **Step 1: Add failing ingest tests to `tests/integration/memory.test.ts`**

First, add `MemoryIngestPipeline` to the @jarv1s/memory import:

```typescript
// Change:
import { MemoryRepository, StubEmbeddingProvider, parseDocument } from "@jarv1s/memory";
// To:
import {
  MemoryIngestPipeline,
  MemoryRepository,
  StubEmbeddingProvider,
  parseDocument
} from "@jarv1s/memory";
```

Then append the following describe block to the end of the file:

```typescript
// ── MemoryIngestPipeline ──────────────────────────────────────────────────────

describe("MemoryIngestPipeline", () => {
  const repo = new MemoryRepository();
  const provider = new StubEmbeddingProvider();
  const pipeline = new MemoryIngestPipeline(provider, repo);

  it("ingestFile produces memory_chunks for each parsed chunk", async () => {
    const filePath = "notes/ingest-test-1.md";
    const content = `## Overview\n\nThis is the overview.\n\n## Details\n\nThis is the details section.`;

    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, filePath, content);
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        await pipeline.ingestFile(scopedDb, vaultCtx, filePath);
        const result = await sql<{ count: string }>`
          SELECT count(*)::text FROM app.memory_chunks
          WHERE owner_user_id = ${userId}::uuid AND source_path = ${filePath}
        `.execute(scopedDb.db);
        expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
      });
    });
  });

  it("ingestFile stores wikilinks in memory_links", async () => {
    const filePath = "notes/ingest-links.md";
    const content = `# Link Test\n\nSee [[Alice]] and [[Bob]].`;

    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, filePath, content);
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        await pipeline.ingestFile(scopedDb, vaultCtx, filePath);
        const result = await sql<{ to_path: string }>`
          SELECT to_path FROM app.memory_links
          WHERE owner_user_id = ${userId}::uuid AND from_path = ${filePath}
          ORDER BY to_path
        `.execute(scopedDb.db);
        expect(result.rows.map((r) => r.to_path)).toEqual(["Alice", "Bob"]);
      });
    });
  });

  it("re-ingesting an edited file replaces old chunks with new ones", async () => {
    const filePath = "notes/ingest-edit.md";
    const original = `## Original\n\nOriginal content.`;
    const revised = `## Revised\n\nRevised content.`;

    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, filePath, original);
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        await pipeline.ingestFile(scopedDb, vaultCtx, filePath);
      });

      await writeVaultFile(vaultCtx, filePath, revised);
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        await pipeline.ingestFile(scopedDb, vaultCtx, filePath);
        const result = await sql<{ text: string }>`
          SELECT text FROM app.memory_chunks
          WHERE owner_user_id = ${userId}::uuid AND source_path = ${filePath}
        `.execute(scopedDb.db);
        expect(result.rows.some((r) => r.text.includes("Revised content."))).toBe(true);
        expect(result.rows.every((r) => !r.text.includes("Original content."))).toBe(true);
      });
    });
  });

  it("deleteFile removes all chunks and links for the path", async () => {
    const filePath = "notes/ingest-delete.md";
    const content = `# Delete Test\n\nSome content with [[Link]].`;

    await vaultRunner.withVaultContext(ctx(userId), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, filePath, content);
      await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
        await pipeline.ingestFile(scopedDb, vaultCtx, filePath);
        await pipeline.deleteFile(scopedDb, userId, filePath);
        const chunks = await sql<{ id: string }>`
          SELECT id FROM app.memory_chunks
          WHERE owner_user_id = ${userId}::uuid AND source_path = ${filePath}
        `.execute(scopedDb.db);
        const links = await sql<{ id: string }>`
          SELECT id FROM app.memory_links
          WHERE owner_user_id = ${userId}::uuid AND from_path = ${filePath}
        `.execute(scopedDb.db);
        expect(chunks.rows).toHaveLength(0);
        expect(links.rows).toHaveLength(0);
      });
    });
  });

  it("rebuildFromVault clears old index and re-indexes all .md files in the vault", async () => {
    // Use a separate user so we don't pollute other tests
    const rebuildUserId = "00000000-0000-4000-8000-000000000014";
    const rebuildClient = new Client({ connectionString: connectionStrings.bootstrap });
    await rebuildClient.connect();
    try {
      await rebuildClient.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, 'memory-rebuild@example.test', false)`,
        [rebuildUserId]
      );
    } finally {
      await rebuildClient.end();
    }

    await vaultRunner.withVaultContext(ctx(rebuildUserId), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, "notes/file-a.md", `## A\n\nContent A.`);
      await writeVaultFile(vaultCtx, "notes/file-b.md", `## B\n\nContent B.`);
      await writeVaultFile(vaultCtx, "notes/ignored.txt", "not markdown");

      await dataContext.withDataContext(ctx(rebuildUserId), async (scopedDb) => {
        await pipeline.rebuildFromVault(scopedDb, vaultCtx);
        const result = await sql<{ source_path: string }>`
          SELECT DISTINCT source_path FROM app.memory_chunks
          WHERE owner_user_id = ${rebuildUserId}::uuid
          ORDER BY source_path
        `.execute(scopedDb.db);
        const paths = result.rows.map((r) => r.source_path);
        expect(paths).toContain("notes/file-a.md");
        expect(paths).toContain("notes/file-b.md");
        expect(paths).not.toContain("notes/ignored.txt");
      });
    });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
pnpm test:memory
```

Expected: 14 pass, 5 new ingest tests fail.

- [ ] **Step 3: Create `packages/memory/src/ingest.ts`**

```typescript
import { createHash } from "node:crypto";

import { listVaultFilesRecursive, readVaultFile } from "@jarv1s/vault";
import type { DataContextDb } from "@jarv1s/db";
import type { VaultContext } from "@jarv1s/vault";

import type { EmbeddingProvider } from "./embedding-provider.js";
import { parseDocument } from "./parser.js";
import type { MemoryRepository, NewChunkData } from "./repository.js";

export class MemoryIngestPipeline {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly repository: MemoryRepository
  ) {}

  async ingestFile(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext,
    relativePath: string
  ): Promise<void> {
    const content = await readVaultFile(vaultCtx, relativePath);
    const { chunks, wikilinks } = parseDocument(content);

    const newChunks: NewChunkData[] = await Promise.all(
      chunks.map(async (chunk) => ({
        sourcePath: relativePath,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        contentHash: createHash("sha256").update(chunk.text).digest("hex"),
        text: chunk.text,
        embedding: await this.embeddingProvider.embed(chunk.text)
      }))
    );

    await this.repository.upsertFileChunks(scopedDb, vaultCtx.actorUserId, relativePath, newChunks);
    await this.repository.replaceFileLinks(scopedDb, vaultCtx.actorUserId, relativePath, wikilinks);
  }

  async deleteFile(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePath: string
  ): Promise<void> {
    await this.repository.deleteFileChunks(scopedDb, ownerUserId, sourcePath);
    await this.repository.replaceFileLinks(scopedDb, ownerUserId, sourcePath, []);
  }

  async rebuildFromVault(scopedDb: DataContextDb, vaultCtx: VaultContext): Promise<void> {
    await this.repository.deleteAllForUser(scopedDb, vaultCtx.actorUserId);
    const allFiles = await listVaultFilesRecursive(vaultCtx);
    for (const file of allFiles) {
      if (file.endsWith(".md")) {
        await this.ingestFile(scopedDb, vaultCtx, file);
      }
    }
  }
}
```

- [ ] **Step 4: Update `packages/memory/src/index.ts`**

```typescript
export type { EmbeddingProvider } from "./embedding-provider.js";
export { StubEmbeddingProvider } from "./embedding-provider.js";
export { MemoryIngestPipeline } from "./ingest.js";
export type { ParsedDocument, TextChunk } from "./parser.js";
export { parseDocument } from "./parser.js";
export type { NewChunkData, RetrievedChunk } from "./repository.js";
export { MemoryRepository } from "./repository.js";
```

- [ ] **Step 5: Run tests**

```bash
pnpm test:memory
```

Expected: 14 + 5 = 19 tests pass. Retriever tests still fail — expected.

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/ingest.ts packages/memory/src/index.ts tests/integration/memory.test.ts
git commit -m "feat(memory): MemoryIngestPipeline — ingest, delete, rebuild"
```

---

### Task 7: `MemoryRetriever`

**Files:**

- Create: `packages/memory/src/retrieval.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `tests/integration/memory.test.ts` (add retriever describe block)

- [ ] **Step 1: Add failing retriever tests to `tests/integration/memory.test.ts`**

First, add `MemoryRetriever` to the @jarv1s/memory import:

```typescript
// Change:
import {
  MemoryIngestPipeline,
  MemoryRepository,
  StubEmbeddingProvider,
  parseDocument
} from "@jarv1s/memory";
// To:
import {
  MemoryIngestPipeline,
  MemoryRepository,
  MemoryRetriever,
  StubEmbeddingProvider,
  parseDocument
} from "@jarv1s/memory";
```

Then append the following describe block to the end of the file:

```typescript
// ── MemoryRetriever ───────────────────────────────────────────────────────────

describe("MemoryRetriever", () => {
  const repo = new MemoryRepository();
  const provider = new StubEmbeddingProvider();
  const pipeline = new MemoryIngestPipeline(provider, repo);
  const retriever = new MemoryRetriever(provider, repo);

  // Use a dedicated user so these tests don't collide with earlier seeded data
  const retrieverUserId = "00000000-0000-4000-8000-000000000015";

  beforeAll(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1, 'memory-retriever@example.test', false)`,
        [retrieverUserId]
      );
    } finally {
      await client.end();
    }

    // Seed two files so retrieval has something to find
    await vaultRunner.withVaultContext(ctx(retrieverUserId), async (vaultCtx) => {
      await writeVaultFile(
        vaultCtx,
        "knowledge/alpha.md",
        `## Alpha\n\nAlpha is the first letter.`
      );
      await writeVaultFile(vaultCtx, "knowledge/beta.md", `## Beta\n\nBeta is the second letter.`);
      await dataContext.withDataContext(ctx(retrieverUserId), async (scopedDb) => {
        await pipeline.ingestFile(scopedDb, vaultCtx, "knowledge/alpha.md");
        await pipeline.ingestFile(scopedDb, vaultCtx, "knowledge/beta.md");
      });
    });
  });

  it("retrieve returns chunks with provenance (sourcePath, lineStart, lineEnd)", async () => {
    const results = await dataContext.withDataContext(ctx(retrieverUserId), async (scopedDb) =>
      retriever.retrieve(scopedDb, "the first letter", 10)
    );
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first).toMatchObject({
      sourcePath: expect.any(String),
      lineStart: expect.any(Number),
      lineEnd: expect.any(Number),
      text: expect.any(String),
      similarity: expect.any(Number)
    });
    expect(first?.sourcePath).toMatch(/knowledge\/(alpha|beta)\.md/);
  });

  it("retrieve is owner-scoped: other user sees no results from this user's vault", async () => {
    const results = await dataContext.withDataContext(ctx(otherUserId), async (scopedDb) =>
      retriever.retrieve(scopedDb, "the first letter", 10)
    );
    // otherUserId has no ingested data, so no results from retrieverUserId's vault
    expect(
      results.every(
        (r) => r.sourcePath !== "knowledge/alpha.md" && r.sourcePath !== "knowledge/beta.md"
      )
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
pnpm test:memory
```

Expected: 19 pass, 2 new retriever tests fail.

- [ ] **Step 3: Create `packages/memory/src/retrieval.ts`**

```typescript
import type { DataContextDb } from "@jarv1s/db";

import type { EmbeddingProvider } from "./embedding-provider.js";
import type { MemoryRepository, RetrievedChunk } from "./repository.js";

export class MemoryRetriever {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly repository: MemoryRepository
  ) {}

  async retrieve(
    scopedDb: DataContextDb,
    query: string,
    limit: number = 10
  ): Promise<RetrievedChunk[]> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    return this.repository.vectorSearch(scopedDb, queryEmbedding, limit);
  }
}
```

- [ ] **Step 4: Update `packages/memory/src/index.ts`** (final state)

```typescript
export type { EmbeddingProvider } from "./embedding-provider.js";
export { StubEmbeddingProvider } from "./embedding-provider.js";
export { MemoryIngestPipeline } from "./ingest.js";
export type { ParsedDocument, TextChunk } from "./parser.js";
export { parseDocument } from "./parser.js";
export type { NewChunkData, RetrievedChunk } from "./repository.js";
export { MemoryRepository } from "./repository.js";
export { MemoryRetriever } from "./retrieval.js";
```

- [ ] **Step 5: Run all memory tests**

```bash
pnpm test:memory
```

Expected: All 21 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/retrieval.ts packages/memory/src/index.ts tests/integration/memory.test.ts
git commit -m "feat(memory): MemoryRetriever — vector search with provenance"
```

---

### Task 8: Module manifest + registry registration

**Files:**

- Create: `packages/memory/src/manifest.ts`
- Modify: `packages/module-registry/src/index.ts`
- Modify: `packages/memory/src/index.ts`

This wires the memory module's SQL migration directory into the migrate script so it runs automatically via `pnpm db:migrate` / `pnpm verify:foundation`.

- [ ] **Step 1: Create `packages/memory/src/manifest.ts`**

```typescript
import { fileURLToPath } from "node:url";

import type { JarvisModuleManifest } from "@jarv1s/module-sdk";

export const MEMORY_MODULE_ID = "memory";
export const memorySqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const memoryModuleManifest: JarvisModuleManifest = {
  id: MEMORY_MODULE_ID,
  name: "Memory",
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
    migrations: ["sql/0001_memory_index.sql"],
    migrationDirectories: ["packages/memory/sql"],
    ownedTables: ["app.memory_chunks", "app.memory_links"]
  }
};
```

- [ ] **Step 2: Export manifest from `packages/memory/src/index.ts`** (add to existing exports)

```typescript
export { memoryModuleManifest, memorySqlMigrationDirectory, MEMORY_MODULE_ID } from "./manifest.js";
```

- [ ] **Step 3: Register memory in `packages/module-registry/src/index.ts`**

Add the import at the top alongside other module imports:

```typescript
import { memoryModuleManifest, memorySqlMigrationDirectory } from "@jarv1s/memory";
```

Add `@jarv1s/memory` to `packages/module-registry/package.json` dependencies:

```json
"@jarv1s/memory": "workspace:*"
```

Add to the `BUILT_IN_MODULES` array (alongside the other entries — order is not critical):

```typescript
{
  manifest: memoryModuleManifest,
  sqlMigrationDirectories: [memorySqlMigrationDirectory],
  queueDefinitions: [],
},
```

- [ ] **Step 4: Re-run pnpm install**

```bash
pnpm install
```

- [ ] **Step 5: Verify migration is discovered and idempotent**

```bash
pnpm db:migrate
```

Expected: "no SQL migrations applied; 28 already current" (the memory migration was already applied in Task 1 Step 5; module-registry now discovers it for future fresh installs).

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/manifest.ts \
  packages/memory/src/index.ts \
  packages/module-registry/src/index.ts \
  packages/module-registry/package.json
git commit -m "feat(memory): module manifest + module-registry registration"
```

---

### Task 9: Foundation gate

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
no SQL migrations applied; 28 already current
Integration Test Files  14 passed (14)
Integration Tests       160 passed (160)
```

(13 pre-existing test files → 14 with memory.test.ts; 138 pre-existing tests → +21 memory + 1 vault update = ~160)

- [ ] **Step 3: Commit any format-only changes**

```bash
git add -A
git commit -m "chore: format after memory module addition"
```

---

## Verification Commands

```bash
pnpm test:vault                     # Slice 2 vault tests still green
pnpm test:memory                    # 21 memory tests (parse, stub, repo, ingest, retriever)
pnpm verify:foundation              # full gate
```

## Notes for Implementer

- `pnpm db:reset` is required before running any tests if the Postgres container was already running with the old `postgres:17-alpine` image. The new `pgvector/pgvector:pg17` image must be pulled first (`docker pull pgvector/pgvector:pg17`).
- The `StubEmbeddingProvider` returns deterministic 384-dim vectors. It is not semantically meaningful — tests verify index correctness, not ranking quality. A real `LocalEmbeddingProvider` (using `@xenova/transformers` or similar) can be added as a separate task once the interface is validated.
- The `vectorSearch` SQL uses RLS implicitly (the `owner_user_id` condition comes from the RLS policy). The explicit `WHERE` clause in `deleteFileChunks` / `deleteAllForUser` is belt-and-suspenders (RLS enforces the constraint; explicit clauses prevent accidental cross-user writes in future).
- `content_hash` is stored but not used for deduplication in this slice (full replace strategy). Hash-based skip-unchanged-chunks is a performance optimization for a future slice.
