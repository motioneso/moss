import { REAL_CHAT_CONFIGURED_ENV } from "../uat/real-chat-env.js";

/**
 * Decides whether a live run binds the stack's real chat sign-in to the cheapest model.
 * LIVE_BIND_CHEAPEST_MODEL=1 (set by run-live-2162.ts) asks for it; a long-lived instance
 * already has a model configured. Asking without a configured sign-in throws rather than fall back.
 */
export function shouldBindCheapestModel(env: NodeJS.ProcessEnv): boolean {
  if (env.LIVE_BIND_CHEAPEST_MODEL !== "1") return false;
  if (!env[REAL_CHAT_CONFIGURED_ENV]) {
    throw new Error(
      "no real chat sign-in is configured for this stack; refusing to fake the model"
    );
  }
  return true;
}
