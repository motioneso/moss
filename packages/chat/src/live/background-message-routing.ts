import type { OriginThreadTransition } from "./origin-record-routing.js";
import type { UserSession } from "./chat-session-provider-identity.js";
import { DEFAULT_CHAT_SURFACE, surfaceSessionKey, type ChatSurface } from "./chat-surface.js";
import type { TranscriptRecord } from "./types.js";

// #3195: a stored background message (a delivered reminder) reaches only the owner's drawer,
// and only while that drawer shows the owner's Main thread. A live session names the thread it
// shows; with no session the drawer shows the owner's current thread, read by the caller.

export interface MainBackgroundMessage {
  readonly actorUserId: string;
  readonly mainThreadId: string;
  /** The drawer's current thread, read under the owner's access rules. */
  readonly drawerThreadId: string | null;
  readonly record: TranscriptRecord;
}

export function routeMainBackgroundMessage(
  input: MainBackgroundMessage & {
    readonly sessions: ReadonlyMap<string, UserSession>;
    readonly transitions: ReadonlyMap<string, OriginThreadTransition>;
    readonly emit: (surface: ChatSurface, record: TranscriptRecord) => void;
  }
): boolean {
  const { actorUserId, mainThreadId, record } = input;
  if (!actorUserId || !mainThreadId) return false;
  if (record.kind !== "reply" || record.background !== true || !record.messageId) return false;
  const key = surfaceSessionKey(actorUserId, DEFAULT_CHAT_SURFACE);
  if (input.transitions.get(key)?.pending) return false;
  const session = input.sessions.get(key);
  if (session) {
    if (
      session.actorUserId !== actorUserId ||
      session.surface !== DEFAULT_CHAT_SURFACE ||
      session.incognito ||
      session.threadId !== mainThreadId
    )
      return false;
  } else if (input.drawerThreadId !== mainThreadId) {
    return false;
  }
  input.emit(DEFAULT_CHAT_SURFACE, record);
  return true;
}
