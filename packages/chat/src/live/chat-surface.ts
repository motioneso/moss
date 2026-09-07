import { DEFAULT_CHAT_SURFACE, normalizeChatSurface, type ChatSurface } from "@moss/shared";

const SESSION_KEY_DELIMITER = ":";

export { DEFAULT_CHAT_SURFACE, normalizeChatSurface };
export type { ChatSurface };

/**
 * Fan-out bucket for Workshop project streams (#2369 slice 1 phase 5). The
 * gateway notifier injects Workshop cards under the raw `workshop:<userId>:
 * <projectId>` key on this surface, and the project conversation subscribes
 * to that same bucket — never parsed as actor+surface, because a project id
 * starting with a-f would parse as a surface and silently misroute the card.
 */
export const WORKSHOP_STREAM_SURFACE: ChatSurface = "workshop" as ChatSurface;

/** True for `workshop:<userId>:<projectId>` session keys. */
export function isWorkshopSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith("workshop:");
}

export function readRouteSurface(query: unknown): ChatSurface {
  const raw =
    query && typeof query === "object" ? (query as { surface?: unknown }).surface : undefined;
  try {
    return normalizeChatSurface(raw);
  } catch {
    throw new Error("Invalid chat surface");
  }
}

export function surfaceSessionKey(
  actorUserId: string,
  surface: ChatSurface | string = DEFAULT_CHAT_SURFACE
): string {
  return `${encodeURIComponent(actorUserId)}${SESSION_KEY_DELIMITER}${normalizeChatSurface(surface)}`;
}

export function parseSurfaceSessionKey(sessionKey: string): {
  actorUserId: string;
  surface: ChatSurface;
} {
  const delimiter = sessionKey.lastIndexOf(SESSION_KEY_DELIMITER);
  if (delimiter <= 0 || delimiter === sessionKey.length - 1) {
    throw new Error("Invalid surface session key");
  }

  let actorUserId: string;
  try {
    actorUserId = decodeURIComponent(sessionKey.slice(0, delimiter));
  } catch {
    throw new Error("Invalid surface session key");
  }
  if (!actorUserId) throw new Error("Invalid surface session key");

  return {
    actorUserId,
    surface: normalizeChatSurface(sessionKey.slice(delimiter + 1))
  };
}
