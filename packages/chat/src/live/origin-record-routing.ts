import type { ChatPersistencePort } from "./chat-session-ports.js";
import type { UserSession } from "./chat-session-provider-identity.js";
import { surfaceSessionKey, type ChatSurface } from "./chat-surface.js";
import { injectActionResultRecord, type PendingActionResult } from "./session-runtime-helpers.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";

export interface OriginThreadTransition {
  readonly version: number;
  readonly pending: number;
}

/** Suppress old-surface fan-out throughout a real new-chat/resume, including its awaits. */
export async function withOriginThreadTransition<T>(
  transitions: Map<string, OriginThreadTransition>,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = transitions.get(key);
  transitions.set(key, {
    version: (previous?.version ?? 0) + 1,
    pending: (previous?.pending ?? 0) + 1
  });
  try {
    return await work();
  } finally {
    const current = transitions.get(key)!;
    transitions.set(key, { version: current.version + 1, pending: current.pending - 1 });
  }
}

/** Action delivery is bound to an owned conversation, never to whatever a surface now selects. */
export async function routeOriginRecord(input: {
  readonly actorUserId: string;
  readonly originThreadId: string | null | undefined;
  readonly record: TranscriptRecord;
  readonly historyOnly?: boolean;
  readonly persistence: ChatPersistencePort;
  readonly sessions: ReadonlyMap<string, UserSession>;
  readonly transitions: ReadonlyMap<string, OriginThreadTransition>;
  readonly turnsInFlight: ReadonlySet<string>;
  readonly sequenceBySession: Map<string, number>;
  readonly pendingBySession: Map<string, PendingActionResult[]>;
  readonly turnRecords: ReadonlyMap<string, TranscriptRecord[]>;
  readonly actionResults: ReadonlyMap<string, ActionResultMetadata[]>;
  readonly emit: (surface: ChatSurface, record: TranscriptRecord) => void;
}): Promise<void> {
  const { actorUserId, originThreadId, record, persistence } = input;
  if (!originThreadId || !record.actionRequestId) return;
  if (record.kind !== "action_request" && record.kind !== "action_result") return;
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
  const origin = await persistence.getOwnedThreadState?.(actorUserId, originThreadId);
  if (!origin || origin.id !== originThreadId) return;
  const key = surfaceSessionKey(actorUserId, origin.surface);
  // A separate idempotent write closes the race with an already-saving/completed model turn.
  if (record.kind === "action_result" && record.outcome && !origin.incognito) {
    await persistence.persistActionRecord?.(actorUserId, originThreadId, {
      ...record,
      ...(recordSequence === undefined ? {} : { sequence: recordSequence })
    });
  }
  if (input.historyOnly) return;
  const current = await persistence.getCurrentThreadState?.(actorUserId, origin.surface);
  const transition = input.transitions.get(key);
  if (
    current?.id !== originThreadId ||
    transition?.pending ||
    (transition?.version ?? 0) !== (versions.get(key)?.version ?? 0)
  )
    return;
  const session = input.sessions.get(key);
  if (session && (session.actorUserId !== actorUserId || session.threadId !== originThreadId))
    return;
  if (record.kind === "action_result" && record.outcome) {
    if (input.turnsInFlight.has(key)) {
      const currentSequence = input.sequenceBySession.get(key) ?? 0;
      recordSequence ??= record.sequence ?? currentSequence + 1;
      approvalSequence ??= Math.max(currentSequence, recordSequence) + 1;
      input.sequenceBySession.set(key, Math.max(currentSequence, approvalSequence));
      const pending = input.pendingBySession.get(key) ?? [];
      pending.push({ record, recordSequence, approvalSequence });
      input.pendingBySession.set(key, pending);
      return;
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
    return;
  }
  input.emit(origin.surface, record);
}
