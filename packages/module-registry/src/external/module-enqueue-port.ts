import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { AccessContext, MossDatabase } from "@moss/db";
import {
  assertModuleJobPayload,
  enqueueModuleJobForActor,
  type ExternalModuleJobPayload
} from "@moss/jobs";
import type { ExternalModuleQueueDeclaration } from "@moss/module-sdk";

import { MODULE_ENQUEUE_LIMITS, type ExternalModuleEnqueueResult } from "./worker-rpc-host.js";

export type ExternalModuleEnqueuePort = (
  access: AccessContext,
  request: {
    readonly queue: ExternalModuleQueueDeclaration;
    readonly jobKind: string;
    readonly idempotencyKey: string;
    readonly params?: Readonly<Record<string, unknown>>;
  }
) => Promise<ExternalModuleEnqueueResult>;

/**
 * Builds the `enqueueJob` port for one module. The API tool path and the worker queue path both
 * call this, so the live check, the payload check and the limits cannot drift between them.
 * Steps 6 to 8 of the `jobs.enqueue` contract run here, in order.
 */
export function createModuleEnqueuePort(input: {
  readonly boss: PgBoss;
  readonly rootDb: Kysely<MossDatabase>;
  readonly module: {
    readonly id: string;
    readonly manifestHash: string;
    readonly queueNames: readonly string[];
  };
  /** True when the module is enabled on this instance and the actor may use it. */
  readonly isLiveForActor: (access: AccessContext) => Promise<boolean>;
}): ExternalModuleEnqueuePort {
  return async (access, request) => {
    if (!(await input.isLiveForActor(access))) return { status: "inactive" };

    const envelope: ExternalModuleJobPayload = {
      actorUserId: access.actorUserId,
      moduleId: input.module.id,
      jobKind: request.jobKind,
      manifestHash: input.module.manifestHash,
      ...(request.params === undefined ? {} : { params: request.params })
    };
    try {
      assertModuleJobPayload(request.queue, envelope);
    } catch {
      return { status: "invalid_params" };
    }

    return enqueueModuleJobForActor(
      input.boss,
      input.rootDb,
      access,
      input.module,
      request.queue,
      {
        jobKind: request.jobKind,
        idempotencyKey: request.idempotencyKey,
        ...(request.params === undefined ? {} : { params: request.params })
      },
      MODULE_ENQUEUE_LIMITS
    );
  };
}
