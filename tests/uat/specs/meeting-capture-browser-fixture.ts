import type { APIRequestContext } from "@playwright/test";
import type { MeetingCaptureControlInput } from "@moss/shared";

/** Cookie-sharing APIRequestContext calls need an explicit Origin for capture mutations. */
export function createCaptureBrowserFixture(
  request: Pick<APIRequestContext, "post">,
  baseURL: string
) {
  const headers = { Origin: new URL(baseURL).origin };
  return {
    replayControl: (meetingId: string, input: MeetingCaptureControlInput) =>
      request.post(`/api/meetings/records/${meetingId}/capture/control`, { headers, data: input })
  };
}
