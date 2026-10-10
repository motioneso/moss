import { sql } from "kysely";

import type { DataContextDb } from "@moss/db";
import { assertDataContextDb } from "@moss/db";
import { cronExprFor, timezoneFor, type NotificationDto } from "@moss/shared";

import {
  DIGEST_BATCH_SIZE,
  NotificationsRepository,
  type NotificationPreferencePort
} from "./repository.js";
import { serializeNotification } from "./routes.js";

export const DIGEST_COMPOSE_QUEUE = "notifications.digest.compose";
export const NOTIFICATION_DIGEST_PREFERENCE_KEY = "notifications:digest";

export type NotificationDigestCadence = "daily" | "weekly";

export interface NotificationDigestPreference {
  readonly enabled: boolean;
  readonly cadence: NotificationDigestCadence;
  readonly scheduleMetadata: Record<string, unknown>;
  readonly lastDigestSentAt: Date | null;
  // Tie-break for rows sharing the watermark time; set only while a batch is unfinished.
  readonly lastDigestSentId?: string | null;
}

export interface DigestComposeJobPayload {
  readonly actorUserId: string;
  readonly reason: "scheduled-digest";
  readonly idempotencyKey: string;
}

export interface NotificationDigestScheduler {
  schedule(
    name: string,
    cron: string,
    data: DigestComposeJobPayload,
    options: { readonly tz: string; readonly key: string }
  ): Promise<unknown>;
  unschedule(name: string, key: string): Promise<unknown>;
}

export interface NotificationDigestPreferencesPort {
  get(scopedDb: DataContextDb, key: string): Promise<unknown>;
  upsert(scopedDb: DataContextDb, key: string, value: unknown): Promise<unknown>;
}

export interface NotificationDigestSender {
  sendDigest(
    scopedDb: DataContextDb,
    input: { to: string; subject: string; text: string; html: string }
  ): Promise<{ ok: boolean }>;
}

export interface NotificationDigestComposeDeps {
  readonly baseUrl: string;
  readonly notificationsRepository?: NotificationsRepository;
  readonly preferencesRepository: NotificationDigestPreferencesPort;
  readonly notificationPreferencePort?: NotificationPreferencePort;
  readonly sender: NotificationDigestSender;
  readonly now?: () => Date;
}

export type NotificationDigestComposeResult =
  | { status: "skipped"; reason: "disabled" | "empty" }
  | { status: "failed" }
  | { status: "sent"; count: number };

const DEFAULT_DIGEST_PREFERENCE: NotificationDigestPreference = {
  enabled: false,
  cadence: "daily",
  scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
  lastDigestSentAt: null
};

export function digestPreferenceFromRaw(raw: unknown): NotificationDigestPreference {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_DIGEST_PREFERENCE;
  const value = raw as Record<string, unknown>;
  const enabled = value.enabled === true;
  const cadence = value.cadence === "weekly" ? "weekly" : "daily";
  const scheduleMetadata =
    value.scheduleMetadata && typeof value.scheduleMetadata === "object"
      ? (value.scheduleMetadata as Record<string, unknown>)
      : DEFAULT_DIGEST_PREFERENCE.scheduleMetadata;
  const lastDigestSentAt =
    typeof value.lastDigestSentAt === "string" ? parseDate(value.lastDigestSentAt) : null;
  const lastDigestSentId =
    typeof value.lastDigestSentId === "string" ? value.lastDigestSentId : null;
  return { enabled, cadence, scheduleMetadata, lastDigestSentAt, lastDigestSentId };
}

export function digestPreferenceToRaw(preference: NotificationDigestPreference) {
  return {
    enabled: preference.enabled,
    cadence: preference.cadence,
    scheduleMetadata: preference.scheduleMetadata,
    lastDigestSentAt: preference.lastDigestSentAt?.toISOString() ?? null,
    lastDigestSentId: preference.lastDigestSentId ?? null
  };
}

export function digestScheduleData(actorUserId: string): DigestComposeJobPayload {
  return {
    actorUserId,
    reason: "scheduled-digest",
    idempotencyKey: `digest:${actorUserId}`
  };
}

export async function reconcileDigestSchedule(
  boss: NotificationDigestScheduler,
  actorUserId: string,
  preference: NotificationDigestPreference
): Promise<void> {
  const key = digestScheduleKey(actorUserId);
  if (!preference.enabled) {
    await boss.unschedule(DIGEST_COMPOSE_QUEUE, key);
    return;
  }
  const data = digestScheduleData(actorUserId);
  assertDigestPayload(data);
  await boss.schedule(
    DIGEST_COMPOSE_QUEUE,
    cronExprFor(preference.cadence, preference.scheduleMetadata),
    data,
    { tz: timezoneFor(preference.scheduleMetadata), key }
  );
}

