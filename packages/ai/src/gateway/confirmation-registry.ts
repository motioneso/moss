export type ResolutionStatus = "confirmed" | "rejected" | "cancelled";
export type AwaitOutcome = ResolutionStatus | "timeout";

interface Waiter {
  readonly sessionId?: string;
  readonly settle: (outcome: AwaitOutcome) => void;
}

/**
 * Bridges the synchronous blocked tool call to the asynchronous human Approve/Deny.
 * In-memory only: a server restart mid-wait orphans the call (accepted cost).
 */
export class ConfirmationRegistry {
  private readonly waiters = new Map<string, Waiter>();
  private readonly completions = new Map<string, () => void>();
  private readonly cancelledSessions = new Set<string>();

  awaitResolution(
    actionRequestId: string,
    timeoutMs: number,
    sessionId?: string
  ): Promise<AwaitOutcome> {
    return new Promise<AwaitOutcome>((resolve) => {
      if (sessionId && this.cancelledSessions.has(sessionId)) {
        resolve("cancelled");
        return;
      }

      const timer = setTimeout(() => {
        this.waiters.delete(actionRequestId);
        resolve("timeout");
      }, timeoutMs);

      this.waiters.set(actionRequestId, {
        sessionId,
        settle: (outcome) => {
          clearTimeout(timer);
          this.waiters.delete(actionRequestId);
          resolve(outcome);
        }
      });
    });
  }

  /** Cancel every live ACP ask belonging to a stopped agent session. */
  cancelSession(sessionId: string): number {
    this.cancelledSessions.add(sessionId);
    let cancelled = 0;
    for (const waiter of this.waiters.values()) {
      if (waiter.sessionId !== sessionId) continue;
      waiter.settle("cancelled");
      cancelled += 1;
    }
    return cancelled;
  }

  /** Allow permission asks from the next turn on a previously stopped session. */
  beginTurn(sessionId: string): void {
    this.cancelledSessions.delete(sessionId);
  }

  /**
   * Settle the still-blocked call for this action, if one is live. Returns true when a
   * live waiter was found and unblocked, false when none was (the call already timed out,
   * was already resolved, or the server restarted mid-wait). The caller uses the false
   * return to avoid recording a "confirmed" that can never execute (drawer/DB divergence).
   * Fire-and-forget: use `resolveAndAwaitCompletion` when the caller needs to know the woken
   * call has actually finished, not just been signalled.
   */
  resolve(actionRequestId: string, status: ResolutionStatus): boolean {
    const waiter = this.waiters.get(actionRequestId);
    if (!waiter) return false;
    waiter.settle(status);
    return true;
  }

  /**
   * Wake the still-blocked call for this action, if one is live, then wait for it to report
   * back via markDone (#2149: closes the window between "confirmed" being persisted and the
   * tool's write actually landing — the caller now only learns "resolved" once the woken call
   * has fully finished handling the outcome, not merely been signalled). Resolves to false
   * immediately, with no wait, when no live waiter existed — same case `resolve()` covers.
   */
  async resolveAndAwaitCompletion(
    actionRequestId: string,
    status: ResolutionStatus
  ): Promise<boolean> {
    const waiter = this.waiters.get(actionRequestId);
    if (!waiter) return false;

    const completion = new Promise<void>((resolveCompletion) => {
      this.completions.set(actionRequestId, resolveCompletion);
    });
    waiter.settle(status);
    await completion;
    return true;
  }

  /**
   * Called by the woken call once it has fully finished handling the outcome (denied path or
   * confirmed-and-executed path). A no-op if nothing is waiting on this id.
   */
  markDone(actionRequestId: string): void {
    const resolveCompletion = this.completions.get(actionRequestId);
    if (!resolveCompletion) return;
    this.completions.delete(actionRequestId);
    resolveCompletion();
  }

  /** True while a call is still blocked awaiting resolution for this action. */
  isAwaiting(actionRequestId: string): boolean {
    return this.waiters.has(actionRequestId);
  }
}
