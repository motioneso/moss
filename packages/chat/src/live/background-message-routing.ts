import type { OriginThreadTransition } from "./origin-record-routing.js";
import { DEFAULT_CHAT_SURFACE, surfaceSessionKey, type ChatSurface } from "./chat-surface.js";
import type { TranscriptRecord } from "./types.js";

// #3195: a stored background message (a delivered reminder) reaches only the owner's drawer,
// and only while that drawer shows the owner's Main thread. The shown thread comes from the
// privacy-state read the browser also uses to pick its thread. With no live session that read
// answers Main, even if the browser still displays a side chat, so the browser's own side-chat
// drop is the backstop for that case.

export type BackgroundRecord = TranscriptRecord & {
  readonly kind: "reply";
  readonly messageId: string;
  readonly background: true;
};

export interface MainBackgroundMessage {
  readonly actorUserId: string;
  readonly mainThreadId: string;
  readonly record: BackgroundRecord;
}

export interface ShownDrawerThread {
  readonly incognito: boolean;
  readonly threadId?: string;
}

export async function routeMainBackgroundMessage(
  input: MainBackgroundMessage & {
    readonly shown: (actorUserId: string) => Promise<ShownDrawerThread>;
    readonly transitions: ReadonlyMap<string, OriginThreadTransition>;
    readonly emit: (surface: ChatSurface, record: TranscriptRecord) => void;
  }
): Promise<void> {
  const shown = await input.shown(input.actorUserId);

  // Checked after the read, so a chat switch that starts meanwhile still wins.
  const key = surfaceSessionKey(input.actorUserId, DEFAULT_CHAT_SURFACE);
  if (input.transitions.get(key)?.pending) return;
  if (shown.incognito || shown.threadId !== input.mainThreadId) return;
  input.emit(DEFAULT_CHAT_SURFACE, input.record);
}
