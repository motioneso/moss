export const DISCOVERY_TIMEOUT_MS = 15_000;
export const TOOL_CALL_TIMEOUT_MS = 30_000;

/** #2175 Task 4 — the only cap that fires for an integration tool result; see call-memory.ts for the per-request ceiling/budget it feeds. */
export const INTEGRATION_RESPONSE_CHAR_CAP = 8_000;
export const INTEGRATION_CALL_CEILING = 12;
export const INTEGRATION_REQUEST_CHAR_BUDGET = 24_000;

export async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

export interface CappedChars {
  readonly detail: unknown;
  readonly truncated: boolean;
  /** Characters the service actually sent, measured before truncation — the per-request budget counts this, not what the model ends up seeing. */
  readonly rawChars: number;
}

/**
 * Caps a tool's raw result to `cap` characters, measured as the service actually sent it
 * (#2175 Task 4). Applied once in the proxy so it covers both the MCP and OpenAPI call paths —
 * neither carries its own cap after this task.
 */
export function capChars(detail: unknown, cap: number): CappedChars {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  const rawChars = text.length;
  if (rawChars <= cap) return { detail, truncated: false, rawChars };
  return { detail: text.slice(0, cap), truncated: true, rawChars };
}
