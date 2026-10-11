import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import {
  approvalChoice,
  approvalNumber,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import { GoalsRepository } from "./repository.js";

const repository = new GoalsRepository();
const sourceLabels = {
  goal: "Goal",
  task: "Task",
  note: "Note",
  email: "Email",
  calendar: "Calendar",
  chat: "Chat",
  memory: "Memory",
  manual: "Manual"
} as const;
export type GoalApprovalSourceResolver = (
  db: DataContextDb,
  input: {
    readonly actorUserId: string;
    readonly sourceKind: keyof typeof sourceLabels;
    readonly sourceRef: string;
  }
) => Promise<{ readonly label: string; readonly version: string } | null>;
let resolveSource: GoalApprovalSourceResolver | undefined;
/** The host binds public owning-module readers; the goal module never queries foreign tables. */
export function configureGoalApprovalReferences(
  resolver: GoalApprovalSourceResolver | undefined
): void {
  resolveSource = resolver;
}
const goalFields: ApprovalFieldMap = {
  title: { label: "Title", present: approvalText },
  desiredOutcome: { label: "Desired outcome", present: approvalText },
  priority: { label: "Priority", present: approvalNumber },
  reviewCadence: {
    label: "Review frequency",
    present: approvalChoice({
      none: "No scheduled reviews",
      daily: "Daily",
      weekly: "Weekly",
      biweekly: "Every two weeks",
      monthly: "Monthly",
      custom: "Custom"
    })
  },
  targetAt: { label: "Target date", present: approvalText }
};
export const goalCreatePresentation: ToolApprovalPresentation = async (_db, input) => {
  const fields = presentApprovalFields(input, goalFields, ["title", "desiredOutcome"]);
  return fields ? { content: "user_authored", target: "Your goals", fields } : null;
};
export const goalCreateRoutePresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  if (
    Object.keys(input.params).length ||
    (input.query && Object.keys(input.query).length) ||
    !input.body ||
    typeof input.body !== "object" ||
    Array.isArray(input.body)
  )
    return null;
  return goalCreatePresentation(db, input.body as Record<string, unknown>, ctx);
};

export const goalUpdatePresentation: ToolApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const { goalId, ...changes } = input;
  if (typeof goalId !== "string" || !isUuid(goalId)) return null;
  const fields = presentApprovalFields(changes, {
    ...goalFields,
    status: {
      label: "Status",
      present: approvalChoice({
        active: "Active",
        paused: "Paused",
        blocked: "Blocked",
        completed: "Completed",
        archived: "Archived"
      })
    }
  });
  if (!fields) return null;
  const goal = await repository.getById(db, goalId);
  return goal
    ? { target: goal.title, fields, version: JSON.stringify([goal.id, goal.updatedAt]) }
    : null;
};

export const goalEvidencePresentation: ToolApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  const { goalId, ...changes } = input;
  if (typeof goalId !== "string" || !isUuid(goalId)) return null;
  const declarations: Record<string, ApprovalFieldMap[string]> = {
    evidenceKind: {
      label: "Evidence type",
      present: approvalChoice({
        context: "Context",
        task: "Task",
        status: "Status",
        progress: "Progress",
        blocker: "Blocker",
        decision: "Decision",
        checkpoint: "Checkpoint",
        suggested_action: "Suggested action"
      })
    },
    sourceKind: {
      label: "Source type",
      present: approvalChoice({
        goal: "Goal",
        task: "Task",
        note: "Note",
        email: "Email",
        calendar: "Calendar",
        chat: "Chat",
        memory: "Memory",
        manual: "Manual"
      })
    },
    sourceLabel: { label: "Source label", present: approvalText },
    summary: { label: "Summary", present: approvalText },
    occurredAt: { label: "Occurred at", present: approvalText }
  };
  const versions: unknown[] = [];
  if (Object.hasOwn(changes, "sourceRef") && changes.sourceKind === "manual") {
    if (typeof changes.sourceRef !== "string") return null;
    declarations.sourceRef = { label: "Manual reference", present: approvalText };
  } else if (Object.hasOwn(changes, "sourceRef")) {
    if (
      typeof changes.sourceRef !== "string" ||
      !changes.sourceRef ||
      typeof changes.sourceKind !== "string" ||
      !Object.hasOwn(sourceLabels, changes.sourceKind)
    )
      return null;
    let source: { label: string; version: string } | null;
    if (changes.sourceKind === "goal") {
      if (!isUuid(changes.sourceRef)) return null;
      const goal = await repository.getById(db, changes.sourceRef);
      source = goal
        ? { label: goal.title, version: JSON.stringify([goal.id, goal.updatedAt]) }
        : null;
    } else {
      source =
        (await resolveSource?.(db, {
          actorUserId: ctx.actorUserId,
          sourceKind: changes.sourceKind as keyof typeof sourceLabels,
          sourceRef: changes.sourceRef
        })) ?? null;
    }
    if (!source?.label || !source.version) return null;
    declarations.sourceRef = {
      label: "Source",
      present: (value) => (value === changes.sourceRef ? source.label : null)
    };
    versions.push([changes.sourceKind, changes.sourceRef, source.version]);
  }
  const fields = presentApprovalFields(changes, declarations, [
    "evidenceKind",
    "sourceKind",
    "sourceLabel",
    "summary"
  ]);
  if (!fields) return null;
  const goal = await repository.getById(db, goalId);
  return goal
    ? {
        target: goal.title,
        fields,
        version: JSON.stringify([[goal.id, goal.updatedAt], ...versions])
      }
    : null;
};
