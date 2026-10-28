import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  assertUuid,
  lockManagedActor,
  lockManagedSources,
  readScopedActorUserId,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner,
  type ManagedSourceKey
} from "@moss/db";

export class ManagedSourceUnavailableError extends Error {
  constructor() {
    super("This recording is unavailable for managed publication");
    this.name = "ManagedSourceUnavailableError";
  }
}
export class ManagedSourceFencedError extends Error {
  constructor() {
    super("This recording has changed or is being removed; refresh its saved state");
    this.name = "ManagedSourceFencedError";
  }
}

interface FenceRow {
  readonly generation: number;
  readonly state: "active" | "deleting" | "sealed";
  readonly operationId: string | null;
}
export interface ManagedSourceRevision {
  readonly source: ManagedSourceKey;
  readonly generation: number;
}
export interface ManagedSourceSnapshot {
  readonly ownerUserId: string;
  readonly actorGeneration: number;
  readonly sources: readonly ManagedSourceRevision[];
}
export interface ManagedDeletionOperation {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly state: "deleting" | "sealed";
  readonly source: ManagedSourceKey | null;
}

/** The host verifies current authority through the source module's public scoped API. */
export interface ManagedSourceAuthority {
  assertExists(db: DataContextDb, source: ManagedSourceKey): Promise<void>;
}
const admissionBrand: unique symbol = Symbol("ManagedSourceAdmission");
export interface ManagedSourceAdmission extends ManagedSourceSnapshot {
  readonly [admissionBrand]: true;
}
const liveAdmissions = new WeakMap<ManagedSourceAdmission, DataContextDb>();

const cleanupBrand: unique symbol = Symbol("ManagedCleanupAdmission");
export interface ManagedCleanupAdmission {
  readonly [cleanupBrand]: true;
  readonly operation: ManagedDeletionOperation;
}
const liveCleanupAdmissions = new WeakMap<ManagedCleanupAdmission, DataContextDb>();

export function assertManagedCleanupAdmission(
  db: DataContextDb,
  admission: ManagedCleanupAdmission
): void {
  if (liveCleanupAdmissions.get(admission) !== db) {
    throw new Error("Managed cleanup requires its current scoped cleanup callback");
  }
}

export function assertManagedSourceAdmission(
  db: DataContextDb,
  admission: ManagedSourceAdmission
): void {
  if (liveAdmissions.get(admission) !== db) {
    throw new Error("Managed publication requires its current scoped admission callback");
  }
}

async function scopedOwner(db: DataContextDb): Promise<string> {
  const owner = await readScopedActorUserId(db);
  if (!owner) throw new ManagedSourceUnavailableError();
  assertUuid(owner, "Managed source owner");
  return owner.toLowerCase();
}
function ownedSource(owner: string, source: ManagedSourceKey): ManagedSourceKey {
  if (source.ownerUserId.toLowerCase() !== owner) throw new ManagedSourceUnavailableError();
  assertUuid(source.sourceId, "Managed source ID");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source.sourceModuleId)) {
    throw new ManagedSourceUnavailableError();
  }
  return {
    ...source,
    ownerUserId: owner,
    sourceId: source.sourceId.toLowerCase()
  };
}
async function readActor(db: DataContextDb, owner: string): Promise<FenceRow | undefined> {
  const result = await sql<FenceRow>`
    select generation, state, operation_id as "operationId"
    from app.notes_managed_actors where owner_user_id = ${owner}::uuid
  `.execute(db.db);
  return result.rows[0];
}
async function readSource(
  db: DataContextDb,
  source: ManagedSourceKey
): Promise<FenceRow | undefined> {
  const result = await sql<FenceRow>`
    select generation, state, operation_id as "operationId"
    from app.notes_managed_sources
    where owner_user_id = ${source.ownerUserId}::uuid
      and source_module_id = ${source.sourceModuleId} and source_id = ${source.sourceId}::uuid
  `.execute(db.db);
  return result.rows[0];
}
async function ensureActor(db: DataContextDb, owner: string): Promise<FenceRow> {
  await sql`
    insert into app.notes_managed_actors(owner_user_id, generation, state)
    select ${owner}::uuid, 0, 'active'
    where exists(select 1 from app.users where id = ${owner}::uuid)
    on conflict(owner_user_id) do nothing
  `.execute(db.db);
  const actor = await readActor(db, owner);
  if (!actor) throw new ManagedSourceUnavailableError();
  return actor;
}
function requireActive(
  row: FenceRow | undefined,
  expectedGeneration?: number
): asserts row is FenceRow {
  if (
    !row ||
    row.state !== "active" ||
    (expectedGeneration !== undefined && row.generation !== expectedGeneration)
  ) {
    throw new ManagedSourceFencedError();
  }
}
function deletionOperation(
  owner: string,
  source: ManagedSourceKey | null,
  row: FenceRow
): ManagedDeletionOperation {
  if (row.state === "active" || !row.operationId)
    throw new Error("Expected a persisted deletion operation");
  return {
    ownerUserId: owner,
    source,
    operationId: row.operationId,
    generation: row.generation,
    state: row.state
  };
}

