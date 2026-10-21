import type { ChatPersistencePort } from "./chat-session-ports.js";
import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "./chat-surface.js";

type ThreadState = { readonly id: string; readonly incognito: boolean } | undefined;

/** A cold drawer reconnect starts at Main; a live or explicitly switched chat keeps its selection. */
export function usesMainThreadSelection(input: {
  readonly surface: ChatSurface;
  readonly forceReplay: boolean;
}): boolean {
  return input.surface === DEFAULT_CHAT_SURFACE && !input.forceReplay;
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

/**
 * The selected conversation, opened first when the actor has none. A turn binds here before any
 * pre-model answer, so a new account's first message lands in Main whoever answers it.
 */
export async function getOrOpenSelectedThreadState(input: {
  readonly actorUserId: string;
  readonly surface: ChatSurface;
  readonly useMain: boolean;
  readonly persistence: Pick<
    ChatPersistencePort,
    "getCurrentThreadState" | "getMainThreadState" | "openNewConversation"
  >;
}): Promise<ThreadState> {
  const selected = await getSelectedThreadState(input);
  if (selected || !input.persistence.getCurrentThreadState) return selected;
  await input.persistence.openNewConversation(input.actorUserId, undefined, input.surface);
  return getSelectedThreadState(input);
}

/**
 * The pinned conversation's state while it is still the actor's selection: the current
 * conversation, or Main for the drawer. Anything else means the selection moved.
 */
export async function getPinnedThreadState(input: {
  readonly actorUserId: string;
  readonly surface: ChatSurface;
  readonly threadId: string;
  readonly persistence: Pick<ChatPersistencePort, "getCurrentThreadState" | "getMainThreadState">;
}): Promise<ThreadState> {
  const current = await input.persistence.getCurrentThreadState?.(input.actorUserId, input.surface);
  if (current?.id === input.threadId) return current;
  if (input.surface !== DEFAULT_CHAT_SURFACE || !input.persistence.getMainThreadState) return;
  const main = await input.persistence.getMainThreadState(input.actorUserId);
  return main?.id === input.threadId ? main : undefined;
}
