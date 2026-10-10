import { Button } from "@moss/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Group, Note, PaneHead, Row, Select, Switch } from "@moss/settings-ui";
import type {
  AiActionPolicyTier,
  EmailTaskCreationMode,
  EmailTaskCreationModeResponse,
  GetAiActionPoliciesResponse,
  GetEmailBriefingSettingsResponse,
  ListSourceBehaviorsResponse,
  PatchAiActionPolicyResponse,
  PutSourceBehaviorResponse,
  UpdateEmailTaskCreationModeRequest,
  UpdateEmailBriefingSettingsRequest,
  UpdateEmailBriefingSettingsResponse
} from "@moss/shared";
import { DEFAULT_EMAIL_TASK_MODE } from "@moss/shared";

const EMAIL_BEHAVIOR_ID = "email.briefings";
const DRAFTS_MODULE_ID = "email";
const DRAFTS_FAMILY_ID = "email_drafts";
const SOURCE_BEHAVIORS_KEY = ["settings", "source-behaviors"] as const;
const EMAIL_SETTINGS_KEY = ["email", "briefing-settings"] as const;
const EMAIL_TASK_MODE_KEY = ["email", "task-mode"] as const;
const ACTION_POLICY_KEY = ["ai", "action-policy"] as const;

export const EMAIL_TASK_MODE_OPTIONS: ReadonlyArray<{
  readonly value: EmailTaskCreationMode;
  readonly label: string;
  readonly desc: string;
}> = [
  { value: "off", label: "Off", desc: "Never create tasks from email." },
  { value: "suggest", label: "Suggest", desc: "Stage suggestions for your review (default)." },
  {
    value: "auto_safe",
    label: "Auto for safe items",
    desc: "Auto-add bills and hard deadlines; stage the rest."
  },
  { value: "auto", label: "Auto", desc: "Auto-add anything your assistant is confident about." }
];

// The "draft replies without asking" toggle maps the generic email_drafts action
// policy between the two tiers the family allows: ON = trusted_auto (auto-execute
// the draft after the model proposes it), OFF = ask_each_time (confirm each draft).
// Default OFF when no policy row exists yet — private-by-default.
export function draftAutoTierFromPolicies(
  policies: GetAiActionPoliciesResponse["policies"]
): AiActionPolicyTier {
  return (
    policies.find(
      (policy) => policy.moduleId === DRAFTS_MODULE_ID && policy.actionFamilyId === DRAFTS_FAMILY_ID
    )?.tier ?? "ask_each_time"
  );
}

export function draftAutoChecked(tier: AiActionPolicyTier): boolean {
  return tier === "trusted_auto";
}

export function draftAutoTierFromChecked(checked: boolean): AiActionPolicyTier {
  return checked ? "trusted_auto" : "ask_each_time";
}

