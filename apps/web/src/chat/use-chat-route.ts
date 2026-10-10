import { useQuery } from "@tanstack/react-query";
import type { LookupAiCapabilityRouteResponse } from "@moss/shared";

import { lookupAiCapabilityRoute } from "../api/client";
import { queryKeys } from "../api/query-keys";

export function chatAvailableFromRoute(data: LookupAiCapabilityRouteResponse | undefined): boolean {
  return data?.route?.available === true;
}

/**
 * Asks the server whether chat has a model, again on every open, so a model
 * added after an earlier answer shows at once. A cached "unavailable" answer
 * is not trusted while that recheck is in flight.
 */
export function useChatRoute(open: boolean) {
  const query = useQuery({
    queryKey: queryKeys.ai.capability("chat"),
    queryFn: () => lookupAiCapabilityRoute("chat"),
    enabled: open,
    retry: false,
    staleTime: 0
  });
  const chatUnavailable = query.isSuccess && !chatAvailableFromRoute(query.data);

  return {
    lockedModelUnavailable: query.data?.route?.reason === "admin-pin-unavailable",
    chatUnavailable,
    rechecking: chatUnavailable && query.isFetching
  };
}
