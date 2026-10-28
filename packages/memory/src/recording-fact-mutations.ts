import { createHash } from "node:crypto";
import { sql } from "kysely";
import {
  assertDataContextDb,
  assertUuid,
  readScopedActorUserId,
  type DataContextDb,
  type ManagedSourceKey
} from "@moss/db";
import type {
  RecordingFactAuthority,
  RecordingFactSourceSnapshot
} from "./recording-fact-authority.js";

export class RecordingFactConflictError extends Error {
  readonly code = "recording_memory_conflict";
  constructor() {
    super(
      "This recording's memory has changed or is being removed; refresh its saved state before continuing"
    );
    this.name = "RecordingFactConflictError";
  }
}

interface FactIdentity {
  readonly id: string;
  readonly subject_entity_id: string;
  readonly object_entity_id: string | null;
  readonly conflict_group_id: string | null;
  readonly row_version: string;
  readonly recording_side: "personal" | "work" | null;
  readonly version_revision: string | null;
}
interface AssociationIdentity {
  readonly receipt_id: string;
  readonly fact_id: string;
  readonly source_module_id: "meetings";
  readonly source_id: string;
  readonly source_version: number;
  readonly item_key: string;
  readonly source_generation: number;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: string;
}
interface MutationSet {
  readonly facts: readonly FactIdentity[];
  readonly associations: readonly AssociationIdentity[];
}
interface LiveMutation {
  readonly owner: string;
  readonly factIds: ReadonlySet<string>;
}

/** Admission precedes every managed graph lock. A scope cannot grow its source set. */
export class RecordingFactMutations {
  private readonly live = new WeakMap<DataContextDb, LiveMutation>();
  constructor(private readonly authority?: RecordingFactAuthority) {}

  /** A review captures all existing associations plus its own reserved source. */
  async capture(
    db: DataContextDb,
    owner: string,
    ids: readonly string[],
    additional: readonly ManagedSourceKey[]
  ): Promise<RecordingFactSourceSnapshot> {
    if (!this.authority) throw new RecordingFactConflictError();
    const state = await this.discover(db, owner, ids);
    const sources = [
      ...additional,
      ...state.associations.map((receipt) => ({
        ownerUserId: owner,
        sourceModuleId: receipt.source_module_id,
        sourceId: receipt.source_id
      }))
    ];
    return this.authority.captureSourcesScoped(db, sources);
  }

  /** Reviewed source mutations use the captured snapshot even before a fact exists. */
  async withPrepared<T>(
    db: DataContextDb,
    expected: RecordingFactSourceSnapshot,
    ids: readonly string[],
    work: () => Promise<T>,
    reconcilingSource: ManagedSourceKey | null = null
  ): Promise<T> {
    const owner = expected.ownerUserId;
    if (!this.authority || this.live.has(db)) throw new RecordingFactConflictError();
    const initial = await this.discover(db, owner, ids);
    for (const receipt of initial.associations) {
      const captured = expected.sources.find(
        (entry) =>
          entry.source.sourceModuleId === receipt.source_module_id &&
          entry.source.sourceId === receipt.source_id
      );
      const reconciling =
        reconcilingSource?.sourceModuleId === receipt.source_module_id &&
        reconcilingSource.sourceId === receipt.source_id;
      if (!captured || (!reconciling && captured.generation !== receipt.source_generation)) {
        throw new RecordingFactConflictError();
      }
    }
    return this.authority.withPublicationScoped(db, expected, async () => {
      await this.lockSet(db, owner, initial);
      if (fingerprint(initial) !== fingerprint(await this.discover(db, owner, ids))) {
        throw new RecordingFactConflictError();
      }
      this.live.set(db, { owner, factIds: new Set(initial.facts.map((fact) => fact.id)) });
      try {
        return await work();
      } finally {
        this.live.delete(db);
      }
    });
  }

  async withFacts<T>(
    db: DataContextDb,
    owner: string,
    inputIds: readonly string[],
    work: () => Promise<T>
  ): Promise<T> {
    assertDataContextDb(db);
    assertUuid(owner, "Memory owner");
    for (const id of inputIds) assertUuid(id, "Memory fact");
    const ids = [...new Set(inputIds.map((id) => id.toLowerCase()))].sort();
    const initial = await this.discover(db, owner, ids);
    const managed = initial.facts.some((fact) => fact.version_revision !== null);
    if (!managed) return work();
    if ((await readScopedActorUserId(db))?.toLowerCase() !== owner.toLowerCase()) {
      throw new RecordingFactConflictError();
    }
    const currentScope = this.live.get(db);
    if (currentScope) {
      if (
        currentScope.owner !== owner ||
        initial.facts.some((fact) => !currentScope.factIds.has(fact.id))
      ) {
        throw new RecordingFactConflictError();
      }
      return work();
    }
    if (!this.authority || initial.associations.length === 0) {
      throw new RecordingFactConflictError();
    }
    const sources: ManagedSourceKey[] = initial.associations.map((receipt) => ({
      ownerUserId: owner,
      sourceModuleId: receipt.source_module_id,
      sourceId: receipt.source_id
    }));
    const snapshot = await this.authority.captureSourcesScoped(db, sources);
    // A source transition must finish reconciling its existing associations first.
    for (const receipt of initial.associations) {
      const captured = snapshot.sources.find(
        (entry) =>
          entry.source.sourceModuleId === receipt.source_module_id &&
          entry.source.sourceId === receipt.source_id
      );
      if (!captured || captured.generation !== receipt.source_generation) {
        throw new RecordingFactConflictError();
      }
    }
    return this.authority.withPublicationScoped(db, snapshot, async () => {
      await this.lockSet(db, owner, initial);
      if (fingerprint(await this.discover(db, owner, ids)) !== fingerprint(initial)) {
        throw new RecordingFactConflictError();
      }
      this.live.set(db, { owner, factIds: new Set(initial.facts.map((fact) => fact.id)) });
      try {
        return await work();
      } finally {
        this.live.delete(db);
      }
    });
  }

