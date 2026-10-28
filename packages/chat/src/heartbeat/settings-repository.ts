import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import {
  defaultHeartbeatSources,
  HEARTBEAT_SOURCES,
  type HeartbeatCadenceMinutes,
  type HeartbeatSettings,
  type HeartbeatSource
} from "@moss/shared";

import { HEARTBEAT_DEFAULT_CADENCE_MINUTES } from "./limits.js";

export interface ReadHeartbeatSettings {
  readonly settings: HeartbeatSettings;
  /** False when the stored sources record fails validation. Checks hold until the owner saves. */
  readonly readable: boolean;
  readonly nextDueAt: Date | null;
}

export interface HeartbeatSettingsInput {
  readonly enabled: boolean;
  readonly cadenceMinutes: HeartbeatCadenceMinutes;
  readonly sources: Readonly<Record<HeartbeatSource, boolean>>;
}

export type SaveHeartbeatSettingsResult =
  | { readonly kind: "saved"; readonly settings: HeartbeatSettings }
  | { readonly kind: "conflict"; readonly settings: HeartbeatSettings };

export function defaultHeartbeatSettings(): HeartbeatSettings {
  return {
    enabled: true,
    cadenceMinutes: HEARTBEAT_DEFAULT_CADENCE_MINUTES,
    sources: defaultHeartbeatSources(),
    revision: 0,
    origin: "default"
  };
}

export function parseHeartbeatSources(value: unknown): Record<HeartbeatSource, boolean> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== HEARTBEAT_SOURCES.length) return null;
  const parsed = {} as Record<HeartbeatSource, boolean>;
  for (const source of HEARTBEAT_SOURCES) {
    const flag = record[source];
    if (typeof flag !== "boolean") return null;
    parsed[source] = flag;
  }
  return parsed;
}

function jsonb(value: unknown) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export class HeartbeatSettingsRepository {
  /** The stored record, or undefined when the owner has none yet. */
  async find(
    scopedDb: DataContextDb,
    options: { readonly forUpdate?: boolean } = {}
  ): Promise<ReadHeartbeatSettings | undefined> {
    assertDataContextDb(scopedDb);
    let query = scopedDb.db
      .selectFrom("app.heartbeat_settings")
      .select(["enabled", "cadence_minutes", "sources", "origin", "revision", "next_due_at"])
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`);
    if (options.forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) return undefined;
    const sources = parseHeartbeatSources(row.sources);
    return {
      settings: {
        enabled: row.enabled,
        cadenceMinutes: row.cadence_minutes === 30 ? 30 : 60,
        sources: sources ?? defaultHeartbeatSources(),
        revision: row.revision,
        origin: row.origin
      },
      readable: sources !== null,
      nextDueAt: row.next_due_at
    };
  }

  /**
   * Creates the owner's first record if none exists. Returns the stored record whether this call
   * or a concurrent one created it.
   */
  async enroll(
    scopedDb: DataContextDb,
    seed: Pick<HeartbeatSettings, "enabled" | "sources" | "origin">
  ): Promise<ReadHeartbeatSettings> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.heartbeat_settings")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        enabled: seed.enabled,
        cadence_minutes: HEARTBEAT_DEFAULT_CADENCE_MINUTES,
        sources: jsonb(seed.sources),
        origin: seed.origin,
        next_due_at: seed.enabled ? new Date() : null
      })
      .onConflict((oc) => oc.column("owner_user_id").doNothing())
      .execute();
    const stored = await this.find(scopedDb);
    if (!stored) throw new Error("Heartbeat settings are missing after enrollment");
    return stored;
  }

  /**
   * Compare-and-set save. Expected revision 0 means "no stored record yet". A miss in either
   * direction returns the stored record so the caller can show what changed.
   */
  async save(
    scopedDb: DataContextDb,
    input: HeartbeatSettingsInput,
    expectedRevision: number
  ): Promise<SaveHeartbeatSettingsResult> {
    assertDataContextDb(scopedDb);
    const current = await this.find(scopedDb, { forUpdate: true });
    const currentRevision = current?.settings.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      return { kind: "conflict", settings: current?.settings ?? defaultHeartbeatSettings() };
    }
    const nextDueAt = this.nextDueAfterSave(current, input);
    if (!current) {
      const inserted = await scopedDb.db
        .insertInto("app.heartbeat_settings")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          enabled: input.enabled,
          cadence_minutes: input.cadenceMinutes,
          sources: jsonb(input.sources),
          origin: "saved",
          next_due_at: nextDueAt
        })
        .onConflict((oc) => oc.column("owner_user_id").doNothing())
        .returning("revision")
        .executeTakeFirst();
      if (!inserted) {
        const stored = await this.find(scopedDb);
        return { kind: "conflict", settings: stored?.settings ?? defaultHeartbeatSettings() };
      }
    } else {
      await scopedDb.db
        .updateTable("app.heartbeat_settings")
        .set({
          enabled: input.enabled,
          cadence_minutes: input.cadenceMinutes,
          sources: jsonb(input.sources),
          origin: "saved",
          revision: currentRevision + 1,
          next_due_at: nextDueAt,
          updated_at: new Date()
        })
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .where("revision", "=", currentRevision)
        .execute();
    }
    const stored = await this.find(scopedDb);
    if (!stored) throw new Error("Heartbeat settings are missing after save");
    return { kind: "saved", settings: stored.settings };
  }

  /** Off clears the schedule. Turning on checks soon. A new frequency replaces the schedule. */
  private nextDueAfterSave(
    current: ReadHeartbeatSettings | undefined,
    input: HeartbeatSettingsInput
  ): Date | null {
    if (!input.enabled) return null;
    if (!current || !current.settings.enabled || !current.readable) return new Date();
    if (current.settings.cadenceMinutes !== input.cadenceMinutes) {
      return minutesFromNow(input.cadenceMinutes);
    }
    return current.nextDueAt ?? minutesFromNow(input.cadenceMinutes);
  }

  /** Moves the schedule forward after a check, but only while the saved record is unchanged. */
  async advance(
    scopedDb: DataContextDb,
    revision: number,
    cadenceMinutes: HeartbeatCadenceMinutes
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.heartbeat_settings")
      .set({ next_due_at: minutesFromNow(cadenceMinutes) })
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("revision", "=", revision)
      .where("enabled", "=", true)
      .execute();
  }

  /** Clears the schedule for an owner who is off. */
  async clearSchedule(scopedDb: DataContextDb): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.heartbeat_settings")
      .set({ next_due_at: null })
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .execute();
  }
}
