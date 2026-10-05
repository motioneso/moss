import type { QueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid, clearSessionUnsavedChanges } from "@moss/module-web-sdk";

export const outputDenialKey = (id: string) => ["meetings", "output-denied", id] as const;
const epochKey = (id: string) => ["meetings", "output-access-epoch", id] as const;
export function outputAccessEpoch(client: QueryClient, id: string): string | undefined {
  return client.getQueryData<string>(epochKey(id));
}
export function invalidateOutputAccess(client: QueryClient, id: string): void {
  clearSessionUnsavedChanges(client, `meetings:${id}:output:`);
  client.setQueryData(epochKey(id), randomUuid());
  client.setQueryData(outputDenialKey(id), true);
  client.removeQueries({ queryKey: ["meetings", "output-session", id] });
}
/** Only an authorized read started after the latest denial may reopen this surface. */
export function recoverOutputAccess(
  client: QueryClient,
  id: string,
  epoch: string | undefined,
  signal: AbortSignal
): void {
  if (!signal.aborted && outputAccessEpoch(client, id) === epoch)
    client.setQueryData(outputDenialKey(id), false);
}
export function isOutputAccessDenied(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ([401, 403].includes(error.status) ||
      (error.status === 404 && error.code === "meeting_not_found"))
  );
}
