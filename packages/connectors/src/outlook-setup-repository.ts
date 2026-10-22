import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import {
  assertDataContextDb,
  type ConnectorOutlookSetupsTable,
  type DataContextDb
} from "@moss/db";
import { HttpError } from "@moss/module-sdk";

export type OutlookSetupRow = Selectable<ConnectorOutlookSetupsTable>;
export interface OutlookRuntimeGeneration {
  readonly runtimeId: string;
  readonly generation: number;
}
export interface OutlookLease extends OutlookRuntimeGeneration {
  readonly leaseId: string;
  readonly kind: "viewer" | "collector";
  readonly sessionId: string | null;
}

export const OUTLOOK_SETUP_IDLE_MS = 30 * 60_000;
export const OUTLOOK_VIEWER_IDLE_MS = 5 * 60_000;
export const OUTLOOK_LEASE_ABSOLUTE_MS = 30 * 60_000;
export const OUTLOOK_LEASE_HEARTBEAT_MS = 15_000;
export const OUTLOOK_LEASE_EXPIRY_MS = 45_000;

const emptyLease = {
  lease_id: null,
  lease_kind: null,
  lease_session_id: null,
  lease_expires_at: null,
  lease_absolute_expires_at: null,
  lease_activity_at: null
} as const;
const setupStates = ["preparing", "sign-in", "confirm"] as const;
const revokedStates = ["removing", "cleanup-failed", "removed"] as const;

/** Persistence only. Callers must resolve live browser auth before any viewer operation. */
export class OutlookSetupRepository {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(db: DataContextDb): Promise<OutlookSetupRow | undefined> {
    assertDataContextDb(db);
    return db.db.selectFrom("app.connector_outlook_setups").selectAll().executeTakeFirst();
  }

  private async lockOwner(db: DataContextDb): Promise<void> {
    assertDataContextDb(db);
    // Serializes even first creation; distinct owners do not share a global lock.
    await sql`select pg_advisory_xact_lock(hashtextextended(
      'outlook-setup:' || app.current_actor_user_id()::text, 0))`.execute(db.db);
  }

  private current(db: DataContextDb, ref: OutlookRuntimeGeneration) {
    assertDataContextDb(db);
    return db.db
      .updateTable("app.connector_outlook_setups")
      .where("runtime_id", "=", ref.runtimeId)
      .where("generation", "=", ref.generation);
  }

