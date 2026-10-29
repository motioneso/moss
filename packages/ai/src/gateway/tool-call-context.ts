import { randomUUID } from "node:crypto";

import type { ToolContext } from "@moss/module-sdk";
import type { SessionTokenRegistry } from "./session-tokens.js";

/** Capture identity synchronously before locale lookup or other awaited call preparation. */
export function captureToolCallContext(tokens: SessionTokenRegistry, token: string) {
  const { actorUserId, chatSessionId, threadId, allowedToolNames } = tokens.verify(token);
  const turnId = tokens.readCurrentTurnId?.(chatSessionId);
  const context: ToolContext = {
    actorUserId,
    requestId: `mcp_${randomUUID()}`,
    chatSessionId,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {})
  };
  return { context, allowedToolNames };
}
