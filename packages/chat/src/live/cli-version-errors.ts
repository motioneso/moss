/**
 * #2689 — the provider's own "version X or newer is required" refusal, raised when the installed
 * command-line tool is too old for the chosen model. Every engine that sees it throws a
 * `CliChatUnavailableError` carrying {@link CLI_VERSION_TOO_OLD_MESSAGE} and nothing else, so no
 * provider output travels with it. The fixed message survives the runner socket unchanged, which
 * lets the chat routes show it and the background logger name it.
 */

export const CLI_VERSION_TOO_OLD_CODE = "cli_version_too_old";

export const CLI_VERSION_TOO_OLD_MESSAGE =
  "The installed AI tool is too old for this model. Moss updates it automatically; an admin can check Settings > AI providers.";

const VERSION_TOO_OLD = /\bversion \d+(?:\.\d+)+ or newer is required\b/i;

/** True when provider text carries the "version X or newer is required" refusal. */
export function isCliVersionTooOldText(text: string): boolean {
  return VERSION_TOO_OLD.test(text);
}

/** True when a reply is the provider's own API error text, not model output. */
export function isCliVersionTooOldReply(text: string): boolean {
  return /^\s*API Error: \d{3}\b/.test(text) && isCliVersionTooOldText(text);
}

/** Checks an error's message and any JSON-RPC `data` detail; neither is kept. */
export function isCliVersionTooOldError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const data = (error as { data?: unknown } | null)?.data;
  let detail: string;
  try {
    detail = typeof data === "string" ? data : (JSON.stringify(data) ?? "");
  } catch {
    detail = "";
  }
  return isCliVersionTooOldText(`${message}\n${detail}`);
}

let tooOldListener: (() => void) | undefined;

/**
 * Registers the one function that runs when a chat turn hits the too-old refusal. The composition
 * root sets it to "refresh and check now". Pass `undefined` to clear it.
 */
export function setCliVersionTooOldListener(listener: (() => void) | undefined): void {
  tooOldListener = listener;
}

/** Tells the listener a turn was refused for an old tool. Never throws. */
export function notifyCliVersionTooOld(): void {
  try {
    tooOldListener?.();
  } catch {
    // The refusal is already on its way to the user; a failed refresh must not mask it.
  }
}
