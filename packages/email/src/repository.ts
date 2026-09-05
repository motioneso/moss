import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb, type EmailMessage } from "@moss/db";

function hasCompleteTriage(signals: unknown): boolean {
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) return false;
  const actionability = (signals as Record<string, unknown>).actionability;
  if (!actionability || typeof actionability !== "object" || Array.isArray(actionability)) {
    return false;
  }
  const fields = actionability as Record<string, unknown>;
  if (
    fields.category !== "needs_action" &&
    fields.category !== "needs_reply" &&
    fields.category !== "time_sensitive_info"
  ) {
    return typeof fields.category === "string" && fields.category !== "unknown";
  }
  return (
    typeof fields.inferredSubject === "string" &&
    fields.inferredSubject.trim().length > 0 &&
    Array.isArray(fields.suggestedTasks) &&
    fields.suggestedTasks.length > 0
  );
}

export interface CreateCachedEmailMessageInput {
  readonly id?: string;
  readonly connectorAccountId: string;
  readonly sender: string;
  readonly recipients?: readonly string[];
  readonly subject: string;
  readonly snippet?: string | null;
  readonly bodyExcerpt?: string | null;
  readonly receivedAt: Date | string;
  readonly externalId: string;
  readonly externalMetadata?: Record<string, unknown>;
  readonly summary?: string | null;
  readonly signals?: Record<string, unknown>;
}

export class EmailRepository {
  /** Hard cap on any persisted body excerpt — a preview, never a full body. */
  static readonly MAX_BODY_EXCERPT_CHARS = 500;
  static readonly BRIEFING_RECENT_LIMIT = 200;
  static readonly BRIEFING_OLDER_UNRESOLVED_LIMIT = 25;

  async listVisible(scopedDb: DataContextDb): Promise<EmailMessage[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.email_messages")
      .selectAll()
      .orderBy("received_at", "desc")
      .orderBy("id")
      .execute();
  }

  async listVisibleForBriefing(scopedDb: DataContextDb): Promise<EmailMessage[]> {
    assertDataContextDb(scopedDb);

    const recent = await scopedDb.db
      .selectFrom("app.email_messages")
      .selectAll()
      .orderBy("received_at", "desc")
      .orderBy("id")
      .limit(EmailRepository.BRIEFING_RECENT_LIMIT)
      .execute();

    const recentIds = recent.map((message) => message.id);
    const olderUnresolved = await scopedDb.db
      .selectFrom("app.email_messages")
      .selectAll()
      .$if(recentIds.length > 0, (qb) => qb.where("id", "not in", recentIds))
      .where(
        sql<boolean>`concat_ws(' ',
          coalesce(sender, ''),
          coalesce(subject, ''),
          coalesce(snippet, ''),
          coalesce(summary, ''),
          coalesce(signals::text, '')
        ) ~* '(reply|respond|let me know|can you|please review|follow up|question|action)'`
      )
      .orderBy("received_at", "desc")
      .orderBy("id")
      .limit(EmailRepository.BRIEFING_OLDER_UNRESOLVED_LIMIT)
      .execute();

    return [...recent, ...olderUnresolved];
  }

  async getById(scopedDb: DataContextDb, messageId: string): Promise<EmailMessage | undefined> {
    assertDataContextDb(scopedDb);

    // Visibility is intentionally enforced by forced RLS; unauthorized rows read as absent.
    return scopedDb.db
      .selectFrom("app.email_messages")
      .selectAll()
      .where("id", "=", messageId)
      .executeTakeFirst();
  }

  /**
   * external_id is unique only per connector account (UNIQUE (connector_account_id,
   * external_id) — see 0012_email_module.sql), never globally: two different accounts can
   * share the same provider message id. Both columns are required so this never resolves
   * the wrong account's row.
   */
  async getByConnectorAccountAndExternalId(
    scopedDb: DataContextDb,
    connectorAccountId: string,
    externalId: string
  ): Promise<EmailMessage | undefined> {
    assertDataContextDb(scopedDb);

    // Visibility is intentionally enforced by forced RLS; unauthorized rows read as absent.
    return scopedDb.db
      .selectFrom("app.email_messages")
      .selectAll()
      .where("connector_account_id", "=", connectorAccountId)
      .where("external_id", "=", externalId)
      .executeTakeFirst();
  }

