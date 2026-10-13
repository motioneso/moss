import { test } from "@playwright/test";
import { proveScheduledSourceReport } from "./scheduled-source-live-proof.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
test("a real model saves an exact owner read, reports source status and refuses removed access", async ({
  page
}) => {
  await proveScheduledSourceReport(page);
});
