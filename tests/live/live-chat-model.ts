import { REAL_CHAT_CONFIGURED_ENV } from "../uat/real-chat-env.js";

/**
 * Decides whether a live run binds the stack's copied Codex login to the cheapest model.
 * LIVE_BIND_CHEAPEST_MODEL=1 (set by run-live-2162.ts) asks for it; a long-lived instance
 * already has a model configured. Asking without a copied login throws rather than fall back.
 */
export function shouldBindCheapestModel(env: NodeJS.ProcessEnv): boolean {
  if (env.LIVE_BIND_CHEAPEST_MODEL !== "1") return false;
  if (!env[REAL_CHAT_CONFIGURED_ENV]) {
    throw new Error("no Codex sign-in was copied into this stack; refusing to fake the model");
  }
  return true;
}
