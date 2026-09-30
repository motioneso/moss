import type { FastifyBaseLogger } from "fastify";
import type { PgBoss } from "pg-boss";

import type { BriefingDefinition, BriefingType, DataContextDb } from "@moss/db";
import { assertMetadataOnlyPayload } from "@moss/jobs";
import { cronExprFor, timezoneFor } from "@moss/shared";

import { BRIEFINGS_RUN_QUEUE } from "./identifiers.js";
import type { BriefingsRepository } from "./repository.js";
export { cronExprFor, timezoneFor } from "@moss/shared";

/** Logger fallback — silent when no logger is injected (observability spec). */
const NOOP_LOGGER: Pick<FastifyBaseLogger, "error"> = {
  error: () => undefined
};

const DEFAULT_TIMEZONE = "UTC";

export function defaultScheduleMetadataFor(type: BriefingType): Record<string, unknown> {
  if (type === "evening") return { targetTime: "19:00", timezone: DEFAULT_TIMEZONE };
  if (type === "weekly_review")
    return { targetTime: "09:00", timezone: DEFAULT_TIMEZONE, dayOfWeek: 0 };
  return { targetTime: "07:00", timezone: DEFAULT_TIMEZONE };
}

/**
 * Reconcile pg-boss schedule rows for one definition. Keyed on definition.id so
 * create/update/cadence-change/tz-change all upsert through the same (name, key).
 * The scheduled-run data is metadata-only ({actorUserId, definitionId, runKind, briefingType});
 * the worker mints briefingRunId at fire time. Schedule writes happen in the
 * owner's request context only — there is no cross-user read here.
 */
export async function reconcileSchedule(
  boss: PgBoss,
  definition: BriefingDefinition
): Promise<void> {
  if ((definition.cadence === "daily" || definition.cadence === "weekly") && definition.enabled) {
    const cron = cronExprFor(definition.cadence, definition.schedule_metadata);
    const tz = timezoneFor(definition.schedule_metadata);
    const data = {
      actorUserId: definition.owner_user_id,
      definitionId: definition.id,
      runKind: "scheduled" as const,
      briefingType: definition.briefing_type
    };
    // Defense-in-depth: boss.schedule does NOT route through sendJob's metadata guard,
    // so assert the cron payload is metadata-only here too (Hard Invariant). All three
    // keys are in ALLOWED_PAYLOAD_KEYS today; this catches a future drift at the source.
    assertMetadataOnlyPayload(data);
    await boss.schedule(BRIEFINGS_RUN_QUEUE, cron, data, { tz, key: definition.id });
    return;
  }
  await boss.unschedule(BRIEFINGS_RUN_QUEUE, definition.id);
}

/**
 * Per-session self-heal: reconcile only the definitions the actor OWNS. `listDefinitions`
 * is owner-OR-share under RLS (verified: `briefing_definitions_select` is
 * `owner_user_id = current_actor OR has_share(...)`), so we MUST filter to
 * `owner_user_id === actorUserId` — otherwise a viewer-actor would schedule/unschedule a
 * definition they merely have shared view on (a cross-user schedule write). Best-effort:
 * a single reconcile failure is logged (name+message) and does not abort the rest.
 */
export async function reconcileOwnedSchedules(
  boss: PgBoss,
  scopedDb: DataContextDb,
  repository: BriefingsRepository,
  actorUserId: string,
  logger: Pick<FastifyBaseLogger, "error"> = NOOP_LOGGER
): Promise<void> {
  const definitions = await repository.listDefinitions(scopedDb);
  const owned = definitions.filter((d) => d.owner_user_id === actorUserId);
  for (const definition of owned) {
    try {
      await reconcileSchedule(boss, definition);
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      logger.error(
        {
          event: "briefing_schedule_reconcile_failed",
          definitionId: definition.id,
          error: e.name,
          message: e.message.slice(0, 200)
        },
        "briefing schedule reconcile failed"
      );
    }
  }
}
