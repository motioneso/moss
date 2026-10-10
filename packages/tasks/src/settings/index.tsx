import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Group, Note, PaneHead, Row, Switch } from "@moss/settings-ui";
import { Button } from "@moss/ui";
import type {
  TaskAgencyAutoExecuteResponse,
  UpdateTaskAgencyAutoExecuteRequest
} from "@moss/shared";

const AGENCY_AUTO_EXECUTE_KEY = ["tasks", "agency-auto-execute"] as const;

async function requestJson<T>(path: string, init?: RequestInit & { body?: unknown }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...init,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "include",
    headers
  });
  if (!response.ok) throw new Error(response.statusText || "Request failed");
  return (await response.json()) as T;
}

function getAgencyAutoExecute(): Promise<TaskAgencyAutoExecuteResponse> {
  return requestJson<TaskAgencyAutoExecuteResponse>("/api/tasks/agency-auto-execute");
}

function patchAgencyAutoExecute(enabled: boolean): Promise<TaskAgencyAutoExecuteResponse> {
  return requestJson<TaskAgencyAutoExecuteResponse>("/api/tasks/agency-auto-execute", {
    method: "PATCH",
    body: { enabled } satisfies UpdateTaskAgencyAutoExecuteRequest
  });
}

export default function TasksSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: AGENCY_AUTO_EXECUTE_KEY, queryFn: getAgencyAutoExecute });
  const mutation = useMutation({
    mutationFn: patchAgencyAutoExecute,
    onSuccess: (data) => queryClient.setQueryData(AGENCY_AUTO_EXECUTE_KEY, data)
  });

  const enabled = query.data?.enabled ?? false;
  const disabled = !query.data || mutation.isPending;

  return (
    <>
      <PaneHead title="Tasks" desc="How your assistant handles task changes from chat." />
      {query.isPending ? <p role="status">Loading task settings…</p> : null}
      {query.isError ? (
        <div role="alert">
          <Note>
            {query.data
              ? "Could not refresh task settings. Your last saved preference is shown."
              : "Could not load task settings. Your saved preference is unavailable."}
          </Note>
          <Button
            variant="secondary"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry loading
          </Button>
        </div>
      ) : null}
      <Group title="Assistant actions">
        <Row
          name="Let your assistant create and update tasks without asking"
          desc="When off, your assistant asks before creating, updating, scheduling, or completing tasks from chat."
          control={
            <Switch
              ariaLabel="Let your assistant create and update tasks without asking"
              checked={enabled}
              disabled={disabled}
              onChange={(value) => mutation.mutate(value)}
            />
          }
        />
      </Group>
      {mutation.isError ? (
        <div role="alert">
          <Note>
            Could not save task action preference. Your last confirmed preference is shown. Try
            again.
          </Note>
        </div>
      ) : null}
    </>
  );
}
