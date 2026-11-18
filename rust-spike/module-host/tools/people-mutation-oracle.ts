// Runs the existing implementation. The caller rolls the whole workflow back.
import { assertDataContextDb } from "@moss/db";
import { sql } from "kysely";
import { PeopleRepository } from "../../../packages/people/src/repository.js";
import { PersonContextService } from "../../../packages/people/src/service.js";

export async function mutationOracle(scope: unknown, ownerUserId: string): Promise<unknown> {
  assertDataContextDb(scope);
  const repo = new PeopleRepository();
  const service = new PersonContextService(repo);
  const startedAt = new Date().toISOString();
  const alpha = await repo.findOrCreatePerson(scope, ownerUserId, "Mutation Alpha");
  const beta = await repo.findOrCreatePerson(scope, ownerUserId, "Mutation Beta");
  const identityInput = {
    ownerUserId,
    personId: alpha.id,
    identityKind: "email_address",
    sourceKind: "email",
    normalizedValue: "mutation@example.test",
    displayValue: "Initial address",
    sourceRef: "initial-ref",
    sourceRefHash: "initial-hash",
    status: "active",
    confidence: 0.6,
    provenance: "source"
  } as const;
  const identity = await repo.upsertIdentity(scope, identityInput);
  const identityAgain = await repo.upsertIdentity(scope, {
    ...identityInput,
    personId: beta.id,
    displayValue: "Changed address",
    confidence: 0.9,
    sourceRef: "ignored-ref"
  });
  const aliasInput = {
    ...identityInput,
    identityKind: "alias",
    sourceKind: "manual",
    normalizedValue: "same alias",
    displayValue: "Same Alias"
  } as const;
  const aliasFirst = await repo.upsertIdentity(scope, aliasInput);
  const aliasSecond = await repo.upsertIdentity(scope, aliasInput);
  const linkInput = {
    ownerUserId,
    personId: beta.id,
    sourceKind: "email",
    sourceRef: "first-ref",
    sourceRefHash: "mutation-link",
    linkKind: "sender",
    sourceLabel: "First label",
    summary: "First summary",
    occurredAt: new Date("2020-01-01Z"),
    confidence: 0.6
  } as const;
  const link = await repo.upsertLink(scope, linkInput);
  const linkAgain = await repo.upsertLink(scope, {
    ...linkInput,
    sourceRef: "ignored-ref",
    sourceLabel: "Changed label",
    summary: "Changed summary",
    occurredAt: new Date("2021-01-01Z"),
    confidence: 0.9
  });
  const sourceInput = {
    ownerUserId,
    linkId: link.id,
    identityId: identity.id,
    sourceRefHash: "source-hash",
    linkKind: "sender",
    confidence: 0.6
  } as const;
  const source = await repo.upsertLinkSource(scope, sourceInput);
  const sourceAgain = await repo.upsertLinkSource(scope, {
    ...sourceInput,
    identityId: null,
    confidence: 0.9
  });
  const candidateInput = {
    ownerUserId,
    candidateKind: "link_identity",
    primaryPersonId: alpha.id,
    identityId: identity.id,
    reasonSummary: "Original reason",
    confidence: 0.6,
    ids: ["mutation-case"]
  } as const;
  const candidate = await repo.upsertMatchCandidate(scope, {
    ...candidateInput,
    ids: [...candidateInput.ids]
  });
  await service.rejectCandidate(scope, ownerUserId, candidate.id);
  const rejected = await repo.getMatchCandidate(scope, ownerUserId, candidate.id);
  const candidateAgain = await repo.upsertMatchCandidate(scope, {
    ...candidateInput,
    ids: [...candidateInput.ids],
    reasonSummary: "Ignored reason",
    confidence: 0.9
  });
  await service.acceptCandidate(scope, ownerUserId, candidate.id);
  const accepted = await repo.getMatchCandidate(scope, ownerUserId, candidate.id);
  const merged = await service.mergePeople(scope, ownerUserId, alpha.id, beta.id);
  const split = await service.splitIdentity(
    scope,
    ownerUserId,
    identity.id,
    undefined,
    "Mutation New"
  );
  const responses = {
    alpha,
    beta,
    identity,
    identityAgain,
    aliasFirst,
    aliasSecond,
    link,
    linkAgain,
    source,
    sourceAgain,
    candidate,
    rejected,
    candidateAgain,
    accepted,
    merged,
    split
  };
  const rows: Record<string, unknown> = {};
  for (const table of [
    "app.person_context_people",
    "app.person_context_identities",
    "app.person_context_links",
    "app.person_context_link_sources",
    "app.person_context_match_candidates",
    "app.person_context_events",
    "app.person_context_indexing_state"
  ] as const) {
    const result = await sql<{
      row: unknown;
    }>`SELECT to_jsonb(p) AS row FROM ${sql.table(table)} AS p WHERE p.owner_user_id=${ownerUserId}`.execute(
      scope.db
    );
    rows[table] = result.rows.map((row) => row.row);
  }
  return { startedAt, responses, rows };
}
