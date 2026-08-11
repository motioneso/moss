import type { PgBoss, SendOptions } from "pg-boss";
import { sql, type Kysely } from "kysely";

import type { AccessContext, MossDatabase } from "@moss/db";
import { matchesModuleParamsSchema, type ExternalModuleQueueDeclaration } from "@moss/module-sdk";
import { hasRecentJob, PLATFORM_MODULE_CONTROL_QUEUE } from "./pg-boss.js";

export interface ExternalModuleJobPayload {
  readonly actorUserId: string;
  readonly moduleId: string;
  readonly jobKind: string;
  readonly manifestHash: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ModuleControlPayload {
  readonly moduleId: string;
  readonly action: "reconcile";
}

export function assertModuleControlPayload(
  payload: unknown
): asserts payload is ModuleControlPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Module control payload must be an object");
  }
  const value = payload as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    typeof value.moduleId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.moduleId) ||
    value.action !== "reconcile"
  ) {
    throw new Error("Module control payload is invalid");
  }
}

export async function sendModuleControl(
  boss: PgBoss,
  payload: ModuleControlPayload
): Promise<string | null> {
  assertModuleControlPayload(payload);
  return boss.send(PLATFORM_MODULE_CONTROL_QUEUE, payload);
}

export function assertModuleJobPayload(
  queue: ExternalModuleQueueDeclaration,
  payload: unknown
): asserts payload is ExternalModuleJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Module job payload must be an object");
  }
  const value = payload as Record<string, unknown>;
  const keys = new Set(["actorUserId", "moduleId", "jobKind", "manifestHash", "params"]);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error("Module job payload contains an undeclared key");
  }
  if (
    typeof value.actorUserId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.actorUserId
    )
  ) {
    throw new Error("Module job actorUserId must be a UUID");
  }
  if (
    typeof value.moduleId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.moduleId) ||
    !queue.name.startsWith(`${value.moduleId}.`)
  ) {
    throw new Error("Module job moduleId does not own the queue");
  }
  if (typeof value.jobKind !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.jobKind)) {
    throw new Error("Module job jobKind is invalid");
  }
  if (typeof value.manifestHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.manifestHash)) {
    throw new Error("Module job manifestHash is invalid");
  }
  if (value.params !== undefined) {
    const encoded = JSON.stringify(value.params);
    if (
      !queue.paramsSchema ||
      Buffer.byteLength(encoded) > 2_048 ||
      !matchesModuleParamsSchema(queue.paramsSchema, value.params)
    ) {
      throw new Error("Module job params do not match paramsSchema");
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 4_096) {
    throw new Error("Module job payload exceeds 4 KiB");
  }
}

export async function sendModuleJob(
  boss: PgBoss,
  access: AccessContext,
  module: { readonly id: string; readonly manifestHash: string },
  queue: ExternalModuleQueueDeclaration,
  command: { readonly jobKind: string; readonly params?: Readonly<Record<string, unknown>> },
  options?: Pick<SendOptions, "singletonKey" | "singletonSeconds">,
  rootDb?: Kysely<MossDatabase>
): Promise<string | null> {
  const payload: ExternalModuleJobPayload = {
    actorUserId: access.actorUserId,
    moduleId: module.id,
    jobKind: command.jobKind,
    manifestHash: module.manifestHash,
    ...(command.params === undefined ? {} : { params: command.params })
  };
  assertModuleJobPayload(queue, payload);

  if (rootDb && options?.singletonKey && options?.singletonSeconds) {
    const singletonKey = options.singletonKey;
    const singletonSeconds = options.singletonSeconds;
    return rootDb.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${singletonKey}, 0))`.execute(trx);
      const recent = await hasRecentJob(trx, queue.name, singletonKey, singletonSeconds);
      if (recent) return null;
      return boss.send(queue.name, payload, options);
    });
  }

  return boss.send(queue.name, payload, options);
}
