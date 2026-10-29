import { randomUUID } from "node:crypto";

import type { PgBoss } from "pg-boss";

import type { DataContextDb } from "@moss/db";
import { scopedJobDatabase, sendJob } from "@moss/jobs";
import type { ChatHeartbeatOriginV1 } from "@moss/shared";

import type { ChatRepository } from "../repository.js";
import { notifyReminderArrival } from "../reminders/live-arrival.js";
import type { HeartbeatCandidate } from "./filter.js";
import { CHAT_HEARTBEAT_NOTIFY_QUEUE, type HeartbeatNotifyPayload } from "./notify.js";
import { markPublished } from "./store.js";
import type { HeartbeatModelResult } from "./validator.js";

/** Formats an ISO time in the owner's zone. Date-only values stay dates; unparseable ones pass through. */
export function readableTime(value: string, timeZone: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: dateOnly ? "UTC" : timeZone,
      dateStyle: "medium",
      ...(dateOnly ? {} : { timeStyle: "short" })
    }).format(parsed);
  } catch {
    return value;
  }
}

/** Plain-text copy of the message, for readers that do not render the item cards. */
export function heartbeatBody(origin: ChatHeartbeatOriginV1, timeZone = "UTC"): string {
  const lines = origin.items.map(
    (item) =>
      `- ${item.title}${item.at ? ` (${readableTime(item.at, timeZone)})` : ""}: ${item.note}`
  );
  return [origin.intro, ...lines].filter((line) => line !== "").join("\n");
}

/**
 * Writes the check-in into the owner's Main chat, records the findings as published and queues
 * the notification, all in the caller's transaction. Titles, times and sources come from the
 * evidence; the model only supplied the notes and intro.
 */
export async function publishHeartbeat(
  scopedDb: DataContextDb,
  deps: { readonly chat: ChatRepository; readonly boss: Pick<PgBoss, "send"> },
  input: {
    readonly actorUserId: string;
    readonly occurrenceId: string;
    readonly settingsRevision: number;
    readonly candidates: readonly HeartbeatCandidate[];
    readonly result: HeartbeatModelResult;
    readonly now: Date;
    /** The owner's timezone, used to write times in the plain-text body. */
    readonly timeZone?: string;
  }
): Promise<{ readonly messageId: string; readonly itemCount: number }> {
  const byId = new Map(input.candidates.map((candidate) => [candidate.findingId, candidate]));
  const chosen = input.result.selected.flatMap((entry) => {
    const candidate = byId.get(entry.findingId);
    return candidate ? [{ candidate, note: entry.note }] : [];
  });
  const origin: ChatHeartbeatOriginV1 = {
    version: 1,
    kind: "heartbeat",
    occurrenceId: input.occurrenceId,
    intro: input.result.intro ?? "",
    items: chosen.map(({ candidate, note }) => ({
      findingId: candidate.findingId,
      source: candidate.source,
      title: candidate.item.title,
      at: candidate.item.at,
      note
    }))
  };
  const thread = await deps.chat.ensureMainThread(scopedDb, input.actorUserId);
  const messageId = randomUUID();
  await deps.chat.insertReservedAssistantMessage(scopedDb, {
    id: messageId,
    threadId: thread.id,
    body: heartbeatBody(origin, input.timeZone),
    origin,
    now: input.now
  });
  await markPublished(
    scopedDb,
    input.occurrenceId,
    input.now,
    chosen.map(({ candidate }) => ({
      id: candidate.findingId,
      source: candidate.source,
      entityKey: candidate.item.entityKey,
      episodeKey: candidate.item.episodeKey
    }))
  );
  await notifyReminderArrival(scopedDb, {
    actorUserId: input.actorUserId,
    threadId: thread.id,
    messageId
  });
  await sendJob<HeartbeatNotifyPayload>(
    deps.boss,
    CHAT_HEARTBEAT_NOTIFY_QUEUE,
    {
      actorUserId: input.actorUserId,
      resourceId: input.occurrenceId,
      version: input.settingsRevision,
      idempotencyKey: messageId
    },
    { db: scopedJobDatabase(scopedDb) }
  );
  return { messageId, itemCount: chosen.length };
}
