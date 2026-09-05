import { randomUUID } from "node:crypto";

import { sql, type SqlBool } from "kysely";

import { assertDataContextDb, type DataContextDb, type Notification } from "@moss/db";

import { projectNotificationMetadata } from "./metadata.js";

export interface NotificationWithReadState extends Notification {
  readonly read_at: Date | null;
}

export interface ListNotificationsResult {
  readonly notifications: readonly NotificationWithReadState[];
  readonly unreadCount: number;
  // #1285: per-module unread breakdown of the SAME count `unreadCount` rolls up — a module
  // nav badge is defined as "that module's unread notification count" (rulings-ledger G6)
  // rather than a new polling channel, so the badge and the bell can never disagree. Core
  // notifications (module_id IS NULL) are excluded; they already reach the bell via
  // `unreadCount` and have no nav entry to badge.
  readonly unreadByModule: Readonly<Record<string, number>>;
}

/**
 * Input for creating a notification. The V1 delivery model is **in-app, actor-scoped**:
 * `recipient_user_id` and `actor_user_id` are ALWAYS `app.current_actor_user_id()` — there
 * is intentionally no override here. RLS would silently reject any other recipient, so an
 * override would be phantom flexibility that misleads callers into thinking cross-recipient
 * or system-emitter paths are supported. A future spec can re-introduce a system-emitter
 * (NULL `actor_user_id`) path with its own `SECURITY DEFINER` plumbing when needed.
 *
 * `metadata` is bounded by `projectNotificationMetadata` before it is written; the type is
 * wide here only because callers should not have to construct the bounded form themselves.
 */
export interface CreateNotificationInput {
  readonly moduleId: string;
  readonly title: string;
  readonly body?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly urgency?: "urgent" | "normal" | "low";
  /**
   * Task 2b (#1283): a module-supplied dedup key. Re-posting the same
   * (recipient, moduleId, eventKey) updates the existing row in place and
   * clears any existing read state, rather than creating a duplicate — see
   * `create()`. Omitted (or `null`) means "always insert a new row," the
   * behavior every caller before this task already gets.
   */
  readonly eventKey?: string | null;
  /**
   * Same-origin path only ("/settings", never "https://…" or "//host/…").
   * Validated again here even though the RPC boundary (worker-rpc-host.ts)
   * already checked it — defense in depth against open redirect for any
   * caller that reaches this repository directly.
   */
  readonly href?: string | null;
}

/**
 * Cross-module port: notifications reads the actor's quiet-hours settings (and locale
 * timezone fallback) without importing from @moss/settings or @moss/structured-state.
 * The implementation is injected by the composition root (module-registry).
 */
export interface QuietHoursPort {
  getSettings(scopedDb: DataContextDb): Promise<unknown>;
  getLocaleTimezone(scopedDb: DataContextDb): Promise<string | null>;
}

export interface NotificationPreferencePort {
  isModuleEnabled(scopedDb: DataContextDb, moduleId: string): Promise<boolean>;
}

/**
 * Cross-package port: notifications enqueues push delivery jobs without importing
 * `@moss/jobs` (pg-boss) into the domain layer. The real implementation
 * (`createPushQueuePort` in `@moss/jobs`) is injected by the composition root. Absence
 * (the default) means push is simply not wired for that caller — consistent with
 * `notificationPreferencePort` being optional above.
 */
export interface PushQueuePort {
  enqueueDeliver(notificationId: string, recipientUserId: string): Promise<void>;
  enqueueSummary(recipientUserId: string, releaseAt: Date): Promise<void>;
}

export interface QuietHoursSettings {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string | null;
}

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function parseQuietHoursSettings(raw: unknown): QuietHoursSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  if (!isValidHHMM(r.start) || !isValidHHMM(r.end)) return null;
  const timezone = typeof r.timezone === "string" && r.timezone.length > 0 ? r.timezone : null;
  return { enabled: r.enabled, start: r.start, end: r.end, timezone };
}

function getLocalMinutes(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return (parseInt(parts.hour ?? "0", 10) % 24) * 60 + parseInt(parts.minute ?? "0", 10);
}

function parseHHMM(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(":");
  return [parseInt(h ?? "0", 10), parseInt(m ?? "0", 10)];
}

function isInQuietHours(now: Date, settings: QuietHoursSettings, tz: string): boolean {
  if (!settings.enabled) return false;
  const cur = getLocalMinutes(now, tz);
  const [sh, sm] = parseHHMM(settings.start);
  const [eh, em] = parseHHMM(settings.end);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  // Overnight window (e.g. 22:00–07:00): when start >= end wrap crosses midnight
  if (start >= end) return cur >= start || cur < end;
  return cur >= start && cur < end;
}

