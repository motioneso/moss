import type { PgBoss } from "pg-boss";
import type { DataContextRunner } from "@moss/db";
import { importCalendarMirror } from "@moss/calendar";
import {
  assertMetadataOnlyPayload,
  sendJob,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";
import { PreferencesRepository } from "@moss/structured-state";
import { collectOutlookCalendar } from "./outlook-calendar-browser.js";
import {
  outlookBindingKey,
  outlookBindingFingerprint,
  outlookCalendarBinding,
  OUTLOOK_BROWSER_PROVIDER,
  type OutlookCalendarBinding
} from "./outlook-calendar-config.js";
import { OutlookCalendarSourceError } from "./outlook-calendar-source.js";
import { ConnectorsRepository } from "./repository.js";
import { featureGrantsPrefKey, isFeatureGranted } from "./feature-grants.js";

export const OUTLOOK_CALENDAR_QUEUE = "connectors.outlook-calendar";
export const OUTLOOK_CALENDAR_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: OUTLOOK_CALENDAR_QUEUE,
    options: { policy: "exclusive", retryLimit: 0, deleteAfterSeconds: 300, retentionSeconds: 600 }
  }
];
interface OutlookCalendarPayload extends ActorScopedJobPayload {
  readonly kind: "outlook-calendar";
}
export type OutlookCalendarState =
  | "collecting"
  | "current"
  | "partial"
  | "stale"
  | "sign-in-needed"
  | "source-changed"
  | "settings-not-found"
  | "disconnected";
export interface OutlookCalendarHealth {
  readonly state: OutlookCalendarState;
  readonly lastCompleteAt?: string;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly timeZone?: string;
  readonly unconfirmed?: number;
  readonly failures?: number;
  readonly attemptedAt?: string;
}
export const outlookHealthKey = (id: string): string => `connector.${id}.outlook_calendar_health`;
export function readOutlookHealth(value: unknown): OutlookCalendarHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "collecting" };
  const v = value as OutlookCalendarHealth;
  if (
    ![
      "collecting",
      "current",
      "partial",
      "stale",
      "sign-in-needed",
      "source-changed",
      "settings-not-found",
      "disconnected"
    ].includes(v.state)
  )
    return { state: "collecting" };
  return v;
}
export async function requestOutlookCalendarSync(boss: PgBoss, actorUserId: string): Promise<void> {
  const payload: OutlookCalendarPayload = { actorUserId, kind: "outlook-calendar" };
  await sendJob(boss, OUTLOOK_CALENDAR_QUEUE, payload, { singletonKey: actorUserId });
}

/** Browser I/O runs outside the short owner-scoped persistence transactions. */
export async function runOutlookCalendarSync(
  dataContext: DataContextRunner,
  binding: OutlookCalendarBinding,
  collect: typeof collectOutlookCalendar = collectOutlookCalendar
): Promise<void> {
  const repo = new ConnectorsRepository();
  const prefs = new PreferencesRepository();
  const access = { actorUserId: binding.ownerUserId };
  const load = () =>
    dataContext.withDataContext(access, async (db) => {
      const matches = (await repo.listAccounts(db)).filter(
        (a) => a.provider_id === OUTLOOK_BROWSER_PROVIDER && a.status === "active"
      );
      if (matches.length !== 1) return null;
      const account = matches[0]!;
      if (
        (await prefs.get(db, outlookBindingKey(account.id))) !== outlookBindingFingerprint(binding)
      ) {
        const health = readOutlookHealth(await prefs.get(db, outlookHealthKey(account.id)));
        await prefs.upsert(db, outlookHealthKey(account.id), {
          ...health,
          state: "source-changed"
        });
        return null;
      }
      if (!isFeatureGranted(await prefs.get(db, featureGrantsPrefKey(account.id)), "calendar"))
        return null;
      return {
        account,
        health: readOutlookHealth(await prefs.get(db, outlookHealthKey(account.id)))
      };
    });
  const source = await load();
  if (
    !source ||
    ["sign-in-needed", "source-changed", "disconnected"].includes(source.health.state) ||
    (source.health.failures ?? 0) >= 3
  )
    return;
  const now = new Date();
  const started = await dataContext.withDataContext(access, async (db) => {
    await repo.lockAccountSync(db, binding.ownerUserId);
    const account = (await repo.listAccounts(db)).find((a) => a.id === source.account.id);
    if (account?.status !== "active") return false;
    await prefs.upsert(db, outlookHealthKey(source.account.id), {
      ...source.health,
      state: "collecting",
      attemptedAt: now.toISOString()
    });
    return true;
  });
  if (!started) return;
  try {
    const scan = await collect(binding, now);
    await dataContext.withDataContext(access, async (db) => {
      await repo.lockAccountSync(db, binding.ownerUserId);
      const current = (await repo.listAccounts(db)).find((a) => a.id === source.account.id);
      if (
        current?.status !== "active" ||
        !isFeatureGranted(await prefs.get(db, featureGrantsPrefKey(source.account.id)), "calendar")
      )
        return;
      const result = await importCalendarMirror(db, source.account.id, scan);
      const health: OutlookCalendarHealth = {
        ...source.health,
        state: scan.complete ? "current" : "partial",
        failures: scan.complete ? 0 : (source.health.failures ?? 0) + 1,
        attemptedAt: now.toISOString(),
        unconfirmed: scan.complete ? result.unconfirmed : source.health.unconfirmed,
        ...(scan.complete
          ? {
              lastCompleteAt: scan.observedAt,
              windowStart: scan.windowStart,
              windowEnd: scan.windowEnd,
              timeZone: scan.timeZone
            }
          : {})
      };
      await prefs.upsert(db, outlookHealthKey(source.account.id), health);
    });
  } catch (error) {
    const state = error instanceof OutlookCalendarSourceError ? error.code : "partial";
    await dataContext.withDataContext(access, async (db) => {
      await repo.lockAccountSync(db, binding.ownerUserId);
      const current = (await repo.listAccounts(db)).find((a) => a.id === source.account.id);
      if (current?.status !== "active") return;
      await prefs.upsert(db, outlookHealthKey(source.account.id), {
        ...source.health,
        state,
        attemptedAt: now.toISOString(),
        failures: (source.health.failures ?? 0) + 1
      });
    });
  }
}

export async function registerOutlookCalendarWorker(
  boss: PgBoss,
  dataContext: DataContextRunner
): Promise<string[]> {
  const binding = outlookCalendarBinding();
  if (!binding) return [];
  const payload: OutlookCalendarPayload = {
    actorUserId: binding.ownerUserId,
    kind: "outlook-calendar"
  };
  assertMetadataOnlyPayload(payload);
  await boss.schedule(OUTLOOK_CALENDAR_QUEUE, "*/5 * * * *", payload, {
    key: "operator-binding",
    singletonKey: binding.ownerUserId,
    tz: "UTC"
  });
  const id = await boss.work<OutlookCalendarPayload>(
    OUTLOOK_CALENDAR_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (
        !job ||
        job.data.kind !== "outlook-calendar" ||
        job.data.actorUserId !== binding.ownerUserId
      )
        return;
      await runOutlookCalendarSync(dataContext, binding);
    }
  );
  return [id];
}
