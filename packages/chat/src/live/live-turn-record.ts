import type { StoredAttachmentMeta } from "../attachments-service.js";
import type { ChatPersistencePort } from "./chat-session-ports.js";

/**
 * #3128: records the reply in flight before the model receives it. A failed write leaves this
 * turn without restart recovery but never blocks it. Returns whether a record now exists.
 */
export async function openLiveTurnRecord(
  persistence: ChatPersistencePort,
  actorUserId: string,
  session: { readonly incognito: boolean; readonly threadId: string | null },
  turn: {
    readonly turnId: string;
    readonly userText: string;
    readonly attachments: readonly StoredAttachmentMeta[];
  }
): Promise<boolean> {
  if (!persistence.beginLiveTurn || session.incognito || !session.threadId) return false;
  try {
    await persistence.beginLiveTurn(actorUserId, {
      turnId: turn.turnId,
      threadId: session.threadId,
      userText: turn.userText,
      attachments: turn.attachments.map((meta) => ({
        id: meta.id,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes
      }))
    });
    return true;
  } catch (error) {
    logLiveTurnFailure("chat.live_turn.begin_failed", turn.turnId, error);
    return false;
  }
}

/** Closes an unsaved live turn; `interrupted` stores its question and the interrupted note. */
export async function settleLiveTurnRecord(
  persistence: ChatPersistencePort,
  actorUserId: string,
  turnId: string,
  interrupted: boolean
): Promise<void> {
  try {
    await persistence.settleLiveTurn?.(actorUserId, turnId, interrupted);
  } catch (error) {
    logLiveTurnFailure("chat.live_turn.settle_failed", turnId, error);
  }
}

// Ids and error class only; the question text never reaches logs.
function logLiveTurnFailure(event: string, turnId: string, error: unknown): void {
  console.warn(
    JSON.stringify({ event, turnId, error: error instanceof Error ? error.name : "unknown" })
  );
}
