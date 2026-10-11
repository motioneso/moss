import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import {
  ApprovalInputError,
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
    newPersonDisplayName: {
      label:
        targetPersonId !== undefined
          ? "Unused name (existing person selected)"
          : "Person name to find or create",
      present: approvalText
    }
  });
  if (!presented) return null;
  const fields = [...presented];
  const source = await identity(db, ctx.actorUserId, identityId);
  if (!source) return null;
  const versions: unknown[] = [source];
  let effect: string;
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
    effect = Object.hasOwn(rest, "newPersonDisplayName")
      ? "Move this identity to the selected existing person. The supplied new-person name is unused; no person is created or renamed. This cannot be undone."
      : "Move this identity to the selected existing person. No person is created or renamed. This cannot be undone.";
  } else {
    const name =
      typeof rest.newPersonDisplayName === "string"
        ? rest.newPersonDisplayName
        : source.display_value;
    // Match the execution's read-only get-or-create lookup and bind whether this name exists.
    const matches = await db.db
      .selectFrom("app.person_context_people")
      .select(["id", "display_name", "updated_at"])
      .where("owner_user_id", "=", ctx.actorUserId)
      .where("display_name", "=", name)
      .where("status", "!=", "merged")
      .limit(2)
      .execute();
    if (matches.length > 1)
      throw new ApprovalInputError(
        "More than one person has this name. Choose the specific existing person before moving the identity."
      );
    const existing = matches[0];
    fields.push({
      label: existing ? "Move to existing person" : "Create person named",
      value: name
    });
    versions.push(existing ?? null);
    effect = existing
      ? "Move this identity to the existing person with this exact name. No person is created. This cannot be undone."
      : "Create a person with this name and move this identity to that person. This cannot be undone.";
  }
  return {
    target: source.display_value,
    fields: [
      ...fields,
      {
        label: "Effect",
        value: effect
      }
    ],
    version: JSON.stringify(versions)
  };
};
