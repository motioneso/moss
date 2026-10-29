import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  assertDataContextDb,
  isUuid,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import type {
  ChatModuleNoticeOriginV1,
  ModuleNoticeActionReference,
  ModuleNoticeSource
} from "@moss/shared";
import type { BackgroundMessage } from "./live/background-message-routing.js";
import { ChatRepository } from "./repository.js";
import { readOrigin, asRecord } from "./route-serializers.js";
import { notifyStoredMessageArrival, type StoredMessageArrival } from "./stored-message-arrival.js";

export const MODULE_NOTICE_ARRIVAL_CHANNEL = "moss_chat_module_notice_arrival";

/** Temporary module unavailability retains the source intent for a later Main read. */
export class ModuleNoticeUnavailableError extends Error {}

export interface ModuleNoticeContent {
  /** Rendered by trusted host code from the current owning record. */
  readonly text: string;
  readonly actions: readonly ModuleNoticeActionReference[];
}

/** Only the host registers definitions. Modules submit source intent, never message content. */
export interface ModuleNoticeDefinition {
  readonly moduleId: string;
  readonly noticeKind: string;
  readonly actionNames: readonly string[];
  /** Holds source admission/current revision through the callback's short transaction. */
  withCurrentSource<T>(
    access: AccessContext,
    source: ModuleNoticeSource,
    work: (db: DataContextDb, content: ModuleNoticeContent) => Promise<T>
  ): Promise<T | undefined>;
}

export type ModuleNoticeResult =
  | {
      readonly state: "stored" | "duplicate";
      readonly noticeId: string;
      readonly messageId: string;
      readonly threadId: string;
    }
  | { readonly state: "stale" | "no_main" };

interface NoticeRow {
  readonly id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly module_id: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly notice_kind: string;
  readonly actions: readonly ModuleNoticeActionReference[];
}

function bounded(value: string, max: number): boolean {
  return (
    value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max && !value.includes("\0")
  );
}

function validSource(source: ModuleNoticeSource): boolean {
  return (
    /^[a-z][a-z0-9_-]{0,79}$/.test(source.moduleId) &&
    isUuid(source.sourceId) &&
    bounded(source.sourceVersion, 160) &&
    /^[a-z][a-z0-9_-]{0,79}$/.test(source.noticeKind)
  );
}

function validateContent(
  source: ModuleNoticeSource,
  definition: ModuleNoticeDefinition,
  content: ModuleNoticeContent
): void {
  if (!bounded(content.text, 8192) || content.actions.length > 4)
    throw new Error("Invalid module notice content");
  const names = new Set<string>();
  for (const action of content.actions) {
    if (
      !definition.actionNames.includes(action.toolName) ||
      names.has(action.toolName) ||
      !bounded(action.label, 120) ||
      action.sourceId !== source.sourceId ||
      action.sourceVersion !== source.sourceVersion
    )
      throw new Error("Invalid module notice action reference");
    names.add(action.toolName);
  }
}

/** Chat alone chooses Main and reserves stored message IDs, under current source authority. */
export class ModuleNoticeService {
  private readonly definitions = new Map<string, ModuleNoticeDefinition>();
  constructor(
    private readonly runner: DataContextRunner,
    definitions: readonly ModuleNoticeDefinition[],
    private readonly chat = new ChatRepository()
  ) {
    for (const definition of definitions) {
      const key = `${definition.moduleId}:${definition.noticeKind}`;
      if (this.definitions.has(key)) throw new Error("Duplicate module notice definition");
      this.definitions.set(key, definition);
    }
  }

  /** Trusted composition reserves IDs in the same transaction as its source output and job. */
  async reservePendingScoped(
    access: AccessContext,
    db: DataContextDb,
    source: ModuleNoticeSource
  ): Promise<void> {
    assertDataContextDb(db);
    if (!validSource(source) || !this.definitions.has(`${source.moduleId}:${source.noticeKind}`))
      throw new Error("Undeclared module notice source");
    await sql`insert into app.chat_module_notice_intents
      (owner_user_id,module_id,source_id,source_version,notice_kind)
      values (${access.actorUserId}::uuid,${source.moduleId},${source.sourceId}::uuid,${source.sourceVersion},${source.noticeKind})
      on conflict do nothing`.execute(db.db);
  }

