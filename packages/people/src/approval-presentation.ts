import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import {
  approvalText,
  presentApprovalFields,
  type ApprovalField,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import { PeopleRepository } from "./repository.js";

const repository = new PeopleRepository();
async function person(db: DataContextDb, owner: string, id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.person_context_people")
    .select(["id", "display_name", "updated_at"])
    .where("owner_user_id", "=", owner)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ?? null;
}
async function identity(db: DataContextDb, owner: string, id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.person_context_identities")
    .select(["id", "display_value", "person_id", "updated_at"])
    .where("owner_user_id", "=", owner)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ?? null;
}

export function peopleMatchPresentation(accept: boolean): ToolApprovalPresentation {
  return async (db, input, ctx) => {
    assertDataContextDb(db);
    const { candidateId, ...rest } = input;
    if (!presentApprovalFields(rest, {}) || typeof candidateId !== "string" || !isUuid(candidateId))
      return null;
    const candidate = await repository.getMatchCandidate(db, ctx.actorUserId, candidateId);
    if (
      !candidate ||
      (accept &&
        (candidate.candidateKind === "merge_people" ||
          candidate.candidateKind === "split_identity"))
    )
      return null;
    const fields: ApprovalField[] = [];
    const versions: unknown[] = [[candidate.id, candidate.updatedAt]];
    if (candidate.suggestedDisplayName)
      fields.push({ label: "Suggested person", value: candidate.suggestedDisplayName });
    for (const [id, label] of [
      [candidate.primaryPersonId, "Person"],
      [candidate.secondaryPersonId, "Other person"]
    ] as const) {
      if (id === null) continue;
      const resolved = await person(db, ctx.actorUserId, id);
      if (!resolved) return null;
      fields.push({ label, value: resolved.display_name });
      versions.push(resolved);
    }
    if (candidate.identityId) {
      const resolved = await identity(db, ctx.actorUserId, candidate.identityId);
      if (!resolved) return null;
      fields.push({ label: "Identity", value: resolved.display_value });
      versions.push(resolved);
    }
    if (!fields.length) return null;
    if (candidate.reasonSummary)
      fields.push({ label: "Match reason", value: candidate.reasonSummary });
    const kinds = {
      create_person: "Create a person",
      link_identity: "Link an identity",
      merge_people: "Merge people",
      split_identity: "Separate an identity"
    };
    return {
      target: `People match: ${fields[0]!.value}`,
      fields: [{ label: "Match type", value: kinds[candidate.candidateKind] }, ...fields],
      version: JSON.stringify(versions)
    };
  };
}

export function peopleMatchRoutePresentation(accept: boolean): RouteApprovalPresentation {
  const present = peopleMatchPresentation(accept);
  return async (db, input, ctx) => {
    if (
      Object.keys(input.params).length !== 1 ||
      !input.params.id ||
      (input.query && Object.keys(input.query).length) ||
      !presentApprovalFields(input.body, {})
    )
      return null;
    return present(db, { candidateId: input.params.id }, ctx);
  };
}

export const peopleMergePresentation: ToolApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  const { primaryPersonId, secondaryPersonId, ...rest } = input;
  if (!presentApprovalFields(rest, {})) return null;
  const primary = await person(db, ctx.actorUserId, primaryPersonId);
  const secondary = await person(db, ctx.actorUserId, secondaryPersonId);
  if (!primary || !secondary || primary.id === secondary.id) return null;
  return {
    target: primary.display_name,
    fields: [
      { label: "Person to keep", value: primary.display_name },
      { label: "Person to merge and archive", value: secondary.display_name },
      {
        label: "Effect",
        value:
          "Move the archived person's identities and links to the person kept. This cannot be undone."
      }
    ],
    version: JSON.stringify([primary, secondary])
  };
};

export const peopleSplitPresentation: ToolApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  const { identityId, targetPersonId, ...rest } = input;
  const presented = presentApprovalFields(rest, {
    newPersonDisplayName: { label: "Name for a new person", present: approvalText }
  });
  if (!presented) return null;
  const fields = [...presented];
  const source = await identity(db, ctx.actorUserId, identityId);
  if (!source) return null;
  const versions: unknown[] = [source];
  if (source.person_id) {
    const from = await person(db, ctx.actorUserId, source.person_id);
    if (!from) return null;
    fields.push({ label: "Move from", value: from.display_name });
    versions.push(from);
  }
  if (targetPersonId !== undefined) {
    const to = await person(db, ctx.actorUserId, targetPersonId);
    if (!to) return null;
    fields.push({ label: "Move to", value: to.display_name });
    versions.push(to);
  } else {
    const name =
      typeof rest.newPersonDisplayName === "string"
        ? rest.newPersonDisplayName
        : source.display_value;
    // Match the execution's read-only get-or-create lookup and bind whether this name exists.
    const existing = await db.db
      .selectFrom("app.person_context_people")
      .select(["id", "display_name", "updated_at"])
      .where("owner_user_id", "=", ctx.actorUserId)
      .where("display_name", "=", name)
      .where("status", "!=", "merged")
      .executeTakeFirst();
    fields.push({
      label: existing ? "Move to existing person" : "Create person named",
      value: name
    });
    versions.push(existing ?? null);
  }
  return {
    target: source.display_value,
    fields: [
      ...fields,
      {
        label: "Effect",
        value: "Move this identity to the selected person. This cannot be undone."
      }
    ],
    version: JSON.stringify(versions)
  };
};
