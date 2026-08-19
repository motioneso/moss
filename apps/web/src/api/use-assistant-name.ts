import { useQuery } from "@tanstack/react-query";

import { getPersonaSettings } from "./client.js";
import { queryKeys } from "./query-keys.js";

// Single source for the user-configured assistant name (Settings → AI persona).
// Falls back to "Moss" before the persona query resolves or if it fails, so
// callers can drop it straight into copy like `Chat with {name}`. The product
// rename (#1441) landed; this hook remains the one seam for the assistant's
// display name, distinct from the fixed product name "Moss".
export function useAssistantName(pendingFallback = "Moss"): string {
  const query = useQuery({
    queryKey: queryKeys.settings.persona,
    queryFn: getPersonaSettings,
    retry: false
  });
  return query.data?.persona.assistantName?.trim() || (query.isLoading ? pendingFallback : "Moss");
}
