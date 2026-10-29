import { REMINDER_SUMMARY_SCOPES } from "./types.js";

/** Proposal first so the chat output cap cannot hide it behind the rows. */
export const reminderSummaryDataSchema = {
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
        scope: { type: "string", enum: REMINDER_SUMMARY_SCOPES },
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
              text: { type: "string" },
              state: { type: "string" },
              contextState: { type: "string" },
              timing: { type: "string" },
              dueAt: { type: "string" },
              dueLocalDay: { type: "string" },
              deadlineAt: { type: ["string", "null"] },
              repeat: {
                type: ["object", "null"],
                properties: { kind: { type: "string" }, seconds: { type: "number" } }
              },
              destinationTitle: { type: ["string", "null"] },
              deliveredAt: { type: ["string", "null"] },
              late: { type: ["boolean", "null"] },
              createdAt: { type: "string" }
            }
          }
        }
      }
    },
    coverage: { type: "string" }
  }
} as const;