  async createCachedMessageForTest(
    scopedDb: DataContextDb,
    input: CreateCachedEmailMessageInput
  ): Promise<EmailMessage> {
    assertDataContextDb(scopedDb);

    const now = new Date();

    return scopedDb.db
      .insertInto("app.email_messages")
      .values({
        id: input.id ?? randomUUID(),
        connector_account_id: input.connectorAccountId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        sender: input.sender,
        recipients: [...(input.recipients ?? [])],
        subject: input.subject,
        snippet: input.snippet ?? null,
        body_excerpt: input.bodyExcerpt ?? null,
        received_at: input.receivedAt,
        external_id: input.externalId,
        external_metadata: input.externalMetadata ?? {},
        summary: input.summary ?? null,
        signals: input.signals ?? {},
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async upsertCachedMessage(
    scopedDb: DataContextDb,
    input: CreateCachedEmailMessageInput
  ): Promise<EmailMessage> {
    assertDataContextDb(scopedDb);

    const now = new Date();
    const bodyExcerpt =
      input.bodyExcerpt != null
        ? input.bodyExcerpt.slice(0, EmailRepository.MAX_BODY_EXCERPT_CHARS)
        : null;
    const incomingHistoryId =
      typeof input.externalMetadata?.historyId === "string"
        ? input.externalMetadata.historyId
        : null;
    // A one-time-code skip is a deliberate replacement, not a partial/missing analysis — it
    // must always overwrite whatever was stored before, even a complete prior triage.
    const isExplicitOtpSkip =
      (input.signals as { skipped?: unknown } | undefined)?.skipped === "otp";
    const preserveSameRevisionTriage =
      !isExplicitOtpSkip &&
      incomingHistoryId !== null &&
      (input.summary == null || !hasCompleteTriage(input.signals));
    const storedTriageIsComplete = sql<boolean>`
      app.email_messages.summary is not null
      and case
        when app.email_messages.signals->'actionability'->>'category'
          in ('needs_action', 'needs_reply', 'time_sensitive_info')
        then nullif(trim(app.email_messages.signals->'actionability'->>'inferredSubject'), '')
          is not null
          and jsonb_array_length(
            coalesce(app.email_messages.signals->'actionability'->'suggestedTasks', '[]'::jsonb)
          ) > 0
        else coalesce(app.email_messages.signals->'actionability'->>'category', 'unknown')
          <> 'unknown'
      end
    `;
    const keepStoredTriage = sql<boolean>`
      app.email_messages.external_metadata->>'historyId' = ${incomingHistoryId}
      and ${storedTriageIsComplete}
    `;

    return scopedDb.db
      .insertInto("app.email_messages")
      .values({
        id: input.id ?? randomUUID(),
        connector_account_id: input.connectorAccountId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        sender: input.sender,
        recipients: [...(input.recipients ?? [])],
        subject: input.subject,
        snippet: input.snippet ?? null,
        body_excerpt: bodyExcerpt,
        received_at: input.receivedAt,
        external_id: input.externalId,
        external_metadata: input.externalMetadata ?? {},
        summary: input.summary ?? null,
        signals: input.signals ?? {},
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["connector_account_id", "external_id"]).doUpdateSet({
          sender: input.sender,
          recipients: [...(input.recipients ?? [])],
          subject: input.subject,
          snippet: input.snippet ?? null,
          body_excerpt: bodyExcerpt,
          received_at: input.receivedAt,
          external_metadata: input.externalMetadata ?? {},
          summary: preserveSameRevisionTriage
            ? sql<
                string | null
              >`case when ${keepStoredTriage} then app.email_messages.summary else ${input.summary ?? null} end`
            : (input.summary ?? null),
          signals: preserveSameRevisionTriage
            ? sql<
                Record<string, unknown>
              >`case when ${keepStoredTriage} then app.email_messages.signals else ${JSON.stringify(input.signals ?? {})}::jsonb end`
            : (input.signals ?? {}),
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Wipe the stored analysis (summary + signals) from the actor's recently received messages so
   * the next sync sends them back through the model instead of skipping them as unchanged. The
   * skip check in the sync phase requires a stored summary AND complete triage, so emptying both
   * is exactly what re-opens them. Nothing else about the message is touched.
   *
   * The owner predicate is load-bearing, not belt-and-braces: the UPDATE policy in
   * sql/0068_email_worker_grants_and_google_insert.sql also admits rows shared to the actor with
   * 'manage', so RLS alone would let this wipe another owner's messages — and only the actor's
   * own sync would ever re-judge them, leaving the other owner blank. Owner-only keeps the reset
   * to mail this actor's own connector accounts brought in.
   */
  async clearRecentTriage(scopedDb: DataContextDb, receivedSince: Date): Promise<number> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .updateTable("app.email_messages")
      .set({ summary: null, signals: {}, updated_at: new Date() })
      .where("received_at", ">=", receivedSince)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  /**
   * Lightweight per-account sync markers for skip-unchanged: external_id, the stored Gmail
   * historyId (read from external_metadata), whether a non-null summary exists, and whether
   * actionable triage has the subject/task fields required for projection. The handler skips the
   * LLM pass only when all three are complete, so partial actionable triage is retried unchanged.
   * RLS-scoped to the actor via the worker SELECT grant (0068); returns only this account's rows.
   */
  async listSyncMarkers(
    scopedDb: DataContextDb,
    connectorAccountId: string
  ): Promise<
    Array<{
      externalId: string;
      historyId: string | null;
      hasSummary: boolean;
      hasCompleteTriage: boolean;
    }>
  > {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.email_messages")
      .select(["external_id", "external_metadata", "summary", "signals"])
      .where("connector_account_id", "=", connectorAccountId)
      .execute();
    return rows.map((r) => ({
      externalId: r.external_id,
      historyId: (r.external_metadata as { historyId?: string | null } | null)?.historyId ?? null,
      hasSummary: r.summary !== null,
      hasCompleteTriage: hasCompleteTriage(r.signals)
    }));
  }
}
