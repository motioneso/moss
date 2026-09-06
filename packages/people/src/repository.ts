import { assertDataContextDb } from "@moss/db";
import { candidateSignature } from "./matching.js";
import type {
  ListLinksParams,
  ListPeopleParams,
  MatchCandidate,
  Person,
  PersonCandidateKind,
  PersonCandidateStatus,
  PersonEvent,
  PersonEventKind,
  PersonIdentity,
  PersonIdentityKind,
  PersonIdentityStatus,
  PersonIndexingState,
  PersonLink,
  PersonLinkKind,
  PersonLinkSource,
  PersonProvenance,
  PersonSourceKind,
  PersonStatus
} from "./types.js";

export interface UpsertPersonParams {
  readonly ownerUserId: string;
  readonly displayName: string;
  readonly status?: PersonStatus;
  readonly confidence?: number;
}

export interface UpsertPersonProjectionParams extends UpsertPersonParams {
  readonly personId: string;
  readonly relationshipSummary?: string | null;
  readonly contextSummary?: string | null;
}

export interface UpsertIdentityParams {
  readonly ownerUserId: string;
  readonly personId: string | null;
  readonly identityKind: PersonIdentityKind;
  readonly sourceKind: PersonSourceKind;
  readonly normalizedValue: string;
  readonly displayValue: string;
  readonly sourceRef: string | null;
  readonly sourceRefHash: string | null;
  readonly status?: PersonIdentityStatus;
  readonly confidence?: number;
  readonly provenance?: PersonProvenance;
}

export interface UpsertLinkParams {
  readonly ownerUserId: string;
  readonly personId: string;
  readonly sourceKind: PersonSourceKind;
  readonly sourceRef: string;
  readonly sourceRefHash: string;
  readonly sourceLabel?: string | null;
  readonly linkKind: PersonLinkKind;
  readonly summary?: string | null;
  readonly occurredAt?: Date | null;
  readonly sourceUpdatedAt?: Date | null;
  readonly confidence?: number;
  readonly provenance?: PersonProvenance;
}

export interface UpsertLinkSourceParams {
  readonly ownerUserId: string;
  readonly linkId: string;
  readonly identityId: string | null;
  readonly sourceRefHash: string;
  readonly linkKind: PersonLinkKind;
  readonly confidence?: number;
}

export interface UpsertMatchCandidateParams {
  readonly ownerUserId: string;
  readonly candidateKind: PersonCandidateKind;
  readonly primaryPersonId?: string | null;
  readonly secondaryPersonId?: string | null;
  readonly identityId?: string | null;
  readonly suggestedDisplayName?: string | null;
  readonly reasonSummary?: string | null;
  readonly confidence?: number;
  readonly ids: string[];
}

export interface InsertEventParams {
  readonly ownerUserId: string;
  readonly eventKind: PersonEventKind;
  readonly personId?: string | null;
  readonly secondaryPersonId?: string | null;
  readonly identityId?: string | null;
  readonly candidateId?: string | null;
  readonly sourceRefHash?: string | null;
}

export interface UpsertIndexingStateParams {
  readonly ownerUserId: string;
  readonly source: PersonSourceKind;
  readonly sourceRefHash: string;
  readonly sourceRef: string;
  readonly lastIndexedAt?: Date | null;
  readonly lastSourceVersion?: string | null;
  readonly pendingSourceVersion?: string | null;
  readonly lastEnqueuedAt?: Date | null;
  readonly lastStartedAt?: Date | null;
  readonly lastFinishedAt?: Date | null;
  readonly failureCount?: number;
}

