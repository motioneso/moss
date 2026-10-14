import type { OriginThreadTransition } from "./origin-record-routing.js";
import { DEFAULT_CHAT_SURFACE, surfaceSessionKey, type ChatSurface } from "./chat-surface.js";
import type { TranscriptRecord } from "./types.js";

// A committed background message reaches only its owner's currently shown destination.
// Browser identity filtering also guards a stale/default server selection.

export type BackgroundRecord = TranscriptRecord & {
  readonly kind: "reply";
  readonly messageId: string;
  readonly background: true;
};

export interface BackgroundMessage {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly record: BackgroundRecord;
}

export interface ShownDrawerThread {
  readonly incognito: boolean;
  readonly threadId?: string;
}

export async function routeBackgroundMessage(
  input: BackgroundMessage & {
    readonly shown: (actorUserId: string) => Promise<ShownDrawerThread>;
    readonly transitions: ReadonlyMap<string, OriginThreadTransition>;
    readonly emit: (surface: ChatSurface, record: TranscriptRecord) => void;
  }
): Promise<void> {
  const shown = await input.shown(input.actorUserId);

  // Checked after the read, so a chat switch that starts meanwhile still wins.
  const key = surfaceSessionKey(input.actorUserId, DEFAULT_CHAT_SURFACE);
  if (input.transitions.get(key)?.pending) return;
  if (shown.incognito || shown.threadId !== input.threadId) return;
  input.emit(DEFAULT_CHAT_SURFACE, input.record);
}
