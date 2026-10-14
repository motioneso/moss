import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ApprovedActionScopeDto } from "@moss/shared";
import { boundedActionScope } from "./terms.js";
import { BOUNDED_ACTION_PROPOSAL_KIND } from "./prepare.js";

export async function listApprovedActionScopes(
  db: DataContextDb
): Promise<ApprovedActionScopeDto[]> {
  assertDataContextDb(db);
  const rows = await db.db
    .selectFrom("app.chat_responsibility_proposals")
    .selectAll()
    .where("proposal_kind", "=", BOUNDED_ACTION_PROPOSAL_KIND)
    .where("state", "=", "accepted")
    .orderBy("accepted_at", "desc")
    .execute();
  return rows.flatMap((row) => {
    const scope = boundedActionScope(row.terms_json);
    return scope && row.accepted_at
      ? [
          {
            id: row.id,
            version: row.proposal_version,
            state: "not_active" as const,
            approvedAt: row.accepted_at.toISOString(),
            scope
          }
        ]
      : [];
  });
}
