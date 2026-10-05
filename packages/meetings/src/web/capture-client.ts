import { requestJson } from "@moss/module-web-sdk";
import type {
  MeetingCaptureBrowserStatus,
  MeetingCaptureControlInput,
  MeetingCaptureState
} from "@moss/shared";

export const captureKeys = {
  status: (id: string) => ["meetings", "capture", id] as const,
  session: (id: string) => ["meetings", "capture-session", id] as const
};
const capturePath = (id: string) => `/api/meetings/records/${encodeURIComponent(id)}/capture`;
export function getCaptureStatus(
  id: string,
  signal?: AbortSignal
): Promise<MeetingCaptureBrowserStatus> {
  return requestJson(capturePath(id), { signal });
}
export function approveCaptureDevice(id: string, challengeId: string): Promise<{ approved: true }> {
  return requestJson(`${capturePath(id)}/approve`, { method: "POST", body: { challengeId } });
}
export function controlCapture(
  id: string,
  body: MeetingCaptureControlInput
): Promise<{ capture: MeetingCaptureState }> {
  return requestJson(`${capturePath(id)}/control`, { method: "POST", body });
}
