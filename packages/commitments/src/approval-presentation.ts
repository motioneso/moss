import { assertDataContextDb, isUuid } from "@moss/db";
import {
  approvalChoice,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import { CommitmentsRepository } from "./repository.js";

const repository = new CommitmentsRepository();
const status = {
  label: "Status",
  present: approvalChoice({
    accepted: "Accepted",
    rejected: "Rejected",
    snoozed: "Snoozed",
    explicit_non_action: "No action needed"
  })
};
const snoozedUntil = { label: "Snooze until", present: approvalText };

export function commitmentPresentation(
  action: "accept" | "reject" | "snooze" | "status" | "suppress"
): ToolApprovalPresentation {
  return async (db, input, ctx) => {
    assertDataContextDb(db);
    const { candidateId, ...changes } = input;
    if (typeof candidateId !== "string" || !isUuid(candidateId)) return null;
    const candidate = await repository.getCandidate(db, ctx.actorUserId, candidateId);
    if (!candidate) return null;
    const declarations: Record<string, ApprovalFieldMap[string]> =
      action === "status" ? { status, snoozedUntil } : action === "snooze" ? { snoozedUntil } : {};
    const versions: unknown[] = [[candidate.id, candidate.updatedAt]];
    if (action === "suppress") {
      if (typeof changes.suppressedBy !== "string" || !isUuid(changes.suppressedBy)) return null;
      const suppressor = await repository.getCandidate(db, ctx.actorUserId, changes.suppressedBy);
      if (!suppressor || suppressor.status !== "explicit_non_action") return null;
      declarations.suppressedBy = {
        label: "No-action decision",
        present: (value) => (value === suppressor.id ? suppressor.title : null)
      };
      versions.push([suppressor.id, suppressor.updatedAt]);
    }
    const fields = presentApprovalFields(
      changes,
      declarations,
      action === "status"
        ? ["status"]
        : action === "snooze"
          ? ["snoozedUntil"]
          : action === "suppress"
            ? ["suppressedBy"]
            : []
    );
    return fields ? { target: candidate.title, fields, version: JSON.stringify(versions) } : null;
  };
}

export function commitmentRoutePresentation(
  action: "status" | "suppress"
): RouteApprovalPresentation {
  const present = commitmentPresentation(action);
  return async (db, input, ctx) => {
    if (
      Object.keys(input.params).length !== 1 ||
      !input.params.id ||
      (input.query && Object.keys(input.query).length) ||
      !input.body ||
      typeof input.body !== "object" ||
      Array.isArray(input.body) ||
      Object.hasOwn(input.body, "candidateId")
    )
      return null;
    return present(
      db,
      { ...(input.body as Record<string, unknown>), candidateId: input.params.id },
      ctx
    );
  };
}
