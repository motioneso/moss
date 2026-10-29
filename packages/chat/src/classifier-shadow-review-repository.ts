import { assertDataContextDb, type DataContextDb } from "@moss/db";

/**
 * Shadow reviews of the classifier gate (#2984 R2.4, migration 0271).
 *
 * One admin row per classifier selection. The rows are a record only. They gate nothing, and the
 * gate runs in whatever mode the admin stores. Every authed actor may read them and only admins
 * may write them. This module only reads.
 */

/** The configured model the classifier binding resolves to. */
export interface ClassifierSelection {
  readonly modelId: string;
  readonly providerModelId: string;
}

export type HasReviewForSelection = (
  scopedDb: DataContextDb,
  selection: ClassifierSelection
) => Promise<boolean>;

/** True when a shadow review row matches this exact selection. */
export const hasReviewForSelection: HasReviewForSelection = async (scopedDb, selection) => {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.chat_classifier_shadow_reviews")
    .select("id")
    .where("classifier_model_id", "=", selection.modelId)
    .where("classifier_provider_model_id", "=", selection.providerModelId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
};
