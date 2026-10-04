import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "@moss/module-web-sdk";
import { isMeetingAccessDenied, meetingKeys } from "./client.js";
import { outputKeys } from "./output-client.js";
import {
  invalidateOutputAccess,
  isOutputAccessDenied,
  outputAccessEpoch,
  outputDenialKey
} from "./output-access.js";

export interface OutputOperation<T> {
  readonly input: T;
  readonly status: "running" | "retry" | "pending" | "failed" | "done";
  readonly message: string;
}
export function denyMeetingOutputs(client: QueryClient, id: string, error: unknown): boolean {
  if (!isOutputAccessDenied(error)) return false;
  invalidateOutputAccess(client, id);
  void client.invalidateQueries({ queryKey: meetingKeys.record(id), exact: true });
  return true;
}
/** Session-only recovery; query removal on sign-out/denial invalidates late callbacks. */
export function useOutputSession<T extends object>(id: string, scope: string, initial: () => T) {
  const client = useQueryClient();
  const key = [...outputKeys.session(id), scope];
  const denialKey = outputDenialKey(id);
  const denial = useQuery({
    queryKey: denialKey,
    queryFn: () => false,
    initialData: false,
    enabled: false,
    gcTime: Infinity
  });
  const query = useQuery<T>({
    queryKey: key,
    queryFn: initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity
  });
  const identity = client.getQueryCache().find({ queryKey: key, exact: true });
  const epoch = outputAccessEpoch(client, id);
  const currentIdentity = () =>
    client.getQueryCache().find({ queryKey: key, exact: true }) === identity &&
    outputAccessEpoch(client, id) === epoch;
  const update = (change: (current: T) => T) =>
    client.setQueryData<T>(key, (current) => (current === undefined ? undefined : change(current)));
  const authorized = () =>
    currentIdentity() &&
    client.getQueryData(key) !== undefined &&
    client.getQueryData(denialKey) !== true &&
    !isMeetingAccessDenied(client.getQueryState(meetingKeys.record(id))?.error) &&
    !isMeetingAccessDenied(client.getQueryState(outputKeys.list(id))?.error);
  const deny = (error: unknown) => !currentIdentity() || denyMeetingOutputs(client, id, error);
  return { state: query.data, update, authorized, deny, denied: denial.data, client, key };
}
export function operationError(error: unknown): { status: "retry" | "failed"; message: string } {
  if (isMeetingAccessDenied(error))
    return {
      status: "failed",
      message: "Access is unavailable. Return to history or sign in again."
    };
  if (error instanceof ApiError && error.status === 409)
    return {
      status: "failed",
      message:
        "The saved version changed or needs review. Refresh before trying a new request. Your edits are kept."
    };
  if (error instanceof ApiError && [400, 422].includes(error.status))
    return {
      status: "failed",
      message: "This request could not be completed. Review the inputs and try a new request."
    };
  return {
    status: "retry",
    message: "The result could not be confirmed. Retry this same request."
  };
}