function rowToPerson(row: Record<string, unknown>): Person {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    displayName: row.display_name as string,
    relationshipSummary: (row.relationship_summary as string | null) ?? null,
    contextSummary: (row.context_summary as string | null) ?? null,
    status: row.status as PersonStatus,
    confidence: row.confidence as number,
    memoryEntityId: (row.memory_entity_id as string | null) ?? null,
    mergedIntoPersonId: (row.merged_into_person_id as string | null) ?? null,
    archivedAt: (row.archived_at as Date | null) ?? null,
    mergedAt: (row.merged_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function rowToIdentity(row: Record<string, unknown>): PersonIdentity {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    personId: (row.person_id as string | null) ?? null,
    identityKind: row.identity_kind as PersonIdentityKind,
    sourceKind: row.source_kind as PersonSourceKind,
    displayValue: row.display_value as string,
    sourceRefHash: (row.source_ref_hash as string | null) ?? null,
    status: row.status as PersonIdentityStatus,
    confidence: row.confidence as number,
    provenance: row.provenance as PersonProvenance,
    firstSeenAt: row.first_seen_at as Date,
    lastSeenAt: row.last_seen_at as Date,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function rowToLink(row: Record<string, unknown>): PersonLink {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    personId: row.person_id as string,
    sourceKind: row.source_kind as PersonSourceKind,
    sourceRefHash: row.source_ref_hash as string,
    sourceLabel: (row.source_label as string | null) ?? null,
    linkKind: row.link_kind as PersonLinkKind,
    summary: (row.summary as string | null) ?? null,
    occurredAt: (row.occurred_at as Date | null) ?? null,
    sourceUpdatedAt: (row.source_updated_at as Date | null) ?? null,
    confidence: row.confidence as number,
    provenance: row.provenance as PersonProvenance,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function rowToLinkSource(row: Record<string, unknown>): PersonLinkSource {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    linkId: row.link_id as string,
    identityId: (row.identity_id as string | null) ?? null,
    sourceRefHash: row.source_ref_hash as string,
    linkKind: row.link_kind as PersonLinkKind,
    confidence: row.confidence as number,
    createdAt: row.created_at as Date
  };
}

function rowToMatchCandidate(row: Record<string, unknown>): MatchCandidate {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    candidateKind: row.candidate_kind as PersonCandidateKind,
    status: row.status as PersonCandidateStatus,
    primaryPersonId: (row.primary_person_id as string | null) ?? null,
    secondaryPersonId: (row.secondary_person_id as string | null) ?? null,
    identityId: (row.identity_id as string | null) ?? null,
    suggestedDisplayName: (row.suggested_display_name as string | null) ?? null,
    reasonSummary: (row.reason_summary as string | null) ?? null,
    confidence: row.confidence as number,
    candidateSignature: row.candidate_signature as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

function rowToEvent(row: Record<string, unknown>): PersonEvent {
  return {
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    eventKind: row.event_kind as PersonEventKind,
    personId: (row.person_id as string | null) ?? null,
    secondaryPersonId: (row.secondary_person_id as string | null) ?? null,
    identityId: (row.identity_id as string | null) ?? null,
    candidateId: (row.candidate_id as string | null) ?? null,
    sourceRefHash: (row.source_ref_hash as string | null) ?? null,
    createdAt: row.created_at as Date
  };
}

function rowToIndexingState(row: Record<string, unknown>): PersonIndexingState {
  return {
    ownerUserId: row.owner_user_id as string,
    source: row.source as PersonSourceKind,
    sourceRefHash: row.source_ref_hash as string,
    sourceRef: row.source_ref as string,
    lastIndexedAt: (row.last_indexed_at as Date | null) ?? null,
    lastSourceVersion: (row.last_source_version as string | null) ?? null,
    pendingSourceVersion: (row.pending_source_version as string | null) ?? null,
    lastEnqueuedAt: (row.last_enqueued_at as Date | null) ?? null,
    lastStartedAt: (row.last_started_at as Date | null) ?? null,
    lastFinishedAt: (row.last_finished_at as Date | null) ?? null,
    failureCount: row.failure_count as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date
  };
}

export class PeopleRepository {
  async upsertPerson(scopedDb: unknown, params: UpsertPersonParams): Promise<Person> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    const existing = await scopedDb.db
      .selectFrom("app.person_context_people as p")
      .selectAll()
      .where("p.owner_user_id", "=", params.ownerUserId)
      .where("p.display_name", "=", params.displayName)
      .where("p.status", "!=", "merged")
      .executeTakeFirst();

    if (existing) return rowToPerson(existing as Record<string, unknown>);

    const row = await scopedDb.db
      .insertInto("app.person_context_people")
      .values({
        owner_user_id: params.ownerUserId,
        display_name: params.displayName,
        status: params.status ?? "active",
        confidence: params.confidence ?? 0.5,
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToPerson(row as Record<string, unknown>);
  }

  async upsertPersonProjection(
    scopedDb: unknown,
    params: UpsertPersonProjectionParams
  ): Promise<Person> {
    assertDataContextDb(scopedDb);
    const now = new Date();
    const status = params.status ?? "active";

    const row = await scopedDb.db
      .insertInto("app.person_context_people")
      .values({
        id: params.personId,
        owner_user_id: params.ownerUserId,
        display_name: params.displayName,
        relationship_summary: params.relationshipSummary ?? null,
        context_summary: params.contextSummary ?? null,
        status,
        confidence: params.confidence ?? 1,
        archived_at: status === "archived" ? now : null,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        // `id` is user/caller-controlled (e.g. an inbound identity-linking flow), so the update
        // half of this upsert is scoped to the same owner as a defense-in-depth belt-and-suspenders
        // check, even though RLS (USING/WITH CHECK owner_user_id = current_actor_user_id()) already
        // blocks a cross-owner row from being touched here today.
        oc
          .column("id")
          .doUpdateSet({
            display_name: params.displayName,
            relationship_summary: params.relationshipSummary ?? null,
            context_summary: params.contextSummary ?? null,
            status,
            confidence: params.confidence ?? 1,
            archived_at: status === "archived" ? now : null,
            updated_at: now
          })
          .where("app.person_context_people.owner_user_id", "=", params.ownerUserId)
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToPerson(row as Record<string, unknown>);
  }

  async findOrCreatePerson(
    scopedDb: unknown,
    ownerUserId: string,
    displayName: string
  ): Promise<Person> {
    return this.upsertPerson(scopedDb, { ownerUserId, displayName });
  }

  async getPerson(scopedDb: unknown, ownerUserId: string, personId: string): Promise<Person> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.person_context_people as p")
      .selectAll()
      .where("p.id", "=", personId)
      .where("p.owner_user_id", "=", ownerUserId)
      .executeTakeFirst();

    if (!row) throw Object.assign(new Error("Person not found"), { code: "NOT_FOUND" });
    return rowToPerson(row as Record<string, unknown>);
  }

  async listPeople(
    scopedDb: unknown,
    ownerUserId: string,
    params: ListPeopleParams
  ): Promise<Person[]> {
    assertDataContextDb(scopedDb);
    let q = scopedDb.db
      .selectFrom("app.person_context_people as p")
      .selectAll()
      .where("p.owner_user_id", "=", ownerUserId)
      .orderBy("p.display_name", "asc");

    if (params.status) q = q.where("p.status", "=", params.status);
    if (params.search) q = q.where("p.display_name", "ilike", `${params.search}%`);
    if (params.limit) q = q.limit(params.limit);

    const rows = await q.execute();
    return rows.map((r) => rowToPerson(r as Record<string, unknown>));
  }

  async updatePerson(
    scopedDb: unknown,
    ownerUserId: string,
    personId: string,
    patch: Partial<
      Pick<Person, "displayName" | "relationshipSummary" | "contextSummary" | "status">
    >
  ): Promise<Person> {
    assertDataContextDb(scopedDb);
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.relationshipSummary !== undefined)
      set.relationship_summary = patch.relationshipSummary;
    if (patch.contextSummary !== undefined) set.context_summary = patch.contextSummary;
    if (patch.status !== undefined) set.status = patch.status;

    const row = await scopedDb.db
      .updateTable("app.person_context_people")
      .set(set)
      .where("id", "=", personId)
      .where("owner_user_id", "=", ownerUserId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToPerson(row as Record<string, unknown>);
  }

  async archivePerson(scopedDb: unknown, ownerUserId: string, personId: string): Promise<Person> {
    return this.updatePerson(scopedDb, ownerUserId, personId, { status: "archived" });
  }

  async upsertIdentity(scopedDb: unknown, params: UpsertIdentityParams): Promise<PersonIdentity> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    const canConflict =
      (params.status === "active" || params.status === undefined) &&
      (params.identityKind === "email_address" || params.identityKind === "source_identity");

    if (canConflict) {
      const existing = await scopedDb.db
        .selectFrom("app.person_context_identities as i")
        .selectAll()
        .where("i.owner_user_id", "=", params.ownerUserId)
        .where("i.identity_kind", "=", params.identityKind)
        .where("i.source_kind", "=", params.sourceKind)
        .where("i.normalized_value", "=", params.normalizedValue)
        .where("i.status", "=", "active")
        .executeTakeFirst();

      if (existing) {
        const updated = await scopedDb.db
          .updateTable("app.person_context_identities")
          .set({
            display_value: params.displayValue,
            person_id: params.personId,
            last_seen_at: now,
            updated_at: now
          })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return rowToIdentity(updated as Record<string, unknown>);
      }
    }

    const row = await scopedDb.db
      .insertInto("app.person_context_identities")
      .values({
        owner_user_id: params.ownerUserId,
        person_id: params.personId,
        identity_kind: params.identityKind,
        source_kind: params.sourceKind,
        normalized_value: params.normalizedValue,
        display_value: params.displayValue,
        source_ref: params.sourceRef,
        source_ref_hash: params.sourceRefHash,
        status: params.status ?? "active",
        confidence: params.confidence ?? 0.5,
        provenance: params.provenance ?? "source",
        first_seen_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToIdentity(row as Record<string, unknown>);
  }

  /**
   * Every email address the owner has attached to a person, normalised (#2274). Used to tell the
   * email gate which senders the user already knows; never leaves the worker.
   */
  async listEmailIdentityValues(scopedDb: unknown, ownerUserId: string): Promise<string[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.person_context_identities as i")
      .select(["i.normalized_value"])
      .where("i.owner_user_id", "=", ownerUserId)
      .where("i.identity_kind", "=", "email_address")
      .execute();
    return rows.map((r) => r.normalized_value).filter((v): v is string => typeof v === "string");
  }

  async listIdentities(
    scopedDb: unknown,
    ownerUserId: string,
    personId: string
  ): Promise<PersonIdentity[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.person_context_identities as i")
      .select([
        "i.id",
        "i.owner_user_id",
        "i.person_id",
        "i.identity_kind",
        "i.source_kind",
        "i.display_value",
        "i.source_ref_hash",
        "i.status",
        "i.confidence",
        "i.provenance",
        "i.first_seen_at",
        "i.last_seen_at",
        "i.created_at",
        "i.updated_at"
      ])
      .where("i.owner_user_id", "=", ownerUserId)
      .where("i.person_id", "=", personId)
      .orderBy("i.last_seen_at", "desc")
      .execute();

    return rows.map((r) => rowToIdentity(r as Record<string, unknown>));
  }

  async deleteNoteIdentities(
    scopedDb: unknown,
    ownerUserId: string,
    personId: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .deleteFrom("app.person_context_identities")
      .where("owner_user_id", "=", ownerUserId)
      .where("person_id", "=", personId)
      .where("source_kind", "=", "note")
      .execute();
  }

  async upsertLink(scopedDb: unknown, params: UpsertLinkParams): Promise<PersonLink> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    const row = await scopedDb.db
      .insertInto("app.person_context_links")
      .values({
        owner_user_id: params.ownerUserId,
        person_id: params.personId,
        source_kind: params.sourceKind,
        source_ref: params.sourceRef,
        source_ref_hash: params.sourceRefHash,
        source_label: params.sourceLabel ?? null,
        link_kind: params.linkKind,
        summary: params.summary ?? null,
        occurred_at: params.occurredAt ?? null,
        source_updated_at: params.sourceUpdatedAt ?? null,
        confidence: params.confidence ?? 0.5,
        provenance: params.provenance ?? "source",
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "person_id", "source_ref_hash", "link_kind"]).doUpdateSet({
          source_label: params.sourceLabel ?? null,
          summary: params.summary ?? null,
          source_updated_at: params.sourceUpdatedAt ?? null,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToLink(row as Record<string, unknown>);
  }

  async listLinks(
    scopedDb: unknown,
    ownerUserId: string,
    personId: string,
    params: ListLinksParams
  ): Promise<PersonLink[]> {
    assertDataContextDb(scopedDb);
    let q = scopedDb.db
      .selectFrom("app.person_context_links as l")
      .select([
        "l.id",
        "l.owner_user_id",
        "l.person_id",
        "l.source_kind",
        "l.source_ref_hash",
        "l.source_label",
        "l.link_kind",
        "l.summary",
        "l.occurred_at",
        "l.source_updated_at",
        "l.confidence",
        "l.provenance",
        "l.created_at",
        "l.updated_at"
      ])
      .where("l.owner_user_id", "=", ownerUserId)
      .where("l.person_id", "=", personId)
      .orderBy("l.occurred_at", "desc")
      .orderBy("l.created_at", "desc");

    if (params.sourceKind) q = q.where("l.source_kind", "=", params.sourceKind);
    if (params.linkKind) q = q.where("l.link_kind", "=", params.linkKind);
    if (params.limit) q = q.limit(params.limit);

    const rows = await q.execute();
    return rows.map((r) => rowToLink(r as Record<string, unknown>));
  }

  async upsertLinkSource(
    scopedDb: unknown,
    params: UpsertLinkSourceParams
  ): Promise<PersonLinkSource> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    const row = await scopedDb.db
      .insertInto("app.person_context_link_sources")
      .values({
        owner_user_id: params.ownerUserId,
        link_id: params.linkId,
        identity_id: params.identityId,
        source_ref_hash: params.sourceRefHash,
        link_kind: params.linkKind,
        confidence: params.confidence ?? 0.5,
        created_at: now
      })
      .onConflict((oc) =>
        oc
          .columns(["owner_user_id", "link_id", "source_ref_hash"])
          .doUpdateSet({ confidence: params.confidence ?? 0.5 })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToLinkSource(row as Record<string, unknown>);
  }

  async upsertMatchCandidate(
    scopedDb: unknown,
    params: UpsertMatchCandidateParams
  ): Promise<MatchCandidate> {
    assertDataContextDb(scopedDb);
    const now = new Date();
    const sig = candidateSignature(params.candidateKind, params.ids);

    const row = await scopedDb.db
      .insertInto("app.person_context_match_candidates")
      .values({
        owner_user_id: params.ownerUserId,
        candidate_kind: params.candidateKind,
        status: "pending",
        primary_person_id: params.primaryPersonId ?? null,
        secondary_person_id: params.secondaryPersonId ?? null,
        identity_id: params.identityId ?? null,
        suggested_display_name: params.suggestedDisplayName ?? null,
        reason_summary: params.reasonSummary ?? null,
        confidence: params.confidence ?? 0.5,
        candidate_signature: sig,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "candidate_signature"]).doUpdateSet({
          confidence: params.confidence ?? 0.5,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToMatchCandidate(row as Record<string, unknown>);
  }

  async getMatchCandidate(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string
  ): Promise<MatchCandidate | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.person_context_match_candidates as mc")
      .selectAll()
      .where("mc.id", "=", candidateId)
      .where("mc.owner_user_id", "=", ownerUserId)
      .executeTakeFirst();

    return row ? rowToMatchCandidate(row as Record<string, unknown>) : null;
  }

  async listMatchCandidates(
    scopedDb: unknown,
    ownerUserId: string,
    status?: string
  ): Promise<MatchCandidate[]> {
    assertDataContextDb(scopedDb);
    let q = scopedDb.db
      .selectFrom("app.person_context_match_candidates as mc")
      .selectAll()
      .where("mc.owner_user_id", "=", ownerUserId)
      .orderBy("mc.created_at", "desc");

    if (status) q = q.where("mc.status", "=", status as never);
    else q = q.where("mc.status", "=", "pending");

    const rows = await q.execute();
    return rows.map((r) => rowToMatchCandidate(r as Record<string, unknown>));
  }

  async updateMatchCandidateStatus(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string,
    status: PersonCandidateStatus
  ): Promise<MatchCandidate> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.person_context_match_candidates")
      .set({ status, updated_at: new Date() })
      .where("id", "=", candidateId)
      .where("owner_user_id", "=", ownerUserId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToMatchCandidate(row as Record<string, unknown>);
  }

  async insertEvent(scopedDb: unknown, params: InsertEventParams): Promise<PersonEvent> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.person_context_events")
      .values({
        owner_user_id: params.ownerUserId,
        event_kind: params.eventKind,
        person_id: params.personId ?? null,
        secondary_person_id: params.secondaryPersonId ?? null,
        identity_id: params.identityId ?? null,
        candidate_id: params.candidateId ?? null,
        source_ref_hash: params.sourceRefHash ?? null,
        created_at: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToEvent(row as Record<string, unknown>);
  }

  async getIndexingState(
    scopedDb: unknown,
    ownerUserId: string,
    source: PersonSourceKind,
    sourceRefHash: string
  ): Promise<PersonIndexingState | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.person_context_indexing_state as s")
      .selectAll()
      .where("s.owner_user_id", "=", ownerUserId)
      .where("s.source", "=", source)
      .where("s.source_ref_hash", "=", sourceRefHash)
      .executeTakeFirst();

    return row ? rowToIndexingState(row as Record<string, unknown>) : null;
  }

  async upsertIndexingState(
    scopedDb: unknown,
    params: UpsertIndexingStateParams
  ): Promise<PersonIndexingState> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    const row = await scopedDb.db
      .insertInto("app.person_context_indexing_state")
      .values({
        owner_user_id: params.ownerUserId,
        source: params.source,
        source_ref_hash: params.sourceRefHash,
        source_ref: params.sourceRef,
        last_indexed_at: params.lastIndexedAt ?? null,
        last_source_version: params.lastSourceVersion ?? null,
        pending_source_version: params.pendingSourceVersion ?? null,
        last_enqueued_at: params.lastEnqueuedAt ?? null,
        last_started_at: params.lastStartedAt ?? null,
        last_finished_at: params.lastFinishedAt ?? null,
        failure_count: params.failureCount ?? 0,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "source", "source_ref_hash"]).doUpdateSet({
          source_ref: params.sourceRef,
          last_indexed_at: params.lastIndexedAt ?? null,
          last_source_version: params.lastSourceVersion ?? null,
          pending_source_version: params.pendingSourceVersion ?? null,
          last_enqueued_at: params.lastEnqueuedAt ?? null,
          last_started_at: params.lastStartedAt ?? null,
          last_finished_at: params.lastFinishedAt ?? null,
          failure_count: params.failureCount ?? 0,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToIndexingState(row as Record<string, unknown>);
  }

  async mergePeople(
    scopedDb: unknown,
    ownerUserId: string,
    primaryId: string,
    secondaryId: string
  ): Promise<Person> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    await scopedDb.db
      .updateTable("app.person_context_identities")
      .set({ person_id: primaryId, updated_at: now })
      .where("owner_user_id", "=", ownerUserId)
      .where("person_id", "=", secondaryId)
      .execute();

    await scopedDb.db
      .updateTable("app.person_context_links")
      .set({ person_id: primaryId, updated_at: now })
      .where("owner_user_id", "=", ownerUserId)
      .where("person_id", "=", secondaryId)
      .execute();

    await scopedDb.db
      .updateTable("app.person_context_people")
      .set({
        status: "merged",
        merged_into_person_id: primaryId,
        merged_at: now,
        updated_at: now
      })
      .where("id", "=", secondaryId)
      .where("owner_user_id", "=", ownerUserId)
      .execute();

    await this.insertEvent(scopedDb, {
      ownerUserId,
      eventKind: "merged",
      personId: primaryId,
      secondaryPersonId: secondaryId
    });

    return this.getPerson(scopedDb, ownerUserId, primaryId);
  }
}