  private async discardPending(
    db: DataContextDb,
    access: AccessContext,
    source: ModuleNoticeSource
  ): Promise<void> {
    await sql`delete from app.chat_module_notice_intents where owner_user_id=${access.actorUserId}::uuid
      and module_id=${source.moduleId} and source_id=${source.sourceId}::uuid
      and source_version=${source.sourceVersion} and notice_kind=${source.noticeKind}`.execute(
      db.db
    );
  }

  /** Queue exhaustion cannot consume intent; an ordinary Main read retries a bounded batch. */
  async recoverPending(access: AccessContext): Promise<void> {
    const pending = await this.runner.withDataContext(access, async (db) => {
      const main = await this.chat.getMainThread(db, access.actorUserId);
      if (!main || main.incognito || main.surface !== "drawer") return [];
      return (
        await sql<{
          module_id: string;
          source_id: string;
          source_version: string;
          notice_kind: string;
        }>`
        select module_id,source_id,source_version,notice_kind from app.chat_module_notice_intents
        where owner_user_id=${access.actorUserId}::uuid order by created_at,source_id limit 100`.execute(
          db.db
        )
      ).rows;
    });
    for (const row of pending) {
      const source = {
        moduleId: row.module_id,
        sourceId: row.source_id,
        sourceVersion: row.source_version,
        noticeKind: row.notice_kind
      };
      try {
        const result = await this.publish(access, source);
        if (result.state === "stale")
          await this.runner.withDataContext(access, (db) =>
            this.discardPending(db, access, source)
          );
      } catch {
        // Storage or module availability can recover on the next read; retain the intent.
      }
    }
  }

  async publish(access: AccessContext, source: ModuleNoticeSource): Promise<ModuleNoticeResult> {
    if (!validSource(source)) throw new Error("Invalid module notice source");
    const definition = this.definitions.get(`${source.moduleId}:${source.noticeKind}`);
    if (!definition) throw new Error("Undeclared module notice");
    const result = await definition.withCurrentSource<ModuleNoticeResult>(
      access,
      source,
      async (db, content) => {
        assertDataContextDb(db);
        validateContent(source, definition, content);
        await this.reservePendingScoped(access, db, source);
        // Source admission precedes Chat selection; no model, provider, or nested service transaction.
        await this.chat.lockThreadSelection(db);
        const main = await this.chat.getMainThread(db, access.actorUserId);
        if (!main || main.incognito || main.owner_user_id !== access.actorUserId)
          return { state: "no_main" };
        const target = await db.db
          .selectFrom("app.chat_threads")
          .select("id")
          .where("id", "=", main.id)
          .where("owner_user_id", "=", access.actorUserId)
          .where("is_main", "=", true)
          .where("incognito", "=", false)
          .where("surface", "=", "drawer")
          .forShare()
          .executeTakeFirst();
        if (!target) return { state: "no_main" };
        const existing = await sql<NoticeRow>`select * from app.chat_module_notices
        where owner_user_id = ${access.actorUserId}::uuid and module_id = ${source.moduleId}
        and source_id = ${source.sourceId}::uuid and source_version = ${source.sourceVersion}
        and notice_kind = ${source.noticeKind}`.execute(db.db);
        const duplicate = existing.rows[0];
        if (duplicate) {
          await this.discardPending(db, access, source);
          return {
            state: "duplicate",
            noticeId: duplicate.id,
            messageId: duplicate.message_id,
            threadId: duplicate.thread_id
          };
        }
        const noticeId = randomUUID(),
          messageId = randomUUID(),
          now = new Date();
        const origin: ChatModuleNoticeOriginV1 = {
          version: 1,
          kind: "module_notice",
          noticeId,
          ...source,
          actions: content.actions
        };
        await sql`insert into app.chat_module_notices
        (id, owner_user_id, module_id, source_id, source_version, notice_kind, thread_id, message_id, actions, created_at)
        values (${noticeId}::uuid, ${access.actorUserId}::uuid, ${source.moduleId}, ${source.sourceId}::uuid,
          ${source.sourceVersion}, ${source.noticeKind}, ${target.id}::uuid, ${messageId}::uuid,
          ${JSON.stringify(content.actions)}::jsonb, ${now})`.execute(db.db);
        await this.chat.insertReservedAssistantMessage(db, {
          id: messageId,
          threadId: target.id,
          body: content.text,
          origin,
          now
        });
        await notifyStoredMessageArrival(db, MODULE_NOTICE_ARRIVAL_CHANNEL, {
          actorUserId: access.actorUserId,
          threadId: target.id,
          messageId
        });
        await this.discardPending(db, access, source);
        return { state: "stored", noticeId, messageId, threadId: target.id };
      }
    );
    return result ?? { state: "stale" };
  }

