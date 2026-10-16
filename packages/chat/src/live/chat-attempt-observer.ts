import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

/** Diagnostic metadata only. The bootstrap owns transport, counters and evidence windows. */
export const CHAT_ATTEMPT_CHANNEL = "moss.chat.attempt.v1";
export const CHAT_ATTEMPT_SITES = [
  "turn",
  "ensure.initial",
  "ensure.retry",
  "heal",
  "factory",
  "launch",
  "replay.submit",
  "submit.initial",
  "submit.retry",
  "classifier.evaluate",
  "shadow.start",
  "shadow.run"
] as const;
export type ChatAttemptSite = (typeof CHAT_ATTEMPT_SITES)[number];
type ObserverError = "unknown_context" | "context_mismatch" | "unknown_thread" | "subscriber_error";
export interface ChatAttemptIdentity {
  readonly actorUserId: string;
  readonly surface: string;
  readonly turnId?: string;
  readonly threadId?: string | null;
}
interface TurnContext extends ChatAttemptIdentity {
  readonly turnId: string;
  threadId: string | null;
  signal?: AbortSignal;
}
export interface ChatAttemptEvent {
  readonly version: 1;
  readonly sequence: number;
  readonly phase: "coverage" | "entry" | "settle" | "context" | "error";
  readonly sites?: readonly ChatAttemptSite[];
  readonly site?: ChatAttemptSite;
  readonly attemptId?: number;
  readonly actorUserId?: string;
  readonly surface?: string;
  readonly turnId?: string;
  readonly threadId?: string | null;
  readonly outcome?: "ok" | "error" | "aborted";
  readonly aborted?: boolean;
  readonly observerError?: ObserverError;
}

const diagnostics = channel(CHAT_ATTEMPT_CHANNEL);
const registered = new Set<ChatAttemptSite>();
let context: AsyncLocalStorage<TurnContext> | undefined;
let sequence = 0;
let stickyError: ObserverError | undefined;

export function chatAttemptObservationEnabled(): boolean {
  return diagnostics.hasSubscribers;
}

export function registerChatAttemptSites(...sites: ChatAttemptSite[]): void {
  for (const site of sites) registered.add(site);
  if (chatAttemptObservationEnabled()) publish({ phase: "coverage", sites: [...registered] });
}

function publish(event: Omit<ChatAttemptEvent, "version" | "sequence" | "observerError">): number {
  const next = ++sequence;
  try {
    diagnostics.publish(
      Object.freeze({ ...event, version: 1, sequence: next, observerError: stickyError })
    );
  } catch {
    stickyError = "subscriber_error";
  }
  return next;
}

function fail(error: ObserverError): void {
  if (stickyError) return;
  stickyError = error;
  publish({ phase: "error" });
}

/**
 * Use for each subscriber initialization/callback, including async callbacks. Node's channel
 * dispatch defers subscriber throws outside publish's stack; publish's catch alone is insufficient.
 * This primitive does not certify a future bootstrap's complete composition.
 */
export function guardChatAttemptObserver(work: () => void | Promise<void>): () => void {
  return () => {
    try {
      const result = work();
      if (result instanceof Promise)
        void result.then(undefined, () => {
          fail("subscriber_error");
        });
    } catch {
      fail("subscriber_error");
    }
  };
}

function fields(turn: TurnContext | undefined) {
  return turn
    ? {
        actorUserId: turn.actorUserId,
        surface: turn.surface,
        turnId: turn.turnId,
        threadId: turn.threadId
      }
    : {};
}

function checkedContext(expected?: ChatAttemptIdentity): TurnContext | undefined {
  const turn = context?.getStore();
  if (!turn) fail("unknown_context");
  else if (
    expected &&
    (expected.actorUserId !== turn.actorUserId ||
      expected.surface !== turn.surface ||
      (expected.turnId !== undefined && expected.turnId !== turn.turnId) ||
      (expected.threadId !== undefined && expected.threadId !== turn.threadId))
  )
    fail("context_mismatch");
  return turn;
}

export function bindChatAttemptThread(
  threadId: string | null,
  expected: ChatAttemptIdentity
): void {
  if (!chatAttemptObservationEnabled()) return;
  const turn = checkedContext(expected);
  if (!turn) return;
  if (turn.threadId !== null && turn.threadId !== threadId) fail("context_mismatch");
  else turn.threadId = threadId;
  publish({ phase: "context", ...fields(turn) });
}

export function bindChatAttemptSignal(signal: AbortSignal): void {
  if (chatAttemptObservationEnabled()) {
    const turn = checkedContext();
    if (turn) turn.signal = signal;
  }
}

/** A span closes only at the caller's actual settlement/finally, including swallowed failures. */
export function beginChatAttempt(
  site: ChatAttemptSite,
  expected?: ChatAttemptIdentity,
  signal?: AbortSignal
): ((failed?: boolean) => void) | undefined {
  if (!chatAttemptObservationEnabled()) return undefined;
  const turn = checkedContext(expected);
  publish({ phase: "coverage", sites: Object.freeze([...registered]) });
  const attemptId = sequence + 1;
  publish({
    phase: "entry",
    site,
    attemptId,
    ...fields(turn),
    aborted: (signal ?? turn?.signal)?.aborted ?? false
  });
  return (failed = false) => {
    if (site === "turn" && !turn?.threadId) fail("unknown_thread");
    const aborted = (signal ?? turn?.signal)?.aborted ?? false;
    publish({
      phase: "settle",
      site,
      attemptId,
      ...fields(turn),
      aborted,
      outcome: aborted ? "aborted" : failed ? "error" : "ok"
    });
  };
}

/** Enabled callsites only: invoke exactly once, return the original value/promise/error. */
export function observeChatAttempt<T>(
  site: ChatAttemptSite,
  work: () => T,
  expected?: ChatAttemptIdentity,
  signal?: AbortSignal
): T {
  const settle = beginChatAttempt(site, expected, signal);
  try {
    const result = work();
    if (result instanceof Promise)
      void result.then(
        () => settle?.(),
        () => settle?.(true)
      );
    else settle?.();
    return result;
  } catch (error) {
    settle?.(true);
    throw error;
  }
}

export function observeChatTurn<T>(
  identity: ChatAttemptIdentity & { readonly turnId: string },
  work: () => T
): T {
  if (!chatAttemptObservationEnabled()) return work();
  context ??= new AsyncLocalStorage<TurnContext>();
  return context.run({ ...identity, threadId: null }, () =>
    observeChatAttempt("turn", work, identity)
  );
}
