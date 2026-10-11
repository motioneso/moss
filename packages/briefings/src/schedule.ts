import type { FastifyBaseLogger } from "fastify";
import type { PgBoss } from "pg-boss";

import type { BriefingDefinition, BriefingType, DataContextDb } from "@moss/db";
import { assertMetadataOnlyPayload } from "@moss/jobs";
import { DEFAULT_LOCALE_SETTINGS, cronExprFor, timezoneFor } from "@moss/shared";

import { BRIEFINGS_RUN_QUEUE } from "./identifiers.js";
import type { BriefingsRepository } from "./repository.js";
export { cronExprFor, timezoneFor } from "@moss/shared";

/** Logger fallback — silent when no logger is injected (observability spec). */
const NOOP_LOGGER: Pick<FastifyBaseLogger, "error"> = {
  error: () => undefined
};

/** Default schedule in the owner's timezone; unknown owners get the app-wide default locale. */
export function defaultScheduleMetadataFor(
  type: BriefingType,
  timeZone: string = DEFAULT_LOCALE_SETTINGS.timezone
): Record<string, unknown> {
  if (type === "evening") return { targetTime: "19:00", timezone: timeZone };
  if (type === "weekly_review") return { targetTime: "09:00", timezone: timeZone, dayOfWeek: 0 };
  return { targetTime: "07:00", timezone: timeZone };
}

/**
 * Reconcile pg-boss schedule rows for one definition. Keyed on definition.id so
 * create/update/cadence-change/tz-change all upsert through the same (name, key).
 * The scheduled-run data is metadata-only ({actorUserId, definitionId, runKind, briefingType});
 * the worker mints briefingRunId at fire time. Schedule writes happen in the
 * owner's request context only — there is no cross-user read here.
 *
 * `ownerTimeZone` is the owner's saved locale timezone. When given it wins over the
 * timezone stored on the definition, so the cron follows the person (#3390).
 */
export async function reconcileSchedule(
  boss: PgBoss,
  definition: BriefingDefinition,
  ownerTimeZone?: string
): Promise<void> {
  if ((definition.cadence === "daily" || definition.cadence === "weekly") && definition.enabled) {
    const cron = cronExprFor(definition.cadence, definition.schedule_metadata);
    const tz = ownerTimeZone ?? timezoneFor(definition.schedule_metadata);
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

/** A misaligned scheduled fire still runs when it lands at most this long after the target. */
const LATE_FIRE_GRACE_MINUTES = 180;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ScheduledFireAlignment {
  /** The cron was registered in another zone and is now re-registered in the owner's. */
  readonly realigned: boolean;
  /** Whether this fire should produce a run. */
  readonly run: boolean;
}

/**
 * Re-register a firing cron in the owner's zone when it was registered in another one (a UTC
 * default from before #3390, or a zone the owner has since changed), so no owner depends on
 * opening a screen for the fix to reach them (#3390). An aligned fire always runs. A misaligned
 * fire runs only when it lands on the target day within the grace after the target time;
 * otherwise it is skipped and the realigned cron produces this period's run.
 */
export async function alignScheduledFire(
  boss: PgBoss,
  definition: BriefingDefinition,
  ownerTimeZone: string,
  now: Date = new Date()
): Promise<ScheduledFireAlignment> {
  const [registered] = await boss.getSchedules(BRIEFINGS_RUN_QUEUE, definition.id);
  if (!registered || registered.timezone === ownerTimeZone) {
    return { realigned: false, run: true };
  }
  await reconcileSchedule(boss, definition, ownerTimeZone);
  return { realigned: true, run: firesWithinGrace(definition, ownerTimeZone, now) };
}

function firesWithinGrace(definition: BriefingDefinition, timeZone: string, now: Date): boolean {
  const [minute, hour, , , dayOfWeek] = cronExprFor(
    definition.cadence,
    definition.schedule_metadata
  ).split(" ");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  if (dayOfWeek !== "*" && WEEKDAYS.indexOf(part("weekday")) !== Number(dayOfWeek)) return false;
  const late =
    Number(part("hour")) * 60 + Number(part("minute")) - (Number(hour) * 60 + Number(minute));
  return late >= 0 && late <= LATE_FIRE_GRACE_MINUTES;
}

/**
 * Per-session self-heal: reconcile only the definitions the actor OWNS. `listDefinitions`
 * is owner-OR-share under RLS (verified: `briefing_definitions_select` is
 * `owner_user_id = current_actor OR has_share(...)`), so we MUST filter to
 * `owner_user_id === actorUserId` — otherwise a viewer-actor would schedule/unschedule a
 * definition they merely have shared view on (a cross-user schedule write). Best-effort:
 * a single reconcile failure is logged (name+message) and does not abort the rest.
 * Re-running on each visit is also how a changed locale timezone reaches existing crons.
 */
export async function reconcileOwnedSchedules(
  boss: PgBoss,
  scopedDb: DataContextDb,
  repository: BriefingsRepository,
  actorUserId: string,
  logger: Pick<FastifyBaseLogger, "error"> = NOOP_LOGGER,
  ownerTimeZone?: string
): Promise<void> {
  const definitions = await repository.listDefinitions(scopedDb);
  const owned = definitions.filter((d) => d.owner_user_id === actorUserId);
  for (const definition of owned) {
    try {
      await reconcileSchedule(boss, definition, ownerTimeZone);
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
