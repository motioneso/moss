import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid, requestJson } from "@moss/module-web-sdk";
import type {
  ListMySessionsResponse,
  MeetingCaptureDevicesResponse,
  MeetingCapturePreferences,
  MeetingOutputsResponse,
  RecordingCapabilitiesResponse,
  UpdateMeetingCapturePreferences
} from "@moss/shared";
import {
  getMeetingPreferences,
  isMeetingAccessDenied,
  meetingKeys,
  putMeetingPreferences
} from "./client.js";
import { captureKeys } from "./capture-client.js";
import { captureSelection, type CaptureChoice } from "./capture-presentation.js";
import { useCaptureDevices } from "./capture-ready.js";
import {
  isRecordingNoticeAcknowledged,
  refreshRecordingNotice,
  useRecordingNotice
} from "./recording-notice.js";
import { useSessionDraft } from "./session-draft.js";

export const meetingSettingsKeys = {
  draft: ["meetings", "settings-draft"] as const,
  availability: ["meetings", "output-availability"] as const,
  sessions: ["settings", "sessions"] as const,
  capabilities: ["companion", "recording-capabilities"] as const
};
interface SettingsDraft {
  readonly loaded: boolean;
  readonly deviceId: string;
  readonly choice: CaptureChoice;
  readonly sourceChanged: boolean;
  readonly summarizeOnStop: boolean;
  readonly summaryTemplateId: MeetingCapturePreferences["summaryTemplateId"];
  readonly summaryChanges: Pick<
    UpdateMeetingCapturePreferences,
    "summarizeOnStop" | "summaryTemplateId"
  >;
  readonly skippedComputerAudio: boolean;
  readonly requestKey: string | null;
  readonly error: string | null;
  readonly saved: boolean;
}
const emptyDraft = (): SettingsDraft => ({
  loaded: false,
  deviceId: "",
  choice: { mode: "computer-audio", microphoneId: "", applicationId: "" },
  sourceChanged: false,
  summarizeOnStop: true,
  summaryTemplateId: "general",
  summaryChanges: {},
  skippedComputerAudio: false,
  requestKey: null,
  error: null,
  saved: false
});
function savedDraft(preferences: MeetingCapturePreferences): SettingsDraft {
  const source = preferences.rememberedSource;
  return {
    ...emptyDraft(),
    loaded: true,
    deviceId: source?.deviceId ?? "",
    choice: {
      mode: source?.mode ?? preferences.defaultCaptureMode ?? "computer-audio",
      microphoneId: source?.microphoneId ?? "",
      applicationId: source?.applicationId ?? ""
    },
    summarizeOnStop: preferences.summarizeOnStop,
    summaryTemplateId: preferences.summaryTemplateId
  };
}
export function useMeetingSettings() {
  const client = useQueryClient();
  const notice = useRecordingNotice();
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences,
    retry: false,
    refetchOnWindowFocus: "always"
  });
  const devices = useCaptureDevices();
  const sessions = useQuery({
    queryKey: meetingSettingsKeys.sessions,
    queryFn: ({ signal }) => requestJson<ListMySessionsResponse>("/api/me/sessions", { signal }),
    retry: false
  });
  const capabilities = useQuery({
    queryKey: meetingSettingsKeys.capabilities,
    queryFn: ({ signal }) =>
      requestJson<RecordingCapabilitiesResponse>("/api/companion/recording-capabilities", {
        signal
      }),
    retry: false
  });
  const availability = useQuery({
    queryKey: meetingSettingsKeys.availability,
    queryFn: ({ signal }) =>
      requestJson<Pick<MeetingOutputsResponse, "generationAvailability" | "templates">>(
        "/api/meetings/output-availability",
        { signal }
      ),
    retry: false,
    refetchOnWindowFocus: "always"
  });
  const macAccessDenied = [sessions.error, capabilities.error, devices.error].some(
    isMeetingAccessDenied
  );
  const visibleDevices = macAccessDenied ? [] : (devices.data?.devices ?? []);
  const draft = useSessionDraft(meetingSettingsKeys.draft, emptyDraft);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!preferences.data) return;
    draft.update((current) =>
      current.requestKey || current.sourceChanged || Object.keys(current.summaryChanges).length > 0
        ? current
        : { ...savedDraft(preferences.data!), saved: current.saved }
    );
  }, [preferences.data, draft.data.loaded, draft.update]);
  // Only a new setup can prefill an unambiguous choice. Never replace a saved, missing source.
  useEffect(() => {
    if (
      !draft.data.loaded ||
      preferences.data?.rememberedSource ||
      !devices.data ||
      macAccessDenied
    )
      return;
    draft.update((current) => {
      if (current.requestKey || current.sourceChanged) return current;
      const device = current.deviceId
        ? devices.data!.devices.find((item) => item.deviceId === current.deviceId)
        : devices.data!.devices.length === 1
          ? devices.data!.devices[0]
          : undefined;
      if (!device) return current;
      const microphoneId =
        current.choice.microphoneId ||
        (device.inventory.microphones.length === 1
          ? device.inventory.microphones[0]!.deviceId
          : "");
      if (current.deviceId === device.deviceId && current.choice.microphoneId === microphoneId)
        return current;
      return { ...current, deviceId: device.deviceId, choice: { ...current.choice, microphoneId } };
    });
  }, [
    draft.data.loaded,
    devices.data,
    preferences.data?.rememberedSource,
    draft.update,
    macAccessDenied
  ]);
  const data = draft.data;
  const device = visibleDevices.find((item) => item.deviceId === data.deviceId);
  const selection = captureSelection(data.choice, device?.inventory ?? null);
  const edit = (change: Partial<SettingsDraft>) =>
    draft.update((current) =>
      current.requestKey
        ? current
        : {
            ...current,
            ...change,
            summaryChanges: {
              ...current.summaryChanges,
              ...(change.summarizeOnStop !== undefined
                ? { summarizeOnStop: change.summarizeOnStop }
                : {}),
              ...(change.summaryTemplateId !== undefined
                ? { summaryTemplateId: change.summaryTemplateId }
                : {})
            },
            error: null,
            saved: false
          }
    );
  const refresh = () => {
    void devices.refetch();
    void sessions.refetch();
    void capabilities.refetch();
    void availability.refetch();
    void preferences.refetch();
    void notice.query.refetch();
  };
  async function save(completeSetup: boolean, onCompleted?: () => void) {
    const current = client.getQueryData<SettingsDraft>(meetingSettingsKeys.draft);
    if (
      !current?.loaded ||
      current.requestKey ||
      client.getQueryState(meetingKeys.preferences)?.status !== "success"
    )
      return;
    const saveSource = completeSetup || current.sourceChanged;
    if (
      saveSource &&
      [meetingSettingsKeys.sessions, meetingSettingsKeys.capabilities, captureKeys.devices].some(
        (key) => isMeetingAccessDenied(client.getQueryState(key)?.error)
      )
    )
      return;
    const liveDevice = client
      .getQueryData<MeetingCaptureDevicesResponse>(captureKeys.devices)
      ?.devices.find((item) => item.deviceId === current.deviceId);
    const liveSelection = captureSelection(current.choice, liveDevice?.inventory ?? null);
    if (
      saveSource &&
      (!liveSelection || client.getQueryState(captureKeys.devices)?.status !== "success")
    )
      return;
    if (saveSource && !isRecordingNoticeAcknowledged(client)) return;
    if (!saveSource && Object.keys(current.summaryChanges).length === 0) return;
    const requestKey = randomUuid();
    const body: UpdateMeetingCapturePreferences = {
      ...(saveSource && liveSelection
        ? {
            defaultCaptureMode: liveSelection.mode,
            rememberedSource: {
              deviceId: current.deviceId,
              microphoneId: liveSelection.microphone.deviceId,
              mode: liveSelection.mode,
              ...(liveSelection.mode === "selected-app"
                ? { applicationId: liveSelection.applicationId }
                : {})
            }
          }
        : {}),
      ...(completeSetup
        ? {
            summarizeOnStop: current.summarizeOnStop,
            summaryTemplateId: current.summaryTemplateId
          }
        : current.summaryChanges),
      ...(completeSetup ? { completeSetup: true } : {})
    };
    draft.update((value) => ({ ...value, requestKey, saved: false, error: null }));
    const ownsSave = () =>
      draft.currentSession() &&
      client.getQueryData<SettingsDraft>(meetingSettingsKeys.draft)?.requestKey === requestKey;
    try {
      const saved = await putMeetingPreferences(body);
      if (!ownsSave()) return;
      // A read started before this write must not replace the new setup-completion receipt.
      await client.cancelQueries({ queryKey: meetingKeys.preferences, exact: true });
      if (!ownsSave()) return;
      client.setQueryData(meetingKeys.preferences, saved);
      draft.update(() => ({ ...savedDraft(saved), saved: true }));
      if (active.current) onCompleted?.();
    } catch (error) {
      if (!ownsSave()) return;
      const noticeChanged =
        error instanceof ApiError && error.code === "meeting_capture_notice_required";
      if (noticeChanged) refreshRecordingNotice(client);
      draft.update((value) => ({
        ...value,
        requestKey: null,
        error: noticeChanged
          ? "Review the current recording notice, then finish setup again. Your choices are kept."
          : "Couldn’t save your meeting settings. Your choices are kept. Check again and retry."
      }));
    }
  }
  return {
    data,
    preferences,
    devices,
    device,
    selection,
    sessions,
    capabilities,
    availability,
    macAccessDenied,
    visibleDevices,
    saving: !!data.requestKey,
    canSave:
      data.loaded &&
      (data.sourceChanged || Object.keys(data.summaryChanges).length > 0) &&
      !preferences.isError &&
      (!data.sourceChanged || (!!selection && !devices.isError && notice.acknowledged)),
    canFinishSetup:
      data.loaded && !!selection && notice.acknowledged && !devices.isError && !preferences.isError,
    edit,
    chooseDevice: (deviceId: string) => {
      const selected = devices.data?.devices.find((item) => item.deviceId === deviceId);
      edit({
        deviceId,
        sourceChanged: true,
        choice: {
          ...data.choice,
          microphoneId:
            selected?.inventory.microphones.length === 1
              ? selected.inventory.microphones[0]!.deviceId
              : "",
          applicationId: ""
        }
      });
    },
    chooseSource: (change: Partial<CaptureChoice>) =>
      edit({
        choice: { ...data.choice, ...change },
        sourceChanged: true,
        skippedComputerAudio: false
      }),
    refresh,
    save
  };
}
export type MeetingSettingsState = ReturnType<typeof useMeetingSettings>;
