export interface AiApiKeyCredential {
  readonly apiKey: string;
}

export function parseAiApiKeyCredential(value: Record<string, unknown>): AiApiKeyCredential | null {
  // A pasted key often carries a trailing space or newline, and a provider refuses the key with it.
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  return apiKey.length > 0 ? { apiKey } : null;
}
