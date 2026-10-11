import { useQuery } from "@tanstack/react-query";
import type { OnboardingStatusResponse } from "@moss/shared";

import { ApiError, lookupAiCapabilityRoute } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";

/**
 * #369 — chat-availability signal, derived from the SAME onboarding status #365 added.
 *
 * "A provider is connected" ⇔ at least one CLI provider has reached the persisted `ready`
 * lifecycle state (install → login → ready). Anything earlier (not_installed, installing,
 * installed, needs_login, error) is NOT chat-capable. This is provider-AGNOSTIC: it counts
 * any provider kind that is ready, never a specific provider/model.
 *
 * The member status variant carries no per-provider install state (member chat availability is
 * derived from other module endpoints, not here), so this conservatively returns false for it —
 * the empty-chat explainer then still offers the connect path, which is the safe default.
 */
export function hasConnectedProvider(status: OnboardingStatusResponse | undefined): boolean {
  if (status === undefined || status.role !== "founder") return false;
  return status.steps.cliAuth.providers.some((provider) => provider.installState === "ready");
}

/**
 * True when the signed-in user has a usable chat route (own provider or the shared setup), for
 * every role. Same source the chat drawer uses.
 */
export function useChatAvailable(): boolean {
  const route = useQuery({
    queryKey: queryKeys.ai.capability("chat"),
    queryFn: () => lookupAiCapabilityRoute("chat"),
    retry: false
  });
  return route.data?.route?.available === true;
}

/**
 * True iff `error` is the 400 the chat-turn route returns when no active chat-capable model is
 * configured (packages/chat live-routes maps the thrown config error to this stable 400). We
 * branch on the typed {@link ApiError} status + a tolerant message match so the UI can render the
 * friendly "connect a provider" explainer INSTEAD of surfacing the raw backend string.
 */
export function isNoActiveChatModelError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    /no active chat-capable model/i.test(error.message)
  );
}
