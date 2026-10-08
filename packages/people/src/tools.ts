import {
  peopleMatchPresentation,
  peopleMergePresentation,
  peopleSplitPresentation
} from "./approval-presentation.js";
import { assertDataContextDb } from "@moss/db";
import type { ModuleAssistantToolManifest, ToolExecute } from "@moss/module-sdk";
import { PeopleRepository } from "./repository.js";
import { PersonContextService } from "./service.js";

const repo = new PeopleRepository();
const svc = new PersonContextService(repo);

const resolveExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { query } = input as { query: string };
  const person = await svc.resolve(scopedDb, ctx.actorUserId, query);
  return { data: { person: person ?? null } };
};

const getContextExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { personId } = input as { personId: string };
  const detail = await svc.getPerson(scopedDb, ctx.actorUserId, personId);
  const links = await svc.listLinks(scopedDb, ctx.actorUserId, personId, {});
  const linksWithCitation = links.map((link) => ({
    ...link,
    citationToken: `${link.sourceKind}:${link.sourceRefHash}:${link.id}`
  }));
  return {
    data: { person: detail, links: linksWithCitation },
    columnOrder: ["id", "linkKind", "summary", "occurredAt", "citationToken"]
  };
};

const listRecentExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { limit } = input as { limit?: number };
  const people = await svc.listPeople(scopedDb, ctx.actorUserId, { limit: limit ?? 20 });
  return { data: { items: people }, columnOrder: ["id", "displayName", "status", "updatedAt"] };
};

const acceptMatchExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { candidateId } = input as { candidateId: string };
  await svc.acceptCandidate(scopedDb, ctx.actorUserId, candidateId);
  return { data: { accepted: true } };
};

const rejectMatchExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { candidateId } = input as { candidateId: string };
  await svc.rejectCandidate(scopedDb, ctx.actorUserId, candidateId);
  return { data: { rejected: true } };
};

const mergeExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { primaryPersonId, secondaryPersonId } = input as {
    primaryPersonId: string;
    secondaryPersonId: string;
  };
  const merged = await svc.mergePeople(
    scopedDb,
    ctx.actorUserId,
    primaryPersonId,
    secondaryPersonId
  );
  return { data: { person: merged } };
};

const splitIdentityExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { identityId, targetPersonId, newPersonDisplayName } = input as {
    identityId: string;
    targetPersonId?: string;
    newPersonDisplayName?: string;
  };
  const person = await svc.splitIdentity(
    scopedDb,
    ctx.actorUserId,
    identityId,
    targetPersonId,
    newPersonDisplayName
  );
  return { data: { person } };
};

export const PEOPLE_TOOLS: ModuleAssistantToolManifest[] = [
  {
    name: "people.resolve",
    description: "Find a person by name or email address. Returns the matched person or null.",
    permissionId: "people:read",
    risk: "read",
    content: "outside",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Name or email address to look up" }
      }
    },
    execute: resolveExecute
  },
  {
    name: "people.getContext",
    description:
      "Get full person context including all known links (emails, meetings, tasks). " +
      "Each link includes a citationToken for source attribution.",
    permissionId: "people:read",
    risk: "read",
    content: "outside",
    inputSchema: {
      type: "object",
      required: ["personId"],
      properties: {
        personId: { type: "string" }
      }
    },
    execute: getContextExecute
  },
  {
    name: "people.listRecent",
    description: "List recently seen people.",
    permissionId: "people:read",
    risk: "read",
    content: "outside",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20, maximum: 100 }
      }
    },
    execute: listRecentExecute
  },
  {
    name: "people.acceptMatch",
    actionLabel: "Accept People match",
    approvalPresentation: peopleMatchPresentation(true),
    description:
      "Accept a match candidate (link_identity or create_person kind). " +
      "For merge_people or split_identity candidates, use people.merge or people.splitIdentity instead.",
    permissionId: "people:write",
    actionFamilyId: "people_review",
    risk: "write",
    content: "user_authored",
    executionPolicy: "auto",
    selfOperationGrant: "granted_at_install",
    inputSchema: {
      type: "object",
      required: ["candidateId"],
      properties: {
        candidateId: { type: "string" }
      }
    },
    execute: acceptMatchExecute
  },
  {
    name: "people.rejectMatch",
    actionLabel: "Reject People match",
    approvalPresentation: peopleMatchPresentation(false),
    description: "Reject a match candidate.",
    permissionId: "people:write",
    actionFamilyId: "people_review",
    risk: "write",
    content: "user_authored",
    executionPolicy: "auto",
    selfOperationGrant: "granted_at_install",
    inputSchema: {
      type: "object",
      required: ["candidateId"],
      properties: {
        candidateId: { type: "string" }
      }
    },
    execute: rejectMatchExecute
  },
  {
    name: "people.merge",
    actionLabel: "Merge people",
    approvalPresentation: peopleMergePresentation,
    description:
      "Merge two people records into one. The secondary person is archived and all its " +
      "identities and links are re-linked to the primary. This action is irreversible.",
    permissionId: "people:merge",
    risk: "destructive",
    executionPolicy: "confirm",
    selfOperationGrant: "confirm_always",
    inputSchema: {
      type: "object",
      required: ["primaryPersonId", "secondaryPersonId"],
      properties: {
        primaryPersonId: { type: "string", description: "Person to keep" },
        secondaryPersonId: { type: "string", description: "Person to merge and archive" }
      }
    },
    execute: mergeExecute
  },
  {
    name: "people.splitIdentity",
    actionLabel: "Separate a person identity",
    approvalPresentation: peopleSplitPresentation,
    description:
      "Move an identity from its current person to a different person (or a new one). " +
      "Use when two identities were incorrectly merged. This action is irreversible.",
    permissionId: "people:split",
    risk: "destructive",
    executionPolicy: "confirm",
    selfOperationGrant: "confirm_always",
    inputSchema: {
      type: "object",
      required: ["identityId"],
      properties: {
        identityId: { type: "string" },
        targetPersonId: {
          type: "string",
          description: "Existing person to move the identity to. Omit to create a new person."
        },
        newPersonDisplayName: {
          type: "string",
          description: "Display name for the new person (required when targetPersonId is omitted)."
        }
      }
    },
    execute: splitIdentityExecute
  }
];
