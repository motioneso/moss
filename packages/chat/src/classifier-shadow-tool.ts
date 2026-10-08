import { assertDataContextDb } from "@moss/db";
import {
  presentApprovalFields,
  type ToolApprovalPresentation,
  type RouteApprovalPresentation
} from "@moss/module-sdk";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";

import { ClassifierShadowRepository } from "./classifier-shadow-repository.js";

// #2911 — the chat tool behind "ask Moss to delete my classifier shadow records". It runs the
// owner-only delete from #2908 under the caller's own data context, so row-level security scopes
// it to that person's records. It is declared risk "destructive" with confirm_always, so the user
// approves a card before anything is removed.

const shadowRepository = new ClassifierShadowRepository();

export const chatDeleteClassifierShadowRecordsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {}
} as const;

export const chatDeleteClassifierShadowRecordsOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deleted"],
  properties: { deleted: { type: "number" } }
} as const;

export const chatDeleteClassifierShadowRecordsExecute: ToolExecute = async (
  scopedDb
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const deleted = await shadowRepository.deleteForOwner(scopedDb);
  return { data: { deleted } };
};

export const shadowDeletePresentation: ToolApprovalPresentation = async (_db, input) => {
  const fields = presentApprovalFields(input, {});
  return fields ? { target: "All your tool-picking trial records", fields } : null;
};
export const shadowDeleteRoutePresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || Object.keys(input.query ?? {}).length) return null;
  const fields = presentApprovalFields(input.body, {});
  return fields ? { target: "All your tool-picking trial records", fields } : null;
};