  async start(db: DataContextDb): Promise<OutlookSetupRow> {
    await this.lockOwner(db);
    const prior = await this.get(db);
    if (prior && prior.state !== "removed") {
      if (prior.state === "removing" || prior.state === "cleanup-failed")
        throw new HttpError(409, "The previous Outlook session is still being removed.");
      if (setupStates.some((s) => s === prior.state) && prior.setup_expires_at <= this.now()) {
        // Return the revoked state so the transaction commits durable cleanup work.
        return (await this.revoke(db, {
          runtimeId: prior.runtime_id,
          generation: prior.generation
        }))!;
      }
      return prior;
    }
    const now = this.now();
    return db.db
      .insertInto("app.connector_outlook_setups")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        runtime_id: randomUUID(),
        generation: (prior?.generation ?? 0) + 1,
        state: "preparing",
        identity_hash: null,
        setup_expires_at: new Date(now.getTime() + OUTLOOK_SETUP_IDLE_MS),
        ...emptyLease,
        created_at: now,
        updated_at: now
      })
      .onConflict((c) =>
        c.column("owner_user_id").doUpdateSet((eb) => ({
          runtime_id: eb.ref("excluded.runtime_id"),
          generation: eb.ref("excluded.generation"),
          state: "preparing",
          identity_hash: null,
          setup_expires_at: eb.ref("excluded.setup_expires_at"),
          ...emptyLease,
          updated_at: now
        }))
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async ready(
    db: DataContextDb,
    ref: OutlookRuntimeGeneration
  ): Promise<OutlookSetupRow | undefined> {
    return this.current(db, ref)
      .where("state", "=", "preparing")
      .where("setup_expires_at", ">", this.now())
      .set({ state: "sign-in", updated_at: this.now() })
      .returningAll()
      .executeTakeFirst();
  }

  async expire(db: DataContextDb): Promise<OutlookSetupRow | undefined> {
    await this.lockOwner(db);
    const row = await this.get(db);
    if (!row || !setupStates.some((s) => s === row.state) || row.setup_expires_at > this.now())
      return undefined;
    return this.revoke(db, { runtimeId: row.runtime_id, generation: row.generation });
  }

  /** The hash comes from a freshly verified runtime identity, never a client assertion. */
  async confirm(
    db: DataContextDb,
    ref: OutlookRuntimeGeneration,
    identityHash: string
  ): Promise<OutlookSetupRow | undefined> {
    return this.current(db, ref)
      .where("state", "in", ["sign-in", "confirm"])
      .where("setup_expires_at", ">", this.now())
      .where("lease_id", "is", null)
      .set({ state: "active", identity_hash: identityHash, updated_at: this.now() })
      .returningAll()
      .executeTakeFirst();
  }

  /** A resumed account may only return to the previously confirmed identity. */
  async verifyIdentity(
    db: DataContextDb,
    ref: OutlookRuntimeGeneration,
    identityHash: string | null
  ): Promise<OutlookSetupRow | undefined> {
    await this.lockOwner(db);
    const row = await this.get(db);
    if (
      !row ||
      row.runtime_id !== ref.runtimeId ||
      row.generation !== ref.generation ||
      !row.identity_hash ||
      revokedStates.some((s) => s === row.state)
    )
      return undefined;
    const state = !identityHash
      ? "sign-in-needed"
      : identityHash === row.identity_hash
        ? "active"
        : "source-changed";
    return this.current(db, ref)
      .set({ state, ...(state === "active" ? {} : emptyLease), updated_at: this.now() })
      .returningAll()
      .executeTakeFirst();
  }

  async revoke(
    db: DataContextDb,
    ref: OutlookRuntimeGeneration
  ): Promise<OutlookSetupRow | undefined> {
    return this.current(db, ref)
      .where("state", "not in", revokedStates)
      .set({
        state: "removing",
        generation: sql<number>`generation + 1`,
        ...emptyLease,
        updated_at: this.now()
      })
      .returningAll()
      .executeTakeFirst();
  }

  async acquireLease(
    db: DataContextDb,
    ref: OutlookRuntimeGeneration,
    control:
      | { readonly kind: "viewer"; readonly sessionId: string }
      | { readonly kind: "collector" }
  ): Promise<OutlookLease | undefined> {
    const now = this.now();
    const leaseId = randomUUID();
    const row = await this.current(db, ref)
      .where(
        "state",
        "in",
        control.kind === "collector"
          ? ["active"]
          : ["sign-in", "confirm", "active", "sign-in-needed", "source-changed"]
      )
      .where((eb) => eb.or([eb("state", "not in", setupStates), eb("setup_expires_at", ">", now)]))
      .where((eb) =>
        eb.or([
          eb("lease_id", "is", null),
          eb("lease_expires_at", "<=", now),
          eb("lease_absolute_expires_at", "<=", now),
          eb.and([
            eb("lease_kind", "=", "viewer"),
            eb("lease_activity_at", "<=", new Date(now.getTime() - OUTLOOK_VIEWER_IDLE_MS))
          ])
        ])
      )
      .set({
        lease_id: leaseId,
        lease_kind: control.kind,
        lease_session_id: control.kind === "viewer" ? control.sessionId : null,
        lease_expires_at: new Date(now.getTime() + OUTLOOK_LEASE_EXPIRY_MS),
        lease_absolute_expires_at: new Date(now.getTime() + OUTLOOK_LEASE_ABSOLUTE_MS),
        lease_activity_at: now,
        updated_at: now
      })
      .returning("runtime_id")
      .executeTakeFirst();
    return row
      ? {
          ...ref,
          leaseId,
          kind: control.kind,
          sessionId: control.kind === "viewer" ? control.sessionId : null
        }
      : undefined;
  }

  private liveLease(db: DataContextDb, lease: OutlookLease) {
    const now = this.now();
    return this.current(db, lease)
      .where("lease_id", "=", lease.leaseId)
      .where("lease_kind", "=", lease.kind)
      .where("lease_session_id", lease.sessionId === null ? "is" : "=", lease.sessionId)
      .where("lease_expires_at", ">", now)
      .where("lease_absolute_expires_at", ">", now)
      .where((eb) =>
        eb.or([
          eb("lease_kind", "=", "collector"),
          eb("lease_activity_at", ">", new Date(now.getTime() - OUTLOOK_VIEWER_IDLE_MS))
        ])
      )
      .where((eb) => eb.or([eb("state", "not in", setupStates), eb("setup_expires_at", ">", now)]));
  }

  async heartbeat(db: DataContextDb, lease: OutlookLease, activity = false): Promise<boolean> {
    const now = this.now();
    const row = await this.liveLease(db, lease)
      .set({
        lease_expires_at: new Date(now.getTime() + OUTLOOK_LEASE_EXPIRY_MS),
        ...(activity
          ? {
              lease_activity_at: now,
              setup_expires_at: new Date(now.getTime() + OUTLOOK_SETUP_IDLE_MS)
            }
          : {}),
        updated_at: now
      })
      .returning("runtime_id")
      .executeTakeFirst();
    return !!row;
  }

  async releaseLease(db: DataContextDb, lease: OutlookLease): Promise<boolean> {
    const row = await this.current(db, lease)
      .where("lease_id", "=", lease.leaseId)
      .where("lease_kind", "=", lease.kind)
      .where("lease_session_id", lease.sessionId === null ? "is" : "=", lease.sessionId)
      .set({ ...emptyLease, updated_at: this.now() })
      .returning("runtime_id")
      .executeTakeFirst();
    return !!row;
  }
}
