import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Group, Note, PaneHead, Row, Select, Switch } from "@moss/settings-ui";
import type {
  CalendarAutomationMode,
  GetCalendarBriefingSettingsResponse,
  ListSourceBehaviorsResponse,
  PutSourceBehaviorResponse,
  UpdateCalendarBriefingSettingsRequest,
  UpdateCalendarBriefingSettingsResponse
} from "@moss/shared";

const CALENDAR_BEHAVIOR_ID = "calendar.briefings";
const SOURCE_BEHAVIORS_KEY = ["settings", "source-behaviors"] as const;
const CALENDAR_SETTINGS_KEY = ["calendar", "briefing-settings"] as const;

export const CALENDAR_MODE_OPTIONS: ReadonlyArray<{
  readonly value: CalendarAutomationMode;
  readonly label: string;
  readonly desc: string;
}> = [
  { value: "off", label: "Off", desc: "Do not create suggestions or actions." },
  { value: "suggest", label: "Suggest", desc: "Show a governed suggestion for review." },
  { value: "auto", label: "Auto", desc: "Run the scoped action without asking again." }
];

// Time blocks' "auto" tier (calendar_writeback) arms two unattended writers, not one: the chat
// gateway auto-running calendar.createEvent, and the background follow-through worker
// (buildCalendarFollowThroughPort.executeAutoActions) that reads the same tier and writes without
// a chat session at all. The shared CALENDAR_MODE_OPTIONS "auto" desc only names the first, so
// override it here for Time blocks specifically -- Prep tasks has no background writer and must
// keep the shared generic copy.
const CALENDAR_TIME_BLOCK_AUTO_DESC =
  "Create time blocks automatically, both when your assistant proposes them in chat and unattended in the background.";

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

function getSourceBehaviors() {
  return requestJson<ListSourceBehaviorsResponse>("/api/me/source-behaviors");
}

function putSourceBehavior(enabled: boolean) {
  return requestJson<PutSourceBehaviorResponse>(
    `/api/me/source-behaviors/${encodeURIComponent(CALENDAR_BEHAVIOR_ID)}`,
    { method: "PUT", body: { enabled } }
  );
}

function getCalendarSettings() {
  return requestJson<GetCalendarBriefingSettingsResponse>("/api/calendar/briefing-settings");
}

function patchCalendarSettings(body: UpdateCalendarBriefingSettingsRequest) {
  return requestJson<UpdateCalendarBriefingSettingsResponse>("/api/calendar/briefing-settings", {
    method: "PATCH",
    body
  });
}

export default function CalendarSettings() {
  const queryClient = useQueryClient();
  const sourceBehaviors = useQuery({ queryKey: SOURCE_BEHAVIORS_KEY, queryFn: getSourceBehaviors });
  const settingsQuery = useQuery({ queryKey: CALENDAR_SETTINGS_KEY, queryFn: getCalendarSettings });
  const behaviorMutation = useMutation({
    mutationFn: putSourceBehavior,
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: SOURCE_BEHAVIORS_KEY
      })
  });
  const settingsMutation = useMutation({
    mutationFn: patchCalendarSettings,
    onSuccess: (data) => queryClient.setQueryData(CALENDAR_SETTINGS_KEY, data)
  });

  const behaviorEnabled =
    sourceBehaviors.data?.sources
      .flatMap((source) => source.behaviors)
      .find((behavior) => behavior.id === CALENDAR_BEHAVIOR_ID)?.enabled ?? true;
  const settings = (settingsMutation.data ?? settingsQuery.data)?.settings;
  const prepTaskMode = settings?.prepTaskMode ?? "suggest";
  const timeBlockMode = settings?.timeBlockMode ?? "suggest";
  const prepTaskModeOption = CALENDAR_MODE_OPTIONS.find((option) => option.value === prepTaskMode);
  const timeBlockModeOption = CALENDAR_MODE_OPTIONS.find(
    (option) => option.value === timeBlockMode
  );
  const disabled =
    sourceBehaviors.isLoading ||
    settingsQuery.isLoading ||
    behaviorMutation.isPending ||
    settingsMutation.isPending;

  return (
    <>
      <PaneHead
        title="Calendar"
        desc="How calendar-derived signals show up in briefings, without bypassing normal task or time-block governance."
      />
      <Group title="Briefing signal">
        <Row
          name="Include calendar signal in briefings"
          desc="Use calendar-derived readiness signals instead of replaying the whole agenda."
          control={
            <Switch
              ariaLabel="Include calendar signal in briefings"
              checked={behaviorEnabled}
              disabled={disabled}
              onChange={(value) => behaviorMutation.mutate(value)}
            />
          }
        />
        <Row
          name="Look ahead two days"
          desc="Let the briefing flag prep-needed meetings coming up soon."
          control={
            <Switch
              ariaLabel="Look ahead two days"
              checked={(settings?.lookaheadDays ?? 2) === 2}
              disabled={disabled}
              onChange={(value) => settingsMutation.mutate({ lookaheadDays: value ? 2 : 0 })}
            />
          }
        />
      </Group>
      <Group title="Follow-through">
        <Row
          name="Prep tasks"
          desc={prepTaskModeOption?.desc ?? "How meeting prep becomes tasks."}
          control={
            <Select
              aria-label="Prep tasks"
              value={prepTaskMode}
              disabled={disabled}
              onChange={(event) =>
                settingsMutation.mutate({
                  prepTaskMode: event.currentTarget.value as CalendarAutomationMode
                })
              }
            >
              {CALENDAR_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          }
        />
        <Row
          name="Time blocks"
          desc={
            timeBlockMode === "auto"
              ? CALENDAR_TIME_BLOCK_AUTO_DESC
              : (timeBlockModeOption?.desc ?? "How calendar signals become time blocks.")
          }
          control={
            <Select
              aria-label="Time blocks"
              value={timeBlockMode}
              disabled={disabled}
              onChange={(event) =>
                settingsMutation.mutate({
                  timeBlockMode: event.currentTarget.value as CalendarAutomationMode
                })
              }
            >
              {CALENDAR_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          }
        />
      </Group>
      {sourceBehaviors.isError ||
      settingsQuery.isError ||
      behaviorMutation.isError ||
      settingsMutation.isError ? (
        <Note>Could not save calendar briefing settings. Try again.</Note>
      ) : null}
    </>
  );
}
