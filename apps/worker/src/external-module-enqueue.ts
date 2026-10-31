import type { PgBoss } from "pg-boss";
import type { Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { createModuleEnqueuePort } from "@moss/module-registry/node";

/**
 * ctx.jobs.enqueue (#3722) for the queue path. The actor is the parent job's envelope actor.
 * A module is live when the worker's own enabled predicate holds and the actor is still an
 * active member, the same two checks the trust gate runs before a job starts.
 */
export function createWorkerEnqueuePortFactory(deps: {
  readonly boss: PgBoss;
  readonly rootDb: Kysely<MossDatabase>;
  readonly isModuleEnabled: (moduleId: string) => Promise<boolean>;
  readonly listActiveUserIds: (moduleId: string) => Promise<readonly string[]>;
}) {
  return (module: ExternalModuleDiscovery) =>
    createModuleEnqueuePort({
      boss: deps.boss,
      rootDb: deps.rootDb,
      module: {
        id: module.id,
        manifestHash: module.manifestHash,
        queueNames: (module.manifest.worker?.queues ?? []).map((queue) => queue.name)
      },
      isLiveForActor: async (access) =>
        (await deps.isModuleEnabled(module.id)) &&
        (await deps.listActiveUserIds(module.id)).includes(access.actorUserId)
    });
}
