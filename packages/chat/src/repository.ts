import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import {
  assertDataContextDb,
  type ChatMessage,
  type ChatMessageStatus,
  type ChatThread,
  type DataContextDb
} from "@moss/db";
import type {
  AnswerProvenanceMetadataV1,
  ChatActivityEventDto,
  ChatAttachmentDto,
  ChatSurface,
  ChatTurnOriginV1,
  ChatTurnUsageDto,
  SourceFreshnessV1
} from "@moss/shared";
import type { StoredMeetingChatContext } from "@moss/shared";
import { normalizeChatSurface } from "./live/chat-surface.js";
import { toIsoString } from "./memory-serializers.js";
import {
  actionRecordId,
  actionRecords,
  mergeTerminalAction,
  type TerminalActionRecord
} from "./action-record-history.js";
import {
  claimLiveTurn,
  claimStaleLiveTurns,
  deleteLiveTurn,
  hasStaleLiveTurns,
  INTERRUPTED_REPLY_TEXT,
  type ClaimedLiveTurn
} from "./live-turns.js";

/** Absorbed synthetic rows remain stored; only their visible replacement participates in history. */
function visibleChatMessage(table: "app.chat_messages" | "m" = "app.chat_messages") {
  const metadata = sql.ref(`${table}.tool_metadata`);
  return sql<boolean>`NOT COALESCE(
    ${sql.ref(`${table}.body`)} = ''
    AND ${sql.ref(`${table}.role`)} = 'assistant'
    AND ${sql.ref(`${table}.status`)} = 'stored'
    AND ${metadata}->'actionOutcomeOnly' = 'true'::jsonb
    AND ${metadata}->'actionOutcomeHidden' = 'true'::jsonb,
    false
  )`;
}

export interface PublishConversationSummaryInput {
  readonly threadId: string;
  readonly expectedRevision: number;
  readonly expectedCoveredThroughMessageId: string | null;
  readonly throughMessageId: string;
  readonly summary: string;
}

export type PublishConversationSummaryResult = "published" | "stale" | "missing";

export interface CreateChatThreadInput {
  readonly title: string;
  readonly incognito?: boolean;
  readonly surface?: ChatSurface;
}

/** Options shared by the model-origin and gate-origin completed-turn writers. */
export interface CompletedTurnOptions {
  readonly meetingContext?: StoredMeetingChatContext;
  readonly sourceFreshness?: SourceFreshnessV1 | null;
  readonly answerProvenance?: AnswerProvenanceMetadataV1;
  /** #1133 — attachment display metadata (id/name/mime/size) — never bytes. */
  readonly attachments?: readonly ChatAttachmentDto[];
  readonly actionResults?: readonly ChatActivityEventDto[];
  readonly activityRecords?: readonly unknown[];
  readonly elapsedMs?: number;
  readonly usage?: ChatTurnUsageDto;
  /** #3128: live turn identity; stamped on both rows and clears the in-flight record. */
  readonly turnId?: string;
}

/**
 * Chat persistence for the live drawer runtime: thread reads + the born-complete
 * turn recording the in-process CLI runtime needs. The legacy worker-backed
 * methods (create/append/status/activity/complete) and the pg-boss enqueue were
 * removed in the retire-legacy-chat-model change.
 */
export class ChatRepository {
  async listThreads(
    scopedDb: DataContextDb,
    surface?: ChatSurface
  ): Promise<(ChatThread & { readonly lastMessageBody: string | null })[]> {
    assertDataContextDb(scopedDb);
    const chatSurface = normalizeChatSurface(surface);

    return scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll("app.chat_threads")
      .select((eb) =>
        eb
          .selectFrom("app.chat_messages")
          .where(visibleChatMessage())
          .select("body")
          .whereRef("app.chat_messages.thread_id", "=", "app.chat_threads.id")
          // A saved turn stores the person's message and the reply at the same
          // instant, so ties on created_at must break toward the reply — that is
          // the message the preview should show.
          .orderBy("created_at", "desc")
          .orderBy(sql<number>`CASE WHEN role = 'user' THEN 0 ELSE 1 END`, "desc")
          .orderBy("id", "desc")
          .limit(1)
          .as("lastMessageBody")
      )
      .where("incognito", "=", false)
      .where("surface", "=", chatSurface)
      .orderBy("last_active_at", "desc")
      .orderBy("id")
      .execute();
  }

