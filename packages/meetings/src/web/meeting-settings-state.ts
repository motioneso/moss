import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUuid } from "@moss/module-web-sdk";
import type { MeetingCaptureMode, MeetingCapturePreferences } from "@moss/shared";
import {
  getMeetingPreferences,
  isMeetingAccessDenied,
  meetingKeys,
  putMeetingPreferences
} from "./client.js";
import { captureKeys } from "./capture-client.js";
import { useSessionDraft } from "./session-draft.js";
import { meetingLinkKeys, useMeetingLinkActions } from "./meeting-link-state.js";
import { useMeetingConnection } from "./meeting-connection.js";

export const meetingSettingsKeys = {
  draft: ["meetings", "settings-draft"] as const,
  sessions: meetingLinkKeys.sessions,
  capabilities: meetingLinkKeys.capabilities
};
interface SettingsDraft {
  readonly mode: MeetingCaptureMode;
  readonly dirty: boolean;
  readonly requestKey: string | null;
  readonly error: string | null;
}
const emptyDraft = (): SettingsDraft => ({
  mode: "computer-audio",
  dirty: false,
  requestKey: null,
  error: null
});
const savedMode = (preferences: MeetingCapturePreferences) =>
  preferences.defaultCaptureMode ?? preferences.rememberedSource?.mode ?? "computer-audio";

export function useMeetingSettings() {
  const client = useQueryClient();
  const links = useMeetingLinkActions();
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences,
    retry: false,
    refetchOnWindowFocus: "always"
  });
  const connection = useMeetingConnection(preferences.data?.rememberedSource?.deviceId);
  const draft = useSessionDraft(meetingSettingsKeys.draft, emptyDraft);
  useEffect(() => {
    if (!preferences.data) return;
    draft.update((current) =>
      current.dirty || current.requestKey
        ? current
        : { ...emptyDraft(), mode: savedMode(preferences.data!) }
    );
  }, [preferences.data, draft.update]);
  async function save(mode: "computer-audio" | "microphone-only") {
    const current = client.getQueryData<SettingsDraft>(meetingSettingsKeys.draft);
    if (
      !current ||
      current.requestKey ||
      links.pending ||
      !draft.currentSession() ||
      client.getQueryState(meetingKeys.preferences)?.status !== "success" ||
      [meetingLinkKeys.sessions, meetingLinkKeys.capabilities, captureKeys.devices].some((key) =>
        isMeetingAccessDenied(client.getQueryState(key)?.error)
      )
    )
      return;
    const requestKey = randomUuid();
    draft.update(() => ({ mode, dirty: true, requestKey, error: null }));
    const owns = () =>
      draft.currentSession() &&
      client.getQueryData<SettingsDraft>(meetingSettingsKeys.draft)?.requestKey === requestKey;
    try {
      const saved = await putMeetingPreferences({ defaultCaptureMode: mode });
      if (!owns()) return;
      await client.cancelQueries({ queryKey: meetingKeys.preferences, exact: true });
      if (!owns()) return;
      client.setQueryData(meetingKeys.preferences, saved);
      draft.update(() => ({ ...emptyDraft(), mode: savedMode(saved) }));
    } catch {
      if (owns())
        draft.update((value) => ({
          ...value,
          requestKey: null,
          error: "Couldn’t save your audio source. Your choice is kept here."
        }));
    }
  }
  return {
    ...connection,
    preferences,
    links,
    data: draft.data,
    saving: !!draft.data.requestKey || links.pending,
    save,
    retry: () => {
      if (draft.data.mode !== "selected-app") void save(draft.data.mode);
    },
    refresh: () => {
      connection.refresh();
      void preferences.refetch();
    }
  };
}
export type MeetingSettingsState = ReturnType<typeof useMeetingSettings>;
