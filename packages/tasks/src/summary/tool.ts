import { assertDataContextDb } from "@moss/db";
import type {
  ModuleAssistantToolManifest,
  ToolExecute,
  VisualSnapshotRegistrationService
} from "@moss/module-sdk";
import { readTaskSummary } from "./repository.js";
import { taskSummaryCoverage } from "./contract.js";
import { TASK_SUMMARY_SCOPES, type TaskSummary, type TaskSummaryScope } from "./types.js";

export function taskSummarySnapshot(summary: TaskSummary) {
  return {
    kind: "tasks.summary",
    origin: "source" as const,
    source: { id: "tasks", label: "Tasks" },
    retrievedAt: summary.retrievedAt,
    coverage: taskSummaryCoverage(summary),
    fields: { ...summary, items: summary.items.map((item) => ({ ...item })) }
  };
}
export function taskSummaryData(
  summary: TaskSummary,
  ctx: Parameters<ToolExecute>[2],
  services?: Parameters<ToolExecute>[3]
) {
  const registrar = services?.visualPresentation as VisualSnapshotRegistrationService | undefined;
  const registered = registrar?.registerSnapshot(ctx, taskSummarySnapshot(summary));
  return {
    summary,
    coverage: taskSummaryCoverage(summary),
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
      : {})
  };
}
export const taskSummaryExecute: ToolExecute = async (db, input, ctx, services) => {
  assertDataContextDb(db);
  if (
    Object.keys(input).some((key) => key !== "scope") ||
    (input.scope !== undefined && !TASK_SUMMARY_SCOPES.includes(input.scope as TaskSummaryScope))
  )
    throw new Error("Invalid task summary scope");
  const summary = await readTaskSummary(db, input.scope as TaskSummaryScope | undefined);
  return { data: taskSummaryData(summary, ctx, services) };
};
export const taskSummaryTool: ModuleAssistantToolManifest = {
  name: "tasks.summary",
  permissionId: "tasks.view",
  risk: "read",
  content: "outside",
  description:
    "Read a bounded task summary for what needs doing today, overdue work, upcoming tasks, undated tasks, completed work or all persisted states. Prefer this read-only source for task summaries: it never advances recurrence. Default today includes open tasks due today/earlier plus undated work. Includes authorized shares. Returns actual status, priority, actor-local due days, source time and honest coverage; at most twelve rows. Reminders are excluded. Stored timestamps do not retain date-only intent; never interpret saved noon as an exact deadline. Recurrence shows persisted occurrences only. Source-bound visual proposal is available when useful; use the returned proposal unchanged. Keep concise grounded prose alongside it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { scope: { type: "string", enum: TASK_SUMMARY_SCOPES } }
  },
  execute: taskSummaryExecute
};
