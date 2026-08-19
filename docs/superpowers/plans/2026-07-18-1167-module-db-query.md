# Module `ctx.db.query` (#1167) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the module-facing `ctx.db.query` seam (#914 slice 4, worker half): D5 bounds on `createModuleStorageRpc`, a `db.query` RPC in the worker host, and `ctx.db` in the module SDK — so FIN-06 (and every future module) can run bounded SQL against its own declared tables.

**Architecture:** All enforcement lives parent-side in `@jarv1s/db` (`classifyModuleStatement` allowlist + `ModuleQueryBounds` caps inside `createModuleStorageRpc`); the worker host (`worker-rpc-host.ts`) adds a thin `db.query` branch that requires a declared `database.ownedTables`, maps read-risk to `readOnly`, and maps classifier errors to RPC error codes; the SDK adds a `ctx.db.query` proxy over the existing JSON-RPC `callParent`. `MODULE_WORKER_CONTRACT_VERSION` stays `1` (additive context member; the version gates the stdio protocol shape, which is unchanged).

**Tech Stack:** TypeScript, Kysely (`CompiledQuery.raw`), node-postgres, Vitest, existing module-role broker (`SET LOCAL ROLE jarvis_mod_<slug>_runtime`) and RLS generation.

**Task issue:** #1167 (platform prerequisite of FIN-06 #1166). **Spec:** `docs/superpowers/specs/2026-07-18-fin-06-tables-migration-delta.md` (slice 1) + `docs/superpowers/specs/2026-07-09-module-data-plane.md` D5. Spec approval record: merged PR #1168.

## Global Constraints

- Branch: `feat/1167-module-db-query` off `origin/main`. One commit per task, message verbatim from the task's commit step, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Explicit `git add <paths>` only — never `-A`/`.`; NEVER stage `.claude/context-meter.log`.
- Run `pnpm exec prettier --write <files>` on every file you touched before each commit.
- Allowlist + redaction are ALWAYS on — `ModuleQueryBounds` has no escape for them. Only the numeric caps/timeout accept `null` (= disabled, platform-internal escape for the export path).
- Default bound values (exported constants, exact): `MODULE_QUERY_STATEMENT_TIMEOUT_MS = 5_000`, `MODULE_QUERY_ROW_CAP = 5_000`, `MODULE_QUERY_RESULT_BYTE_CAP = 5 * 1024 * 1024`.
- Errors crossing to workers or logs carry NO query text, NO params, NO pg `detail`/`hint` fields (pg detail can echo row data). The pg primary message + SQLSTATE are kept — they are read only by the authoring module's host-side consumers. Verified during grounding: `worker-runtime.ts` already sends workers a generic `rpc_failed` and never logs RPC failures, so no runtime logging change is needed.
- No new dependencies. `@jarv1s/module-registry` already depends on `@jarv1s/db` (package.json line 22).
- Fail-closed bias: any SQL construct the classifier cannot prove safe is rejected (`forbidden_statement`). Documented false positives (identifiers colliding with keywords, `LIKE'x'` without a space, `set_config` as a string literal) are acceptable — module authors quote/space around them.
- This change is not user-visible — say that plainly in the PR summary (release-note line: platform plumbing for module-owned tables; no user-facing behavior change).

---

### Task 1: Statement classifier + `ModuleQueryError` (`@jarv1s/db`)

**Files:**

- Create: `packages/db/src/module-statement-classify.ts`
- Modify: `packages/db/src/index.ts` (add one `export *` line)
- Test: `tests/unit/module-statement-classify.test.ts`

**Interfaces:**

- Consumes: nothing (pure function + error class).
- Produces: `classifyModuleStatement(queryText: string): ModuleStatementKind` where `ModuleStatementKind = "select" | "insert" | "update" | "delete"` (throws `ModuleQueryError` otherwise); `class ModuleQueryError extends Error` with `readonly code: ModuleQueryErrorCode`, `readonly sqlstate?: string`, `name === "ModuleQueryError"`, message `` `${code}: ${detail}` ``; `ModuleQueryErrorCode = "forbidden_statement" | "forbidden_mutation" | "row_cap_exceeded" | "result_byte_cap_exceeded" | "db_query_failed"`. Task 2 imports both; Task 3 imports `ModuleQueryError` from `@jarv1s/db`.

Security requirements this classifier enforces (each has a test):

1. Only SELECT / INSERT / UPDATE / DELETE (incl. WITH-prefixed) — no DDL, TRUNCATE, COPY, transaction control, SET.
2. A data-modifying CTE (`WITH d AS (DELETE …) SELECT …`) classifies as the mutation, at ANY paren depth — otherwise a read-risk tool could mutate through a "select".
3. `set_config` is rejected outright (case-insensitive substring, fail closed): a volatile `set_config('app.actor_user_id', …, true)` inside an allowed SELECT would spoof the RLS GUCs.
4. `U&'…'`/`U&"…"` (unicode-escape literals/identifiers) rejected — they can assemble `set_config` without the literal substring.
5. `E'…'` strings rejected — backslash escapes (`E'\''`) would desync the quote skipper and hide keywords.
6. Dollar-quoted strings (`$$…$$`, `$tag$…$tag$`) rejected — same skipper-desync class. `$1`-style positional params are allowed.
7. Multiple statements (`SELECT 1; DELETE …`) rejected by the classifier itself: node-postgres falls back to the SIMPLE query protocol for parameterless queries, which WOULD execute the second command. A trailing semicolon (only whitespace/comments after) is allowed.
8. Unterminated strings/block comments rejected.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/module-statement-classify.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyModuleStatement, ModuleQueryError } from "@jarv1s/db";

