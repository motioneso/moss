import { sql } from "kysely";
import type { PgBoss, WorkOptions } from "pg-boss";

import { isUuid, type DataContextDb, type DataContextRunner } from "@moss/db";
import { registerDataContextWorker, type ActorScopedJobPayload } from "@moss/jobs";
import {
  PUSH_QUEUE_RETRY_OPTIONS,
  type NotificationsRepository,
  type NotificationWithReadState
} from "@moss/notifications";
import { chatMessageHref, type ChatHeartbeatOriginV1 } from "@moss/shared";

import { readOrigin } from "../route-serializers.js";
import { isMuted } from "./filter.js";
import { HeartbeatSettingsRepository } from "./settings-repository.js";
import { loadMuteRules } from "./store.js";

export const CHAT_HEARTBEAT_NOTIFY_QUEUE = "chat.heartbeat-notify";
export const CHAT_HEARTBEAT_NOTIFY_QUEUE_DEFINITION = {
  name: CHAT_HEARTBEAT_NOTIFY_QUEUE,
  options: PUSH_QUEUE_RETRY_OPTIONS
};

/** Metadata only. `resourceId` is the occurrence ID and `idempotencyKey` the message ID. */
export interface HeartbeatNotifyPayload extends ActorScopedJobPayload {
  readonly resourceId: string;
  readonly version: number;
  readonly idempotencyKey: string;
}

type Remaining = {
  readonly origin: ChatHeartbeatOriginV1;
  readonly items: ChatHeartbeatOriginV1["items"];
};

/** An item's time has passed when it carries a full timestamp earlier than now. */
function isExpired(at: string | null, now: Date): boolean {
  if (!at || !at.includes("T")) return false;
  const time = Date.parse(at);
  return !Number.isNaN(time) && time < now.getTime();
}

/**
 * The published items that still deserve a push: the owner has check-ins on, the message still
 * exists, and each kept item is neither muted nor past its time.
 */
async function remainingItems(
  scopedDb: DataContextDb,
  messageId: string,
  now: Date
): Promise<Remaining | null> {
  if (!isUuid(messageId)) return null;
  const settings = await new HeartbeatSettingsRepository().find(scopedDb);
  if (settings && !settings.settings.enabled) return null;
  const row = await scopedDb.db
    .selectFrom("app.chat_messages")
    .select("model_metadata")
    .where("id", "=", messageId)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  const metadata = (row?.model_metadata ?? {}) as Record<string, unknown>;
  const origin = readOrigin(metadata.origin);
  if (origin?.kind !== "heartbeat") return null;
  const mutes = await loadMuteRules(scopedDb);
  const findings = await scopedDb.db
    .selectFrom("app.heartbeat_findings")
    .select(["id", "entity_key"])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("occurrence_id", "=", origin.occurrenceId)
    .execute();
  const entityOf = new Map(findings.map((finding) => [finding.id, finding.entity_key]));
  const items = origin.items.filter(
    (item) =>
      !isExpired(item.at, now) &&
      !isMuted(mutes, item.source, {
        entityKey: entityOf.get(item.findingId) ?? item.findingId,
        episodeKey: "",
        title: item.title,
        at: item.at,
        kind: "",
        facts: {}
      })
  );
  return items.length > 0 ? { origin, items } : null;
}

export function heartbeatPushBody(remaining: Remaining): string {
  const titles = remaining.items.map((item) => item.title);
  const shown = titles.slice(0, 3).join(", ");
  return titles.length > 3 ? `${shown} and ${titles.length - 3} more` : shown;
}

export async function runHeartbeatNotifyJob(
  scopedDb: DataContextDb,
  payload: HeartbeatNotifyPayload,
  notifications: NotificationsRepository,
  now: Date = new Date()
): Promise<"created" | "already_created" | "inactive" | "muted"> {
  const eventKey = `heartbeat:${payload.resourceId}`;
  if (await notifications.findByEventKey(scopedDb, "chat", eventKey)) return "already_created";
  const remaining = await remainingItems(scopedDb, payload.idempotencyKey, now);
  if (!remaining || remaining.origin.occurrenceId !== payload.resourceId) return "inactive";
  const notification = await notifications.create(scopedDb, {
    moduleId: "chat",
    title: "Check-in from Moss",
    body: heartbeatPushBody(remaining),
    urgency: "normal",
    eventKey,
    href: chatMessageHref(payload.idempotencyKey),
    metadata: {
      kind: "chat_heartbeat",
      occurrenceId: payload.resourceId,
      messageId: payload.idempotencyKey
    }
  });
  return notification ? "created" : "muted";
}

/**
 * Dispatch-time recheck: the push is dropped when the owner turned check-ins off, muted every
 * item, or every item has expired. It never grants a quiet-hours exception.
 */
export async function isHeartbeatNotificationActive(
  scopedDb: DataContextDb,
  notification: NotificationWithReadState,
  now: Date = new Date()
): Promise<boolean> {
  const { messageId } = notification.metadata;
  if (typeof messageId !== "string") return false;
  return (await remainingItems(scopedDb, messageId, now)) !== null;
}

export function registerHeartbeatNotifyWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  notifications: NotificationsRepository,
  workOptions?: WorkOptions
): Promise<string> {
  return registerDataContextWorker<HeartbeatNotifyPayload, string>(
    boss,
    CHAT_HEARTBEAT_NOTIFY_QUEUE,
    dataContext,
    (job, scopedDb) => runHeartbeatNotifyJob(scopedDb, job.data, notifications),
    workOptions
  );
}