export function computeDeferredUntil(
  now: Date,
  settings: QuietHoursSettings,
  tz: string
): Date | null {
  if (!isInQuietHours(now, settings, tz)) return null;
  const [eh, em] = parseHHMM(settings.end);
  const endTotalMin = eh * 60 + em;
  const curLocal = getLocalMinutes(now, tz);

  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour12: false
  });
  const partsMap = Object.fromEntries(dateFmt.formatToParts(now).map((p) => [p.type, p.value]));
  const year = parseInt(partsMap.year ?? "2000", 10);
  const month = parseInt(partsMap.month ?? "1", 10) - 1;
  const day = parseInt(partsMap.day ?? "1", 10);

  // For overnight windows (start > end), pre-midnight leg means end is NEXT local day.
  const dayOffset = endTotalMin <= curLocal ? 1 : 0;

  // Naive approximation: treat tz offset as zero, place end-time at UTC midnight + end.
  const naiveUTC = new Date(Date.UTC(year, month, day + dayOffset, eh, em, 0));

  // Measure how far the naive approximation's local time is from the target local time.
  // Use modular arithmetic (±720 window) so overnight wrap doesn't flip the sign.
  const localMinAtNaive = getLocalMinutes(naiveUTC, tz);
  let deltaMin = endTotalMin - localMinAtNaive;
  if (deltaMin < -720) deltaMin += 1440;
  if (deltaMin > 720) deltaMin -= 1440;

  return new Date(naiveUTC.getTime() + deltaMin * 60 * 1000);
}

export async function resolveTimezone(
  port: QuietHoursPort,
  scopedDb: DataContextDb,
  explicitTz: string | null
): Promise<string> {
  if (explicitTz) return explicitTz;
  const localeTz = await port.getLocaleTimezone(scopedDb);
  return localeTz ?? "UTC";
}

/**
 * Task 2b (#1283): same rule as worker-rpc-host.ts's `notifyHref` — a same-origin
 * path only, never an absolute URL, a protocol-relative URL, or a scheme. This is
 * the SECOND of the two layers the docblock on `CreateNotificationInput.href`
 * promises; a caller that reaches this repository by any path other than the RPC
 * boundary (there is none today, but nothing stops a future one) still gets the
 * open-redirect guard.
 */
function validateHref(href: string | null | undefined): string | null {
  if (href === undefined || href === null) return null;
  if (href.length === 0 || !href.startsWith("/") || href.startsWith("//") || href.includes(":")) {
    throw new Error("href must be a same-origin path");
  }
  return href;
}

export class NotificationsRepository {
  constructor(
    private readonly quietHoursPort?: QuietHoursPort,
    private readonly notificationPreferencePort?: NotificationPreferencePort,
    private readonly pushQueuePort?: PushQueuePort
  ) {}

  async listVisible(scopedDb: DataContextDb): Promise<ListNotificationsResult> {
    assertDataContextDb(scopedDb);

    const [notifications, unreadCount, unreadByModule] = await Promise.all([
      this.listVisibleRows(scopedDb),
      this.countUnread(scopedDb),
      this.countUnreadByModule(scopedDb)
    ]);

    return { notifications, unreadCount, unreadByModule };
  }

  async getById(
    scopedDb: DataContextDb,
    notificationId: string
  ): Promise<NotificationWithReadState | undefined> {
    assertDataContextDb(scopedDb);

    return this.visibleRowsQuery(scopedDb)
      .where("notifications.id", "=", notificationId)
      .executeTakeFirst();
  }

