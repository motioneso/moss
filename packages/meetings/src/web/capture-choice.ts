import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeetingRememberedSource } from "@moss/shared";
import { getMeetingPreferences, meetingKeys, putMeetingPreferences } from "./client.js";
import {
  emptyCaptureChoice,
  captureSelection,
  type CaptureChoice
} from "./capture-presentation.js";
import { useSessionDraft } from "./session-draft.js";
import { useCaptureDevices } from "./capture-ready.js";
const choiceKey = ["meetings", "source-choice"] as const;
export function useReadyCapture() {
  const client = useQueryClient();
  const devices = useCaptureDevices();
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences
  });
  const draft = useSessionDraft(choiceKey, () => ({
    loaded: false,
    deviceId: "",
    choice: emptyCaptureChoice
  }));
  useEffect(() => {
    if (draft.data.loaded || !preferences.data) return;
    const source = preferences.data.rememberedSource;
    draft.update((current) =>
      current.loaded
        ? current
        : {
            loaded: true,
            deviceId: source?.deviceId ?? "",
            choice: {
              ...emptyCaptureChoice,
              mode: source?.mode ?? preferences.data!.defaultCaptureMode,
              microphoneId: source?.microphoneId ?? "",
              applicationId: source?.applicationId ?? ""
            }
          }
    );
  }, [preferences.data, draft.data.loaded, draft.update]);
  const device = devices.data?.devices.find((item) => item.deviceId === draft.data.deviceId);
  const selection = captureSelection(draft.data.choice, device?.inventory ?? null);
  return {
    devices,
    device,
    selection,
    choice: draft.data.choice,
    deviceId: draft.data.deviceId,
    onDevice: (deviceId: string) =>
      draft.update((current) => ({
        loaded: true,
        deviceId,
        choice: { ...emptyCaptureChoice, mode: current.choice.mode }
      })),
    onChoice: (change: Partial<CaptureChoice>) =>
      draft.update((current) => ({
        ...current,
        loaded: true,
        choice: { ...current.choice, ...change }
      })),
    remember: async () => {
      if (!device || !selection) return;
      const applicationId = selection.mode === "selected-app" ? selection.applicationId : undefined;
      if (selection.mode === "selected-app" && !applicationId) return;
      const rememberedSource: MeetingRememberedSource = {
        deviceId: device.deviceId,
        mode: selection.mode,
        microphoneId: selection.microphone.deviceId,
        ...(applicationId ? { applicationId } : {})
      };
      const saved = await putMeetingPreferences({
        defaultCaptureMode: selection.mode,
        rememberedSource
      });
      if (draft.currentSession()) client.setQueryData(meetingKeys.preferences, saved);
    }
  };
}
