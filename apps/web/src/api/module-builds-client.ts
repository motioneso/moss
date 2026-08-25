import type { ApproveModuleBuildResponse } from "@moss/shared";

import { requestJson } from "./client.js";

/** #1888 — the "Build it" button on the plan card in chat. */
export async function approveModuleBuild(buildId: string): Promise<ApproveModuleBuildResponse> {
  return requestJson<ApproveModuleBuildResponse>(
    `/api/ai/module-builds/${encodeURIComponent(buildId)}/approve`,
    { method: "POST" }
  );
}
