import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, MoonStar, Sunrise } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { NotificationDigestCadenceDto, PushDeviceDto } from "@moss/shared";
import { Button } from "@moss/ui";

import {
  DEFAULT_NOTIFICATIONS,
  notificationSensitivityHint,
  type NotificationSensitivity,
  type NotificationsSettings
} from "./settings-sample-data";
import {
  createBriefingDefinition,
  deletePushSubscription,
  getNotificationDigestPreference,
  getNotificationPreferences,
  getLocaleSettings,
  getPushConfig,
  listSourceBehaviors,
  listAiAssistantTools,
  listBriefingDefinitions,
  putNotificationDigestPreference,
  putNotificationPreference,
  putSourceBehavior,
  registerPushSubscription,
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
import { Badge, Field, Group, NotWired, Note, Row, Segmented, Select, Switch } from "./settings-ui";
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
        <PushChannel />
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

// #743 / #2227: web push. There is no server-computed device fingerprint (the plan's
// endpointHash field was dropped to keep the DTO small — one design call made without asking),
// so "This device" is decided locally: the id the server hands back on subscribe is cached in
// localStorage and compared against the device list on every load.
const PUSH_DEVICE_ID_STORAGE_KEY = "moss.push.deviceId";

function pushIsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64Url: string): BufferSource {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function PushChannel() {
  const queryClient = useQueryClient();
  const supported = pushIsSupported();
  const [permission, setPermission] = useState<NotificationPermission | null>(
    supported ? Notification.permission : null
  );
  const [deviceId, setDeviceId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(PUSH_DEVICE_ID_STORAGE_KEY)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: queryKeys.settings.notificationPush,
    queryFn: getPushConfig,
    enabled: supported && permission !== "denied"
  });

  const removeMutation = useMutation({
    mutationFn: (device: PushDeviceDto) => deletePushSubscription(device.id),
    onSuccess: (_result, device) => {
      if (device.id === deviceId) {
        window.localStorage.removeItem(PUSH_DEVICE_ID_STORAGE_KEY);
        setDeviceId(null);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.notificationPush });
    },
    onError: (err) => setError(readError(err))
  });

  const enable = async () => {
    setError(null);
    setBusy(true);
    try {
      const requested = await Notification.requestPermission();
      setPermission(requested);
      if (requested !== "granted") {
        return;
      }
      const config = configQuery.data ?? (await configQuery.refetch()).data;
      if (!config) {
        throw new Error("Couldn't load push settings from the server.");
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey)
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("The browser didn't return a usable subscription.");
      }
      const result = await registerPushSubscription({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
      });
      window.localStorage.setItem(PUSH_DEVICE_ID_STORAGE_KEY, result.device.id);
      setDeviceId(result.device.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.notificationPush });
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <Row
        name="Push"
        desc="Not available here: this browser doesn't support push, or the page isn't loaded over a secure connection."
      />
    );
  }

  if (permission === "denied") {
    return (
      <Row
        name="Push"
        desc="Blocked in this browser's site settings. Allow notifications for this site, then reload the page."
      />
    );
  }

  const devices = configQuery.data?.enabledDevices ?? [];

  return (
    <>
      <Row
        name="Push"
        desc="System notifications on this device."
        control={
          <Button variant="secondary" size="sm" onClick={() => void enable()} disabled={busy}>
            {busy ? "Enabling..." : "Enable on this device"}
          </Button>
        }
      />
      {error ? <NotWired>{error}</NotWired> : null}
      {devices.map((device) => (
        <Row
          key={device.id}
          name={device.label ?? "Unnamed device"}
          desc={
            device.disabledAt
              ? "Turned off after repeated delivery failures."
              : "Registered for push notifications."
          }
          control={
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {device.id === deviceId ? (
                <Badge tone="forest" dot>
                  This device
                </Badge>
              ) : null}
              <Button
                variant="quiet"
                size="sm"
                onClick={() => removeMutation.mutate(device)}
                disabled={removeMutation.isPending}
              >
                Remove
              </Button>
            </span>
          }
        />
      ))}
    </>
  );
}