function requireDeletion(
  row: FenceRow | undefined,
  operation: ManagedDeletionOperation
): asserts row is FenceRow {
  if (
    !row ||
    row.state === "active" ||
    row.generation !== operation.generation ||
    row.operationId !== operation.operationId
  ) {
    throw new ManagedSourceFencedError();
  }
}

/** Owns short actor/source transactions. Model and embedding work belongs outside these callbacks. */
export class ManagedSourceLifecycle {
  constructor(
    private readonly runner: DataContextRunner,
    private readonly authority: ManagedSourceAuthority
  ) {}

  async registerSource(
    access: AccessContext,
    input: ManagedSourceKey
  ): Promise<ManagedSourceSnapshot> {
    return this.runner.withDataContext(access, async (db) => {
      const owner = await scopedOwner(db);
      const source = ownedSource(owner, input);
      await lockManagedActor(db, owner, "shared");
      await lockManagedSources(db, [source], "exclusive");
      const actor = await ensureActor(db, owner);
      requireActive(actor);
      await this.authority.assertExists(db, source);
      await sql`
        insert into app.notes_managed_sources(owner_user_id, source_module_id, source_id, generation, state)
        values (${owner}::uuid, ${source.sourceModuleId}, ${source.sourceId}::uuid, 0, 'active')
        on conflict(owner_user_id, source_module_id, source_id) do nothing
      `.execute(db.db);
      const current = await readSource(db, source);
      requireActive(current);
      return {
        ownerUserId: owner,
        actorGeneration: actor.generation,
        sources: [{ source, generation: current.generation }]
      };
    });
  }

  async withPublication<T>(
    access: AccessContext,
    expected: ManagedSourceSnapshot,
    work: (db: DataContextDb, admission: ManagedSourceAdmission) => Promise<T>
  ): Promise<T> {
    return this.runner.withDataContext(access, (db) =>
      this.withPublicationScoped(db, expected, work)
    );
  }

  async withPublicationScoped<T>(
    db: DataContextDb,
    expected: ManagedSourceSnapshot,
    work: (db: DataContextDb, admission: ManagedSourceAdmission) => Promise<T>
  ): Promise<T> {
    return this.withAdmissionScoped(db, expected, "shared", work);
  }

  /** Short reservation serializes source receipt limits without changing semantic generation. */
  async withReservation<T>(
    access: AccessContext,
    expected: ManagedSourceSnapshot,
    work: (db: DataContextDb, admission: ManagedSourceAdmission) => Promise<T>
  ): Promise<T> {
    if (expected.sources.length !== 1) throw new ManagedSourceUnavailableError();
    return this.runner.withDataContext(access, (db) =>
      this.withAdmissionScoped(db, expected, "exclusive", work)
    );
  }