  /**
   * Insert a notification, or — when `input.eventKey` is set and already exists for this
   * (recipient, moduleId) — update that existing row in place and return it to unread instead
   * of creating a duplicate (Task 2b, #1283 ruling: re-firing a key resurfaces the notification
   * exactly as a fresh one would).
   *
   * Both the insert and the keyed-update path run through ONE upsert CTE: the
   * `notifications_recipient_module_event_key_idx` partial unique index (migration 0175) is
   * the ON CONFLICT arbiter, and it only indexes rows with a non-null `event_key` — so an
   * un-keyed call (the only kind that existed before this task) never matches it and always
   * inserts, unchanged from prior behavior. The `cleared_read` CTE deletes any existing read
   * row for the (possibly pre-existing) notification id in the SAME statement as the upsert,
   * so "update in place" and "return to unread" cannot happen as two separate, racy writes —
   * a concurrent `markRead` either lands before this transaction (and gets cleared) or after
   * (and re-reads a row this statement already returned as unread).
   */
  async create(
    scopedDb: DataContextDb,
    input: CreateNotificationInput
  ): Promise<NotificationWithReadState | null> {
    assertDataContextDb(scopedDb);
    if (!input.moduleId?.trim()) {
      throw new Error("moduleId is required");
    }
    if (
      this.notificationPreferencePort &&
      !(await this.notificationPreferencePort.isModuleEnabled(scopedDb, input.moduleId))
    ) {
      return null;
    }

    const projectedMetadata = projectNotificationMetadata(input.metadata);
    const urgency = input.urgency ?? "normal";
    const eventKey = input.eventKey ?? null;
    const href = validateHref(input.href);

    let deferredUntil: Date | null = null;
    if (urgency !== "urgent" && this.quietHoursPort) {
      const raw = await this.quietHoursPort.getSettings(scopedDb);
      const settings = parseQuietHoursSettings(raw);
      if (settings?.enabled) {
        const tz = await resolveTimezone(this.quietHoursPort, scopedDb, settings.timezone);
        deferredUntil = computeDeferredUntil(new Date(), settings, tz);
      }
    }

    const rows = await sql<NotificationWithReadState>`
      WITH upserted AS (
        INSERT INTO app.notifications (
          id, module_id, actor_user_id, recipient_user_id, title, body, metadata,
          created_at, urgency, deferred_until, event_key, href, updated_at
        )
        VALUES (
          ${randomUUID()}::uuid,
          ${input.moduleId},
          app.current_actor_user_id(),
          app.current_actor_user_id(),
          ${input.title},
          ${input.body ?? null},
          ${JSON.stringify(projectedMetadata)}::jsonb,
          now(),
          ${urgency},
          ${deferredUntil},
          ${eventKey},
          ${href},
          now()
        )
        ON CONFLICT (recipient_user_id, module_id, event_key) WHERE event_key IS NOT NULL
        DO UPDATE SET
          title = excluded.title,
          body = excluded.body,
          metadata = excluded.metadata,
          urgency = excluded.urgency,
          deferred_until = excluded.deferred_until,
          href = excluded.href,
          updated_at = now()
        RETURNING *
      ),
      cleared_read AS (
        DELETE FROM app.notification_reads
        WHERE notification_id IN (SELECT id FROM upserted)
      )
      SELECT
        upserted.id AS id,
        upserted.module_id AS module_id,
        upserted.actor_user_id AS actor_user_id,
        upserted.recipient_user_id AS recipient_user_id,
        upserted.title AS title,
        upserted.body AS body,
        upserted.metadata AS metadata,
        upserted.created_at AS created_at,
        upserted.urgency AS urgency,
        upserted.deferred_until AS deferred_until,
        upserted.event_key AS event_key,
        upserted.href AS href,
        upserted.updated_at AS updated_at,
        NULL::timestamptz AS read_at
      FROM upserted
    `.execute(scopedDb.db);

    // The upsert CTE always produces exactly one row (INSERT ... ON CONFLICT DO UPDATE
    // never returns zero) — an empty result here is a genuine bug, not the "module
    // disabled" case, which already returned above and never reaches this query. Keep
    // that distinct from the `| null` return type: throwing here mirrors the previous
    // `executeTakeFirstOrThrow()` failure semantics instead of silently reusing `null`
    // for two unrelated meanings.
    const row = rows.rows[0];
    if (!row) throw new Error("notifications upsert returned no row");

    // Push delivery (#743 / #2227): urgent and never-deferred notifications push
    // immediately; a deferred one only ever gets one summary push at release time
    // (Resolved Decision 2), never an individual push. recipient_user_id is always the
    // acting actor (see CreateNotificationInput docblock), so it is never null here.
    if (this.pushQueuePort && row.recipient_user_id) {
      if (deferredUntil) {
        await this.pushQueuePort.enqueueSummary(row.recipient_user_id, deferredUntil);
      } else {
        await this.pushQueuePort.enqueueDeliver(row.id, row.recipient_user_id);
      }
    }

    return row;
  }

