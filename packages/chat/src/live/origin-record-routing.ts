import { reportActionRecordFailure } from "@moss/ai";
import type { ChatPersistencePort } from "./chat-session-ports.js";
import type { UserSession } from "./chat-session-provider-identity.js";
import { normalizeChatSurface, surfaceSessionKey, type ChatSurface } from "./chat-surface.js";
import { injectActionResultRecord, type PendingActionResult } from "./session-runtime-helpers.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";

export interface OriginThreadTransition {
  readonly version: number;
  readonly pending: number;
  readonly settled: Promise<void>;
}

/** Cancel this caller's admission wait without canceling a shared selection or launch. */
export async function waitForChatAdmission<T>(
  pending: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Wait for selection changes, never for the model turn that Stop must interrupt. */
export async function waitForOriginThreadTransition(
  transitions: ReadonlyMap<string, OriginThreadTransition>,
  key: string,
  signal?: AbortSignal
): Promise<void> {
  while (transitions.get(key)?.pending && !signal?.aborted) {
    await waitForChatAdmission(transitions.get(key)!.settled, signal);
  }
}

/** Suppress old-surface fan-out throughout a real new-chat/resume, including its awaits. */
export async function withOriginThreadTransition<T>(
  transitions: Map<string, OriginThreadTransition>,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = transitions.get(key);
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  transitions.set(key, {
    version: (previous?.version ?? 0) + 1,
    pending: (previous?.pending ?? 0) + 1,
    settled: Promise.all([previous?.settled, pending]).then(() => undefined)
  });
  try {
    return await work();
  } finally {
    const current = transitions.get(key)!;
    transitions.set(key, {
      ...current,
      version: current.version + 1,
      pending: current.pending - 1
    });
    complete();
  }
}

export interface OriginRecordReceipt {
  readonly historyPersisted: boolean;
  readonly historyIgnored?: boolean;
}

interface OriginRoutingState {
  readonly persistence: ChatPersistencePort;
  readonly sessions: ReadonlyMap<string, UserSession>;
  readonly transitions: ReadonlyMap<string, OriginThreadTransition>;
  readonly turnsInFlight: ReadonlySet<string>;
  readonly sequenceBySession: Map<string, number>;
  readonly pendingBySession: Map<string, PendingActionResult[]>;
  readonly turnRecords: ReadonlyMap<string, TranscriptRecord[]>;
  readonly actionResults: ReadonlyMap<string, ActionResultMetadata[]>;
  readonly emit: (surface: ChatSurface, record: TranscriptRecord) => void;
}

/** Only server-verified origins may use this synchronous path; it never consults a current pointer. */
export function routeLiveOriginRecord(
  input: OriginRoutingState & {
    readonly actorUserId: string;
    readonly originThreadId: string;
    readonly record: TranscriptRecord;
    readonly surface: string;
  }
): boolean {
  const { actorUserId, originThreadId, record } = input;
  if (!originThreadId || !record.actionRequestId || !input.surface) return false;
  if (record.kind !== "action_request" && record.kind !== "action_result") return false;
  let surface: ChatSurface;
  try {
    surface = normalizeChatSurface(input.surface);
  } catch {
    return false;
  }
  const key = surfaceSessionKey(actorUserId, surface);
  const session = input.sessions.get(key);
  if (
    !session ||
    session.actorUserId !== actorUserId ||
    session.threadId !== originThreadId ||
    session.surface !== surface ||
    input.transitions.get(key)?.pending
  )
    return false;
  if (record.kind === "action_result" && record.outcome) {
    injectActionResultRecord(record, {
      sessionKey: key,
      sequenceBySession: input.sequenceBySession,
      turnRecords: input.turnRecords.get(key),
      actionResults: input.actionResults.get(key),
      emit: (next) => input.emit(surface, next)
    });
  } else {
    input.emit(surface, record);
  }
  return true;
}

/** Action delivery is bound to an owned conversation, never to whatever a surface now selects. */
export async function routeOriginRecord(
  input: OriginRoutingState & {
    readonly actorUserId: string;
    readonly originThreadId: string | null | undefined;
    readonly record: TranscriptRecord;
    readonly historyOnly?: boolean;
  }
): Promise<OriginRecordReceipt> {
  const { actorUserId, originThreadId, record, persistence } = input;
  const receipt: { historyPersisted: boolean; historyIgnored?: boolean } = {
    historyPersisted: false
  };
  if (!originThreadId || !record.actionRequestId) return receipt;
  if (record.kind !== "action_request" && record.kind !== "action_result") return receipt;
  const versions = new Map(input.transitions);
  // Reserve the original arrival position before the owner lookup can yield to engine reads.
  const arrivingSession = [...input.sessions.values()].find(
    (session) => session.actorUserId === actorUserId && session.threadId === originThreadId
  );
  const arrivingKey = arrivingSession && surfaceSessionKey(actorUserId, arrivingSession.surface);
  let recordSequence: number | undefined;
  let approvalSequence: number | undefined;
  if (
    !input.historyOnly &&
    record.kind === "action_result" &&
    arrivingKey &&
    input.turnsInFlight.has(arrivingKey)
  ) {
    const current = input.sequenceBySession.get(arrivingKey) ?? 0;
    recordSequence = record.sequence ?? current + 1;
    approvalSequence = Math.max(current, recordSequence) + 1;
    input.sequenceBySession.set(arrivingKey, approvalSequence);
  }
  if (!persistence.getOwnedThreadState) return receipt;
  const origin = await persistence.getOwnedThreadState(actorUserId, originThreadId);
  if (!origin) return { historyPersisted: false, historyIgnored: true };
  if (origin.id !== originThreadId) return receipt;
  if (origin.incognito) receipt.historyIgnored = true;
  const key = surfaceSessionKey(actorUserId, origin.surface);
  // A separate idempotent write closes the race with an already-saving/completed model turn.
  if (record.kind === "action_result" && record.outcome && !origin.incognito) {
    try {
      receipt.historyPersisted =
        (await persistence.persistActionRecord?.(actorUserId, originThreadId, {
          ...record,
          ...(recordSequence === undefined ? {} : { sequence: recordSequence })
        })) === true;
    } catch (error) {
      // A history write failure must not hide a known live outcome or its refresh hints.
      // The exact owned/current/session/transition checks still apply below.
      reportActionRecordFailure(record.actionRequestId, error);
    }
  }
  if (input.historyOnly) return receipt;
  const current = await persistence.getCurrentThreadState?.(actorUserId, origin.surface);
  const transition = input.transitions.get(key);
  if (
    current?.id !== originThreadId ||
    transition?.pending ||
    (transition?.version ?? 0) !== (versions.get(key)?.version ?? 0)
  )
    return receipt;
  const session = input.sessions.get(key);
  if (session && (session.actorUserId !== actorUserId || session.threadId !== originThreadId))
    return receipt;
  if (record.kind === "action_result" && record.outcome) {
    if (input.turnsInFlight.has(key)) {
      const currentSequence = input.sequenceBySession.get(key) ?? 0;
      recordSequence ??= record.sequence ?? currentSequence + 1;
      approvalSequence ??= Math.max(currentSequence, recordSequence) + 1;
      input.sequenceBySession.set(key, Math.max(currentSequence, approvalSequence));
      const pending = input.pendingBySession.get(key) ?? [];
      pending.push({ record, recordSequence, approvalSequence });
      input.pendingBySession.set(key, pending);
      return receipt;
    }
    injectActionResultRecord(record, {
      sessionKey: key,
      sequenceBySession: input.sequenceBySession,
      recordSequence,
      approvalSequence,
      turnRecords: input.turnRecords.get(key),
      actionResults: input.actionResults.get(key),
      emit: (next) => input.emit(origin.surface, next)
    });
    return receipt;
  }
  input.emit(origin.surface, record);
  return receipt;
}
