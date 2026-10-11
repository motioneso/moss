import type { StoredAttachmentMeta } from "../attachments-service.js";
import type { ChatPersistencePort } from "./chat-session-ports.js";

/**
 * #3128: the in-flight record of one live reply. A turn that never saves is settled as
 * interrupted (its question plus the note) or discarded (a stop or refusal).
 */
export interface LiveTurnRecord {
  /** The completed turn landed; its save already removed the record. */
  saved(): void;
  /** The reply failed after the model received it. */
  interrupted(): void;
  /** Closes an unsaved record. Never throws. */
  settle(): Promise<void>;
}

/**
 * Records the reply in flight before the model receives it. A failed write leaves this turn
 * without restart recovery but never blocks it, so the result is undefined then.
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
): Promise<LiveTurnRecord | undefined> {
  const threadId = session.threadId;
  if (!persistence.beginLiveTurn || session.incognito || !threadId) return undefined;
  try {
    await persistence.beginLiveTurn(actorUserId, {
      turnId: turn.turnId,
      threadId,
      userText: turn.userText,
      attachments: turn.attachments.map((meta) => ({
        id: meta.id,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes
      }))
    });
  } catch (error) {
    logLiveTurnFailure("chat.live_turn.begin_failed", turn.turnId, error);
    return undefined;
  }

  let outcome: "open" | "saved" | "interrupted" = "open";
  return {
    saved: () => {
      outcome = "saved";
    },
    interrupted: () => {
      if (outcome === "open") outcome = "interrupted";
    },
    settle: async () => {
      if (outcome === "saved") return;
      try {
        if (outcome === "interrupted") {
          await persistence.storeInterruptedLiveTurn?.(actorUserId, threadId, turn.turnId);
        } else {
          await persistence.discardLiveTurn?.(actorUserId, turn.turnId);
        }
      } catch (error) {
        logLiveTurnFailure("chat.live_turn.settle_failed", turn.turnId, error);
      }
    }
  };
}

// Ids and error class only; the question text never reaches logs.
function logLiveTurnFailure(event: string, turnId: string, error: unknown): void {
  console.warn(
    JSON.stringify({ event, turnId, error: error instanceof Error ? error.name : "unknown" })
  );
}
