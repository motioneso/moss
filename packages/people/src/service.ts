import { sql } from "kysely";
import { assertDataContextDb } from "@moss/db";
import { normalizeIdentity } from "./matching.js";
import type { PeopleRepository } from "./repository.js";
import type {
  ListLinksParams,
  ListPeopleParams,
  MatchCandidate,
  Person,
  PersonDetail,
  PersonLink
} from "./types.js";

export class RequiresExplicitActionError extends Error {
  readonly code = "REQUIRES_EXPLICIT_ACTION";
  constructor(message: string) {
    super(message);
    this.name = "RequiresExplicitActionError";
  }
}

export class PersonContextService {
  constructor(private readonly repo: PeopleRepository) {}

  async resolve(scopedDb: unknown, ownerUserId: string, query: string): Promise<Person | null> {
    assertDataContextDb(scopedDb);
    const lowered = normalizeIdentity("email_address", query);

    // Identity values keep their stored case (aliases are title-cased), so compare lowercased.
    const identity = await scopedDb.db
      .selectFrom("app.person_context_identities as i")
      .select(["i.person_id"])
      .where("i.owner_user_id", "=", ownerUserId)
      .where(sql<boolean>`lower(i.normalized_value) = ${lowered}`)
      .executeTakeFirst();

    if (identity?.person_id) {
      return this.repo.getPerson(scopedDb, ownerUserId, identity.person_id);
    }

    const byName = await scopedDb.db
      .selectFrom("app.person_context_people as p")
      .select(["p.id"])
      .where("p.owner_user_id", "=", ownerUserId)
      .where(sql<boolean>`lower(p.display_name) = ${lowered}`)
      .orderBy("p.created_at")
      .executeTakeFirst();

    if (!byName) return null;
    return this.repo.getPerson(scopedDb, ownerUserId, byName.id);
  }

  async getPerson(scopedDb: unknown, ownerUserId: string, personId: string): Promise<PersonDetail> {
    const person = await this.repo.getPerson(scopedDb, ownerUserId, personId);
    const identities = await this.repo.listIdentities(scopedDb, ownerUserId, personId);
    const recentLinks = await this.repo.listLinks(scopedDb, ownerUserId, personId, { limit: 20 });
    return { ...person, identities, recentLinks };
  }

  async listPeople(
    scopedDb: unknown,
    ownerUserId: string,
    params: ListPeopleParams
  ): Promise<Person[]> {
    return this.repo.listPeople(scopedDb, ownerUserId, params);
  }

  async listLinks(
    scopedDb: unknown,
    ownerUserId: string,
    personId: string,
    params: ListLinksParams
  ): Promise<PersonLink[]> {
    return this.repo.listLinks(scopedDb, ownerUserId, personId, params);
  }

  async listMatchCandidates(scopedDb: unknown, ownerUserId: string): Promise<MatchCandidate[]> {
    return this.repo.listMatchCandidates(scopedDb, ownerUserId);
  }

  async acceptCandidate(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string
  ): Promise<void> {
    const candidate = await this.repo.getMatchCandidate(scopedDb, ownerUserId, candidateId);
    if (!candidate) throw Object.assign(new Error("Candidate not found"), { code: "NOT_FOUND" });

    if (
      candidate.candidateKind === "merge_people" ||
      candidate.candidateKind === "split_identity"
    ) {
      throw new RequiresExplicitActionError(
        `Candidate kind "${candidate.candidateKind}" requires explicit action via people.merge or people.splitIdentity`
      );
    }

    if (candidate.candidateKind === "link_identity" && candidate.identityId) {
      await this.repo.upsertIdentity(scopedDb, {
        ownerUserId,
        personId: candidate.primaryPersonId,
        identityKind: "alias",
        sourceKind: "manual",
        normalizedValue: candidateId,
        displayValue: candidateId,
        sourceRef: null,
        sourceRefHash: null,
        status: "active",
        confidence: candidate.confidence,
        provenance: "user_confirmed"
      });
      await this.repo.insertEvent(scopedDb, {
        ownerUserId,
        eventKind: "candidate_accepted",
        personId: candidate.primaryPersonId,
        candidateId
      });
    } else if (candidate.candidateKind === "create_person") {
      if (candidate.suggestedDisplayName) {
        await this.repo.findOrCreatePerson(scopedDb, ownerUserId, candidate.suggestedDisplayName);
      }
      await this.repo.insertEvent(scopedDb, {
        ownerUserId,
        eventKind: "candidate_accepted",
        candidateId
      });
    }

    await this.repo.updateMatchCandidateStatus(scopedDb, ownerUserId, candidateId, "accepted");
  }

  async rejectCandidate(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string
  ): Promise<void> {
    await this.repo.updateMatchCandidateStatus(scopedDb, ownerUserId, candidateId, "rejected");
    await this.repo.insertEvent(scopedDb, {
      ownerUserId,
      eventKind: "candidate_rejected",
      candidateId
    });
  }

  async suppressCandidate(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string
  ): Promise<void> {
    await this.repo.updateMatchCandidateStatus(scopedDb, ownerUserId, candidateId, "suppressed");
  }

  async splitIdentity(
    scopedDb: unknown,
    ownerUserId: string,
    identityId: string,
    targetPersonId?: string,
    newPersonDisplayName?: string
  ): Promise<Person> {
    assertDataContextDb(scopedDb);

    const identity = await scopedDb.db
      .selectFrom("app.person_context_identities as i")
      .selectAll()
      .where("i.id", "=", identityId)
      .where("i.owner_user_id", "=", ownerUserId)
      .executeTakeFirst();

    if (!identity) throw Object.assign(new Error("Identity not found"), { code: "NOT_FOUND" });

    const fromPersonId = identity.person_id;

    let toPersonId = targetPersonId;
    if (!toPersonId) {
      const displayName = newPersonDisplayName ?? identity.display_value;
      const newPerson = await this.repo.findOrCreatePerson(scopedDb, ownerUserId, displayName);
      toPersonId = newPerson.id;
    }

    await scopedDb.db
      .updateTable("app.person_context_identities")
      .set({ person_id: toPersonId, updated_at: new Date() })
      .where("id", "=", identityId)
      .where("owner_user_id", "=", ownerUserId)
      .execute();

    if (fromPersonId) {
      await this.repo.insertEvent(scopedDb, {
        ownerUserId,
        eventKind: "split",
        personId: fromPersonId,
        secondaryPersonId: toPersonId,
        identityId
      });
    }
    await this.repo.insertEvent(scopedDb, {
      ownerUserId,
      eventKind: "identity_linked",
      personId: toPersonId,
      identityId
    });

    return this.repo.getPerson(scopedDb, ownerUserId, toPersonId);
  }

  async mergePeople(
    scopedDb: unknown,
    ownerUserId: string,
    primaryId: string,
    secondaryId: string
  ): Promise<Person> {
    return this.repo.mergePeople(scopedDb, ownerUserId, primaryId, secondaryId);
  }
}
