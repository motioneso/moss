import type { AssistantToolGatewayDependencies } from "@moss/ai";

import type { ChatRepository } from "../repository.js";
import type { ChatUserMemorySettingsRepository } from "../memory-settings-repository.js";
import { parseSurfaceSessionKey } from "./chat-surface.js";
import { isCredentialShaped } from "./notes-secret-filter.js";

interface NotesReadToolTrustDeps {
  readonly threads: Pick<ChatRepository, "getCurrentThread">;
  readonly memorySettings: Pick<ChatUserMemorySettingsRepository, "getOrCreate">;
}

const emptyNotesResult = () => ({ data: { chunks: [] } });

/** Keeps every gateway path for model-originated notes reads behind the same privacy boundary. */
export function createNotesReadToolTrustBoundary(
  deps: NotesReadToolTrustDeps
): NonNullable<AssistantToolGatewayDependencies["readToolTrustBoundary"]> {
  return async ({ scopedDb, toolName, ctx, execute }) => {
    if (toolName !== "notes.search") return execute();

    const surface = readOwnedSurface(ctx.chatSessionId, ctx.actorUserId);
    if (!surface) return emptyNotesResult();

    const [thread, settings] = await Promise.all([
      deps.threads.getCurrentThread(scopedDb, ctx.actorUserId, surface),
      deps.memorySettings.getOrCreate(scopedDb, ctx.actorUserId)
    ]);
    if (thread?.incognito || !settings.recallEnabled) return emptyNotesResult();

    const result = await execute();
    const data = result.data as { chunks?: unknown };
    const chunks = Array.isArray(data.chunks)
      ? data.chunks.filter((chunk) => isSafeNotesChunk(chunk))
      : [];
    return { ...result, data: { ...data, chunks } };
  };
}

function readOwnedSurface(sessionKey: string, actorUserId: string) {
  try {
    const parsed = parseSurfaceSessionKey(sessionKey);
    return parsed.actorUserId === actorUserId ? parsed.surface : null;
  } catch {
    return null;
  }
}

function isSafeNotesChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const { sourcePath, text } = chunk as { sourcePath?: unknown; text?: unknown };
  if (typeof sourcePath !== "string" || typeof text !== "string") return false;
  if (!isCredentialShaped(sourcePath) && !isCredentialShaped(text)) return true;
  console.warn(JSON.stringify({ event: "notes_tool_credential_chunk_dropped" }));
  return false;
}