async function requestJson<T>(
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: unknown }
): Promise<T> {
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

function getSourceBehaviors(signal: AbortSignal) {
  return requestJson<ListSourceBehaviorsResponse>("/api/me/source-behaviors", { signal });
}

function putSourceBehavior(enabled: boolean) {
  return requestJson<PutSourceBehaviorResponse>(
    `/api/me/source-behaviors/${encodeURIComponent(EMAIL_BEHAVIOR_ID)}`,
    {
      method: "PUT",
      body: { enabled }
    }
  );
}

function getEmailSettings(signal: AbortSignal) {
  return requestJson<GetEmailBriefingSettingsResponse>("/api/email/briefing-settings", { signal });
}

function patchEmailSettings(body: UpdateEmailBriefingSettingsRequest) {
  return requestJson<UpdateEmailBriefingSettingsResponse>("/api/email/briefing-settings", {
    method: "PATCH",
    body
  });
}

function getEmailTaskMode(signal: AbortSignal) {
  return requestJson<EmailTaskCreationModeResponse>("/api/email/task-creation-mode", { signal });
}

function putEmailTaskMode(body: UpdateEmailTaskCreationModeRequest) {
  return requestJson<EmailTaskCreationModeResponse>("/api/email/task-creation-mode", {
    method: "PUT",
    body
  });
}

function getActionPolicies(signal: AbortSignal) {
  return requestJson<GetAiActionPoliciesResponse>("/api/ai/action-policy", { signal });
}

function patchDraftPolicy(tier: AiActionPolicyTier) {
  return requestJson<PatchAiActionPolicyResponse>(
    `/api/ai/action-policy/${encodeURIComponent(DRAFTS_MODULE_ID)}/${encodeURIComponent(DRAFTS_FAMILY_ID)}`,
    {
      method: "PATCH",
      body: { tier }
    }
  );
}

export default function EmailSettings() {
  const queryClient = useQueryClient();
  const sourceBehaviors = useQuery({
    queryKey: SOURCE_BEHAVIORS_KEY,
    queryFn: ({ signal }) => getSourceBehaviors(signal)
  });
  const settingsQuery = useQuery({
    queryKey: EMAIL_SETTINGS_KEY,
    queryFn: ({ signal }) => getEmailSettings(signal)
  });
  const behaviorMutation = useMutation({
    mutationFn: putSourceBehavior,
    onMutate: () => queryClient.cancelQueries({ queryKey: SOURCE_BEHAVIORS_KEY, exact: true }),
    onSuccess: async (data) => {
      await queryClient.cancelQueries({ queryKey: SOURCE_BEHAVIORS_KEY, exact: true });
      queryClient.setQueryData(SOURCE_BEHAVIORS_KEY, data);
    }
  });
  const settingsMutation = useMutation({
    mutationFn: patchEmailSettings,
    onMutate: () => queryClient.cancelQueries({ queryKey: EMAIL_SETTINGS_KEY, exact: true }),
    onSuccess: async (data) => {
      // A focus refresh or retry can start during the mutation, after onMutate's cancellation.
      // Only the successful server response may replace the confirmed choice at this point.
      await queryClient.cancelQueries({ queryKey: EMAIL_SETTINGS_KEY, exact: true });
      queryClient.setQueryData(EMAIL_SETTINGS_KEY, data);
    }
  });
  const taskModeQuery = useQuery({
    queryKey: EMAIL_TASK_MODE_KEY,
    queryFn: ({ signal }) => getEmailTaskMode(signal)
  });
  const taskModeMutation = useMutation({
    mutationFn: (mode: EmailTaskCreationMode) => putEmailTaskMode({ mode }),
    onMutate: () => queryClient.cancelQueries({ queryKey: EMAIL_TASK_MODE_KEY, exact: true }),
    onSuccess: async (data) => {
      await queryClient.cancelQueries({ queryKey: EMAIL_TASK_MODE_KEY, exact: true });
      queryClient.setQueryData(EMAIL_TASK_MODE_KEY, data);
    }
  });
  const policiesQuery = useQuery({
    queryKey: ACTION_POLICY_KEY,
    queryFn: ({ signal }) => getActionPolicies(signal)
  });
  const draftPolicyMutation = useMutation({
    mutationFn: patchDraftPolicy,
    onMutate: () => queryClient.cancelQueries({ queryKey: ACTION_POLICY_KEY, exact: true }),
    onSuccess: async (data) => {
      await queryClient.cancelQueries({ queryKey: ACTION_POLICY_KEY, exact: true });
      queryClient.setQueryData<GetAiActionPoliciesResponse>(ACTION_POLICY_KEY, (previous) => ({
        policies: [
          ...(previous?.policies ?? []).filter(
            (policy) =>
              policy.moduleId !== data.moduleId || policy.actionFamilyId !== data.actionFamilyId
          ),
          data
        ]
      }));
    }
  });

  const behaviorEnabled =
    sourceBehaviors.data?.sources
      .flatMap((source) => source.behaviors)
      .find((behavior) => behavior.id === EMAIL_BEHAVIOR_ID)?.enabled ?? true;
  const settings = settingsQuery.data?.settings;
  const taskMode = taskModeQuery.data?.mode ?? DEFAULT_EMAIL_TASK_MODE;
  const taskModeOption = EMAIL_TASK_MODE_OPTIONS.find((option) => option.value === taskMode);
  const draftAutoTier = draftAutoTierFromPolicies(policiesQuery.data?.policies ?? []);
  const hasReadError =
    sourceBehaviors.isError ||
    settingsQuery.isError ||
    taskModeQuery.isError ||
    policiesQuery.isError;
  const anyWritePending =
    behaviorMutation.isPending ||
    settingsMutation.isPending ||
    taskModeMutation.isPending ||
    draftPolicyMutation.isPending;
  const retryReads = () => {
    if (anyWritePending) return;
    void sourceBehaviors.refetch();
    void settingsQuery.refetch();
    void taskModeQuery.refetch();
    void policiesQuery.refetch();
  };
  const head = (
    <PaneHead
      title="Email"
      desc="How important email appears in briefings and becomes tasks and replies."
    />
  );
  if (!sourceBehaviors.data || !settings || !taskModeQuery.data || !policiesQuery.data)
    return (
      <>
        {head}
        <p role="status">
          {hasReadError ? "Could not load email settings." : "Loading email settings…"}
        </p>
        {hasReadError ? (
          <Button variant="secondary" size="sm" disabled={anyWritePending} onClick={retryReads}>
            Try again
          </Button>
        ) : null}
      </>
    );
  const disabled =
    behaviorMutation.isPending || settingsMutation.isPending || taskModeMutation.isPending;
  const draftPolicyDisabled = draftPolicyMutation.isPending;

  return (
    <>
      {head}
      <Group title="Briefing signal">
        <Row
          name="Include email signal in briefings"
          desc="Surface the specific threads that matter instead of inbox volume."
          control={
            <Switch
              ariaLabel="Include email signal in briefings"
              checked={behaviorEnabled}
              disabled={disabled}
              onChange={(value) => behaviorMutation.mutate(value)}
            />
          }
        />
      </Group>
      <Group title="Follow-through">
        <Row
          name="Task creation"
          desc={taskModeOption?.desc ?? "How email becomes tasks."}
          control={
            <Select
              value={taskMode}
              aria-label="Email task creation mode"
              disabled={disabled}
              onChange={(event) =>
                taskModeMutation.mutate(event.currentTarget.value as EmailTaskCreationMode)
              }
            >
              {EMAIL_TASK_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          }
        />
        <Row
          name="Create tasks from email signals"
          desc="Allow briefing-worthy email to become task proposals through the normal task action loop."
          control={
            <Switch
              ariaLabel="Create tasks from email signals"
              checked={settings?.createTasks ?? true}
              disabled={disabled}
              onChange={(value) => settingsMutation.mutate({ createTasks: value })}
            />
          }
        />
        <Row
          name="Suggest replies"
          desc="Let the briefing call out the specific thread that likely needs a reply."
          control={
            <Switch
              ariaLabel="Suggest replies"
              checked={settings?.suggestReplies ?? true}
              disabled={disabled}
              onChange={(value) => settingsMutation.mutate({ suggestReplies: value })}
            />
          }
        />
        <Row
          name="Draft replies"
          desc="Permit draft generation through normal email tooling when that path is available."
          control={
            <Switch
              ariaLabel="Draft replies"
              checked={settings?.draftReplies ?? true}
              disabled={disabled}
              onChange={(value) => settingsMutation.mutate({ draftReplies: value })}
            />
          }
        />
        <Row
          name="Auto-send replies"
          desc="Sending still follows your email approval rules. Turning this on does not change those rules."
          control={
            <Switch
              ariaLabel="Auto-send replies"
              checked={settings?.autoSend ?? false}
              disabled={disabled}
              onChange={(value) => settingsMutation.mutate({ autoSend: value })}
            />
          }
        />
      </Group>
      <Group title="Reply agency">
        <Row
          name="Let your assistant draft email replies without asking"
          desc="When on, your assistant saves reply drafts to the original Gmail thread automatically. Drafts never send on their own — you still open and send them yourself."
          control={
            <Switch
              ariaLabel="Let your assistant draft email replies without asking"
              checked={draftAutoChecked(draftAutoTier)}
              disabled={draftPolicyDisabled}
              onChange={(value) => draftPolicyMutation.mutate(draftAutoTierFromChecked(value))}
            />
          }
        />
      </Group>
      {hasReadError ? (
        <div role="status">
          <Note>Could not refresh email settings. Showing the last saved choices.</Note>
          <Button variant="secondary" size="sm" disabled={anyWritePending} onClick={retryReads}>
            Try again
          </Button>
        </div>
      ) : null}
      {behaviorMutation.isError ||
      settingsMutation.isError ||
      taskModeMutation.isError ||
      draftPolicyMutation.isError ? (
        <div role="alert">
          <Note>Could not save email settings. Try again.</Note>
        </div>
      ) : null}
    </>
  );
}
