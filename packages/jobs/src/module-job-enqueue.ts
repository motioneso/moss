import { createHash } from "node:crypto";

import type { PgBoss } from "pg-boss";
import { sql, type Kysely } from "kysely";

import type { AccessContext, MossDatabase } from "@moss/db";
import type { ExternalModuleQueueDeclaration } from "@moss/module-sdk";
import type { ModuleJobEnqueueResult } from "@moss/module-sdk/worker";

import { assertModuleJobPayload, type ExternalModuleJobPayload } from "./module-jobs.js";
import { withModuleEnqueueLock } from "./module-job-sweep.js";

export interface ModuleEnqueueLimits {
  /** Rows in created, retry or active on the module's queues for one actor. */
  readonly pending: number;
  /** Rows created in the last 3,600 seconds, any state except cancelled. */
  readonly hourly: number;
}

/**
 * Fixed platform namespace for module job ids (UUID v5). It must never change. Any
 * change re-derives every job id and lets a retried step enqueue a second time.
 */
export const MODULE_JOB_ID_NAMESPACE = "71dd6e02-9cde-4943-ac23-3a72e0464852";

const JOB_KIND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const HOURLY_WINDOW_SECONDS = 3_600;

/** Name-based UUID v5 (RFC 4122) over the module, queue, actor and key joined with NUL. */
export function deriveModuleJobId(
  moduleId: string,
  queueName: string,
  actorUserId: string,
  idempotencyKey: string
): string {
  const namespace = Buffer.from(MODULE_JOB_ID_NAMESPACE.replaceAll("-", ""), "hex");
  const name = Buffer.from([moduleId, queueName, actorUserId, idempotencyKey].join("\0"), "utf8");
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Enqueue one job for the actor on a module queue, under the per-actor enqueue lock.
 * Order: duplicate, pending limit, hourly limit, send. Returns a status only. The key
 * text is hashed into the job id and appears in no payload, singleton key, log or error.
 */
export async function enqueueModuleJobForActor(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>,
  access: AccessContext,
  module: {
    readonly id: string;
    readonly manifestHash: string;
    readonly queueNames: readonly string[];
  },
  queue: ExternalModuleQueueDeclaration,
  command: {
    readonly jobKind: string;
    readonly idempotencyKey: string;
    readonly params?: Readonly<Record<string, unknown>>;
  },
  limits: ModuleEnqueueLimits
): Promise<ModuleJobEnqueueResult> {
  if (
    typeof command.jobKind !== "string" ||
    !JOB_KIND_PATTERN.test(command.jobKind) ||
    typeof command.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey) ||
    !module.queueNames.includes(queue.name)
  ) {
    throw new Error("Module job enqueue request is invalid");
  }

  const payload: ExternalModuleJobPayload = {
    actorUserId: access.actorUserId,
    moduleId: module.id,
    jobKind: command.jobKind,
    manifestHash: module.manifestHash,
    ...(command.params === undefined ? {} : { params: command.params })
  };
  assertModuleJobPayload(queue, payload);

  const jobId = deriveModuleJobId(
    module.id,
    queue.name,
    access.actorUserId,
    command.idempotencyKey
  );
  const queueNames = [...module.queueNames];

  return withModuleEnqueueLock(rootDb, module.id, access.actorUserId, async (trx) => {
    const existing = await sql<{ found: boolean }>`
      select exists (
        select 1 from pgboss.job where name = ${queue.name} and id = ${jobId}::uuid
      ) as found
    `.execute(trx);
    if (existing.rows[0]?.found) return { status: "duplicate" } as const;

    const pending = await sql<{ n: number }>`
      select count(*)::int as n
      from pgboss.job
      where name = any(${queueNames}::text[])
        and data->>'actorUserId' = ${access.actorUserId}
        and state in ('created', 'retry', 'active')
    `.execute(trx);
    if ((pending.rows[0]?.n ?? 0) >= limits.pending) {
      return { status: "limited", limit: "pending" } as const;
    }

    const hourly = await sql<{ n: number }>`
      select count(*)::int as n
      from pgboss.job
      where name = any(${queueNames}::text[])
        and data->>'actorUserId' = ${access.actorUserId}
        and state <> 'cancelled'
        and created_on >= now() - make_interval(secs => ${HOURLY_WINDOW_SECONDS})
    `.execute(trx);
    if ((hourly.rows[0]?.n ?? 0) >= limits.hourly) {
      return { status: "limited", limit: "hourly" } as const;
    }

    const sent = await boss.send(queue.name, payload, { id: jobId });
    return sent === null ? ({ status: "duplicate" } as const) : ({ status: "enqueued" } as const);
  });
}