  /**
   * Record a read for `notificationId` on behalf of the active actor and return the row
   * with its updated read state.
   *
   * Returns `undefined` BOTH when the notification does not exist AND when it exists but is
   * not visible to the current actor (RLS-invisible). This conflation is DELIBERATE: it
   * prevents any existence side-channel. Callers — and the route layer — MUST NOT attempt
   * to differentiate the two cases; the route answers `404 Notification not found` for
   * either. See the docblock on `PATCH /api/notifications/:id/read` in routes.ts.
   *
   * Implementation: a single data-modifying CTE performs the INSERT ... ON CONFLICT and
   * the JOIN back to app.notifications in one round-trip. The SELECT inside the CTE is
   * subject to RLS, so a row that does not exist OR is invisible yields zero inserted
   * rows and the final JOIN returns no rows → `undefined`. markAllRead is intentionally
   * NOT collapsed (it returns a count, not a row, so there is no redundant follow-up read).
   *
   * `FOR UPDATE` on the inner SELECT (Task 2b, #1283) locks the parent notification row
   * for the duration of this transaction, so a concurrent `create()` keyed re-fire of the
   * SAME notification cannot interleave its `cleared_read` DELETE between this INSERT and
   * this query's final read — one of the two transactions waits, then sees the other's
   * committed result, instead of a lost-update race deciding the read state by timing.
   */
  async markRead(
    scopedDb: DataContextDb,
    notificationId: string
  ): Promise<NotificationWithReadState | undefined> {
    assertDataContextDb(scopedDb);

    // Single round-trip via a modifying CTE: the INSERT emits zero rows when the parent
    // notification is absent or RLS-invisible, and the final JOIN returns nothing — which
    // is the exact "absent === denied" behavior we must preserve.
    const rows = await sql<NotificationWithReadState>`
      WITH inserted AS (
        INSERT INTO app.notification_reads (notification_id, user_id, read_at)
        SELECT n.id, app.current_actor_user_id(), now()
        FROM app.notifications n
        WHERE n.id = ${notificationId}::uuid
        FOR UPDATE OF n
        ON CONFLICT (notification_id, user_id) DO UPDATE SET read_at = excluded.read_at
        RETURNING notification_id, read_at
      )
      SELECT
        n.id AS id,
        n.module_id AS module_id,
        n.actor_user_id AS actor_user_id,
        n.recipient_user_id AS recipient_user_id,
        n.title AS title,
        n.body AS body,
        n.metadata AS metadata,
        n.created_at AS created_at,
        n.urgency AS urgency,
        n.deferred_until AS deferred_until,
        n.event_key AS event_key,
        n.href AS href,
        n.updated_at AS updated_at,
        inserted.read_at AS read_at
      FROM app.notifications n
      JOIN inserted ON inserted.notification_id = n.id
    `.execute(scopedDb.db);

    return rows.rows[0];
  }

  async markAllRead(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);

    await scopedDb.db
      .insertInto("app.notification_reads")
      .columns(["notification_id", "user_id", "read_at"])
      .expression((eb) =>
        eb
          .selectFrom("app.notifications")
          .select([
            "id as notification_id",
            sql<string>`app.current_actor_user_id()`.as("user_id"),
            sql<Date>`now()`.as("read_at")
          ])
          // Only mark visible (not still-deferred) notifications as read
          .where(sql<SqlBool>`(deferred_until IS NULL OR now() >= deferred_until)`)
      )
      .onConflict((oc) =>
        oc.columns(["notification_id", "user_id"]).doUpdateSet({
          read_at: sql<Date>`excluded.read_at`
        })
      )
      .execute();

