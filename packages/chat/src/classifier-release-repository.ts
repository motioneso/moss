import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ClassifierToolReleaseRecord } from "@moss/shared";

/**
 * Approved tool release eligibility for the classifier gate, task 1.2 (#2881).
 *
 * The gate may only be switched `on` when at least one approved release exists. Rows are written by
 * the review step (plan task 4.2); this repository reads them and exposes the single boolean the
 * settings runtime-config boundary needs. Instance-global admin data, so it runs under the caller's
 * actor context and RLS allows every authed actor to SELECT, admins only to write.
 */
export interface ClassifierReleaseEligibilityRepository {
  /** True when at least one approved release exists. `on` is rejected when this is false. */
  hasEligibleRelease(scopedDb: DataContextDb): Promise<boolean>;
  /** All approved releases, newest first. */
  listEligibleReleases(scopedDb: DataContextDb): Promise<ClassifierToolReleaseRecord[]>;
}

export class ClassifierReleaseRepository implements ClassifierReleaseEligibilityRepository {
  async hasEligibleRelease(scopedDb: DataContextDb): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.chat_classifier_release_eligibility")
      .select("id")
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listEligibleReleases(scopedDb: DataContextDb): Promise<ClassifierToolReleaseRecord[]> {
    assertDataContextDb(scopedDb);
    const rows = await sql<{
      module_id: string;
      tool_name: string;
      classifier_config_version: string;
      approved_at: Date;
      approved_by_user_id: string;
    }>`
      SELECT module_id, tool_name, classifier_config_version, approved_at, approved_by_user_id
      FROM app.chat_classifier_release_eligibility
      ORDER BY approved_at DESC
    `.execute(scopedDb.db);

    return rows.rows.map((row) => ({
      moduleId: row.module_id,
      toolName: row.tool_name,
      classifierConfigVersion: row.classifier_config_version,
      approvedAt: row.approved_at.toISOString(),
      approvedByUserId: row.approved_by_user_id
    }));
  }
}
