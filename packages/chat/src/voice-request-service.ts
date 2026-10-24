import type { ChatVoiceRequestCursor } from "@moss/shared";
import {
  readScopedActorUserId,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import { ChatRepository } from "./repository.js";
import {
  VoiceRequestRepository,
  voiceNeedsConfirmation,
  type VoiceRequestInput
} from "./voice-requests.js";

export interface VoiceRequestDependencies {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly bootId: string;
  readonly now: () => Date;
  assertAvailable(actor: AccessContext): Promise<void>;
  schedule(
    db: DataContextDb,
    actor: AccessContext,
    id: string,
    delaySeconds?: number
  ): Promise<void>;
  submit(
    actor: AccessContext,
    request: {
      readonly transcript: string;
      readonly threadId: string;
      readonly turnId: string;
    },
    claim: () => Promise<boolean>
  ): Promise<"deferred" | "unclaimed" | "executed">;
}

/** Chat owns persistence and admission. Transcription stays behind the receiver's public API. */
export class VoiceRequestService {
  private readonly requests = new VoiceRequestRepository();
  private readonly chat = new ChatRepository();
  constructor(private readonly deps: VoiceRequestDependencies) {}

  async admit(actor: AccessContext, input: VoiceRequestInput) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, (db) => this.reserve(db, actor, input));
  }

  /** Join the receiver's transcript transaction. Dispatch rechecks availability before effects. */
  async admitInTransaction(db: DataContextDb, input: VoiceRequestInput) {
    const actorUserId = await readScopedActorUserId(db);
    if (!actorUserId) throw new Error("Voice admission requires an owner context");
    return this.reserve(db, { actorUserId }, input);
  }

  private async reserve(db: DataContextDb, actor: AccessContext, input: VoiceRequestInput) {
    const main = await this.chat.ensureMainThread(db, actor.actorUserId);
    const admission = await this.requests.admit(db, main.id, input, this.deps.now());
    if (admission.created && admission.request.state === "queued")
      await this.deps.schedule(db, actor, admission.request.id);
    return admission;
  }

  async list(actor: AccessContext, before?: ChatVoiceRequestCursor) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, (db) => this.requests.list(db, before));
  }

  async status(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, (db) => this.requests.get(db, id));
  }

  async send(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      const row = await this.requests.confirm(db, id, this.deps.now());
      if (row?.state === "queued") await this.deps.schedule(db, actor, id);
      return row;
    });
  }

  async process(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    const row = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const current = await this.requests.get(db, id, true);
      if (current?.state === "dispatching" && current.dispatch_boot_id !== this.deps.bootId) {
        // Canonical turn completion commits the receipt with its reserved message pair.
        // Anything left dispatching after another boot is ambiguous, including gate effects.
        await this.requests.interrupt(db, id, this.deps.now());
        return undefined;
      }
      if (current?.state === "queued" && voiceNeedsConfirmation(current, this.deps.now())) {
        await db.db
          .updateTable("app.chat_voice_requests")
          .set({ state: "ready-to-send", updated_at: this.deps.now() })
          .where("id", "=", id)
          .execute();
        return undefined;
      }
      return current?.state === "queued" ? current : undefined;
    });
    if (!row) return;
    try {
      const result = await this.deps.submit(
        actor,
        {
          transcript: row.transcript,
          threadId: row.thread_id,
          turnId: row.turn_id
        },
        async () => {
          await this.deps.assertAvailable(actor);
          return this.deps.dataContext.withDataContext(actor, async (db) =>
            Boolean(await this.requests.claim(db, id, this.deps.bootId, this.deps.now()))
          );
        }
      );
      await this.deps.dataContext.withDataContext(actor, async (db) => {
        if (result === "deferred") {
          const current = await this.requests.get(db, id, true);
          if (current?.state === "queued") await this.deps.schedule(db, actor, id, 15);
        } else if (result === "executed") {
          // A stopped/refused turn or failed save may return normally without a saved reply.
          await this.requests.interrupt(db, id, this.deps.now());
        }
      });
    } catch (error) {
      // Only queued work is retryable. A dispatch of uncertain outcome stays interrupted.
      await this.deps.dataContext.withDataContext(actor, (db) =>
        this.requests.interrupt(db, id, this.deps.now())
      );
      throw error;
    }
  }
}
