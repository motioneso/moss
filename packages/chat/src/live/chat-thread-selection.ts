import type { ChatPersistencePort } from "./chat-session-ports.js";
import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "./chat-surface.js";

type ThreadState = { readonly id: string; readonly incognito: boolean } | undefined;

/** A cold drawer reconnect starts at Main; a live or explicitly switched chat keeps its selection. */
export function usesMainThreadSelection(input: {
  readonly surface: ChatSurface;
  readonly forceReplay: boolean;
  readonly hasSession: boolean;
}): boolean {
  return input.surface === DEFAULT_CHAT_SURFACE && !input.forceReplay && !input.hasSession;
}

export async function getSelectedThreadState(input: {
  readonly actorUserId: string;
  readonly surface: ChatSurface;
  readonly useMain: boolean;
  readonly persistence: Pick<ChatPersistencePort, "getCurrentThreadState" | "getMainThreadState">;
}): Promise<ThreadState> {
  if (input.useMain && input.persistence.getMainThreadState) {
    return input.persistence.getMainThreadState(input.actorUserId);
  }
  return input.persistence.getCurrentThreadState?.(input.actorUserId, input.surface);
}
