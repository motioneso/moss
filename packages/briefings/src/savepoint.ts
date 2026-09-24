/**
 * Compose shares the job's single transaction, so every best-effort step runs inside its own
 * savepoint. See withSavepoint in @moss/db.
 */
export { withSavepoint as withToolSavepoint } from "@moss/db";
