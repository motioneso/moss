// #3311: the delivered reminders the next Main model turn is shown, bound to their exact
// reserved message ids. Only the stored turn acknowledges them, so a stop or failure leaves
// them pending, and a reminder delivered after this snapshot waits for a later turn.

import type { ConversationProvenancePort } from "@moss/ai";

import { renderReminderContextBlock } from "./chat-context-blocks.js";
import type { ChatPersistencePort, PendingMainReminder } from "./chat-session-ports.js";
import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "./chat-surface.js";
import { admissionForActor, admitToContext, type AdmittedContext } from "./context-admission.js";

export interface MainReminderSnapshot {
  readonly context: AdmittedContext | null;
  readonly messageIds: readonly string[];
}

const EMPTY: MainReminderSnapshot = Object.freeze({ context: null, messageIds: [] });

export async function snapshotMainReminders(
  deps: {
    readonly persistence: Pick<ChatPersistencePort, "listPendingMainReminders">;
    readonly conversationProvenance?: Pick<ConversationProvenancePort, "recordAdmission">;
  },
  actorUserId: string,
  surface: ChatSurface,
  session: { readonly threadId: string | null; readonly incognito: boolean },
  moduleControl: string | undefined
): Promise<MainReminderSnapshot> {
  // Private, module and other-surface turns never read or clear Main's reminders.
  if (surface !== DEFAULT_CHAT_SURFACE || session.incognito || moduleControl) return EMPTY;
  if (!session.threadId || !deps.persistence.listPendingMainReminders) return EMPTY;

  // A failed read degrades to no context; nothing shown means nothing acknowledged.
  let reminders: readonly PendingMainReminder[];
  try {
    reminders = await deps.persistence.listPendingMainReminders(actorUserId, session.threadId);
  } catch {
    return EMPTY;
  }
  if (reminders.length === 0) return EMPTY;

  const context = await admitToContext(
    admissionForActor(deps.conversationProvenance, actorUserId),
    session.threadId,
    "main_reminder_context",
    renderReminderContextBlock(reminders.map((reminder) => reminder.body))
  );
  return Object.freeze({
    context,
    messageIds: Object.freeze(reminders.map((reminder) => reminder.reservedMessageId))
  });
}
