export interface CheckTokenMinter {
  readonly mint: (
    actorUserId: string,
    chatSessionId: string,
    toolNames: readonly string[]
  ) => { readonly token: string; readonly mcpServerUrl: string };
  readonly revoke: (chatSessionId: string) => void;
}

/**
 * Builds the minter for check sessions. A token it mints carries an allowlist of exactly the
 * named tools, and the gateway refuses a call to any other tool at call time.
 */
export function buildCheckTokenMinter(
  tokens: {
    mint: (identity: {
      actorUserId: string;
      chatSessionId: string;
      threadId: null;
      allowedToolNames: Set<string>;
    }) => string;
    revokeBySessionId: (chatSessionId: string) => void;
  },
  mcpServerUrl: string
): CheckTokenMinter {
  return {
    mint: (actorUserId, chatSessionId, toolNames) => ({
      token: tokens.mint({
        actorUserId,
        chatSessionId,
        // Check sessions do not belong to a conversation; the gateway treats them as tainted.
        threadId: null,
        allowedToolNames: new Set(toolNames)
      }),
      mcpServerUrl
    }),
    revoke: (chatSessionId) => tokens.revokeBySessionId(chatSessionId)
  };
}
