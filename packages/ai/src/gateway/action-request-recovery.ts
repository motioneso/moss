import { randomUUID } from "node:crypto";
import type { DataContextRunner } from "@moss/db";
import type { AiRepository } from "../repository.js";
import { expireActionRequest } from "./action-request-lifecycle.js";
import { emitActionResultRecord } from "./action-result-record.js";
import type { SessionNotifier } from "./types.js";

interface RecoveryDeps {
  readonly runner: DataContextRunner;
  readonly repository: Pick<
    AiRepository,
    | "listAssistantActions"
    | "expireAssistantAction"
    | "getAssistantAction"
    | "resolveAssistantAction"
  >;
  readonly notifier: SessionNotifier;
}

/** One next-deadline timer per authenticated owner; no cross-owner maintenance reads. */
export class ActionRequestRecovery {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private disposed = false;
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
        this.schedule(actorUserId, 1000);
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
  }

  private async sweep(actorUserId: string): Promise<void> {
    const access = { actorUserId, requestId: `action-recovery_${randomUUID()}` };
    const rows = await this.deps.runner.withDataContext(access, (db) =>
      this.deps.repository.listAssistantActions(db)
    );
    let nextDeadline = Infinity;
    for (const row of rows) {
      if (row.status === "timed_out" && row.chat_thread_id && row.chat_session_id) {
        emitActionResultRecord(this.deps.notifier, row.chat_session_id, {
          actionRequestId: row.id,
          originThreadId: row.chat_thread_id,
          historyOnly: true,
          toolName: row.tool_name,
          outcome: "denied",
          decidedBy: "timeout",
          reason: "Action timed out."
        });
        await this.deps.notifier.flush?.(row.chat_session_id);
        continue;
      }
      if (row.status !== "pending" || !row.expires_at) continue;
      const deadline = new Date(row.expires_at).getTime();
      if (deadline > Date.now()) {
        nextDeadline = Math.min(nextDeadline, deadline);
        continue;
      }
      const { changed, action } = await expireActionRequest(this.deps, access, row.id);
      if (changed && action?.chat_thread_id && action.chat_session_id) {
        emitActionResultRecord(this.deps.notifier, action.chat_session_id, {
          actionRequestId: action.id,
          originThreadId: action.chat_thread_id,
          toolName: action.tool_name,
          outcome: "denied",
          decidedBy: "timeout",
          reason: "Action timed out."
        });
        await this.deps.notifier.flush?.(action.chat_session_id);
      } else if (action?.status === "pending")
        nextDeadline = Math.min(nextDeadline, Date.now() + 1000);
    }
    if (Number.isFinite(nextDeadline)) this.schedule(actorUserId, nextDeadline - Date.now());
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
