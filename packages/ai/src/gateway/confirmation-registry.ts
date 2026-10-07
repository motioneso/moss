import type { GatewaySessionRecord } from "./types.js";
import { reportActionRecordFailure } from "./action-record-diagnostics.js";

export type ResolutionStatus = "confirmed" | "rejected" | "cancelled";
export type AwaitOutcome = ResolutionStatus | "timeout";

interface Completion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface Waiter {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly settle: (outcome: AwaitOutcome) => void;
  readonly cancel: () => void;
  readonly outcome: () => AwaitOutcome | undefined;
}

const TERMINAL_WRITE_ATTEMPTS = 3;
const TERMINAL_WRITE_BUDGET_MS = 3_000;

/**
 * Bridges the synchronous blocked tool call to the asynchronous human Approve/Deny.
 * In-memory only: a server restart mid-wait orphans the call (accepted cost).
 */
export class ConfirmationRegistry {
  private readonly waiters = new Map<string, Waiter>();
  private readonly completions = new Map<string, Completion>();
  private readonly activeTurns = new Map<string, string>();
  private readonly cancelledTurns = new Set<string>();
  private readonly presentations = new Map<
    string,
    { actorUserId: string; record: Extract<GatewaySessionRecord, { kind: "action_request" }> }
  >();

  storePresentation(
    actorUserId: string,
    record: Extract<GatewaySessionRecord, { kind: "action_request" }>
  ): void {
    if (this.isAwaiting(record.actionRequestId))
      this.presentations.set(record.actionRequestId, {
        actorUserId,
        record: structuredClone(record)
      });
  }

  getPresentation(
    actorUserId: string,
    actionRequestId: string
  ): Extract<GatewaySessionRecord, { kind: "action_request" }> | undefined {
    const saved = this.presentations.get(actionRequestId);
    const complete =
      typeof saved?.record.summary === "string" &&
      saved.record.summary.trim() &&
      (!saved.record.requiresTarget || saved.record.details?.target?.trim());
    return saved?.actorUserId === actorUserId && complete && this.isAwaiting(actionRequestId)
      ? structuredClone(saved.record)
      : undefined;
  }

  awaitResolution(
    actionRequestId: string,
    timeoutMs: number,
    sessionId?: string,
    turnId?: string,
    persistTerminal?: (outcome: "timeout" | "cancelled") => Promise<AwaitOutcome>
  ): Promise<AwaitOutcome> {
    return new Promise<AwaitOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let terminalDeadline: ReturnType<typeof setTimeout> | undefined;
      let writing = false;
      let cancelling = false;
      let attempts = 0;
      let settledOutcome: AwaitOutcome | undefined;
      const fallBack = () => {
        if (this.waiters.get(actionRequestId) !== waiter) return;
        // Only identifiers: storage errors can contain SQL, inputs or private content.
        reportActionRecordFailure(actionRequestId);
        waiter.settle(cancelling ? "cancelled" : "timeout");
      };
      const persist = (outcome: "timeout" | "cancelled") => {
        if (outcome === "cancelled") cancelling = true;
        clearTimeout(timer);
        if (writing || this.waiters.get(actionRequestId) !== waiter) return;
        if (!persistTerminal) {
          waiter.settle(outcome);
          return;
        }
        if (!terminalDeadline) {
          // Bound a hung write as well as repeated failures; no storage outage may pin a model.
          terminalDeadline = setTimeout(fallBack, TERMINAL_WRITE_BUDGET_MS);
          terminalDeadline.unref?.();
        }
        writing = true;
        attempts += 1;
        void Promise.resolve()
          .then(() => persistTerminal(outcome))
          .then(
            (terminal) => {
              writing = false;
              if (this.waiters.get(actionRequestId) === waiter) waiter.settle(terminal);
            },
            () => {
              writing = false;
              if (this.waiters.get(actionRequestId) !== waiter) return;
              if (attempts >= TERMINAL_WRITE_ATTEMPTS) {
                fallBack();
                return;
              }
              // A short retry window lets a concurrently committed decision be observed.
              // Exhaustion settles only a refusal, never grants execution.
              timer = setTimeout(() => persist(cancelling ? "cancelled" : "timeout"), 1000);
              timer.unref?.();
            }
          );
      };
      const waiter: Waiter = {
        sessionId,
        turnId,
        outcome: () => settledOutcome,
        settle: (outcome) => {
          if (this.waiters.get(actionRequestId) !== waiter) return;
          settledOutcome = outcome;
          clearTimeout(timer);
          if (terminalDeadline) clearTimeout(terminalDeadline);
          this.waiters.delete(actionRequestId);
          this.presentations.delete(actionRequestId);
          resolve(outcome);
        },
        cancel: () => persist("cancelled")
      };
      this.waiters.set(actionRequestId, waiter);
      timer = setTimeout(() => persist("timeout"), timeoutMs);
      timer.unref?.();
      if (turnId && this.cancelledTurns.has(turnId)) waiter.cancel();
    });
  }

  /** Cancel every live ACP ask belonging to the active turn of a stopped session. */
  cancelSession(sessionId: string): number {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return 0;
    this.cancelledTurns.add(turnId);
    let cancelled = 0;
    for (const waiter of this.waiters.values()) {
      if (waiter.turnId !== turnId) continue;
      waiter.cancel();
      cancelled += 1;
    }
    return cancelled;
  }

  /** Set the identity used to cancel asks from this turn. */
  beginTurn(sessionId: string, turnId: string): void {
    this.activeTurns.set(sessionId, turnId);
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
    status: ResolutionStatus,
    persist?: () => Promise<boolean>
  ): Promise<boolean> {
    const waiter = this.waiters.get(actionRequestId);
    if (!waiter) return persist ? persist() : false;

    let completion = this.completions.get(actionRequestId);
    if (!completion) {
      let complete!: () => void;
      const promise = new Promise<void>((resolve) => {
        complete = resolve;
      });
      completion = { promise, resolve: complete };
      this.completions.set(actionRequestId, completion);
    }
    // Register the completion observer before awaiting the write: a timer that
    // observes our committed decision must not let this HTTP call return early.
    if (persist && !(await persist())) return false;
    this.resolve(actionRequestId, status);
    await completion.promise;
    return waiter.outcome() === status;
  }

  /**
   * Called by the woken call once it has fully finished handling the outcome (denied path or
   * confirmed-and-executed path). A no-op if nothing is waiting on this id.
   */
  markDone(actionRequestId: string): void {
    const completion = this.completions.get(actionRequestId);
    if (!completion) return;
    this.completions.delete(actionRequestId);
    completion.resolve();
  }

  /** True while a call is still blocked awaiting resolution for this action. */
  isAwaiting(actionRequestId: string): boolean {
    return this.waiters.has(actionRequestId);
  }
}