// #1167 — the statement allowlist is the security boundary in front of
// module-authored SQL (spec 2026-07-09-module-data-plane.md D5). Every case
// here is either a required acceptance or a documented fail-closed rejection.

function classifyError(text: string): ModuleQueryError {
  try {
    classifyModuleStatement(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleQueryError);
    return error as ModuleQueryError;
  }
  throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
}

describe("classifyModuleStatement", () => {
  it("classifies the four allowed kinds", () => {
    expect(classifyModuleStatement("SELECT * FROM app.t WHERE a = $1")).toBe("select");
    expect(classifyModuleStatement("insert into app.t (a) values ($1)")).toBe("insert");
    expect(classifyModuleStatement("UPDATE app.t SET a = $1 WHERE b = $2")).toBe("update");
    expect(classifyModuleStatement("DELETE FROM app.t WHERE a = $1")).toBe("delete");
  });

  it("classifies WITH + top-level select as select", () => {
    expect(
      classifyModuleStatement("WITH recent AS (SELECT * FROM app.t) SELECT count(*) FROM recent")
    ).toBe("select");
  });

  it("classifies WITH + top-level mutation as the mutation", () => {
    expect(classifyModuleStatement("WITH x AS (SELECT 1) UPDATE app.t SET a = 2")).toBe("update");
  });

  it("classifies a data-modifying CTE as the mutation (any depth)", () => {
    // The readOnly-bypass case: depth-0-only scanning would call this "select".
    expect(
      classifyModuleStatement("WITH d AS (DELETE FROM app.t RETURNING id) SELECT * FROM d")
    ).toBe("delete");
    expect(
      classifyModuleStatement(
        "WITH a AS (SELECT 1), b AS (INSERT INTO app.t (x) VALUES (1)) SELECT * FROM a"
      )
    ).toBe("insert");
  });

  it("ignores keywords inside string literals and quoted identifiers", () => {
    expect(classifyModuleStatement("SELECT 'DELETE FROM x' AS label FROM app.t")).toBe("select");
    expect(classifyModuleStatement('SELECT "delete" FROM app.t')).toBe("select");
    expect(classifyModuleStatement("SELECT 'it''s fine' FROM app.t")).toBe("select");
  });

  it("skips comments", () => {
    expect(classifyModuleStatement("-- lead comment\n/* block */ SELECT 1")).toBe("select");
  });

  it("rejects non-allowlisted statement kinds", () => {
    expect(classifyError("TRUNCATE app.t").code).toBe("forbidden_statement");
    expect(classifyError("DROP TABLE app.t").code).toBe("forbidden_statement");
    expect(classifyError("COPY app.t TO STDOUT").code).toBe("forbidden_statement");
    expect(classifyError("BEGIN").code).toBe("forbidden_statement");
    expect(classifyError("SET ROLE postgres").code).toBe("forbidden_statement");
    expect(classifyError("EXPLAIN SELECT 1").code).toBe("forbidden_statement");
  });

  it("rejects set_config anywhere, fail closed (RLS GUC spoofing)", () => {
    expect(classifyError("SELECT set_config('app.actor_user_id', 'victim', true)").code).toBe(
      "forbidden_statement"
    );
    expect(
      classifyError("WITH s AS (SELECT SET_CONFIG('role', 'postgres', true)) SELECT * FROM s").code
    ).toBe("forbidden_statement");
    // Documented false positive: even as a plain string literal it is rejected.
    expect(classifyError("SELECT 'set_config'").code).toBe("forbidden_statement");
  });

  it("rejects unicode-escape and escape-string literals (skipper desync)", () => {
    expect(classifyError("SELECT U&'\\0064elete'").code).toBe("forbidden_statement");
    expect(classifyError('SELECT U&"x" FROM app.t').code).toBe("forbidden_statement");
    expect(classifyError("SELECT E'\\'' , x FROM app.t").code).toBe("forbidden_statement");
  });

  it("rejects dollar-quoted strings but allows positional params", () => {
    expect(classifyError("SELECT $$DELETE FROM app.t$$").code).toBe("forbidden_statement");
    expect(classifyError("SELECT $fn$body$fn$").code).toBe("forbidden_statement");
    expect(classifyModuleStatement("SELECT * FROM app.t WHERE a = $1 AND b = $22")).toBe("select");
  });

  it("rejects multiple statements; allows one trailing semicolon", () => {
    // node-pg uses the simple protocol for parameterless queries — a second
    // command after ';' would actually EXECUTE, so the classifier must reject it.
    expect(classifyError("SELECT 1; DELETE FROM app.t").code).toBe("forbidden_statement");
    expect(classifyError("SELECT 1;\n-- c\nDELETE FROM app.t").code).toBe("forbidden_statement");
    expect(classifyModuleStatement("SELECT 1;")).toBe("select");
    expect(classifyModuleStatement("SELECT 1; -- trailing comment")).toBe("select");
  });

  it("rejects unterminated constructs and empty input", () => {
    expect(classifyError("SELECT 'unterminated").code).toBe("forbidden_statement");
    expect(classifyError("/* unterminated SELECT 1").code).toBe("forbidden_statement");
    expect(classifyError("").code).toBe("forbidden_statement");
    expect(classifyError("   -- only a comment").code).toBe("forbidden_statement");
  });

  it("formats the error contract", () => {
    const error = classifyError("TRUNCATE app.t");
    expect(error.name).toBe("ModuleQueryError");
    expect(error.message).toContain("forbidden_statement");
    expect(error.sqlstate).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/module-statement-classify.test.ts`
Expected: FAIL — `@jarv1s/db` has no export `classifyModuleStatement`.

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/module-statement-classify.ts`:

```typescript
// #1167 (#914 D5) — the statement allowlist in front of module-authored SQL.
// This is a SECURITY boundary, not a SQL parser: anything it cannot prove to
// be a single SELECT/INSERT/UPDATE/DELETE is rejected (fail closed). Known
// false positives (unquoted identifiers named like DML keywords, `LIKE'x'`
// without a space, `set_config` inside a string literal) are accepted costs —
// module authors quote identifiers or add a space.

export type ModuleStatementKind = "select" | "insert" | "update" | "delete";

export type ModuleQueryErrorCode =
  | "forbidden_statement"
  | "forbidden_mutation"
  | "row_cap_exceeded"
  | "result_byte_cap_exceeded"
  | "db_query_failed";

export class ModuleQueryError extends Error {
  constructor(
    readonly code: ModuleQueryErrorCode,
    detail: string,
    readonly sqlstate?: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "ModuleQueryError";
  }
}

const STATEMENT_KINDS: Readonly<Record<string, ModuleStatementKind>> = {
  SELECT: "select",
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete"
};

function forbidden(detail: string): ModuleQueryError {
  return new ModuleQueryError("forbidden_statement", detail);
}

/** Skip a `'…'` or `"…"` region; `''`/`""` doubling is the only escape. */
function skipQuoted(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw forbidden("unterminated quoted literal");
}

/** True when only whitespace and comments remain after `from`. */
function isOnlyTrailingTrivia(text: string, from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    if (ch === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i + 2);
      if (newline === -1) return true;
      i = newline;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return false;
      i = close + 1;
      continue;
    }
    return false;
  }
  return true;
}

export function classifyModuleStatement(queryText: string): ModuleStatementKind {
  // Fail-closed prefilters, checked against the RAW text so no lexer state can
  // hide them:
  // - set_config would spoof the RLS GUCs (app.actor_user_id / role) from
  //   inside an otherwise-allowed SELECT (volatile CTEs are guaranteed-executed).
  // - U&'…' unicode escapes can assemble "set_config" without the substring.
  // - E'…' backslash escapes (E'\'') desync skipQuoted and could hide keywords.
  if (/set_config/i.test(queryText)) throw forbidden("set_config is not allowed");
  if (/u&['"]/i.test(queryText)) throw forbidden("unicode-escaped literals are not allowed");
  if (/[eE]'/.test(queryText)) throw forbidden("escape string literals are not allowed");

  let depth = 0;
  let firstWord: string | undefined;
  let topLevelKind: ModuleStatementKind | undefined;
  let mutationKind: ModuleStatementKind | undefined;
  let i = 0;
  while (i < queryText.length) {
    const ch = queryText[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && queryText[i + 1] === "-") {
      const newline = queryText.indexOf("\n", i + 2);
      if (newline === -1) break;
      i = newline + 1;
      continue;
    }
    if (ch === "/" && queryText[i + 1] === "*") {
      const close = queryText.indexOf("*/", i + 2);
      if (close === -1) throw forbidden("unterminated block comment");
      i = close + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(queryText, i);
      continue;
    }
    if (ch === "$") {
      if (/[0-9]/.test(queryText[i + 1] ?? "")) {
        i += 1;
        while (i < queryText.length && /[0-9]/.test(queryText[i]!)) i += 1;
        continue;
      }
      throw forbidden("dollar-quoted strings are not allowed");
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ";") {
      // node-postgres uses the SIMPLE query protocol for parameterless
      // queries, which executes multiple ';'-separated commands — reject here
      // rather than trusting the server to.
      if (!isOnlyTrailingTrivia(queryText, i + 1)) {
        throw forbidden("multiple SQL statements are not allowed");
      }
      break;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < queryText.length && /[A-Za-z0-9_]/.test(queryText[end]!)) end += 1;
      const word = queryText.slice(i, end).toUpperCase();
      i = end;
      if (firstWord === undefined) {
        firstWord = word;
        if (word !== "WITH") {
          const kind = STATEMENT_KINDS[word];
          if (kind === undefined) throw forbidden(`statement kind ${word} is not allowed`);
          topLevelKind = kind;
          if (kind !== "select") mutationKind = kind;
        }
        continue;
      }
      if (firstWord === "WITH") {
        const kind = STATEMENT_KINDS[word];
        if (kind !== undefined) {
          // Postgres only allows data-modifying statements in WITH at the top
          // level of the query, so ANY mutation keyword under a WITH decides
          // the kind — regardless of paren depth (data-modifying CTEs).
          if (kind !== "select") mutationKind ??= kind;
          else if (depth === 0) topLevelKind ??= "select";
        }
      }
      continue;
    }
    i += 1;
  }
  if (firstWord === undefined) throw forbidden("empty statement");
  if (mutationKind !== undefined) return mutationKind;
  if (topLevelKind === undefined) throw forbidden("no top-level statement found");
  return topLevelKind;
}
```

Then add to `packages/db/src/index.ts`, next to the existing line 9 `export * from "./module-storage-rpc.js";`:

```typescript
export * from "./module-statement-classify.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/module-statement-classify.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/db/src/module-statement-classify.ts packages/db/src/index.ts tests/unit/module-statement-classify.test.ts
git add packages/db/src/module-statement-classify.ts packages/db/src/index.ts tests/unit/module-statement-classify.test.ts
git commit -m "feat(db): statement allowlist classifier for module SQL (#1167)

Not user-visible: platform plumbing for module-owned tables.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `ModuleQueryBounds` in `createModuleStorageRpc` + data-export escape

**Files:**

- Modify: `packages/db/src/module-storage-rpc.ts` (full rewrite shown below; currently 38 lines)
- Modify: `packages/settings/src/data-export.ts` (the `createModuleStorageRpc` call inside `readExternalModuleExportRows`, around lines 180–215)
- Test: `tests/integration/module-storage-rpc.test.ts` (extend; keep the existing RLS test untouched)

**Interfaces:**

- Consumes: `classifyModuleStatement`, `ModuleQueryError` from `./module-statement-classify.js` (Task 1).
- Produces: `createModuleStorageRpc(scopedDb: DataContextDb, moduleId: string, bounds?: ModuleQueryBounds): ModuleStorageRpc` — third arg NEW, optional, so the existing export-path call keeps compiling; `ModuleQueryBounds = { readOnly?: boolean; statementTimeoutMs?: number | null; rowCap?: number | null; resultByteCap?: number | null }` (`undefined` → default, `null` → disabled); exported constants `MODULE_QUERY_STATEMENT_TIMEOUT_MS` / `MODULE_QUERY_ROW_CAP` / `MODULE_QUERY_RESULT_BYTE_CAP`. Task 3 calls this with `{ readOnly: input.toolRisk === "read" }` and maps `ModuleQueryError` codes.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe` in `tests/integration/module-storage-rpc.test.ts` (imports to extend: add `createModuleStorageRpc` is already imported; add `ModuleQueryError` to the `@jarv1s/db` import; add `randomUUID` is already imported from `node:crypto`):

```typescript
// ---- #1167 D5 bounds ---------------------------------------------------------------

it("rejects non-allowlisted statements before they reach Postgres", async () => {
  const owner = randomUUID();
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query("TRUNCATE app.storage_rpc_fixture_items");
    })
  ).rejects.toMatchObject({ name: "ModuleQueryError", code: "forbidden_statement" });
});

it("rejects set_config even wrapped in an allowed SELECT (RLS GUC spoofing)", async () => {
  const owner = randomUUID();
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query("SELECT set_config('app.actor_user_id', $1, true)", [randomUUID()]);
    })
  ).rejects.toMatchObject({ code: "forbidden_statement" });
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query("WITH s AS (SELECT set_config('role', 'postgres', true)) SELECT 1");
    })
  ).rejects.toMatchObject({ code: "forbidden_statement" });
});

it("readOnly blocks plain mutations AND data-modifying CTEs", async () => {
  const owner = randomUUID();
  // Plant one row through the write path first.
  await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
    const rpc = createModuleStorageRpc(scopedDb, moduleId);
    await rpc.query(
      "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) VALUES ($1, $2)",
      [owner, "survives-readonly"]
    );
  });
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, { readOnly: true });
      await rpc.query(
        "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) VALUES ($1, $2)",
        [owner, "blocked"]
      );
    })
  ).rejects.toMatchObject({ name: "ModuleQueryError", code: "forbidden_mutation" });
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, { readOnly: true });
      await rpc.query(
        "WITH d AS (DELETE FROM app.storage_rpc_fixture_items RETURNING id) SELECT * FROM d"
      );
    })
  ).rejects.toMatchObject({ code: "forbidden_mutation" });
  // The CTE delete really did not run.
  await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
    const rpc = createModuleStorageRpc(scopedDb, moduleId, { readOnly: true });
    const rows = await rpc.query(
      "SELECT label FROM app.storage_rpc_fixture_items WHERE owner_user_id = $1",
      [owner]
    );
    expect(rows.rows).toEqual([{ label: "survives-readonly" }]);
  });
});

it("enforces statement_timeout as db_query_failed with SQLSTATE 57014", async () => {
  const owner = randomUUID();
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, { statementTimeoutMs: 200 });
      await rpc.query("SELECT pg_sleep(1)");
    })
  ).rejects.toMatchObject({
    name: "ModuleQueryError",
    code: "db_query_failed",
    sqlstate: "57014"
  });
});

it("enforces rowCap (error, not truncation) and resultByteCap", async () => {
  const owner = randomUUID();
  await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
    const rpc = createModuleStorageRpc(scopedDb, moduleId);
    await rpc.query(
      "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) SELECT $1, 'row-' || n FROM generate_series(1, 3) AS n",
      [owner]
    );
  });
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, { rowCap: 2 });
      await rpc.query("SELECT * FROM app.storage_rpc_fixture_items WHERE owner_user_id = $1", [
        owner
      ]);
    })
  ).rejects.toMatchObject({ code: "row_cap_exceeded" });
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, { resultByteCap: 1024 });
      await rpc.query("SELECT repeat('x', 5000) AS blob");
    })
  ).rejects.toMatchObject({ code: "result_byte_cap_exceeded" });
});

it("null bounds disable every cap (export escape hatch)", async () => {
  const owner = randomUUID();
  await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
    const rpc = createModuleStorageRpc(scopedDb, moduleId, {
      statementTimeoutMs: null,
      rowCap: null,
      resultByteCap: null
    });
    // Would trip a rowCap of 2 and a small byteCap; must pass with nulls.
    const rows = await rpc.query<{ blob: string }>(
      "SELECT repeat('x', 5000) AS blob FROM generate_series(1, 3)"
    );
    expect(rows.rows).toHaveLength(3);
  });
});

it("redacts driver errors: keeps SQLSTATE + primary message, drops pg detail", async () => {
  const owner = randomUUID();
  const marker = randomUUID();
  await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
    const rpc = createModuleStorageRpc(scopedDb, moduleId);
    await rpc.query(
      "INSERT INTO app.storage_rpc_fixture_items (id, owner_user_id, label) VALUES ($1, $2, $3)",
      [marker, owner, "first"]
    );
  });
  let caught: ModuleQueryError | undefined;
  await dataContext
    .withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query(
        "INSERT INTO app.storage_rpc_fixture_items (id, owner_user_id, label) VALUES ($1, $2, $3)",
        [marker, owner, "duplicate"]
      );
    })
    .catch((error: ModuleQueryError) => {
      caught = error;
    });
  expect(caught).toBeInstanceOf(ModuleQueryError);
  expect(caught?.code).toBe("db_query_failed");
  expect(caught?.sqlstate).toBe("23505");
  // pg's DETAIL line ("Key (id)=(<uuid>) already exists.") carries row data —
  // the redaction contract is that it never reaches the error message.
  expect(caught?.message).not.toContain(marker);
});

it("rejects multi-statement input at the classifier (simple-protocol guard)", async () => {
  const owner = randomUUID();
  await expect(
    dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query("SELECT 1; DELETE FROM app.storage_rpc_fixture_items");
    })
  ).rejects.toMatchObject({ code: "forbidden_statement" });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec tsx scripts/test-integration.ts tests/integration/module-storage-rpc.test.ts`
Expected: existing RLS test PASS; new tests FAIL (no third parameter, no `ModuleQueryError` mapping).

- [ ] **Step 3: Rewrite `packages/db/src/module-storage-rpc.ts`**

```typescript
import { CompiledQuery, sql } from "kysely";
import type { DataContextDb } from "./data-context.js";
import { moduleRuntimeRoleName } from "./module-role-broker.js";
import { classifyModuleStatement, ModuleQueryError } from "./module-statement-classify.js";

// #1167 (#914 D5): the ONLY door module-authored SQL may pass through. The
// statement allowlist and error redaction are unconditional; timeout and
// row/byte caps default on and can be disabled (null) only by platform-side
// callers (data export needs unbounded reads).

export const MODULE_QUERY_STATEMENT_TIMEOUT_MS = 5_000;
export const MODULE_QUERY_ROW_CAP = 5_000;
export const MODULE_QUERY_RESULT_BYTE_CAP = 5 * 1024 * 1024;

export interface ModuleQueryResult<T> {
  readonly rows: readonly T[];
}

export interface ModuleStorageRpc {
  query<T = Record<string, unknown>>(
    queryText: string,
    params?: readonly unknown[]
  ): Promise<ModuleQueryResult<T>>;
}

export interface ModuleQueryBounds {
  /** Reject anything but SELECT (read-risk tools). Default false. */
  readonly readOnly?: boolean;
  /** SET LOCAL statement_timeout in ms; null disables. Default 5000. */
  readonly statementTimeoutMs?: number | null;
  /** Max returned rows (error, not truncation); null disables. Default 5000. */
  readonly rowCap?: number | null;
  /** Max JSON-serialized result bytes; null disables. Default 5 MiB. */
  readonly resultByteCap?: number | null;
}

/** SQLSTATE is 5 chars from [0-9A-Z]; anything else is not a pg error code. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function redactedQueryError(error: unknown): ModuleQueryError {
  const candidate = error as { code?: unknown; message?: unknown };
  const sqlstate =
    typeof candidate.code === "string" && SQLSTATE_PATTERN.test(candidate.code)
      ? candidate.code
      : undefined;
  // node-postgres puts ONLY the primary message on .message — the data-bearing
  // fields (detail, hint, where) are separate properties and are dropped here
  // by construction. The primary message may echo tokens from the module's own
  // query text; only the authoring module's host-side consumers read it.
  const message = typeof candidate.message === "string" ? candidate.message : "query failed";
  return new ModuleQueryError("db_query_failed", message, sqlstate);
}

function assertBound(name: string, value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`createModuleStorageRpc: invalid ${name}: ${value}`);
  }
}

export function createModuleStorageRpc(
  scopedDb: DataContextDb,
  moduleId: string,
  bounds: ModuleQueryBounds = {}
): ModuleStorageRpc {
  const role = moduleRuntimeRoleName(moduleId);
  const readOnly = bounds.readOnly ?? false;
  const timeoutMs =
    bounds.statementTimeoutMs === undefined
      ? MODULE_QUERY_STATEMENT_TIMEOUT_MS
      : bounds.statementTimeoutMs;
  const rowCap = bounds.rowCap === undefined ? MODULE_QUERY_ROW_CAP : bounds.rowCap;
  const resultByteCap =
    bounds.resultByteCap === undefined ? MODULE_QUERY_RESULT_BYTE_CAP : bounds.resultByteCap;
  assertBound("statementTimeoutMs", timeoutMs);
  assertBound("rowCap", rowCap);
  assertBound("resultByteCap", resultByteCap);
  return {
    async query<T = Record<string, unknown>>(
      queryText: string,
      params: readonly unknown[] = []
    ): Promise<ModuleQueryResult<T>> {
      const kind = classifyModuleStatement(queryText);
      if (readOnly && kind !== "select") {
        throw new ModuleQueryError(
          "forbidden_mutation",
          `${kind} is not allowed from a read-only tool`
        );
      }
      await sql.raw(`SET LOCAL ROLE ${role}`).execute(scopedDb.db);
      if (timeoutMs !== null) {
        // Value is a validated positive integer — safe to inline; ms units.
        await sql.raw(`SET LOCAL statement_timeout = ${timeoutMs}`).execute(scopedDb.db);
      }
      let result;
      try {
        result = await scopedDb.db.executeQuery<T>(CompiledQuery.raw(queryText, [...params]));
      } catch (error) {
        throw redactedQueryError(error);
      } finally {
        if (timeoutMs !== null) {
          try {
            await sql.raw("SET LOCAL statement_timeout TO DEFAULT").execute(scopedDb.db);
          } catch {
            // A timed-out statement aborts the transaction; the SET LOCAL
            // dies with the rollback anyway.
          }
        }
      }
      if (rowCap !== null && result.rows.length > rowCap) {
        throw new ModuleQueryError("row_cap_exceeded", `query returned more than ${rowCap} rows`);
      }
      if (resultByteCap !== null) {
        const bytes = Buffer.byteLength(JSON.stringify(result.rows), "utf8");
        if (bytes > resultByteCap) {
          throw new ModuleQueryError(
            "result_byte_cap_exceeded",
            `result exceeds ${resultByteCap} bytes`
          );
        }
      }
      return { rows: result.rows };
    }
  };
}
```

- [ ] **Step 4: Add the export escape in `packages/settings/src/data-export.ts`**

Inside `readExternalModuleExportRows`, change the existing `createModuleStorageRpc(scopedDb, manifest.id)` call to:

```typescript
const rpc = createModuleStorageRpc(scopedDb, manifest.id, {
  // Export must return every row of every owned table — the interactive
  // caps (5s / 5000 rows / 5 MiB, #1167) would truncate large exports.
  // The allowlist and redaction stay on; the statement here is a SELECT.
  statementTimeoutMs: null,
  rowCap: null,
  resultByteCap: null
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec tsx scripts/test-integration.ts tests/integration/module-storage-rpc.test.ts`
Expected: PASS (all, including the pre-existing RLS test).
Also run: `pnpm exec tsx scripts/test-integration.ts tests/integration/data-export.test.ts`
Expected: PASS (export path unchanged behaviorally).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/db/src/module-storage-rpc.ts packages/settings/src/data-export.ts tests/integration/module-storage-rpc.test.ts
git add packages/db/src/module-storage-rpc.ts packages/settings/src/data-export.ts tests/integration/module-storage-rpc.test.ts
git commit -m "feat(db): D5 bounds on createModuleStorageRpc — allowlist, timeout, caps, redaction (#1167)

Not user-visible: platform plumbing for module-owned tables.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `db.query` RPC in the worker host

**Files:**

- Modify: `packages/module-registry/src/external/worker-rpc-host.ts`
- Test: `tests/integration/module-worker-rpc.test.ts` (extend)

**Interfaces:**

- Consumes: `createModuleStorageRpc`, `ModuleQueryError` from `@jarv1s/db` (Tasks 1–2); existing helpers `record(value)` and `stringParam(value, key)` in worker-rpc-host.ts; existing `ExternalModuleRpcError`.
- Produces: JSON-RPC method `db.query` with params `{ text: string, params?: unknown[] }`, resolving `{ rows: T[] }`; `ExternalModuleRpcError` code union extended with `"undeclared_database" | "forbidden_db_statement" | "forbidden_db_mutation"`. Task 4's SDK proxy calls exactly this method shape.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` to `tests/integration/module-worker-rpc.test.ts`. It needs its own fixture module with a `database` declaration; module `acme-a` (no `database` key) doubles as the undeclared case. Add `Client` is already imported from `pg`; extend the `@jarv1s/db` import with `ensureModuleRoles, generateModuleTableRlsSql` (mirroring `tests/integration/module-storage-rpc.test.ts`).

```typescript
describe("db.query (#1167)", () => {
  const dbModuleId = "acme-db";
  const moduleDb = {
    id: dbModuleId,
    dir: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      id: dbModuleId,
      name: "Acme DB",
      version: "1.0.0",
      publisher: "Acme",
      lifecycle: "optional" as const,
      compatibility: { jarv1s: ">=0.0.0" },
      auth: [],
      storage: [],
      fetchHosts: [],
      database: { ownedTables: ["app.acme_db_items"] }
    },
    manifestHash: "sha256:db",
    packageHash: "sha256:db"
  };

  beforeAll(async () => {
    await ensureModuleRoles(connectionStrings.bootstrap, dbModuleId);
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        "CREATE TABLE app.acme_db_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid NOT NULL, label text)"
      );
      for (const statement of generateModuleTableRlsSql(dbModuleId, ["app.acme_db_items"])) {
        await client.query(statement);
      }
      // The rpc handler runs on the worker pool; the broker grants the runtime
      // role to jarvis_worker_runtime at ensureModuleRoles time — this explicit
      // grant is idempotent and keeps the test self-documenting.
      await client.query(
        "GRANT jarvis_mod_acme_db_runtime TO jarvis_worker_runtime WITH INHERIT FALSE"
      );
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      // Revoke order matters: downstream runtime grants before the install
      // role's grant-option privileges, mirroring module-storage-rpc.test.ts.
      await client.query("REVOKE jarvis_mod_acme_db_runtime FROM jarvis_worker_runtime");
      await client.query("DROP TABLE IF EXISTS app.acme_db_items");
      await client.query("DROP ROLE IF EXISTS jarvis_mod_acme_db_runtime");
      await client.query("DROP ROLE IF EXISTS jarvis_mod_acme_db_install");
    } finally {
      await client.end();
    }
  });

  const dbRpc = (toolRisk: "read" | "write", module = moduleDb) =>
    createExternalModuleRpcHandler({
      module,
      toolRisk,
      actorUserId: ids.userA,
      requestId: "rpc-db-1",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false
    });

  it("rejects modules without a database declaration", async () => {
    const rpc = createExternalModuleRpcHandler({
      module: moduleA,
      toolRisk: "write",
      actorUserId: ids.userA,
      requestId: "rpc-db-2",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false
    });
    await expect(rpc("db.query", { text: "SELECT 1" }, () => undefined)).rejects.toMatchObject({
      code: "undeclared_database"
    });
  });

  it("writes and reads the module's own table under RLS", async () => {
    const rpc = dbRpc("write");
    await rpc(
      "db.query",
      {
        text: "INSERT INTO app.acme_db_items (owner_user_id, label) VALUES ($1, $2)",
        params: [ids.userA, "from-module"]
      },
      () => undefined
    );
    const result = (await rpc(
      "db.query",
      { text: "SELECT label FROM app.acme_db_items WHERE owner_user_id = $1", params: [ids.userA] },
      () => undefined
    )) as { rows: Array<{ label: string }> };
    expect(result.rows).toEqual([{ label: "from-module" }]);
  });

  it("maps read-risk mutations to forbidden_db_mutation", async () => {
    const rpc = dbRpc("read");
    await expect(
      rpc(
        "db.query",
        {
          text: "INSERT INTO app.acme_db_items (owner_user_id, label) VALUES ($1, $2)",
          params: [ids.userA, "blocked"]
        },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_db_mutation" });
  });

  it("maps allowlist rejections to forbidden_db_statement", async () => {
    const rpc = dbRpc("write");
    await expect(
      rpc("db.query", { text: "TRUNCATE app.acme_db_items" }, () => undefined)
    ).rejects.toMatchObject({ code: "forbidden_db_statement" });
  });

  it("rejects malformed params", async () => {
    const rpc = dbRpc("write");
    await expect(
      rpc("db.query", { text: "SELECT 1", params: "nope" }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc" });
    await expect(rpc("db.query", { params: [] }, () => undefined)).rejects.toMatchObject({
      code: "invalid_rpc"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the new describe fails**

Run: `pnpm exec tsx scripts/test-integration.ts tests/integration/module-worker-rpc.test.ts`
Expected: existing tests PASS; new describe FAILS (`db.query` resolves to the unknown-method path).

- [ ] **Step 3: Implement the host branch**

In `packages/module-registry/src/external/worker-rpc-host.ts`:

1. Extend the `ExternalModuleRpcError` code union with `"undeclared_database" | "forbidden_db_statement" | "forbidden_db_mutation"` (alongside `forbidden_kv_mutation` etc.).
2. Extend the `@jarv1s/db` import with `createModuleStorageRpc, ModuleQueryError`.
3. Inside the `withDataContext` dispatch, immediately AFTER the `set_config('app.current_module_id', …)` statement and BEFORE the `ai.generateStructured` branch, add:

```typescript
if (method === "db.query") {
  // #1167: only modules that declared owned tables get the SQL door; the
  // tables themselves are created/guarded by the platform installer (RLS,
  // owner-only, jarvis_mod_<slug>_runtime role) — this check is the manifest
  // gate, not the security boundary.
  const ownedTables = input.module.manifest.database?.ownedTables ?? [];
  if (ownedTables.length === 0) throw new ExternalModuleRpcError("undeclared_database");
  const p = record(params);
  const text = stringParam(p.text, "text");
  if (p.params !== undefined && !Array.isArray(p.params)) {
    throw new ExternalModuleRpcError("invalid_rpc");
  }
  const storageRpc = createModuleStorageRpc(scopedDb, input.module.id, {
    // Read-risk tools must not mutate — same policy as kv.set's
    // forbidden_kv_mutation. "write" and "destructive" may.
    readOnly: input.toolRisk === "read"
  });
  try {
    return await storageRpc.query(text, (p.params as readonly unknown[] | undefined) ?? []);
  } catch (error) {
    if (error instanceof ModuleQueryError) {
      if (error.code === "forbidden_statement") {
        throw new ExternalModuleRpcError("forbidden_db_statement");
      }
      if (error.code === "forbidden_mutation") {
        throw new ExternalModuleRpcError("forbidden_db_mutation");
      }
    }
    // Cap and db_query_failed errors cross as-is: already redacted at the
    // @jarv1s/db layer (SQLSTATE + primary message only, no detail/hint).
    // worker-runtime.ts forwards workers a generic rpc_failed regardless and
    // logs nothing for rpc errors (verified #1167 grounding).
    throw error;
  }
}
```

(Use the local variable names of the surrounding dispatch — if the scoped Kysely handle or params record are named differently in the file, match them; the structure above is exact.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx scripts/test-integration.ts tests/integration/module-worker-rpc.test.ts`
Expected: PASS (all describes, old and new).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/module-registry/src/external/worker-rpc-host.ts tests/integration/module-worker-rpc.test.ts
git add packages/module-registry/src/external/worker-rpc-host.ts tests/integration/module-worker-rpc.test.ts
git commit -m "feat(module-registry): db.query rpc for modules with declared tables (#1167)

Not user-visible: platform plumbing for module-owned tables.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `ctx.db` in the module SDK

**Files:**

- Modify: `packages/module-sdk/src/worker.ts`
- Test: `tests/unit/module-sdk-worker.test.ts` (extend)

**Interfaces:**

- Consumes: JSON-RPC method `db.query` `{ text, params? }` → `{ rows }` (Task 3); existing `callParent` in worker.ts.
- Produces: `ModuleWorkerContext.db.query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>` — the surface FIN-06 handlers code against. `MODULE_WORKER_CONTRACT_VERSION` stays `1`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/module-sdk-worker.test.ts` (uses the file's existing `spawnWorker`/`next` helpers verbatim):

```typescript
it("exposes ctx.db.query as a db.query rpc round-trip", async () => {
  const { child, next } = await spawnWorker(
    `defineModuleWorker({
      handlers: {
        report: async (ctx) => ({
          withParams: await ctx.db.query("SELECT 1", [2]),
          withoutParams: await ctx.db.query("SELECT 2")
        })
      }
    });`
  );
  expect(await next()).toMatchObject({ method: "worker.ready", params: { version: 1 } });
  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "host:1",
      method: "module.invoke",
      params: { handler: "report", input: {} }
    })}\n`
  );
  const first = await next();
  // params omitted from the wire entirely when the caller passes none —
  // the host treats undefined and absent identically, but absent is smaller.
  expect(first).toMatchObject({ method: "db.query", params: { text: "SELECT 1", params: [2] } });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { rows: [{ one: 1 }] } })}\n`
  );
  const second = await next();
  expect(second).toMatchObject({ method: "db.query", params: { text: "SELECT 2" } });
  expect((second.params as { params?: unknown }).params).toBeUndefined();
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { rows: [{ two: 2 }] } })}\n`
  );
  expect(await next()).toMatchObject({
    id: "host:1",
    result: {
      withParams: { rows: [{ one: 1 }] },
      withoutParams: { rows: [{ two: 2 }] }
    }
  });
  child.kill();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/module-sdk-worker.test.ts`