  /** A correction's newly allocated fact belongs to the already admitted source union. */
  includeReplacement(db: DataContextDb, owner: string, factId: string): void {
    const scope = this.live.get(db);
    if (!scope || scope.owner !== owner) throw new RecordingFactConflictError();
    this.live.set(db, { owner, factIds: new Set([...scope.factIds, factId]) });
  }

  assertLive(db: DataContextDb, owner: string, factId: string): void {
    const scope = this.live.get(db);
    if (!scope || scope.owner !== owner || !scope.factIds.has(factId)) {
      throw new RecordingFactConflictError();
    }
  }

  factIds(db: DataContextDb, owner: string): readonly string[] {
    const scope = this.live.get(db);
    return scope?.owner === owner ? [...scope.factIds].sort() : [];
  }

  /** Generic indexing cannot manufacture authority for an earlier computed embedding. */
  async assertSearchMutation(
    db: DataContextDb,
    owner: string,
    kind: string,
    id: string
  ): Promise<void> {
    const targets =
      kind === "fact"
        ? await sql<{ fact_id: string }>`
      SELECT fact_id FROM app.memory_recording_fact_versions
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ${id}::uuid`.execute(db.db)
        : kind === "episode"
          ? await sql<{ fact_id: string }>`
        SELECT fact_id FROM app.memory_recording_receipts
        WHERE owner_user_id = ${owner}::uuid AND episode_id = ${id}::uuid AND fact_id IS NOT NULL`.execute(
              db.db
            )
          : { rows: [] };
    for (const row of targets.rows) this.assertLive(db, owner, row.fact_id);
  }

  private async discover(
    db: DataContextDb,
    owner: string,
    ids: readonly string[]
  ): Promise<MutationSet> {
    const facts = await sql<FactIdentity>`
      SELECT f.id,f.subject_entity_id,f.object_entity_id,f.conflict_group_id,
        f.xmin::text AS row_version,f.recording_side,v.revision::text AS version_revision
      FROM app.memory_facts f
      LEFT JOIN app.memory_recording_fact_versions v
        ON v.owner_user_id = f.owner_user_id AND v.fact_id = f.id
      WHERE f.owner_user_id = ${owner}::uuid
        AND (f.id = ANY(${ids}::uuid[]) OR f.conflict_group_id IN (
          SELECT conflict_group_id FROM app.memory_facts
          WHERE owner_user_id = ${owner}::uuid AND id = ANY(${ids}::uuid[])
        )) ORDER BY f.id
    `.execute(db.db);
    const associations = await sql<AssociationIdentity>`
      SELECT receipt_id,fact_id,source_module_id,source_id,source_version,item_key,
        source_generation,revision,side,state
      FROM app.memory_recording_receipts
      WHERE owner_user_id = ${owner}::uuid
        AND fact_id = ANY(${facts.rows.map((fact) => fact.id)}::uuid[])
      ORDER BY receipt_id
    `.execute(db.db);
    return { facts: facts.rows, associations: associations.rows };
  }

  private async lockSet(db: DataContextDb, owner: string, state: MutationSet): Promise<void> {
    const groupIds = [
      ...new Set(state.facts.flatMap((fact) => fact.conflict_group_id ?? []))
    ].sort();
    const entityIds = [
      ...new Set(
        state.facts.flatMap((fact) => [
          fact.subject_entity_id,
          ...(fact.object_entity_id ? [fact.object_entity_id] : [])
        ])
      )
    ].sort();
    const factIds = state.facts.map((fact) => fact.id);
    // NOWAIT preserves approved forget's bounded rollback on document/sibling contention.
    await sql`SELECT id FROM app.memory_entities WHERE owner_user_id = ${owner}::uuid
      AND id = ANY(${entityIds}::uuid[]) ORDER BY id FOR SHARE NOWAIT`.execute(db.db);
    await sql`SELECT id FROM app.memory_conflict_groups WHERE owner_user_id = ${owner}::uuid
      AND id = ANY(${groupIds}::uuid[]) ORDER BY id FOR UPDATE NOWAIT`.execute(db.db);
    await sql`SELECT id FROM app.memory_facts WHERE owner_user_id = ${owner}::uuid
      AND id = ANY(${factIds}::uuid[]) ORDER BY id FOR UPDATE NOWAIT`.execute(db.db);
    await sql`SELECT fact_id FROM app.memory_recording_fact_versions WHERE owner_user_id = ${owner}::uuid
      AND fact_id = ANY(${factIds}::uuid[]) ORDER BY fact_id FOR UPDATE NOWAIT`.execute(db.db);
    await sql`SELECT receipt_id FROM app.memory_recording_receipts WHERE owner_user_id = ${owner}::uuid
      AND fact_id = ANY(${factIds}::uuid[]) ORDER BY receipt_id FOR UPDATE NOWAIT`.execute(db.db);
  }
}

function fingerprint(state: MutationSet): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
