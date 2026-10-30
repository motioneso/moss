import { sql, type Kysely } from "kysely";
import type { DataContextRunner, MossDatabase } from "@moss/db";
import {
  OutlookSetupRepository,
  type OutlookRuntimeGeneration
} from "./outlook-setup-repository.js";

export interface OutlookCleanupRuntime {
  /** Resolve only fixed managed resource IDs. Return after both browser and profile are gone. */
  remove(ref: OutlookRuntimeGeneration): Promise<void>;
}

/** One batch for the future runtime-enabled scheduler; no scheduler is registered here. */
export async function sweepOutlookBrowserLifecycle(deps: {
  readonly workerDb: Kysely<MossDatabase>;
  readonly dataContext: DataContextRunner;
  readonly runtime: OutlookCleanupRuntime;
}): Promise<{ removed: number; pending: number }> {
  const repo = new OutlookSetupRepository();
  const actors = await sql<{ actor_user_id: string }>`
    select * from app.list_expired_outlook_setup_actors()
  `.execute(deps.workerDb);
  for (const actor of actors.rows) {
    await deps.dataContext.withDataContext({ actorUserId: actor.actor_user_id }, (db) =>
      repo.expire(db)
    );
  }
  const tasks = await sql<{ runtime_id: string; generation: number; claim_id: string }>`
    select * from app.claim_outlook_browser_cleanup()
  `.execute(deps.workerDb);
  let removed = 0;
  let pending = 0;
  // Dispatch independently: a stuck resource does not hold other owners' database locks.
  await Promise.all(
    tasks.rows.map(async (task) => {
      let didRemove = false;
      try {
        await deps.runtime.remove({ runtimeId: task.runtime_id, generation: task.generation });
        didRemove = true;
      } catch {
        // Only a bounded retry timestamp is persisted. Runtime errors may contain private paths.
      }
      const result = await sql<{ done: boolean }>`
      select app.finish_outlook_browser_cleanup(
        ${task.runtime_id}::uuid, ${task.claim_id}::uuid, ${didRemove}
      ) as done
    `.execute(deps.workerDb);
      if (result.rows[0]?.done && didRemove) removed++;
      else pending++;
    })
  );
  return { removed, pending };
}
