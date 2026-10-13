import { test } from "@playwright/test";
import { proveScheduledSourceReport } from "./scheduled-source-live-proof.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
test("the configured model writes a sourced report while away and revoked access exposes no source", async ({
  page
}) => {
  await proveScheduledSourceReport(page);
});
