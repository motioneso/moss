import { TASK_SUMMARY_SCOPES } from "./types.js";

/** Proposal first so the chat output cap cannot hide it behind a large Focus list. */
export const taskSummaryDataSchema = {
  type: "object",
  properties: {
    presentation: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          properties: {
            catalogVersion: { type: "string" },
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  snapshotRefs: { type: "array", items: { type: "string" } }
                }
              }
            },
            interactions: { type: "array", items: { type: "object", properties: {} } }
          }
        }
      }
    },
    summary: {
      type: "object",
      properties: {
        scope: { type: "string", enum: TASK_SUMMARY_SCOPES },
        timeZone: { type: "string" },
        localDate: { type: "string" },
        retrievedAt: { type: "string" },
        truncated: { type: "boolean" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string" },
              priority: { type: ["number", "null"] },
              dueAt: { type: ["string", "null"] },
              dueState: { type: "string" },
              completedAt: { type: ["string", "null"] },
              updatedAt: { type: "string" },
              recurring: { type: "boolean" }
            }
          }
        }
      }
    },
    coverage: { type: "string" },
    unavailable: { type: "string" }
  }
} as const;
