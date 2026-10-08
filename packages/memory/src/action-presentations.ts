import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import { sql } from "kysely";
import {
  approvalBoolean,
  approvalChoice,
  approvalNumber,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation,
  type ToolContext
} from "@moss/module-sdk";
import { memoryEntityTarget } from "./chat-targets.js";

export type MemoryApprovalSourceResolver = (
  db: DataContextDb,
  input: {
    readonly actorUserId: string;
    readonly sourceKind: "chat" | "note" | "task" | "email" | "calendar" | "manual";
    readonly sourceRef: string;
  }
) => Promise<{ readonly label: string; readonly version: string } | null>;
let resolveSource: MemoryApprovalSourceResolver | undefined;
/** Bound by the composition host to public owning-module readers, never cross-module SQL. */
export function configureMemoryApprovalReferences(
  resolver: MemoryApprovalSourceResolver | undefined
): void {
  resolveSource = resolver;
}

const text = (label: string) => ({ label, present: approvalText });
const nullableText = (label: string) => ({
  label,
  present: (value: unknown) => (value === null ? "Not set" : approvalText(value))
});
const bool = (label: string) => ({ label, present: approvalBoolean });
const number = (label: string) => ({ label, present: approvalNumber });
const recordKind = {
  label: "Memory type",
  present: approvalChoice({
    fact: "Fact",
    preference: "Preference",
    goal: "Goal",
    constraint: "Constraint",
    decision: "Decision",
    relationship: "Relationship",
    alias: "Alias",
    inference: "Inference"
  })
};
const dates: ApprovalFieldMap = {
  validFrom: nullableText("Valid from"),
  validTo: nullableText("Valid until"),
  staleAt: nullableText("Review after"),
  pinned: bool("Pinned")
};
function routeFields(
  declarations: ApprovalFieldMap,
  target?: string,
  required: readonly string[] = []
): RouteApprovalPresentation {
  return async (_db, input) => {
    if (
      Object.keys(input.query ?? {}).length ||
      Object.keys(input.params).some((key) => key !== "id")
    )
      return null;
    const label = input.target ?? target;
    const fields = presentApprovalFields(input.body, declarations, required);
    return label && fields ? { target: label, fields } : null;
  };
}
export const memoryPinPresentation = routeFields({ pinned: bool("Pinned") }, undefined, ["pinned"]);
export const memorySupersedePresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  const result = await routeFields({
    validTo: {
      label: "Valid until",
      present: (value) => (value === null || value === "" ? "Now" : approvalText(value))
    }
  })(db, input, ctx);
  if (!result) return null;
  return result.fields.length
    ? result
    : { ...result, fields: [{ label: "Valid until", value: "Now" }] };
};
export const memoryDeleteEntityPresentation = routeFields({});
export const memoryDatesPresentation = routeFields(dates);
export const memoryRejectPresentation = routeFields({ reason: text("Reason") });
export const memoryAcceptPresentation = routeFields({
  edited: {
    label: "Changes",
    present: (value) =>
      presentApprovalFields(value, {
        summary: text("Memory"),
        recordKind,
        ...dates,
        entityName: text("Subject name"),
        entitySummary: nullableText("Subject summary")
      })
  }
});
export const memoryEditEntityPresentation = routeFields({
  name: text("Name"),
  summary: nullableText("Summary"),
  status: { label: "Status", present: approvalChoice({ active: "Active", archived: "Archived" }) }
});
export const memoryCreateEntityPresentation = routeFields(
  {
    kind: {
      label: "Subject type",
      present: approvalChoice({
        person: "Person",
        project: "Project",
        preference: "Preference",
        goal: "Goal",
        constraint: "Constraint",
        decision: "Decision",
        topic: "Topic",
        place: "Place",
        organization: "Organization",
        self: "You"
      })
    },
    name: text("Name"),
    summary: text("Summary"),
    importance: number("Importance"),
    pinned: bool("Pinned")
  },
  "Memory",
  ["kind", "name"]
);

