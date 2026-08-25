import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, MessageSquare, MessagesSquare, MoonStar, Sunrise } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ChatResponseStyle, NotificationDigestCadenceDto } from "@moss/shared";

import {
  DEFAULT_NOTIFICATIONS,
  notificationSensitivityHint,
  type NotificationSensitivity,
  type NotificationsSettings
} from "./settings-sample-data";
import {
  createBriefingDefinition,
  getChatSettings,
  getNotificationDigestPreference,
  getNotificationPreferences,
  getLocaleSettings,
  listSourceBehaviors,
  listAiAssistantTools,
  listBriefingDefinitions,
  lookupAiCapabilityRoute,
  putChatSettings,
  putNotificationDigestPreference,
  putNotificationPreference,
  putSourceBehavior,
  updateBriefingDefinition
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import {
  createDefinitionRequest,
  findDefinition,
  readSourceLabels,
  readToolNames,
  sourceListDescription,
  targetTimeFor,
  updateDefinitionRequest
} from "../briefings/briefing-settings-model";
import {
  Badge,
  Choice,
  Field,
  Group,
  NotWired,
  Note,
  Row,
  Segmented,
  Select,
  Switch
} from "./settings-ui";
import {
  BRIEFING_SOURCE_BEHAVIORS,
  findSourceBehaviorEnabled,
  writeSourceBehaviorCache
} from "./settings-source-behaviors";

// BACKEND-TODO: persist + apply Notifications sensitivity.

const DIGEST_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

/* Shared takeover chrome for a settings-only module. */
export function ModuleSub(props: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly sub: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="gflow">
      <button type="button" className="gflow__back" onClick={props.onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        Back to modules
      </button>
      <div className="gflow__intro">
        <span className="msub__mark">{props.icon}</span>
        <div className="gflow__introtx">
          <div className="gflow__title">{props.name}</div>
          <div className="gflow__sub">{props.sub}</div>
        </div>
      </div>
      {props.children}
    </div>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Could not update settings";
}

export function BriefingSettings(props: { readonly onBack: () => void }) {
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const definitionsQuery = useQuery({
    queryKey: queryKeys.briefings.definitions,
    queryFn: listBriefingDefinitions
  });
  const toolsQuery = useQuery({
    queryKey: queryKeys.ai.assistantTools,
    queryFn: listAiAssistantTools
  });
  const sourceBehaviorsQuery = useQuery({
    queryKey: queryKeys.settings.sourceBehaviors,
    queryFn: listSourceBehaviors,
    retry: false
  });
  const localeQuery = useQuery({
    queryKey: queryKeys.settings.locale,
    queryFn: getLocaleSettings
  });
  const localTimezone = localeQuery.data?.locale.timezone;
  const definitions = definitionsQuery.data?.definitions ?? [];
  const selectedToolNames = readToolNames(toolsQuery.data?.tools ?? []);
  const sourceLabels = readSourceLabels(toolsQuery.data?.tools ?? []);
  const morning = findDefinition(definitions, "morning");
  const evening = findDefinition(definitions, "evening");
  const mutation = useMutation({
    mutationFn: async (input: {
      readonly type: "morning" | "evening";
      readonly enabled?: boolean;
      readonly targetTime?: string;
    }) => {
      const current = findDefinition(definitions, input.type);
      if (current) {
        return updateBriefingDefinition(
          current.id,
          updateDefinitionRequest(current, {
            enabled: input.enabled,
            targetTime: input.targetTime
          })
        );
      }
      if (selectedToolNames.length === 0) {
        throw new Error("No read tools available for briefings");
      }
      return createBriefingDefinition(
        createDefinitionRequest({
          briefingType: input.type,
          enabled: input.enabled,
          targetTime: input.targetTime,
          selectedToolNames,
          timezone: localTimezone
        })
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefings.definitions });
    }
  });
  const sourceBehaviorMutation = useMutation({
    mutationFn: (input: { readonly id: string; readonly enabled: boolean }) =>
      putSourceBehavior(input.id, { enabled: input.enabled }),
    onSuccess: (data) => writeSourceBehaviorCache(queryClient, data)
  });
  const busy =
    definitionsQuery.isLoading ||
    toolsQuery.isLoading ||
    sourceBehaviorsQuery.isLoading ||
    mutation.isPending ||
    sourceBehaviorMutation.isPending ||
    selectedToolNames.length === 0;
  const error =
    definitionsQuery.error ??
    toolsQuery.error ??
    sourceBehaviorsQuery.error ??
    mutation.error ??
    sourceBehaviorMutation.error;

  return (
    <ModuleSub
      icon={<Sunrise size={21} aria-hidden="true" />}
      name="Briefings"
      sub="Your daily reading ritual"
      onBack={props.onBack}
    >
      {error ? <NotWired>{readError(error)}</NotWired> : null}
      <Group
        title="Cadence"
        desc={`When ${assistantName} prepares your reading. It waits for you — nothing is pushed before this.`}
      >
        <Field
          label="Morning briefing"
          hint="Ready when you wake. Tone follows your assistant persona."
        >
          <input
            className="jds-input"
            type="time"
            value={targetTimeFor(morning, "morning")}
            disabled={busy}
            onChange={(e) => mutation.mutate({ type: "morning", targetTime: e.target.value })}
            aria-label="Morning briefing time"
          />
        </Field>
        <Row
          name="Evening wind-down"
          desc="A short look back, and a glance at tomorrow."
          control={
            <Switch
              ariaLabel="Evening wind-down"
              checked={evening?.enabled ?? false}
              onChange={(v) => mutation.mutate({ type: "evening", enabled: v })}
              disabled={busy}
            />
          }
        />
        {evening?.enabled ? (
          <Field label="Evening time">
            <input
              className="jds-input"
              type="time"
              value={targetTimeFor(evening, "evening")}
              disabled={busy}
              onChange={(e) => mutation.mutate({ type: "evening", targetTime: e.target.value })}
              aria-label="Evening time"
            />
          </Field>
        ) : null}
      </Group>

      <Group title="Sources">
        <Row name="Read tools" desc={sourceListDescription(sourceLabels)} />
        {BRIEFING_SOURCE_BEHAVIORS.map((behavior) => (
          <Row
            key={behavior.id}
            name={behavior.label}
            desc={behavior.description}
            control={
              <Switch
                ariaLabel={behavior.label}
                checked={findSourceBehaviorEnabled(
                  sourceBehaviorsQuery.data?.sources ?? [],
                  behavior.id
                )}
                disabled={busy}
                onChange={(enabled) => sourceBehaviorMutation.mutate({ id: behavior.id, enabled })}
              />
            }
          />
        ))}
      </Group>
    </ModuleSub>
  );
}

export function ChatSettingsView(props: {
  readonly onBack: () => void;
  readonly onCat?: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  const settingsQuery = useQuery({
    queryKey: queryKeys.chat.settings,
    queryFn: getChatSettings
  });
  const mutation = useMutation({
    mutationFn: putChatSettings,
    onSuccess: (data) => queryClient.setQueryData(queryKeys.chat.settings, data)
  });
  const style = settingsQuery.data?.chat.responseStyle ?? "balanced";
  const error = settingsQuery.error ?? mutation.error;

  // Voice input (#738) has no settings of its own here — Chat settings only reflects whether the
  // shared "transcription" AI capability route is configured+healthy, and links out to the one
  // place that configures it. No duplicate provider UI, no separate "enable voice" toggle.
  const transcriptionRouteQuery = useQuery({
    queryKey: queryKeys.ai.capability("transcription"),
    queryFn: () => lookupAiCapabilityRoute("transcription")
  });
  const voiceAvailable = Boolean(transcriptionRouteQuery.data?.route?.available);

  return (
    <ModuleSub
      icon={<MessagesSquare size={21} aria-hidden="true" />}
      name="Chat"
      sub={`How ${assistantName} talks with you`}
      onBack={props.onBack}
    >
      {error ? <NotWired>{readError(error)}</NotWired> : null}
      <Group title="Replies">
        <Choice
          key={style}
          label="Response style"
          hint="Saved default for generated chat answers."
          value={cap(style)}
          options={["Concise", "Balanced", "Detailed"]}
          onChange={(v) =>
            mutation.mutate({ chat: { responseStyle: v.toLowerCase() as ChatResponseStyle } })
          }
        />
      </Group>

      <Group title="Input">
        <Row
          name="Voice input"
          desc={
            voiceAvailable
              ? "A transcription model is configured — tap the mic in the composer to dictate."
              : "Set up a transcription model in Assistant & AI (admin) to enable the composer's mic."
          }
          control={
            voiceAvailable ? (
              <Badge tone="forest">Ready</Badge>
            ) : (
              <button
                type="button"
                className="note__link"
                onClick={() => props.onCat?.("aiproviders")}
              >
                Set up
              </button>
            )
          }
        />
      </Group>
      <Note icon={<MessageSquare size={13} />}>
        {assistantName}'s voice and directness are set once in{" "}
        <button type="button" className="note__link" onClick={() => props.onCat?.("assistant")}>
          Assistant &amp; AI
        </button>
        , these only shape the chat surface.
      </Note>
    </ModuleSub>
  );
}

export function NotificationSettings(props: {
  readonly onBack: () => void;
  readonly onCat?: (id: string) => void;
  readonly onModuleSettings?: (id: "briefings") => void;
}) {
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const [state, setState] = useState<NotificationsSettings>(DEFAULT_NOTIFICATIONS);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<NotificationsSettings>) => setState((s) => ({ ...s, ...patch }));
  const preferencesQuery = useQuery({
    queryKey: queryKeys.settings.notificationPreferences,
    queryFn: getNotificationPreferences,
    retry: false
  });
  const digestQuery = useQuery({
    queryKey: queryKeys.settings.notificationDigest,
    queryFn: getNotificationDigestPreference,
    retry: false
  });
  // #877 finding 4: the digest schedule save used to read the browser-ambient
  // Intl-resolved runtime zone, which can differ from the user's persisted
  // locale. Fetch it the same way the briefings pane above does
  // (BriefingSettings' localeQuery, ~117).
  const localeQuery = useQuery({
    queryKey: queryKeys.settings.locale,
    queryFn: getLocaleSettings
  });
  const localTimezone = localeQuery.data?.locale.timezone;
  const mutation = useMutation({
    mutationFn: (input: {
      readonly moduleId: string;
      readonly enabled: boolean;
      readonly clearUnread?: boolean;
    }) =>
      putNotificationPreference(input.moduleId, {
        enabled: input.enabled,
        clearUnread: input.clearUnread
      }),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(queryKeys.settings.notificationPreferences, (current) => {
        const existing = current as
          | Awaited<ReturnType<typeof getNotificationPreferences>>
          | undefined;
        return {
          preferences: (existing?.preferences ?? []).map((preference) =>
            preference.moduleId === data.preference.moduleId ? data.preference : preference
          )
        };
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list });
    },
    onError: (err) => setError(readError(err))
  });
  const digestMutation = useMutation({
    mutationFn: putNotificationDigestPreference,
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(queryKeys.settings.notificationDigest, data);
    },
    onError: (err) => setError(readError(err))
  });
  const toggleModule = (moduleId: string, enabled: boolean) => {
    const clearUnread =
      !enabled && window.confirm("Mark existing unread notifications from this module as read?");
    mutation.mutate({ moduleId, enabled, clearUnread });
  };
  const preferences = preferencesQuery.data?.preferences ?? [];
  const digest = digestQuery.data?.digest;
  const digestBusy = digestQuery.isLoading || digestMutation.isPending;
  const updateDigest = (
    patch: Partial<{
      enabled: boolean;
      cadence: NotificationDigestCadenceDto;
      targetTime: string;
      dayOfWeek: number;
    }>
  ) => {
    const current = digest ?? {
      enabled: false,
      cadence: "daily" as const,
      scheduleMetadata: {
        targetTime: "07:00",
        // #877 finding 4: use the persisted locale tz (matching the briefings
        // pane's ~148 pattern), not the browser-ambient runtime zone — falls
        // back to UTC only until /api/me/locale resolves.
        timezone: localTimezone ?? "UTC",
        dayOfWeek: undefined
      }
    };
    digestMutation.mutate({
      digest: {
        enabled: patch.enabled ?? current.enabled,
        cadence: patch.cadence ?? current.cadence,
        scheduleMetadata: {
          targetTime: patch.targetTime ?? current.scheduleMetadata.targetTime,
          // #877 finding 4: a digest saved before this fix (or created by the
          // server's own "UTC" default) has scheduleMetadata.timezone stuck at
          // "UTC". Upgrade only that default to the persisted locale on the
          // next save; an explicit prior choice (anything else) is the user's
          // and must be preserved, not silently overwritten.
          timezone:
            current.scheduleMetadata.timezone === "UTC"
              ? (localTimezone ?? current.scheduleMetadata.timezone)
              : current.scheduleMetadata.timezone,
          dayOfWeek: patch.dayOfWeek ?? current.scheduleMetadata.dayOfWeek
        }
      }
    });
  };

  return (
    <ModuleSub
      icon={<Bell size={21} aria-hidden="true" />}
      name="Notifications"
      sub="What's worth surfacing, and how loudly"
      onBack={props.onBack}
    >
      <Group title="Sensitivity" desc={`How readily ${assistantName} interrupts you.`}>
        <div className="nsens">
          <Segmented<NotificationSensitivity>
            value={state.sensitivity}
            options={[
              { value: "quiet", label: "Quiet" },
              { value: "balanced", label: "Balanced" },
              { value: "proactive", label: "Proactive" }
            ]}
            ariaLabel="Sensitivity"
            onChange={(v) => set({ sensitivity: v })}
          />
          <div className="nsens__hint">
            {notificationSensitivityHint(assistantName)[state.sensitivity]}
          </div>
        </div>
      </Group>

      <Group title="Channels" desc="Where notifications reach you.">
        <Row
          name="In-app"
          desc={`The notification center inside ${assistantName}.`}
          control={<Badge tone="forest">Enabled</Badge>}
        />
        <Row name="Push" desc="System notifications on this device." comingIssue={743} />
        <Row
          name="Email digest"
          desc={
            digest?.available === false
              ? digest.unavailableReason === "no_enabled_modules"
                ? "Enable at least one module first."
                : "Connect Google or IMAP email first."
              : "A scheduled summary sent through your connected email account."
          }
          control={
            <Switch
              ariaLabel="Email digest"
              checked={digest?.enabled ?? false}
              disabled={digestBusy || digest?.available !== true}
              onChange={(enabled) => updateDigest({ enabled })}
            />
          }
        />
        {digest?.enabled ? (
          <>
            <Field label="Digest cadence">
              <Segmented<NotificationDigestCadenceDto>
                value={digest.cadence}
                options={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" }
                ]}
                ariaLabel="Digest cadence"
                onChange={(cadence) => updateDigest({ cadence })}
              />
            </Field>
            <Field label="Send time">
              <input
                className="jds-input"
                type="time"
                value={digest.scheduleMetadata.targetTime}
                disabled={digestBusy}
                onChange={(event) => updateDigest({ targetTime: event.target.value })}
                aria-label="Digest send time"
              />
            </Field>
            {digest.cadence === "weekly" ? (
              <Field label="Send day">
                <Select
                  value={String(digest.scheduleMetadata.dayOfWeek ?? 1)}
                  disabled={digestBusy}
                  aria-label="Digest send day"
                  onChange={(event) => updateDigest({ dayOfWeek: Number(event.target.value) })}
                >
                  {DIGEST_WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </>
        ) : null}
      </Group>

      <Group title="Modules" desc="Mute a module without changing its own settings.">
        {error ? <NotWired>{error}</NotWired> : null}
        {preferences.length ? (
          preferences.map((preference) => (
            <Row
              key={preference.moduleId}
              name={preference.moduleName}
              desc={
                preference.moduleId === "briefings" ? (
                  <>
                    Briefing-ready notifications.{" "}
                    <button
                      type="button"
                      className="note__link"
                      onClick={() => props.onModuleSettings?.("briefings")}
                    >
                      Configure
                    </button>
                  </>
                ) : (
                  "Module notifications."
                )
              }
              control={
                <Switch
                  ariaLabel={`Notify from ${preference.moduleName}`}
                  checked={preference.enabled}
                  disabled={mutation.isPending}
                  onChange={(enabled) => toggleModule(preference.moduleId, enabled)}
                />
              }
            />
          ))
        ) : (
          <Row
            name={preferencesQuery.isLoading ? "Loading modules..." : "No module notifications"}
            desc={
              preferencesQuery.isLoading
                ? "Checking enabled modules."
                : "Enabled notification-capable modules will appear here."
            }
          />
        )}
      </Group>
      <Note icon={<MoonStar size={13} />}>
        Quiet hours always win — {assistantName} stays silent then unless something is urgent. Set
        them in{" "}
        <button type="button" className="note__link" onClick={() => props.onCat?.("general")}>
          General
        </button>
        .
      </Note>
    </ModuleSub>
  );
}