  /** Actor-only admission is for a validated bound destination with no remaining sources. */
  async withActorPublicationScoped<T>(
    db: DataContextDb,
    expected: Pick<ManagedSourceSnapshot, "ownerUserId" | "actorGeneration">,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T> {
    const owner = await scopedOwner(db);
    if (expected.ownerUserId.toLowerCase() !== owner) throw new ManagedSourceUnavailableError();
    await lockManagedActor(db, owner, "shared");
    requireActive(await readActor(db, owner), expected.actorGeneration);
    return work(db);
  }

  private async withAdmissionScoped<T>(
    db: DataContextDb,
    expected: ManagedSourceSnapshot,
    mode: "shared" | "exclusive",
    work: (db: DataContextDb, admission: ManagedSourceAdmission) => Promise<T>
  ): Promise<T> {
    const owner = await scopedOwner(db);
    if (expected.ownerUserId.toLowerCase() !== owner || expected.sources.length === 0)
      throw new ManagedSourceUnavailableError();
    const sources = expected.sources.map((entry) => ({
      source: ownedSource(owner, entry.source),
      generation: entry.generation
    }));
    await lockManagedActor(db, owner, "shared");
    await lockManagedSources(
      db,
      sources.map((entry) => entry.source),
      mode
    );
    requireActive(await readActor(db, owner), expected.actorGeneration);
    for (const entry of sources) {
      requireActive(await readSource(db, entry.source), entry.generation);
      await this.authority.assertExists(db, entry.source);
    }
    const admission = Object.freeze<ManagedSourceAdmission>({
      [admissionBrand]: true,
      ownerUserId: owner,
      actorGeneration: expected.actorGeneration,
      sources: Object.freeze(
        sources.map((entry) => Object.freeze({ ...entry, source: Object.freeze(entry.source) }))
      )
    });
    liveAdmissions.set(admission, db);
    try {
      return await work(db, admission);
    } finally {
      liveAdmissions.delete(admission);
    }
  }

  /** The owner/source composition persists its new semantic state in this same transaction. */
  async advanceSource<T>(
    access: AccessContext,
    expected: ManagedSourceSnapshot,
    work: (db: DataContextDb, next: ManagedSourceSnapshot) => Promise<T>
  ): Promise<T> {
    return this.runner.withDataContext(access, async (db) => {
      const owner = await scopedOwner(db);
      if (expected.ownerUserId.toLowerCase() !== owner || expected.sources.length !== 1)
        throw new ManagedSourceUnavailableError();
      const entry = expected.sources[0]!;
      const source = ownedSource(owner, entry.source);
      await lockManagedActor(db, owner, "shared");
      await lockManagedSources(db, [source], "exclusive");
      requireActive(await readActor(db, owner), expected.actorGeneration);
      requireActive(await readSource(db, source), entry.generation);
      await this.authority.assertExists(db, source);
      const updated = await sql<{ generation: number }>`
        update app.notes_managed_sources set generation = generation + 1
        where owner_user_id = ${owner}::uuid and source_module_id = ${source.sourceModuleId}
          and source_id = ${source.sourceId}::uuid returning generation
      `.execute(db.db);
      const next = updated.rows[0];
      if (!next) throw new ManagedSourceUnavailableError();
      return work(db, {
        ownerUserId: owner,
        actorGeneration: expected.actorGeneration,
        sources: [{ source, generation: next.generation }]
      });
    });
  }

  async fenceActor(access: AccessContext): Promise<ManagedDeletionOperation> {
    return this.runner.withDataContext(access, async (db) => {
      const owner = await scopedOwner(db);
      await lockManagedActor(db, owner, "exclusive");
      const actor = await ensureActor(db, owner);
      if (actor.state !== "active") return deletionOperation(owner, null, actor);
      const result = await sql<FenceRow>`
        update app.notes_managed_actors set generation = generation + 1, state = 'deleting', operation_id = ${randomUUID()}::uuid
        where owner_user_id = ${owner}::uuid
        returning generation, state, operation_id as "operationId"
      `.execute(db.db);
      return deletionOperation(owner, null, result.rows[0]!);
    });
  }

  async fenceSource(
    access: AccessContext,
    input: ManagedSourceKey
  ): Promise<ManagedDeletionOperation> {
    return this.runner.withDataContext(access, async (db) => {
      const owner = await scopedOwner(db);
      const source = ownedSource(owner, input);
      await lockManagedActor(db, owner, "shared");
      await lockManagedSources(db, [source], "exclusive");
      requireActive(await ensureActor(db, owner));
      const current = await readSource(db, source);
      if (current && current.state !== "active") return deletionOperation(owner, source, current);
      await this.authority.assertExists(db, source);
      const result = await sql<FenceRow>`
        insert into app.notes_managed_sources(owner_user_id, source_module_id, source_id, generation, state, operation_id)
        values (${owner}::uuid, ${source.sourceModuleId}, ${source.sourceId}::uuid, 1, 'deleting', ${randomUUID()}::uuid)
        on conflict(owner_user_id, source_module_id, source_id) do update
          set generation = app.notes_managed_sources.generation + 1, state = excluded.state, operation_id = excluded.operation_id
        returning generation, state, operation_id as "operationId"
      `.execute(db.db);
      return deletionOperation(owner, source, result.rows[0]!);
    });
  }

  /** A separate capability permits removals, never ordinary publication through a deleting fence. */
  async withCleanup<T>(
    access: AccessContext,
    operation: ManagedDeletionOperation,
    work: (db: DataContextDb, admission: ManagedCleanupAdmission) => Promise<T>
  ): Promise<T> {
    return this.runner.withDataContext(access, async (db) => {
      const owner = await this.lockDeletion(db, operation);
      const row = operation.source
        ? await readSource(db, ownedSource(owner, operation.source))
        : await readActor(db, owner);
      requireDeletion(row, operation);
      if (row.state !== "deleting") throw new ManagedSourceFencedError();
      const current = deletionOperation(
        owner,
        operation.source ? ownedSource(owner, operation.source) : null,
        row
      );
      const admission = Object.freeze<ManagedCleanupAdmission>({
        [cleanupBrand]: true,
        operation: Object.freeze({
          ...current,
          source: current.source ? Object.freeze(current.source) : null
        })
      });
      liveCleanupAdmissions.set(admission, db);
      try {
        return await work(db, admission);
      } finally {
        liveCleanupAdmissions.delete(admission);
      }
    });
  }

  /** Completion is checked under the same exclusive admission which seals the operation. */
  async sealDeletion(
    access: AccessContext,
    operation: ManagedDeletionOperation,
    assertComplete: (db: DataContextDb) => Promise<void>
  ): Promise<ManagedDeletionOperation> {
    return this.runner.withDataContext(access, async (db) => {
      const owner = await this.lockDeletion(db, operation);
      const row = operation.source
        ? await readSource(db, ownedSource(owner, operation.source))
        : await readActor(db, owner);
      requireDeletion(row, operation);
      if (row.state === "sealed") return deletionOperation(owner, operation.source, row);
      await assertComplete(db);
      if (operation.source) {
        const source = ownedSource(owner, operation.source);
        await sql`
          update app.notes_managed_sources set state = 'sealed'
          where owner_user_id = ${owner}::uuid and source_module_id = ${source.sourceModuleId}
            and source_id = ${source.sourceId}::uuid
        `.execute(db.db);
      } else {
        await sql`update app.notes_managed_actors set state = 'sealed'
          where owner_user_id = ${owner}::uuid`.execute(db.db);
      }
      return deletionOperation(owner, operation.source, { ...row, state: "sealed" });
    });
  }

  private async lockDeletion(
    db: DataContextDb,
    operation: ManagedDeletionOperation
  ): Promise<string> {
    const owner = await scopedOwner(db);
    if (operation.ownerUserId.toLowerCase() !== owner) throw new ManagedSourceUnavailableError();
    assertUuid(operation.operationId, "Managed deletion operation");
    await lockManagedActor(db, owner, operation.source ? "shared" : "exclusive");
    if (operation.source) {
      const source = ownedSource(owner, operation.source);
      await lockManagedSources(db, [source], "exclusive");
      // Account deletion supersedes a source's cleanup authority.
      requireActive(await readActor(db, owner));
    }
    return owner;
  }
}
