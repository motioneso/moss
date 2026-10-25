import { assertDataContextDb } from "@moss/db";
import type {
  ModuleAssistantToolManifest,
  ToolExecute,
  VisualSnapshotRegistrationService
} from "@moss/module-sdk";
import { reminderSummaryCoverage } from "./contract.js";
import { readReminderSummary } from "./repository.js";
import { reminderSummaryDataSchema } from "./output-schema.js";
import {
  REMINDER_SUMMARY_SCOPES,
  type ReminderSummary,
  type ReminderSummaryScope
} from "./types.js";

export function reminderSummarySnapshot(summary: ReminderSummary) {
  return {
    kind: "reminders.summary",
    origin: "source" as const,
    source: { id: "chat", label: "Reminders" },
    retrievedAt: summary.retrievedAt,
    coverage: reminderSummaryCoverage(summary),
    fields: { ...summary, items: summary.items.map((item) => ({ ...item })) }
  };
}
export function reminderSummaryData(
  summary: ReminderSummary,
  ctx: Parameters<ToolExecute>[2],
  services?: Parameters<ToolExecute>[3]
) {
  const registrar = services?.visualPresentation as VisualSnapshotRegistrationService | undefined;
  const registered = registrar?.registerSnapshot(ctx, reminderSummarySnapshot(summary));
  return {
    ...(registered?.ok
      ? {
          presentation: {
            proposal: {
              catalogVersion: registered.catalogVersion,
              blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
              interactions: []
            }
          }
        }
      : {}),
    summary,
    coverage: reminderSummaryCoverage(summary)
  };
}
export const reminderSummaryExecute: ToolExecute = async (db, input, ctx, services) => {
  assertDataContextDb(db);
  if (
    Object.keys(input).some((key) => key !== "scope") ||
    (input.scope !== undefined &&
      !REMINDER_SUMMARY_SCOPES.includes(input.scope as ReminderSummaryScope))
  )
    throw new Error("Invalid reminder summary scope");
  const summary = await readReminderSummary(db, input.scope as ReminderSummaryScope | undefined);
  return { data: reminderSummaryData(summary, ctx, services) };
};
export const reminderSummaryTool: ModuleAssistantToolManifest = {
  name: "chat.remindersSummary",
  permissionId: "chat.view",
  risk: "read",
  content: "outside",
  description:
    "Read a bounded, read-only summary of the user's saved reminders: upcoming (scheduled or paused, default), delivered, ended (cancelled, expired, failed) or all. Returns at most twelve rows with the reminder text, real state, due time, deadline, repeat terms, destination, delivery time, actor time zone, source time and honest coverage. It changes nothing and never creates, edits, cancels or delivers. Dismissing from chat context is not cancelling. Repeats show the saved next time only. Source-bound visual proposal is available when useful; use the returned proposal unchanged. Keep concise grounded prose alongside it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { scope: { type: "string", enum: REMINDER_SUMMARY_SCOPES } }
  },
  outputSchema: reminderSummaryDataSchema,
  execute: reminderSummaryExecute
};
