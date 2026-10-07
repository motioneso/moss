import { randomUUID } from "node:crypto";
import type { DataContextRunner } from "@moss/db";
import type { AiRepository } from "../repository.js";
import { expireActionRequest } from "./action-request-lifecycle.js";
import { emitActionResultRecord } from "./action-result-record.js";
import { reportActionRecordFailure } from "./action-record-diagnostics.js";
import type { SessionNotifier } from "./types.js";

interface RecoveryDeps {
  readonly runner: DataContextRunner;
  readonly repository: Pick<
    AiRepository,
    | "listRecoverableAssistantActions"
    | "nextAssistantActionExpiry"
    | "expireAssistantAction"
    | "getAssistantAction"
    | "resolveAssistantAction"
  >;
  readonly notifier: SessionNotifier;
}

/** Recovery starts when the owner opens chat, with one bounded batch/timer per owner. */
export class ActionRequestRecovery {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly retryDelay = new Map<string, number>();
  private readonly lastBatch = new Map<string, string>();
  private readonly historyCursor = new Map<string, string>();
  private disposed = false;
  private readonly loggedFailures = new Set<string>();
  constructor(private readonly deps: RecoveryDeps) {}

  recover(actorUserId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const running = this.running.get(actorUserId);
    if (running) return running;
    const timer = this.timers.get(actorUserId);
    if (timer) clearTimeout(timer);
    this.timers.delete(actorUserId);
    const work = this.sweep(actorUserId)
      .catch((error: unknown) => {
        this.logFailure(actorUserId);
        this.schedule(actorUserId, this.backoff(actorUserId));
        throw error;
      })
      .finally(() => {
        this.running.delete(actorUserId);
      });
    this.running.set(actorUserId, work);
    return work;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.retryDelay.clear();
    this.lastBatch.clear();
    this.historyCursor.clear();
    this.loggedFailures.clear();
  }

  private async sweep(actorUserId: string): Promise<void> {
    const access = { actorUserId, requestId: `action-recovery_${randomUUID()}` };
    const cursor = this.historyCursor.get(actorUserId);
    const rows = await this.deps.runner.withDataContext(access, (db) =>
      this.deps.repository.listRecoverableAssistantActions(db, 50, cursor)
    );
    const futureExpiry = await this.deps.runner.withDataContext(access, (db) =>
      this.deps.repository.nextAssistantActionExpiry(db)
    );
    this.loggedFailures.delete(actorUserId);
    this.retryDelay.delete(actorUserId);
    const pending = rows.filter((row) => row.status === "pending");
    const history = rows.filter((row) => row.status === "timed_out");
    const expiryKey = `expiry:${actorUserId}`;
    const historyKey = `history:${actorUserId}`;
    const batch = pending.map((row) => row.id).join(",");
    if (this.lastBatch.get(actorUserId) !== batch) this.retryDelay.delete(expiryKey);
    this.lastBatch.set(actorUserId, batch);
    let nextDeadline = pending.length > 0 ? Date.now() + this.backoff(expiryKey) : Infinity;
    // Expiry has its own half of the budget. Failed history pages rotate independently,
    // so neither fifty old failures nor private/deleted origins can starve a later deadline.
    if (history.length === 25) {
      this.historyCursor.set(actorUserId, history.at(-1)!.id);
      nextDeadline = Math.min(nextDeadline, Date.now() + 1000);
    } else {
      this.historyCursor.delete(actorUserId);
      if (history.length > 0 || cursor)
        nextDeadline = Math.min(nextDeadline, Date.now() + this.backoff(historyKey));
      else this.retryDelay.delete(historyKey);
    }
    if (pending.length === 0) {
      this.lastBatch.delete(actorUserId);
      this.retryDelay.delete(expiryKey);
    }
    if (futureExpiry) nextDeadline = Math.min(nextDeadline, new Date(futureExpiry).getTime());
    for (const row of rows) {
      try {
        const recovered =
          row.status === "timed_out"
            ? { changed: false, action: row }
            : await expireActionRequest(this.deps, access, row.id);
        const { action } = recovered;
        if (action?.status === "timed_out" && action.chat_thread_id && action.chat_session_id) {
          emitActionResultRecord(this.deps.notifier, action.chat_session_id, {
            actionRequestId: action.id,
            originThreadId: action.chat_thread_id,
            ...(!recovered.changed ? { historyOnly: true } : {}),
            toolName: action.tool_name,
            outcome: "denied",
            decidedBy: "timeout",
            reason: "Action timed out."
          });
          await this.deps.notifier.flush?.(action.chat_session_id);
        }
      } catch {
        this.logFailure(actorUserId, row.id);
      }
    }
    if (Number.isFinite(nextDeadline)) this.schedule(actorUserId, nextDeadline - Date.now());
  }

  private backoff(actorUserId: string): number {
    const delay = this.retryDelay.get(actorUserId) ?? 1000;
    this.retryDelay.set(actorUserId, Math.min(delay * 2, 60_000));
    return delay;
  }

  private logFailure(actorUserId: string, actionRequestId?: string): void {
    if (actionRequestId) {
      reportActionRecordFailure(actionRequestId);
      return;
    }
    if (this.loggedFailures.has(actorUserId)) return;
    this.loggedFailures.add(actorUserId);
    // Never log the error object: database and transport failures can contain private content.
    reportActionRecordFailure(`action-recovery_${randomUUID()}`);
  }

  private schedule(actorUserId: string, delayMs: number): void {
    if (this.disposed) return;
    const previous = this.timers.get(actorUserId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(
      () => {
        this.timers.delete(actorUserId);
        void this.recover(actorUserId).catch(() => {});
      },
      Math.max(1, Math.min(delayMs, 2_147_483_647))
    );
    timer.unref?.();
    this.timers.set(actorUserId, timer);
  }
}
