import { afterEach, describe, expect, it } from "vitest";
import type { DataContextDb } from "@moss/db";
import { MemoryForgetService } from "../../packages/memory/src/forget-service.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

// SQL compilation and result mapping only; PostgreSQL locking/RLS is covered in integration.
const OWNER = "11111111-1111-4111-8111-111111111111";
const FACT = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "33333333-3333-4333-8333-333333333333";
const databases: DataContextDb[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.db.destroy()));
});

function harness(rejectClaim = false) {
  const row = {
    id: FACT,
    subject_entity_id: SUBJECT,
    subject_name: "Mira",
    predicate: "prefers",
    object_text: "full original memory",
    object_entity_id: null as string | null,
    object_name: null as string | null,
    row_version: "510",
    subject_version: "509",
    object_version: null as string | null,
    conflict_group_id: null,
    recording_side: null,
    version_revision: null
  };
  const rows = [row];
  const db = makeRecordingDb({
    rows,
    beforeQuery: async (statement) => {
      // This fixture is a legacy fact: lineage lookups have no receipt/version rows.
      const lineageLookup =
        statement.includes("FROM app.memory_recording_receipts") ||
        statement.includes("FROM app.memory_recording_fact_versions");
      rows.splice(
        0,
        rows.length,
        ...(lineageLookup || (rejectClaim && statement.includes("DELETE FROM app.memory_facts"))
          ? []
          : [row])
      );
    }
  });
  databases.push(db.scoped);
  return { ...db, row, service: new MemoryForgetService() };
}

describe("memory forget target version and conditional deletion", () => {
  it("binds the full label and exact IDs without reading source excerpts", async () => {
    const h = harness();
    h.row.object_text = `First line\n${"full text ".repeat(800)}`;
    const target = await h.service.target(h.scoped, OWNER, FACT);
    expect(target?.label).toBe(`Mira: prefers: ${h.row.object_text}`);
    expect(target?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(h.queries[0]?.sql).toContain("f.xmin::text AS row_version");
    expect(h.queries[0]?.sql).toContain("f.owner_user_id =");
    expect(h.queries[0]?.parameters).toEqual([OWNER, OWNER, FACT, OWNER]);
    expect(h.queries[0]?.sql).not.toMatch(/SELECT \*|excerpt|memory_sources/);
  });

  it.each([
    "object_text",
    "subject_entity_id",
    "row_version",
    "subject_version",
    "object_version"
  ] as const)(
    "refuses changed %s without deleting or deactivating the search document",
    async (field) => {
      const h = harness();
      const target = await h.service.target(h.scoped, OWNER, FACT);
      h.row[field] = field === "subject_entity_id" ? FACT : "changed";
      expect(await h.service.forgetApproved(h.scoped, OWNER, FACT, target!.version)).toBe(false);
      expect(h.queries.some((query) => query.sql.includes("DELETE"))).toBe(false);
      expect(
        h.queries.some((query) => query.sql.includes("UPDATE app.memory_search_documents"))
      ).toBe(false);
    }
  );

  it("locks displayed entities and requires the owner's current xmin before deactivating search", async () => {
    const h = harness();
    const target = await h.service.target(h.scoped, OWNER, FACT);
    h.queries.splice(0);
    expect(await h.service.forgetApproved(h.scoped, OWNER, FACT, target!.version)).toBe(true);
    const entityLock = h.queries.findIndex((query) =>
      query.sql.includes("SELECT id FROM app.memory_entities")
    );
    const deletion = h.queries.findIndex((query) =>
      query.sql.includes("DELETE FROM app.memory_facts")
    );
    const searchLock = h.queries.findIndex((query) =>
      query.sql.includes("SELECT id FROM app.memory_search_documents")
    );
    const deactivation = h.queries.findIndex((query) =>
      query.sql.includes("UPDATE app.memory_search_documents")
    );
    expect(entityLock).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(entityLock);
    expect(searchLock).toBeGreaterThan(deletion);
    expect(deactivation).toBeGreaterThan(searchLock);
    expect(h.queries[entityLock]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "SELECT id FROM app.memory_entities WHERE owner_user_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE"
    );
    expect(h.queries[entityLock]?.parameters).toEqual([OWNER, [SUBJECT]]);
    expect(h.queries[deletion]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "DELETE FROM app.memory_facts WHERE owner_user_id = $1::uuid AND id = $2::uuid AND xmin::text = $3 RETURNING id, conflict_group_id"
    );
    expect(h.queries[deletion]?.parameters).toEqual([OWNER, FACT, "510"]);
    expect(h.queries[searchLock]?.sql.replace(/\s+/g, " ").trim()).toBe(
      "SELECT id FROM app.memory_search_documents WHERE owner_user_id = $1::uuid AND target_kind = 'fact' AND target_id = $2::uuid FOR UPDATE NOWAIT"
    );
    expect(h.queries[searchLock]?.parameters).toEqual([OWNER, FACT]);
  });

  it("leaves search active when the conditional version claim loses a race", async () => {
    const h = harness(true);
    const target = await h.service.target(h.scoped, OWNER, FACT);
    expect(await h.service.forgetApproved(h.scoped, OWNER, FACT, target!.version)).toBe(false);
    expect(
      h.queries.find((query) => query.sql.includes("DELETE FROM app.memory_facts"))?.sql
    ).toContain("AND xmin::text =");
    expect(
      h.queries.some((query) => query.sql.includes("UPDATE app.memory_search_documents"))
    ).toBe(false);
  });
});