    return this.countUnread(scopedDb);
  }

  async markModuleRead(scopedDb: DataContextDb, moduleId: string): Promise<number> {
    assertDataContextDb(scopedDb);

    await scopedDb.db
      .insertInto("app.notification_reads")
      .columns(["notification_id", "user_id", "read_at"])
      .expression((eb) =>
        eb
          .selectFrom("app.notifications")
          .select([
            "id as notification_id",
            sql<string>`app.current_actor_user_id()`.as("user_id"),
            sql<Date>`now()`.as("read_at")
          ])
          .where("module_id", "=", moduleId)
          .where(sql<SqlBool>`(deferred_until IS NULL OR now() >= deferred_until)`)
      )
      .onConflict((oc) =>
        oc.columns(["notification_id", "user_id"]).doUpdateSet({
          read_at: sql<Date>`excluded.read_at`
        })
      )
      .execute();

    return this.countUnread(scopedDb);
  }

  async listDigestEligible(
    scopedDb: DataContextDb,
    input: { since: Date | null; limit?: number }
  ): Promise<NotificationWithReadState[]> {
    assertDataContextDb(scopedDb);

    let query = this.visibleRowsQuery(scopedDb).where("reads.notification_id", "is", null);
    if (input.since) {
      query = query.where("notifications.created_at", ">", input.since);
    }
    return query
      .orderBy("notifications.created_at", "asc")
      .orderBy("notifications.id")
      .limit(input.limit ?? 50)
      .execute();
  }

  private async listVisibleRows(scopedDb: DataContextDb): Promise<NotificationWithReadState[]> {
    // Task 2b (#1283): ordering moves from created_at to "most recently touched" so a keyed
    // re-fire resurfaces at the top of the list exactly like a new notification would —
    // matching the notifications_recipient_updated_at_idx index added in migration 0175.
    // coalesce() covers rows from before this column existed (backfilled to now() by the
    // ADD COLUMN default, but the query stays defensive).
    return this.visibleRowsQuery(scopedDb)
      .orderBy(sql`coalesce(notifications.updated_at, notifications.created_at)`, "desc")
      .orderBy("notifications.id")
      .execute();
  }

  private async countUnread(scopedDb: DataContextDb): Promise<number> {
    const row = await scopedDb.db
      .selectFrom("app.notifications as notifications")
      .leftJoin("app.notification_reads as reads", (join) =>
        join
          .onRef("reads.notification_id", "=", "notifications.id")
          .on("reads.user_id", "=", sql<string>`app.current_actor_user_id()`)
      )
      .select(({ fn }) => fn.count<string>("notifications.id").as("unread_count"))
      .where("reads.notification_id", "is", null)
      .where(
        sql<SqlBool>`(notifications.deferred_until IS NULL OR now() >= notifications.deferred_until)`
      )
      .executeTakeFirstOrThrow();

    return Number(row.unread_count);
  }

  // #1285: mirrors `countUnread` above EXACTLY — same left join to `notification_reads`,
  // same `deferred_until` guard, same RLS-scoped `scopedDb` — but grouped by `module_id`
  // instead of collapsed to one total. `module_id IS NOT NULL` excludes core notifications,
  // which have no module nav entry to badge and already surface via `countUnread`. A left
  // join that forgets the read-state exclusion would count already-read notifications
  // toward a module's badge (rulings-ledger G1: read state lives in a separate table).
  private async countUnreadByModule(scopedDb: DataContextDb): Promise<Record<string, number>> {
    const rows = await scopedDb.db
      .selectFrom("app.notifications as notifications")
      .leftJoin("app.notification_reads as reads", (join) =>
        join
          .onRef("reads.notification_id", "=", "notifications.id")
          .on("reads.user_id", "=", sql<string>`app.current_actor_user_id()`)
      )
      .select(({ fn }) => [
        "notifications.module_id as module_id",
        fn.count<string>("notifications.id").as("unread_count")
      ])
      .where("reads.notification_id", "is", null)
      .where("notifications.module_id", "is not", null)
      .where(
        sql<SqlBool>`(notifications.deferred_until IS NULL OR now() >= notifications.deferred_until)`
      )
      .groupBy("notifications.module_id")
      .execute();

    const unreadByModule: Record<string, number> = {};
    for (const row of rows) {
      // `module_id IS NOT NULL` is enforced in the WHERE clause above, so this is never
      // actually null at runtime — the guard here is only to satisfy the nullable column type.
      if (row.module_id === null) continue;
      unreadByModule[row.module_id] = Number(row.unread_count);
    }
    return unreadByModule;
  }

  private visibleRowsQuery(scopedDb: DataContextDb) {
    return scopedDb.db
      .selectFrom("app.notifications as notifications")
      .leftJoin("app.notification_reads as reads", (join) =>
        join
          .onRef("reads.notification_id", "=", "notifications.id")
          .on("reads.user_id", "=", sql<string>`app.current_actor_user_id()`)
      )
      .select([
        "notifications.id as id",
        "notifications.module_id as module_id",
        "notifications.actor_user_id as actor_user_id",
        "notifications.recipient_user_id as recipient_user_id",
        "notifications.title as title",
        "notifications.body as body",
        "notifications.metadata as metadata",
        "notifications.created_at as created_at",
        "notifications.urgency as urgency",
        "notifications.deferred_until as deferred_until",
        "notifications.event_key as event_key",
        "notifications.href as href",
        "notifications.updated_at as updated_at",
        "reads.read_at as read_at"
      ])
      .where(
        sql<SqlBool>`(notifications.deferred_until IS NULL OR now() >= notifications.deferred_until)`
      );
  }
}