Expected: FAIL — `ctx.db` is undefined, handler rejects with `handler_failed`.

- [ ] **Step 3: Implement in `packages/module-sdk/src/worker.ts`**

1. Add to the `ModuleWorkerContext` interface (after the `ai` member, line ~13 block):

```typescript
  /**
   * Bounded SQL against the module's OWN declared tables (manifest
   * database.ownedTables). The host enforces the statement allowlist
   * (SELECT/INSERT/UPDATE/DELETE only), read-only tool risk, a 5s
   * statement_timeout, and 5000-row / 5 MiB result caps; failures surface
   * as generic rpc errors. Params are $1-style positional placeholders.
   */
  readonly db: {
    query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[]
    ): Promise<{ rows: T[] }>;
  };
```

2. Next to the existing `kv`/`ai` consts (before the readline loop):

```typescript
const db: ModuleWorkerContext["db"] = {
  query: (text, params) =>
    callParent("db.query", params === undefined ? { text } : { text, params }) as Promise<{
      rows: Record<string, unknown>[];
    }>
} as ModuleWorkerContext["db"];
```

3. Add `db` to the ctx object literal in the `module.invoke` branch (currently `input, auth: {...}, fetch, kv, ai` at lines ~125–139):

```typescript
const ctx: ModuleWorkerContext = { input, auth, fetch: boundFetch, kv, ai, db };
```

