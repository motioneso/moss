export const DISCOVERY_TIMEOUT_MS = 15_000;
export const TOOL_CALL_TIMEOUT_MS = 30_000;
export const RESPONSE_CHAR_CAP = 64_000;

export async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}