export function digestScheduleKey(actorUserId: string): string {
  return `digest:${actorUserId}`;
}

export function renderNotificationDigest(input: {
  readonly baseUrl: string;
  readonly notifications: readonly NotificationDto[];
}): { subject: string; text: string; html: string } {
  const settingsUrl = `${input.baseUrl.replace(/\/$/, "")}/settings?section=notifications`;
  const lines = [
    "Moss notification digest",
    "",
    ...input.notifications.flatMap((notification) => [
      `- ${notification.title}`,
      ...(notification.body ? [`  ${notification.body}`] : [])
    ]),
    "",
    `Manage digest settings: ${settingsUrl}`
  ];
  const items = input.notifications
    .map((notification) => {
      const body = notification.body ? `<p>${escapeHtml(notification.body)}</p>` : "";
      return `<li><strong>${escapeHtml(notification.title)}</strong>${body}</li>`;
    })
    .join("");

  return {
    subject: "Moss notification digest",
    text: lines.join("\n"),
    html: `<h1>Moss notification digest</h1><ul>${items}</ul><p><a href="${escapeHtml(settingsUrl)}">Manage digest settings</a></p>`
  };
}

export async function runNotificationDigestCompose(
  scopedDb: DataContextDb,
  deps: NotificationDigestComposeDeps
): Promise<NotificationDigestComposeResult> {
  assertDataContextDb(scopedDb);
  const preferencesRepository = deps.preferencesRepository;
  const preference = digestPreferenceFromRaw(
    await preferencesRepository.get(scopedDb, NOTIFICATION_DIGEST_PREFERENCE_KEY)
  );
  if (!preference.enabled) return { status: "skipped", reason: "disabled" };

  const repository = deps.notificationsRepository ?? new NotificationsRepository();
  const rows = await repository.listDigestEligible(scopedDb, {
    since: preference.lastDigestSentAt,
    sinceId: preference.lastDigestSentId ?? null,
    limit: DIGEST_BATCH_SIZE
  });
  // A full batch may leave eligible rows behind, so the watermark stops at the last row
  // consumed instead of jumping to the current time.
  const truncated = rows.length >= DIGEST_BATCH_SIZE;
  const lastRow = rows[rows.length - 1];
  const watermark = truncated && lastRow ? digestVisibleAt(lastRow) : null;
  const advanceTo = async () => {
    await preferencesRepository.upsert(
      scopedDb,
      NOTIFICATION_DIGEST_PREFERENCE_KEY,
      digestPreferenceToRaw({
        ...preference,
        lastDigestSentAt: watermark ?? deps.now?.() ?? new Date(),
        lastDigestSentId: watermark && lastRow ? lastRow.id : null
      })
    );
  };
  const filtered = [];
  for (const row of rows) {
    if (!row.module_id) continue;
    if (
      !deps.notificationPreferencePort ||
      (await deps.notificationPreferencePort.isModuleEnabled(scopedDb, row.module_id))
    ) {
      filtered.push(row);
    }
  }
  if (filtered.length === 0) {
    if (truncated) await advanceTo();
    return { status: "skipped", reason: "empty" };
  }

  const rendered = renderNotificationDigest({
    baseUrl: deps.baseUrl,
    notifications: filtered.map(serializeNotification)
  });
  const to = await getActorEmail(scopedDb);
  const result = await deps.sender.sendDigest(scopedDb, { to, ...rendered });
  if (!result.ok) return { status: "failed" };

  await advanceTo();
  return { status: "sent", count: filtered.length };
}

// Mirrors the visible-at expression in listDigestEligible.
function digestVisibleAt(row: {
  created_at: Date;
  updated_at: Date | null;
  deferred_until: Date | null;
}): Date {
  const times = [row.created_at, row.updated_at, row.deferred_until]
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime());
  return new Date(Math.max(...times));
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function assertDigestPayload(payload: DigestComposeJobPayload): void {
  const keys = Object.keys(payload).sort();
  if (keys.join(",") !== "actorUserId,idempotencyKey,reason") {
    throw new Error("Digest payload must contain metadata keys only");
  }
}

async function getActorEmail(scopedDb: DataContextDb): Promise<string> {
  const result = await sql<{ email: string }>`
    SELECT email FROM app.users WHERE id = app.current_actor_user_id()
  `.execute(scopedDb.db);
  const email = result.rows[0]?.email;
  if (!email) throw new Error("Digest recipient email not found");
  return email;
}