(Keep the file's existing member names — if the literal spells members inline, add `db` the same way.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/module-sdk-worker.test.ts`
Expected: PASS (all, including the pre-existing protocol tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/module-sdk/src/worker.ts tests/unit/module-sdk-worker.test.ts
git add packages/module-sdk/src/worker.ts tests/unit/module-sdk-worker.test.ts
git commit -m "feat(module-sdk): ctx.db.query worker context member (#1167)

Not user-visible: platform plumbing for module-owned tables.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full gate + PR

**Files:** none (verification + PR only).

- [ ] **Step 1: Run the 12-stage gate piecewise in the foreground** (long background pnpm runs get killed on this box; each stage < 600s):

```bash
pnpm lint
pnpm format:check
pnpm check:file-size
pnpm check:design-tokens
pnpm check:no-ambient-dates
pnpm check:package-deps
pnpm typecheck
pnpm build:app-map
pnpm test:unit
```

Then the DB stages on a throwaway database (create `jarvis_1167_gate` via a tmp tsx script INSIDE the repo using the `@jarv1s/db` bootstrap URL against the `postgres` maintenance DB), then:

```bash
JARVIS_PGDATABASE=jarvis_1167_gate pnpm db:migrate
JARVIS_PGDATABASE=jarvis_1167_gate pnpm test:uat-seed
ls tests/integration/*.test.ts | split -n r/8 - /tmp/claude-1000/batch-
for b in /tmp/claude-1000/batch-*; do JARVIS_PGDATABASE=jarvis_1167_gate pnpm exec tsx scripts/test-integration.ts $(cat $b); done
```

Expected: exit 0 for every stage (record real exit codes). Drop the DB and delete tmp scripts after.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/1167-module-db-query
gh pr create --base main --title "feat: module ctx.db.query with D5 bounds (#1167)" --body "..."
```

PR body must include: `Closes #1167`, the release-note line "Not user-visible: platform plumbing that lets modules store data in their own database tables — no user-facing behavior change.", the gate record (commands + exit codes), and the security-boundary summary (allowlist incl. set_config/U&/E'/dollar-quote/multi-statement rejection, data-modifying-CTE detection, readOnly mapping from tool risk, redaction contract) plus the trailer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: Watch checks, merge manually**

Poll `gh pr checks` until ALL checks (including VF) are green, then `gh pr merge --squash`. (`NEVER --auto` superseded by #895: once the `CI gate` required-status-check ruleset is applied to `main`, `--auto` is safe — `CI gate` aggregates VF and the other conditional jobs, so it's no longer silently skippable. Until the ruleset lands, keep polling manually.)

---

## Self-Review (done at plan time)

- **Spec coverage:** D5 allowlist ✓ (T1), timeout ✓, row/byte caps ✓, redaction ✓ (T2), cancellation → covered by statement_timeout + server-side extended-protocol limits (no client kill-switch in v1; documented), worker RPC ✓ (T3), SDK context ✓ (T4), export-path regression guard ✓ (T2 step 4).
- **Placeholder scan:** all steps carry full code; the two "match the file's local names" notes in T3/T4 are integration guidance, not missing content.
- **Type consistency:** `ModuleQueryBounds`/`ModuleQueryError`/`classifyModuleStatement` names identical across T1→T4; rpc param shape `{ text, params? }` identical in T3 host and T4 SDK; `version: 1` in T4 test matches `MODULE_WORKER_CONTRACT_VERSION = 1`.
