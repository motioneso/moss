import { Button } from "@moss/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge, Group, Note, PaneHead, Row, Switch } from "@moss/settings-ui";
import type { PutWellnessAiConsentRequest, WellnessAiConsentResponse } from "@moss/shared";

const AI_CONSENT_KEY = ["wellness", "ai-consent"] as const;

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

function getWellnessAiConsent(signal: AbortSignal): Promise<WellnessAiConsentResponse> {
  return requestJson<WellnessAiConsentResponse>("/api/wellness/ai-consent", { signal });
}

function putWellnessAiConsent(granted: boolean): Promise<WellnessAiConsentResponse> {
  return requestJson<WellnessAiConsentResponse>("/api/wellness/ai-consent", {
    method: "PUT",
    body: { granted } satisfies PutWellnessAiConsentRequest
  });
}

export default function WellnessSettings() {
  const queryClient = useQueryClient();
  const consentQuery = useQuery({
    queryKey: AI_CONSENT_KEY,
    queryFn: ({ signal }) => getWellnessAiConsent(signal)
  });
  const consentMutation = useMutation({
    mutationFn: putWellnessAiConsent,
    onMutate: () => queryClient.cancelQueries({ queryKey: AI_CONSENT_KEY, exact: true }),
    onSuccess: async (data) => {
      // A focus refresh or explicit retry may have started while the write was pending.
      // Cancel both that read and any pre-write read before publishing the server response.
      await queryClient.cancelQueries({ queryKey: AI_CONSENT_KEY, exact: true });
      queryClient.setQueryData(AI_CONSENT_KEY, data);
    }
  });

  const consent = consentQuery.data;
  const head = (
    <PaneHead title="Wellness" desc="What your assistant can read from your Wellness data." />
  );
  if (!consent)
    return (
      <>
        {head}
        <p role="status">
          {consentQuery.isError
            ? "Could not load Wellness AI access."
            : "Loading Wellness AI access…"}
        </p>
        {consentQuery.isError ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={consentMutation.isPending}
            onClick={() => void consentQuery.refetch()}
          >
            Try again
          </Button>
        ) : null}
      </>
    );
  const disabled = consentMutation.isPending;

  return (
    <>
      {head}
      <Group title="AI access">
        <Row
          name="Allow your assistant to read your wellness data"
          desc="When on, your assistant can read your mood check-ins and medication adherence to reference them in briefings and answer questions about them. Counts only - never a medication list. Turn off anytime; your assistant will explain how to re-enable if asked."
          control={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {consent?.explicit === null ? <Badge tone="neutral">Inherited</Badge> : null}
              <Switch
                ariaLabel="Allow your assistant to read your wellness data"
                checked={consent.effective}
                disabled={disabled}
                onChange={(value) => consentMutation.mutate(value)}
              />
            </span>
          }
        />
      </Group>
      {consentQuery.isError ? (
        <div role="status">
          <Note>Could not refresh Wellness AI access. Showing the last saved choice.</Note>
          <Button
            variant="secondary"
            size="sm"
            disabled={consentMutation.isPending}
            onClick={() => void consentQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {consentMutation.isError ? (
        <div role="alert">
          <Note>Could not save Wellness AI access. Try again.</Note>
        </div>
      ) : null}
      <Note>
        Disabling this does not turn off the Wellness module itself - you'll still log check-ins and
        meds; your assistant just won't see them.
      </Note>
    </>
  );
}
