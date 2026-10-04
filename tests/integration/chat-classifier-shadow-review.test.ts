import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AiRepository } from "@moss/ai";
import { hasReviewForSelection, isCurrentClassifierReviewed } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2984 R2.4: one shadow review per classifier selection unlocks the gate's `on` state. The table is
// empty by default. Instance-global admin data under RLS: every authed actor may read it, only an
// admin may write it.

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

/** Postgres insufficient_privilege (42501), raised by a row-security WITH CHECK refusal on INSERT. */
const RLS_REFUSAL = "42501";

type ScopedDb = Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0];

const asActor = <T>(actorUserId: string, work: (db: ScopedDb) => Promise<T>) =>
  dataContext.withDataContext({ actorUserId, requestId: "shadow-review-test" }, work);

const REVIEWED = { modelId: "model-reviewed", providerModelId: "provider-model-reviewed" };

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("app.chat_classifier_shadow_reviews", () => {
  it("forces row security; the app role may write (admin-gated), the worker may only read", async () => {
    const table = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'app.chat_classifier_shadow_reviews'::regclass
    `.execute(appDb);
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const grant = await sql<{
      app_insert: boolean;
      app_delete: boolean;
      worker_select: boolean;
      worker_insert: boolean;
      worker_delete: boolean;
    }>`
      SELECT
        has_table_privilege('jarvis_app_runtime', 'app.chat_classifier_shadow_reviews', 'INSERT') AS app_insert,
        has_table_privilege('jarvis_app_runtime', 'app.chat_classifier_shadow_reviews', 'DELETE') AS app_delete,
        has_table_privilege('jarvis_worker_runtime', 'app.chat_classifier_shadow_reviews', 'SELECT') AS worker_select,
        has_table_privilege('jarvis_worker_runtime', 'app.chat_classifier_shadow_reviews', 'INSERT') AS worker_insert,
        has_table_privilege('jarvis_worker_runtime', 'app.chat_classifier_shadow_reviews', 'DELETE') AS worker_delete
    `.execute(appDb);
    expect(grant.rows[0]).toEqual({
      app_insert: true,
      app_delete: true,
      worker_select: true,
      worker_insert: false,
      worker_delete: false
    });
  });

  it("is empty by default, and no classifier selected reads as not reviewed", async () => {
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.chat_classifier_shadow_reviews
    `.execute(appDb);
    expect(count.rows[0]?.n).toBe("0");

    expect(
      await asActor(ids.adminUser, (db) =>
        isCurrentClassifierReviewed(db, { classifierDeps: { repository: new AiRepository() } })
      )
    ).toBe(false);
  });

  it("lets an admin record a review that matches only its exact selection", async () => {
    await asActor(ids.adminUser, (db) =>
      sql`
        INSERT INTO app.chat_classifier_shadow_reviews
          (classifier_model_id, classifier_provider_model_id, reviewed_by_user_id)
        VALUES (${REVIEWED.modelId}, ${REVIEWED.providerModelId}, ${ids.adminUser}::uuid)
      `.execute(db.db)
    );

    expect(await asActor(ids.adminUser, (db) => hasReviewForSelection(db, REVIEWED))).toBe(true);
    expect(
      await asActor(ids.adminUser, (db) =>
        hasReviewForSelection(db, { ...REVIEWED, providerModelId: "provider-model-other" })
      )
    ).toBe(false);
    expect(
      await asActor(ids.adminUser, (db) =>
        hasReviewForSelection(db, { ...REVIEWED, modelId: "model-other" })
      )
    ).toBe(false);
  });

  it("is readable by a non-admin actor", async () => {
    expect(await asActor(ids.userA, (db) => hasReviewForSelection(db, REVIEWED))).toBe(true);
  });

  it("refuses a non-admin INSERT with a row-security error", async () => {
    let code: string | null = null;
    try {
      await asActor(ids.userA, (db) =>
        sql`
          INSERT INTO app.chat_classifier_shadow_reviews
            (classifier_model_id, classifier_provider_model_id, reviewed_by_user_id)
          VALUES ('forged-model', 'forged-provider-model', ${ids.userA}::uuid)
        `.execute(db.db)
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? "no-code";
    }
    expect(code).toBe(RLS_REFUSAL);
    expect(
      await asActor(ids.adminUser, (db) =>
        hasReviewForSelection(db, {
          modelId: "forged-model",
          providerModelId: "forged-provider-model"
        })
      )
    ).toBe(false);
  });

  it("skips a non-admin UPDATE and DELETE (zero rows changed) and keeps the review", async () => {
    const updated = await asActor(ids.userA, (db) =>
      sql`
        UPDATE app.chat_classifier_shadow_reviews
        SET classifier_provider_model_id = 'hijacked'
        WHERE classifier_model_id = ${REVIEWED.modelId}
      `.execute(db.db)
    );
    expect(updated.numAffectedRows ?? 0n).toBe(0n);

    const deleted = await asActor(ids.userA, (db) =>
      sql`
        DELETE FROM app.chat_classifier_shadow_reviews
        WHERE classifier_model_id = ${REVIEWED.modelId}
      `.execute(db.db)
    );
    expect(deleted.numAffectedRows ?? 0n).toBe(0n);

    expect(await asActor(ids.adminUser, (db) => hasReviewForSelection(db, REVIEWED))).toBe(true);
  });

  it("lets an admin delete the review", async () => {
    const deleted = await asActor(ids.adminUser, (db) =>
      sql`
        DELETE FROM app.chat_classifier_shadow_reviews
        WHERE classifier_model_id = ${REVIEWED.modelId}
      `.execute(db.db)
    );
    expect(deleted.numAffectedRows).toBe(1n);
    expect(await asActor(ids.adminUser, (db) => hasReviewForSelection(db, REVIEWED))).toBe(false);
  });
});
