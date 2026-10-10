import { resolveMossEnv } from "@moss/db";

/** Default replay window size in messages (unset/invalid env falls back here). */
export const DEFAULT_REPLAY_MESSAGES = 40;

/** Token budget for the replayed message window (excludes the summary). */
export const REPLAY_TOKEN_CAP = 8000;

/** Token budget for the stored rolling summary once capped for injection. */
export const SUMMARY_TOKEN_CAP = 1000;

export interface ReplayMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * Messages replayed after the accepted summary. Unset or empty falls back to
 * DEFAULT_REPLAY_MESSAGES; "0" disables replay; a non-numeric or negative value
 * falls back with one console.warn.
 */
export function getReplayK(): number {
  const val = resolveMossEnv(process.env, "JARVIS_CHAT_REPLAY_K");
  if (val === undefined || val === "") return DEFAULT_REPLAY_MESSAGES;
  const parsed = parseInt(val, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `Invalid JARVIS_CHAT_REPLAY_K value "${val}"; defaulting to ${DEFAULT_REPLAY_MESSAGES}.`
    );
    return DEFAULT_REPLAY_MESSAGES;
  }
  return parsed;
}

/** Token budget for replayed messages. Same parse rules as getReplayK. */
export function getReplayTokenCap(): number {
  const val = resolveMossEnv(process.env, "JARVIS_CHAT_REPLAY_TOKENS");
  if (val === undefined || val === "") return REPLAY_TOKEN_CAP;
  const parsed = parseInt(val, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `Invalid JARVIS_CHAT_REPLAY_TOKENS value "${val}"; defaulting to ${REPLAY_TOKEN_CAP}.`
    );
    return REPLAY_TOKEN_CAP;
  }
  return parsed;
}
