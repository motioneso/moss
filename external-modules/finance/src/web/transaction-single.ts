import type { ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";

/** What one direct category save came to. Only "saved" changed anything. */
export type SingleCategoryResult = "saved" | "cancelled" | "stale" | "refused" | "uncertain";

/**
 * Saves one captured transaction's category with no review step. `confirmOnly` marks the
 * existing category as reviewed; otherwise the category changes to `categoryId`. A stale
 * revision or an unreadable answer is reported so the caller can ask for a saved-records check.
 */
export async function saveSingleCategory(
  tools: ExternalModuleToolsHandleV1,
  row: { id: string; writeRevision: string },
  categoryId: string,
  confirmOnly: boolean
): Promise<SingleCategoryResult> {
  const rows = [{ id: row.id, writeRevision: row.writeRevision }];
  try {
    const result = confirmOnly
      ? await tools.invoke("finance.transactions.confirm", { rows })
      : await tools.invoke("finance.transactions.bulk-category", { categoryId, rows });
    if (result.status === "succeeded" && result.result.status === "ok") return "saved";
    if (result.status === "cancelled") return "cancelled";
    if (result.status === "rejected") {
      return result.moduleCode === "stale_transactions" ? "stale" : "refused";
    }
    return "uncertain";
  } catch {
    return "uncertain";
  }
}