  /**
   * Threads ordered by REAL activity (last_active_at, bumped on every turn via
   * touchThread), most-active first, capped at `limit`. Used by the briefing's
   * today's-chats scan so a long-lived thread active today is never dropped — the
   * existing listThreads orders by updated_at, which is NOT bumped on a turn.
   */
  async listThreadsByActivity(
    scopedDb: DataContextDb,
    limit: number,
    surface?: ChatSurface
  ): Promise<ChatThread[]> {
    assertDataContextDb(scopedDb);
    const chatSurface = normalizeChatSurface(surface);

    return scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("surface", "=", chatSurface)
      .orderBy("last_active_at", "desc")
      .orderBy("id")
      .limit(limit)
      .execute();
  }

  async getThreadById(
    scopedDb: DataContextDb,
    threadId: string,
    surface?: ChatSurface
  ): Promise<ChatThread | undefined> {
    assertDataContextDb(scopedDb);
    const chatSurface = normalizeChatSurface(surface);

    return scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("id", "=", threadId)
      .where("surface", "=", chatSurface)
      .executeTakeFirst();
  }

  /** Exact owner identity with no surface/current-thread default. */
  async getOwnedThreadById(
    scopedDb: DataContextDb,
    actorUserId: string,
    threadId: string
  ): Promise<ChatThread | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("id", "=", threadId)
      .where("owner_user_id", "=", actorUserId)
      .executeTakeFirst();
  }

  /** A late outcome never selects its old thread or creates a synthetic user turn. */
  async persistActionRecord(
    scopedDb: DataContextDb,
    actorUserId: string,
    threadId: string,
    record: TerminalActionRecord
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const thread = await scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("id", "=", threadId)
      .where("owner_user_id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!thread || thread.owner_user_id !== actorUserId || thread.incognito) return false;
    await this.lockActionHistory(scopedDb, threadId);
    const matching = JSON.stringify([{ actionRequestId: record.actionRequestId }]);
    const message = await scopedDb.db
      .selectFrom("app.chat_messages")
      .where(visibleChatMessage())
      .selectAll()
      .where("thread_id", "=", thread.id)
      .where("owner_user_id", "=", actorUserId)
      .where("role", "=", "assistant")
      .where("status", "=", "stored")
      .where(
        sql<boolean>`(tool_metadata->'activity' @> ${matching}::jsonb OR tool_metadata->'actionResults' @> ${matching}::jsonb)`
      )
      .orderBy(
        sql<number>`CASE WHEN tool_metadata->>'actionOutcomeOnly' = 'true' THEN 1 ELSE 0 END`
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (message) {
      const metadata = message.tool_metadata;
      const activity = actionRecords(metadata.activity ?? metadata.actionResults);
      const updatedMetadata = {
        ...metadata,
        activity: mergeTerminalAction(activity, record),
        actionResults: mergeTerminalAction(actionRecords(metadata.actionResults), record).slice(
          0,
          20
        )
      };
      const updated = await scopedDb.db
        .updateTable("app.chat_messages")
        .set({
          tool_metadata: updatedMetadata,
          updated_at: new Date()
        })
        .where("id", "=", message.id)
        .where("thread_id", "=", threadId)
        .where("owner_user_id", "=", actorUserId)
        .where(
          sql<boolean>`tool_metadata IS DISTINCT FROM ${JSON.stringify(updatedMetadata)}::jsonb`
        )
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) return true;
      const unchanged = await scopedDb.db
        .selectFrom("app.chat_messages")
        .select("id")
        .where("id", "=", message.id)
        .where("thread_id", "=", threadId)
        .where("owner_user_id", "=", actorUserId)
        .where("status", "=", "stored")
        .where(sql<boolean>`tool_metadata = ${JSON.stringify(updatedMetadata)}::jsonb`)
        .executeTakeFirst();
      return Boolean(unchanged);
    }
    await this.insertMessage(scopedDb, {
      thread,
      role: "assistant",
      status: "stored",
      body: "",
      modelMetadata: {},
      toolMetadata: {
        selectedTools: [],
        actionOutcomeOnly: true,
        activity: [record],
        actionResults: [record]
      },
      now: new Date()
    });
    return true;
  }

  private async lockActionHistory(scopedDb: DataContextDb, threadId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'chat:action-history:' || app.current_actor_user_id()::text || ':' || ${threadId}, 0
    ))`.execute(scopedDb.db);
  }

  /**
   * #3128: stores every reply in this thread that another API boot left unfinished as its
   * question plus an interrupted note. Nothing is resubmitted, because a tool the reply started
   * may or may not have run.
   */
  async reconcileInterruptedTurns(
    scopedDb: DataContextDb,
    threadId: string,
    bootId: string
  ): Promise<number> {
    assertDataContextDb(scopedDb);
    if (!(await hasStaleLiveTurns(scopedDb, threadId, bootId))) return 0;
    return this.storeInterrupted(scopedDb, threadId, (db) =>
      claimStaleLiveTurns(db, threadId, bootId)
    );
  }

  /** #3128: stores one reply that failed in this process after the model received it. */
  async storeInterruptedTurn(
    scopedDb: DataContextDb,
    threadId: string,
    turnId: string
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const stored = await this.storeInterrupted(scopedDb, threadId, (db) =>
      claimLiveTurn(db, threadId, turnId)
    );
    return stored > 0;
  }

  // Takes the same locks as writeCompletedTurn, so a claimed row and a completed save of the
  // same turn never both land.
  private async storeInterrupted(
    scopedDb: DataContextDb,
    threadId: string,
    claim: (scopedDb: DataContextDb) => Promise<readonly ClaimedLiveTurn[]>
  ): Promise<number> {
    const thread = await scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("id", "=", threadId)
      .forUpdate()
      .executeTakeFirst();
    if (!thread || thread.incognito) return 0;

    await this.lockActionHistory(scopedDb, threadId);
    const claimed = await claim(scopedDb);
    const frontierAt = await this.summaryFrontierCreatedAt(scopedDb, thread);
    for (const turn of claimed) {
      // The pair keeps the question's place in history unless the summary already covers it.
      const startedAt = new Date(turn.started_at);
      const now = frontierAt && startedAt <= frontierAt ? new Date() : startedAt;
      await this.insertMessage(scopedDb, {
        thread,
        role: "user",
        status: "stored",
        body: turn.user_text,
        modelMetadata: {},
        toolMetadata: {
          selectedTools: [],
          turnId: turn.turn_id,
          ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {})
        },
        now
      });
      await this.insertMessage(scopedDb, {
        thread,
        role: "assistant",
        status: "error",
        body: INTERRUPTED_REPLY_TEXT,
        modelMetadata: {},
        toolMetadata: { selectedTools: [], turnId: turn.turn_id, interruptedTurn: true },
        now
      });
    }
    return claimed.length;
  }

  private async summaryFrontierCreatedAt(
    scopedDb: DataContextDb,
    thread: ChatThread
  ): Promise<Date | undefined> {
    if (!thread.summary_covered_through_message_id) return undefined;
    const frontier = await scopedDb.db
      .selectFrom("app.chat_messages")
      .select("created_at")
      .where("id", "=", thread.summary_covered_through_message_id)
      .executeTakeFirst();
    return frontier ? new Date(frontier.created_at) : undefined;
  }

  // The stored user and assistant rows of a turn id that already landed. A real reply outranks
  // the interrupted note of the same turn.
  private async findStoredTurn(
    scopedDb: DataContextDb,
    threadId: string,
    turnId: string
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage } | undefined> {
    const rows = await scopedDb.db
      .selectFrom("app.chat_messages")
      .selectAll()
      .where("thread_id", "=", threadId)
      .where(sql<boolean>`tool_metadata @> ${JSON.stringify({ turnId })}::jsonb`)
      .execute();
    const userMessage = rows.find((row) => row.role === "user");
    const assistants = rows.filter((row) => row.role === "assistant");
    const assistantMessage =
      assistants.find((row) => row.tool_metadata.interruptedTurn !== true) ?? assistants[0];
    return userMessage && assistantMessage ? { userMessage, assistantMessage } : undefined;
  }

  async listMessages(scopedDb: DataContextDb, threadId: string): Promise<ChatMessage[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.chat_messages")
      .where(visibleChatMessage())
      .selectAll()
      .where("thread_id", "=", threadId)
      .orderBy("created_at")
      .orderBy(sql<number>`CASE WHEN role = 'user' THEN 0 ELSE 1 END`)
      .orderBy("id")
      .execute();
  }

  async getMessageById(
    scopedDb: DataContextDb,
    messageId: string
  ): Promise<ChatMessage | undefined> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.chat_messages")
      .where(visibleChatMessage())
      .selectAll()
      .where("id", "=", messageId)
      .executeTakeFirst();
  }

  private async insertMessage(
    scopedDb: DataContextDb,
    input: {
      readonly thread: ChatThread;
      readonly role: ChatMessage["role"];
      readonly status: ChatMessageStatus;
      readonly body: string;
      readonly modelMetadata: Record<string, unknown>;
      readonly toolMetadata: Record<string, unknown>;
      readonly now: Date;
    }
  ): Promise<ChatMessage> {
    return scopedDb.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: input.thread.id,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        role: input.role,
        status: input.status,
        body: input.body,
        model_metadata: input.modelMetadata,
        tool_metadata: input.toolMetadata,
        created_at: input.now,
        updated_at: input.now
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Writes a code-authored assistant message under an id reserved earlier, for example a
   * reminder delivery. No RETURNING; the caller already holds the id it reserved.
   */
  async insertReservedAssistantMessage(
    scopedDb: DataContextDb,
    input: {
      readonly id: string;
      readonly threadId: string;
      readonly body: string;
      readonly origin: ChatTurnOriginV1;
      readonly now: Date;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.chat_messages")
      .values({
        id: input.id,
        thread_id: input.threadId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        role: "assistant",
        status: "stored",
        body: input.body,
        model_metadata: { origin: input.origin },
        tool_metadata: { selectedTools: [] },
        created_at: input.now,
        updated_at: input.now
      })
      .executeTakeFirstOrThrow();
  }

  /** Returns the owner's most-recent thread by last_active_at for an explicit side-chat resume. */
  async getCurrentThread(
    scopedDb: DataContextDb,
    actorUserId: string,
    surface?: ChatSurface
  ): Promise<ChatThread | undefined> {
    assertDataContextDb(scopedDb);
    const chatSurface = normalizeChatSurface(surface);

    return scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("owner_user_id", "=", actorUserId)
      .where("surface", "=", chatSurface)
      .orderBy("last_active_at", "desc")
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
  }

  /** Returns the owner's durable drawer Main chat, excluding shared and transient threads. */
  async getMainThread(
    scopedDb: DataContextDb,
    actorUserId: string
  ): Promise<ChatThread | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("owner_user_id", "=", actorUserId)
      .where("surface", "=", "drawer")
      .where("is_main", "=", true)
      .executeTakeFirst();
  }

  /**
   * Creates a new chat thread stamped active now, making it the most-recent (and
   * therefore "current") conversation for the owner.
   */
  async openNewThread(scopedDb: DataContextDb, input: CreateChatThreadInput): Promise<ChatThread> {
    assertDataContextDb(scopedDb);
    const surface = normalizeChatSurface(input.surface);
    await this.lockThreadSelection(scopedDb, surface);

    const isMain =
      surface === "drawer" &&
      !input.incognito &&
      !(await scopedDb.db
        .selectFrom("app.chat_threads")
        .select("id")
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .where("is_main", "=", true)
        .executeTakeFirst());

    const now = new Date();

    // The database AFTER INSERT trigger atomically initializes clean provenance.
    return scopedDb.db
      .insertInto("app.chat_threads")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        title: input.title,
        incognito: input.incognito ?? false,
        is_main: isMain,
        surface,
        created_at: now,
        updated_at: now,
        last_active_at: this.nextThreadActivity(surface)
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Records a completed live-chat turn WITHOUT enqueuing a pg-boss job: a `stored`
   * user message followed by a `stored` assistant message whose body is the final
   * reply and whose model_metadata stamps the executing provider+model under
   * `executed`. The live runtime drives the CLI in-process and bypasses the worker,
   * so no job is enqueued and the assistant message is born complete.
   */
  async recordCompletedTurn(
    scopedDb: DataContextDb,
    threadId: string,
    userText: string,
    assistantReply: string,
    executed: { readonly provider: string; readonly model: string },
    opts?: CompletedTurnOptions,
    surface?: ChatSurface
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage } | undefined> {
    return this.writeCompletedTurn(
      scopedDb,
      threadId,
      userText,
      assistantReply,
      {
        executed: { provider: executed.provider, model: executed.model },
        ...(opts?.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
        ...(opts?.usage !== undefined ? { usage: opts.usage } : {})
      },
      opts,
      surface
    );
  }

  /**
   * Task 4.1 (#2901) — records a completed turn the classifier gate handled. The reply came from a
   * validated tool result or a code-written failure, so the assistant message carries the
   * gate-origin contract and NO `executed` provider/model and NO usage, which would be fiction.
   * Everything else (user message, freshness, activity, title/summary) is the normal path.
   */
  async recordGateCompletedTurn(
    scopedDb: DataContextDb,
    threadId: string,
    userText: string,
    assistantReply: string,
    origin: ChatTurnOriginV1,
    opts?: CompletedTurnOptions,
    surface?: ChatSurface
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage } | undefined> {
    return this.writeCompletedTurn(
      scopedDb,
      threadId,
      userText,
      assistantReply,
      { origin },
      opts,
      surface
    );
  }

  private async writeCompletedTurn(
    scopedDb: DataContextDb,
    threadId: string,
    userText: string,
    assistantReply: string,
    assistantModelMetadata: Record<string, unknown>,
    opts: CompletedTurnOptions | undefined,
    surface?: ChatSurface
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage } | undefined> {
    assertDataContextDb(scopedDb);

    // Match the live persistence path: lock the parent before the action-history lock.
    const thread = await scopedDb.db
      .selectFrom("app.chat_threads")
      .selectAll()
      .where("id", "=", threadId)
      .where("surface", "=", normalizeChatSurface(surface))
      .forUpdate()
      .executeTakeFirst();

    if (!thread) {
      return undefined;
    }
    if (thread.incognito) {
      return undefined;
    }

    await this.lockActionHistory(scopedDb, threadId);
    // #3128: the turn lands once, and its in-flight record goes in the same transaction so a
    // later restart can never also store it as interrupted. A turn another process already
    // stored as interrupted keeps its question, and the real reply follows the note.
    let landedQuestion: ChatMessage | undefined;
    if (opts?.turnId) {
      const landed = await this.findStoredTurn(scopedDb, threadId, opts.turnId);
      await deleteLiveTurn(scopedDb, opts.turnId);
      if (landed && landed.assistantMessage.tool_metadata.interruptedTurn !== true) return landed;
      landedQuestion = landed?.userMessage;
    }
    const turnIdentity = opts?.turnId ? { turnId: opts.turnId } : {};
    let activity = [...(opts?.activityRecords ?? opts?.actionResults ?? [])];
    let actionResults: readonly unknown[] = [...(opts?.actionResults ?? [])];
    const actionIds = new Set(activity.map(actionRecordId).filter((id): id is string => !!id));
    if (actionIds.size > 0) {
      const existing = await scopedDb.db
        .selectFrom("app.chat_messages")
        .where(visibleChatMessage())
        .selectAll()
        .where("thread_id", "=", threadId)
        .where("owner_user_id", "=", thread.owner_user_id)
        .where("role", "=", "assistant")
        .where((eb) =>
          eb.or(
            [...actionIds].map((id) => {
              const matching = JSON.stringify([{ actionRequestId: id }]);
              return sql<boolean>`(tool_metadata->'activity' @> ${matching}::jsonb OR tool_metadata->'actionResults' @> ${matching}::jsonb)`;
            })
          )
        )
        .execute();
      // A delayed result may also enter a newer live turn in the same conversation. Its
      // already-stored originating message keeps ownership; do not duplicate it on this reply.
      const alreadyStored = new Set(
        existing
          .filter((message) => message.tool_metadata.actionOutcomeOnly !== true)
          .flatMap((message) => [
            ...actionRecords(message.tool_metadata.activity),
            ...actionRecords(message.tool_metadata.actionResults)
          ])
          .map(actionRecordId)
          .filter((id): id is string => !!id && actionIds.has(id))
      );
      activity = activity.filter((entry) => !alreadyStored.has(actionRecordId(entry) ?? ""));
      actionResults = actionResults.filter(
        (entry) => !alreadyStored.has(actionRecordId(entry) ?? "")
      );
      for (const message of existing.filter(
        (entry) => entry.tool_metadata.actionOutcomeOnly === true
      )) {
        const records = actionRecords(message.tool_metadata.activity);
        if (
          records.length === 0 ||
          !records.every((entry) => actionIds.has(actionRecordId(entry) ?? ""))
        )
          continue;
        for (const entry of records) {
          // Only this repository creates these metadata-only terminal rows.
          const terminal = entry as TerminalActionRecord;
          if (!alreadyStored.has(terminal.actionRequestId)) {
            activity = mergeTerminalAction(activity, terminal);
            actionResults = mergeTerminalAction(actionResults, terminal).slice(0, 20);
          }
        }
        await scopedDb.db
          .updateTable("app.chat_messages")
          .set({
            tool_metadata: { ...message.tool_metadata, actionOutcomeHidden: true },
            updated_at: new Date()
          })
          .where("id", "=", message.id)
          .where("thread_id", "=", threadId)
          .where("owner_user_id", "=", thread.owner_user_id)
          .execute();
      }
    }
    const now = new Date();
    const userMessage =
      landedQuestion ??
      (await this.insertMessage(scopedDb, {
        thread,
        role: "user",
        status: "stored",
        body: userText,
        modelMetadata: {},
        toolMetadata: {
          selectedTools: [],
          ...turnIdentity,
          ...(opts?.meetingContext ? { meetingChatV1: opts.meetingContext } : {}),
          // #1133 — chip rendering in history; JSONB metadata only, bytes stay in the vault.
          ...(opts?.attachments?.length ? { attachments: opts.attachments } : {})
        },
        now
      }));
    const assistantMessage = await this.insertMessage(scopedDb, {
      thread,
      role: "assistant",
      status: "stored",
      body: assistantReply,
      modelMetadata: assistantModelMetadata,
      toolMetadata: {
        selectedTools: [],
        ...turnIdentity,
        ...(opts?.meetingContext ? { meetingChatV1: opts.meetingContext } : {}),
        ...(opts?.sourceFreshness ? { sourceFreshness: opts.sourceFreshness } : {}),
        ...(opts?.answerProvenance !== undefined
          ? { answerProvenanceV1: opts.answerProvenance }
          : {}),
        ...(actionResults.length ? { actionResults } : {}),
        ...(activity.length ? { activity } : {}),
        ...(opts?.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
        ...(opts?.usage !== undefined ? { usage: opts.usage } : {})
      },
      now
    });

    return { userMessage, assistantMessage };
  }

  /**
   * Publish a summary candidate with compare-and-swap on the covered frontier.
   *
   * Takes the actor/surface selection lock, then the thread row, matching every
   * other writer. The candidate lands only when the thread is still the owner's,
   * not private, at the expected revision and frontier, and the new frontier is a
   * visible message of this thread that sorts after the current frontier in
   * replay order. Activity time is never touched, so a publish cannot select the
   * thread.
   */
  async publishConversationSummary(
    scopedDb: DataContextDb,
    input: PublishConversationSummaryInput
  ): Promise<PublishConversationSummaryResult> {
    assertDataContextDb(scopedDb);
    const located = await scopedDb.db
      .selectFrom("app.chat_threads")
      .select("surface")
      .where("id", "=", input.threadId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
    if (!located) return "missing";

    await this.lockThreadSelection(scopedDb, normalizeChatSurface(located.surface));
    const thread = await scopedDb.db
      .selectFrom("app.chat_threads")
      .select(["incognito", "summary_revision", "summary_covered_through_message_id"])
      .where("id", "=", input.threadId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .forUpdate()
      .executeTakeFirst();
    if (!thread || thread.incognito) return "missing";
    if (
      thread.summary_revision !== input.expectedRevision ||
      thread.summary_covered_through_message_id !== input.expectedCoveredThroughMessageId
    ) {
      return "stale";
    }

    const frontier = await scopedDb.db
      .selectFrom("app.chat_messages")
      .select("id")
      .where(visibleChatMessage())
      .where("id", "=", input.throughMessageId)
      .where("thread_id", "=", input.threadId)
      .where(
        sql<boolean>`(
          not exists (
            select 1 from app.chat_messages prior
            where prior.id = ${input.expectedCoveredThroughMessageId}
              and prior.thread_id = ${input.threadId}
          )
          or (created_at, case when role = 'user' then 0 else 1 end, id) > (
            select prior.created_at, case when prior.role = 'user' then 0 else 1 end, prior.id
            from app.chat_messages prior
            where prior.id = ${input.expectedCoveredThroughMessageId}
              and prior.thread_id = ${input.threadId}
          )
        )`
      )
      .executeTakeFirst();
    if (!frontier) return "stale";

    await scopedDb.db
      .updateTable("app.chat_threads")
      .set({
        conversation_summary: input.summary,
        summary_covered_through_message_id: input.throughMessageId,
        summary_revision: input.expectedRevision + 1
      })
      .where("id", "=", input.threadId)
      .execute();
    return "published";
  }

  async updateThreadTitle(scopedDb: DataContextDb, threadId: string, title: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.chat_threads")
      .set({ title })
      .where("id", "=", threadId)
      .execute();
  }

  /**
   * Advances the owned thread past the surface's latest activity to select it.
   * The actor/surface lock orders this explicit resume with new chats and completions.
   */
  async touchThread(
    scopedDb: DataContextDb,
    threadId: string,
    surface?: ChatSurface
  ): Promise<ChatThread | undefined> {
    assertDataContextDb(scopedDb);
    const chatSurface = normalizeChatSurface(surface);
    await this.lockThreadSelection(scopedDb, chatSurface);
    return this.updateThreadActivity(scopedDb, threadId, chatSurface);
  }

  /** Refresh a completed bound turn without selecting it over a later new chat or resume. */
  async touchCurrentThread(
    scopedDb: DataContextDb,
    threadId: string,
    surface?: ChatSurface
  ): Promise<ChatThread | undefined> {
    assertDataContextDb(scopedDb);
    const chatSurface = normalizeChatSurface(surface);
    await this.lockThreadSelection(scopedDb, chatSurface);
    const current = await scopedDb.db
      .selectFrom("app.chat_threads")
      .select("id")
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("surface", "=", chatSurface)
      .orderBy("last_active_at", "desc")
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
    if (current?.id !== threadId) return undefined;
    return this.updateThreadActivity(scopedDb, threadId, chatSurface);
  }

  private async lockThreadSelection(scopedDb: DataContextDb, surface: ChatSurface): Promise<void> {
    // New-thread selection, explicit resume and bound completion use the same transaction
    // lock before touching thread rows. The timestamp is generated only after this lock.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'chat:thread-selection:' || app.current_actor_user_id()::text || ':' || ${surface}, 0
    ))`.execute(scopedDb.db);
  }

  private nextThreadActivity(surface: ChatSurface) {
    return sql<Date>`greatest(clock_timestamp(), (
      SELECT max(last_active_at) + interval '1 microsecond' FROM app.chat_threads
      WHERE owner_user_id = app.current_actor_user_id() AND surface = ${surface}
    ))`;
  }

  private updateThreadActivity(scopedDb: DataContextDb, threadId: string, surface: ChatSurface) {
    return scopedDb.db
      .updateTable("app.chat_threads")
      .set({ last_active_at: this.nextThreadActivity(surface) })
      .where("id", "=", threadId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("surface", "=", surface)
      .returningAll()
      .executeTakeFirst();
  }

  async deleteThread(scopedDb: DataContextDb, threadId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db.deleteFrom("app.chat_threads").where("id", "=", threadId).execute();
  }

  /**
   * Stored, non-incognito user/assistant messages within a UTC instant range, for the chat
   * archive job. Ordered by each thread's own first message time, then by message time within
   * the thread — the caller groups consecutive rows sharing threadId into one archive session.
   */
  async listStoredMessagesInRange(
    scopedDb: DataContextDb,
    actorUserId: string,
    rangeStartUtcIso: string,
    rangeEndUtcIso: string
  ): Promise<
    Array<{
      threadId: string;
      threadTitle: string;
      threadFirstMessageAt: string;
      role: "user" | "assistant";
      body: string;
      createdAt: string;
    }>
  > {
    assertDataContextDb(scopedDb);

    const rows = await scopedDb.db
      .selectFrom("app.chat_messages as m")
      .where(visibleChatMessage("m"))
      .innerJoin("app.chat_threads as t", "t.id", "m.thread_id")
      .select([
        "m.thread_id as threadId",
        "t.title as threadTitle",
        sql<Date>`min(m.created_at) over (partition by m.thread_id)`.as("threadFirstMessageAt"),
        "m.role as role",
        "m.body as body",
        "m.created_at as createdAt"
      ])
      .where("t.incognito", "=", false)
      // Meeting-derived text is scoped evidence, not input to general chat archives or memory.
      .where("t.surface", "not like", "mtg-%")
      .where("m.owner_user_id", "=", actorUserId)
      .where("m.status", "=", "stored")
      .where("m.role", "in", ["user", "assistant"])
      .where("m.created_at", ">=", new Date(rangeStartUtcIso))
      .where("m.created_at", "<=", new Date(rangeEndUtcIso))
      .orderBy("threadFirstMessageAt")
      .orderBy("m.created_at")
      .orderBy(sql<number>`CASE WHEN m.role = 'user' THEN 0 ELSE 1 END`)
      .orderBy("m.id")
      .execute();

    return rows.map((row) => ({
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      threadFirstMessageAt: toIsoString(row.threadFirstMessageAt),
      role: row.role as "user" | "assistant",
      body: row.body,
      createdAt: toIsoString(row.createdAt)
    }));
  }
}
