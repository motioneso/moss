import { useQuery } from "@tanstack/react-query";
import { getMeetingPreferences, meetingKeys } from "./client.js";
import { useCaptureDevices } from "./capture-devices.js";
import { captureSelection } from "./capture-presentation.js";

/** Read-only preflight; actual source selection is resolved and checked by the server. */
export function useReadyCapture() {
  const devices = useCaptureDevices();
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences
  });
  const source = preferences.data?.rememberedSource;
  const candidates = devices.data?.devices ?? [];
  const device = source
    ? candidates.find((candidate) => candidate.deviceId === source.deviceId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  const inventory = device?.inventory;
  const microphones = inventory?.microphones ?? [];
  const defaults =
    inventory?.defaultMicrophoneId === undefined
      ? microphones
      : microphones.filter((microphone) => microphone.deviceId === inventory.defaultMicrophoneId);
  const microphoneId = source?.microphoneId ?? (defaults.length === 1 ? defaults[0]!.deviceId : "");
  const mode = preferences.data?.defaultCaptureMode ?? source?.mode ?? "computer-audio";
  const selection = captureSelection(
    { mode, microphoneId, applicationId: source?.applicationId ?? "" },
    inventory ?? null
  );
  return { devices, preferences, device, selection };
}