  /** Notification IDs carry no authority; reload stored owner/Main/ledger/provenance every time. */
  async readArrival(
    access: AccessContext,
    arrival: StoredMessageArrival
  ): Promise<BackgroundMessage | undefined> {
    if (
      access.actorUserId !== arrival.actorUserId ||
      !isUuid(arrival.messageId) ||
      !isUuid(arrival.threadId)
    )
      return undefined;
    // Discover the registered source through an owning read; actual delivery rechecks in its source transaction.
    // The caller supplies the actor-scoped runner so notification actors cannot select raw DB handles.
    try {
      return await this.readAdmittedArrival(access, arrival);
    } catch (error) {
      if (error instanceof ModuleNoticeUnavailableError) return undefined;
      throw error;
    }
  }

  private async readAdmittedArrival(
    access: AccessContext,
    arrival: StoredMessageArrival
  ): Promise<BackgroundMessage | undefined> {
    const initial = await this.runner.withDataContext(access, async (db) => {
      const found = await sql<NoticeRow>`select * from app.chat_module_notices
        where owner_user_id = ${access.actorUserId}::uuid and message_id = ${arrival.messageId}::uuid
          and thread_id = ${arrival.threadId}::uuid`.execute(db.db);
      return found.rows[0];
    });
    if (!initial) return undefined;
    const source: ModuleNoticeSource = {
      moduleId: initial.module_id,
      sourceId: initial.source_id,
      sourceVersion: initial.source_version,
      noticeKind: initial.notice_kind
    };
    const definition = this.definitions.get(`${source.moduleId}:${source.noticeKind}`);
    if (!definition || !validSource(source)) return undefined;
    return definition.withCurrentSource(access, source, async (db) => {
      assertDataContextDb(db);
      const found = await sql<NoticeRow>`select * from app.chat_module_notices
        where owner_user_id = ${access.actorUserId}::uuid and id = ${initial.id}::uuid
          and message_id = ${arrival.messageId}::uuid and thread_id = ${arrival.threadId}::uuid
          and module_id = ${source.moduleId} and source_id = ${source.sourceId}::uuid
          and source_version = ${source.sourceVersion} and notice_kind = ${source.noticeKind}`.execute(
        db.db
      );
      const current = found.rows[0];
      if (!current) return undefined;
      const target = await this.chat.getOwnedThreadById(db, access.actorUserId, arrival.threadId);
      if (
        !target ||
        !target.is_main ||
        target.surface !== "drawer" ||
        target.incognito ||
        target.owner_user_id !== access.actorUserId
      )
        return undefined;
      const message = await this.chat.getMessageById(db, arrival.messageId);
      if (
        !message ||
        message.owner_user_id !== access.actorUserId ||
        message.thread_id !== target.id ||
        message.role !== "assistant" ||
        message.status !== "stored"
      )
        return undefined;
      const origin = readOrigin(asRecord(message.model_metadata).origin);
      // JSONB canonicalizes object key order. Parse both origins before comparison.
      const expected = readOrigin({
        version: 1,
        kind: "module_notice",
        noticeId: current.id,
        ...source,
        actions: current.actions
      });
      if (
        origin?.kind !== "module_notice" ||
        expected?.kind !== "module_notice" ||
        JSON.stringify(origin) !== JSON.stringify(expected)
      )
        return undefined;
      return {
        actorUserId: access.actorUserId,
        threadId: target.id,
        record: {
          kind: "reply",
          text: message.body,
          messageId: message.id,
          background: true,
          backgroundThreadId: target.id,
          origin
        }
      };
    });
  }
}
