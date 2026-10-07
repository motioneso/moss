import { describe, expect, it } from "vitest";
import type { MeetingCaptureInventory } from "@moss/shared";
import {
  captureSelection,
  emptyCaptureChoice
} from "../../packages/meetings/src/web/capture-presentation.js";
const inventory: MeetingCaptureInventory = {
  microphones: [{ deviceId: "stable-mic", sourceId: "mic", label: "Desk microphone" }],
  applications: [
    {
      applicationId: "com.example.meeting",
      appProcessTreeId: "current-process",
      label: "Meeting app"
    }
  ],
  computerAudio: { available: true, excludedProcessTreeIds: ["moss", "trail-marker"] },
  microphonePermission: "granted",
  systemAudioPermission: "granted"
};
describe("stable source resolution", () => {
  it("allows the first explicit Start to request microphone permission, but blocks denied access", () => {
    const choice = {
      ...emptyCaptureChoice,
      mode: "microphone-only" as const,
      microphoneId: "stable-mic"
    };
    expect(
      captureSelection(choice, { ...inventory, microphonePermission: "unknown" })
    ).not.toBeNull();
    expect(captureSelection(choice, { ...inventory, microphonePermission: "denied" })).toBeNull();
  });

  it("does not treat a recycled process ID as a remembered application", () => {
    const choice = {
      ...emptyCaptureChoice,
      mode: "selected-app" as const,
      microphoneId: "stable-mic",
      applicationId: "reused-process"
    };
    expect(
      captureSelection(choice, {
        ...inventory,
        applications: [{ appProcessTreeId: "reused-process", label: "Different app" }]
      })
    ).toBeNull();
  });

  it("requires a clear app instance instead of choosing between duplicate stable identities", () => {
    const choice = {
      ...emptyCaptureChoice,
      mode: "selected-app" as const,
      microphoneId: "stable-mic",
      applicationId: "com.example.meeting"
    };
    expect(
      captureSelection(choice, {
        ...inventory,
        applications: [
          ...inventory.applications,
          {
            applicationId: "com.example.meeting",
            appProcessTreeId: "second-instance",
            label: "Other instance"
          }
        ]
      })
    ).toBeNull();
  });

  it("re-resolves the exact app identity without falling back to another process", () => {
    const choice = {
      ...emptyCaptureChoice,
      mode: "selected-app" as const,
      microphoneId: "stable-mic",
      applicationId: "com.example.meeting"
    };
    expect(captureSelection(choice, inventory)).toMatchObject({
      appProcessTreeId: "current-process"
    });
    expect(
      captureSelection(choice, {
        ...inventory,
        applications: [
          { applicationId: "com.other", appProcessTreeId: "current-process", label: "Other app" }
        ]
      })
    ).toBeNull();
  });
});