/** Only already-owned source records or the exact current chat can stand in for a source ID. */
async function sourcePresentation(db: unknown, value: unknown, ctx: ToolContext) {
  assertDataContextDb(db);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.sourceKind !== "string" || typeof source.sourceRef !== "string") return null;
  if (!["chat", "note", "task", "email", "calendar", "manual"].includes(source.sourceKind))
    return null;
  let label: string | null = null;
  let version: string;
  if (source.sourceKind === "manual") {
    label = source.sourceRef;
    version = JSON.stringify(["manual", source.sourceRef]);
  } else if (source.sourceKind === "chat" && ctx.threadId && source.sourceRef === ctx.threadId) {
    label = "This conversation";
    version = JSON.stringify(["chat", ctx.threadId]);
  } else {
    // An authorization failure throws and cannot be mistaken for a vanished source.
    const current = await resolveSource?.(db, {
      actorUserId: ctx.actorUserId,
      sourceKind: source.sourceKind as Parameters<MemoryApprovalSourceResolver>[1]["sourceKind"],
      sourceRef: source.sourceRef
    });
    if (current) {
      label = current.label;
      version = current.version;
    } else {
      const row = await sql<{ id: string; source_label: string | null; excerpt: string }>`
      SELECT id, source_label, excerpt FROM app.memory_episodes
      WHERE owner_user_id = app.current_actor_user_id()
        AND source_kind = ${source.sourceKind} AND source_ref = ${source.sourceRef}
      ORDER BY created_at DESC LIMIT 1
    `.execute(db.db);
      label = row.rows[0]?.source_label || row.rows[0]?.excerpt || null;
      version = JSON.stringify(row.rows[0]);
    }
  }
  if (!label) return null;
  const fields = presentApprovalFields(
    source,
    {
      sourceKind: {
        label: "Source type",
        present: approvalChoice({
          chat: "Chat",
          note: "Note",
          task: "Task",
          email: "Email",
          calendar: "Calendar",
          manual: "Manual"
        })
      },
      sourceRef: {
        label: source.sourceKind === "manual" ? "Manual reference" : "Source",
        present: (entry) => (entry === source.sourceRef ? label : null)
      },
      sourceLabel: text("Source label"),
      excerpt: text("Source text")
    },
    ["sourceKind", "sourceRef", "excerpt"]
  );
  return fields ? { fields, version } : null;
}
async function rememberPresentation(db: unknown, input: Record<string, unknown>, ctx: ToolContext) {
  const names = new Map<string, string>();
  const versions: string[] = [];
  for (const key of ["subjectEntityId", "objectEntityId"]) {
    const id = input[key];
    if (id === undefined || id === null) continue;
    if (typeof id !== "string" || !isUuid(id)) return null;
    const target = await memoryEntityTarget(db, { id });
    if (!target) return null;
    names.set(id, typeof target === "string" ? target : target.label);
    versions.push(typeof target === "string" ? id : target.version);
  }
  const source = await sourcePresentation(db, input.source, ctx);
  if (!source) return null;
  const reference = (label: string) => ({
    label,
    present: (value: unknown) =>
      value === null ? "Not set" : typeof value === "string" ? (names.get(value) ?? null) : null
  });
  const fields = presentApprovalFields(
    input,
    {
      subjectEntityId: reference("Subject"),
      objectEntityId: reference("Related subject"),
      objectText: nullableText("Memory"),
      predicate: {
        label: "Relationship",
        present: approvalChoice({
          prefers: "Prefers",
          works_on: "Works on",
          has_goal: "Has goal",
          has_constraint: "Has constraint",
          decided: "Decided",
          related_to: "Related to",
          owes: "Owes",
          waiting_on: "Waiting on",
          mentioned_in: "Mentioned in",
          alias_of: "Also known as"
        })
      },
      recordKind,
      confidence: number("Confidence"),
      importance: number("Importance"),
      pinned: bool("Pinned"),
      provenance: {
        label: "How it was learned",
        present: approvalChoice({
          volunteered: "Volunteered",
          inferred: "Inferred",
          confirmed: "Confirmed",
          imported: "Imported"
        })
      },
      source: { label: "Source", present: () => source.fields }
    },
    ["predicate", "source"]
  );
  return fields
    ? {
        target: "Saved memory",
        fields,
        version: JSON.stringify([[...names], versions, source.version])
      }
    : null;
}
export const memoryRememberPresentation: ToolApprovalPresentation = rememberPresentation;
export const memoryRememberRoutePresentation: RouteApprovalPresentation = async (
  db,
  input,
  ctx
) => {
  if (
    Object.keys(input.params).length ||
    Object.keys(input.query ?? {}).length ||
    !input.body ||
    typeof input.body !== "object" ||
    Array.isArray(input.body)
  )
    return null;
  return rememberPresentation(db, input.body as Record<string, unknown>, ctx);
};
