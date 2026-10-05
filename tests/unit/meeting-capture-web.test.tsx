import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@moss/module-web-sdk";
import { Indicator, RadioCardGroup } from "@moss/ui";
import type { MeetingCaptureBrowserStatus, MeetingCaptureState, MeetingRecord } from "@moss/shared";
import * as api from "../../packages/meetings/src/web/capture-client.js";
import { CapturePanel, captureHandoffUrl } from "../../packages/meetings/src/web/capture-panel.js";
import {
  captureSelection,
  captureStatusLabel,
  emptyCaptureChoice
} from "../../packages/meetings/src/web/capture-presentation.js";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";

vi.mock("../../packages/meetings/src/web/capture-client.js", async (original) => ({
  ...(await original<typeof api>()),
  getCaptureStatus: vi.fn(),
  approveCaptureDevice: vi.fn(),
  controlCapture: vi.fn()
}));
const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Design review",
  personalNotes: "Saved notes",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
};
function captureFixture(): MeetingCaptureState {
  return {
    gaps: [],
    gapLimitReached: false,
    grantId: "grant",
    deviceId: "device-123",
    deviceName: "Meeting Mac",
    generation: 0,
    epoch: 0,
    desired: "idle",
    selection: null,
    epochStartMs: 0,
    epochEndMs: null,
    stopCutoffMs: null,
    finalizationDeadline: null,
    expiresAt: new Date(Date.now() + 7200000).toISOString(),
    serverTime: new Date().toISOString(),
    elapsedMs: 0,
    lastSeenAt: new Date().toISOString(),
    observed: { generation: 0, phase: "idle" },
    inventory: {
      microphones: [
        { deviceId: "mic-device", sourceId: "mic-source", label: "USB headset microphone" }
      ],
      applications: [{ appProcessTreeId: "teams-process", label: "Microsoft Teams" }],
      computerAudio: { available: true, excludedProcessTreeIds: ["moss", "trail-marker"] },
      microphonePermission: "granted",
      systemAudioPermission: "granted"
    }
  };
}
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let status: MeetingCaptureBrowserStatus;
const onLiveChange = vi.fn();
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
async function mount() {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CapturePanel meeting={meeting} onLiveChange={onLiveChange} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await flush();
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
  });
  await flush();
}
function label() {
  return renderer!.root.findByType(Indicator).props.label;
}
async function changeStatus(next: MeetingCaptureBrowserStatus) {
  status = next;
  await act(async () => {
    client.setQueryData(api.captureKeys.status(meeting.id), next);
  });
  await flush();
}
async function choose(mode = "microphone-only") {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(renderer!.root.findAllByType(RadioCardGroup)).toHaveLength(1);
  });
  await act(async () => {
    renderer!.root.findByType(RadioCardGroup).props.onChange(mode);
    renderer!.root
      .findByProps({ id: "meeting-capture-microphone" })
      .props.onChange({ target: { value: "mic-device" } });
  });
  await flush();
  if (mode === "selected-app") {
    await act(async () => {
      renderer!.root
        .findByProps({ id: "meeting-capture-application" })
        .props.onChange({ target: { value: "teams-process" } });
    });
  }
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Participants have been notified and recording is permitted" })
      .props.onChange({ target: { checked: true } });
  });
  await flush();
}
function activeCapture(): MeetingCaptureState {
  return {
    ...captureFixture(),
    generation: 1,
    epoch: 1,
    desired: "recording",
    observed: { generation: 1, phase: "recording" },
    selection: {
      mode: "microphone-only",
      microphone: { deviceId: "mic-device", sourceId: "mic-source" }
    }
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    location: { origin: "https://moss.example" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected provider request")))
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } }
  });
  client.setQueryData(meetingKeys.record(meeting.id), { meeting });
  status = { pendingLinks: [], capture: captureFixture(), processingReady: true };
  vi.mocked(api.getCaptureStatus).mockImplementation(async () => status);
  vi.mocked(api.approveCaptureDevice).mockResolvedValue({ approved: true });
  vi.mocked(api.controlCapture).mockImplementation(async (_id, input) => {
    const capture = status.capture!;
    const desired = (
      { record: "recording", pause: "paused", stop: "stopped", revoke: "revoked" } as const
    )[input.command];
    const next = {
      ...capture,
      desired,
      generation: capture.generation + 1,
      selection: input.selection ?? capture.selection,
      serverTime: new Date().toISOString(),
      stopCutoffMs: desired === "stopped" ? 1234 : null
    };
    status = { ...status, capture: next };
    return { capture: next };
  });
});
afterEach(async () => {
  if (renderer)
    await act(async () => {
      renderer!.unmount();
    });
  renderer = undefined;
  client.clear();
  vi.unstubAllGlobals();
});

describe("explicit meeting capture UI (synthetic transport, not live Mac proof)", () => {
  it("offers a nonsecret native setup link without inventing a connection", async () => {
    status = { ...status, capture: null };
    await mount();
    expect(label()).toBe("Trail Marker not connected");
    const link = renderer!.root
      .findAllByType("a")
      .find((item) => item.children.join("") === "Open Trail Marker")!;
    const url = new URL(link.props.href);
    expect(url.protocol).toBe("moss-meeting:");
    expect([...url.searchParams.keys()]).toEqual(["instance", "meetingId"]);
    expect(url.searchParams.get("instance")).toBe("https://moss.example");
    expect(url.searchParams.get("meetingId")).toBe(meeting.id);
    expect(button("Record")).toBeUndefined();
    expect(api.controlCapture).not.toHaveBeenCalled();
  });
  it("keeps a fresh remote browser explicit when an approved recorder is on another device", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://remote-moss.example" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    status = {
      ...status,
      capture: {
        ...captureFixture(),
        deviceId: "other-device-recorder",
        deviceName: "Conference room Mac"
      }
    };
    await mount();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(renderer!.root.findAllByType(RadioCardGroup)).toHaveLength(1);
    });
    expect(label()).toBe("Connected");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Conference room Mac");
    expect(renderer!.root.findByType(RadioCardGroup).props.value).toBeNull();
    expect(renderer!.root.findByProps({ id: "meeting-capture-microphone" }).props.value).toBe("");
    expect(
      renderer!.root.findByProps({
        "aria-label": "Participants have been notified and recording is permitted"
      }).props.checked
    ).toBe(false);
    expect(client.getQueryData(api.captureKeys.session(meeting.id))).toMatchObject({
      choice: { mode: null, microphoneId: "", applicationId: "", notice: false }
    });
    expect(button("Record").props.disabled).toBe(true);
    expect(api.controlCapture).not.toHaveBeenCalled();
    expect(api.approveCaptureDevice).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("requires a separate approval naming the exact meeting and device", async () => {
    status = {
      ...status,
      capture: null,
      pendingLinks: [
        {
          challengeId: "challenge",
          deviceId: "exact-device",
          deviceName: "Ben’s Mac",
          meetingId: meeting.id,
          expiresAt: new Date(Date.now() + 60000).toISOString()
        }
      ]
    };
    await mount();
    const content = JSON.stringify(renderer!.toJSON());
    expect(content).toContain("Ben’s Mac");
    expect(content).toContain("Design review");
    expect(content).toContain("exact-device");
    expect(api.approveCaptureDevice).not.toHaveBeenCalled();
    await click("Approve this device");
    expect(api.approveCaptureDevice).toHaveBeenCalledExactlyOnceWith(meeting.id, "challenge");
    expect(api.controlCapture).not.toHaveBeenCalled();
  });
  it.each(["microphone-only", "selected-app", "computer-audio"])(
    "records only the explicit %s selection and notice",
    async (mode) => {
      await mount();
      expect(button("Record").props.disabled).toBe(true);
      await choose(mode);
      expect(button("Record").props.disabled).toBe(false);
      await click("Record");
      expect(api.controlCapture).toHaveBeenCalledTimes(1);
      const input = vi.mocked(api.controlCapture).mock.calls[0]![1];
      expect(input).toMatchObject({
        grantId: "grant",
        expectedGeneration: 0,
        command: "record",
        noticeAcknowledged: true,
        selection: { mode, microphone: { deviceId: "mic-device", sourceId: "mic-source" } }
      });
      if (mode === "microphone-only") expect(input.selection).not.toHaveProperty("outputSourceId");
      if (mode === "selected-app")
        expect(input.selection).toMatchObject({ appProcessTreeId: "teams-process" });
      if (mode === "computer-audio")
        expect(input.selection).toMatchObject({
          scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss", "trail-marker"] }
        });
      expect(label()).toBe("Starting…");
    }
  );
  it("requires fresh source selection and notice for a newly approved Mac", async () => {
    await mount();
    await choose();
    expect(button("Record").props.disabled).toBe(false);
    await changeStatus({
      ...status,
      capture: {
        ...captureFixture(),
        grantId: "new-grant",
        deviceId: "different-device",
        deviceName: "Different Mac"
      }
    });
    expect(button("Record").props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ id: "meeting-capture-microphone" }).props.value).toBe("");
    expect(
      renderer!.root.findByProps({
        "aria-label": "Participants have been notified and recording is permitted"
      }).props.checked
    ).toBe(false);
  });
  it("does not broaden capture when the selected app disappears", async () => {
    await mount();
    await choose("selected-app");
    await changeStatus({
      ...status,
      capture: {
        ...status.capture!,
        inventory: { ...status.capture!.inventory!, applications: [] }
      }
    });
    expect(button("Record").props.disabled).toBe(true);
    expect(renderer!.root.findByType(RadioCardGroup).props.value).toBe("selected-app");
    expect(api.controlCapture).not.toHaveBeenCalled();
  });
  it("fails closed for processing while keeping settings in AI providers", async () => {
    status = { ...status, processingReady: false };
    await mount();
    await choose();
    expect(button("Record").props.disabled).toBe(true);
    expect(
      renderer!.root
        .findAllByType("a")
        .some((item) => item.props.href === "/settings?section=aiproviders")
    ).toBe(true);
    expect(api.controlCapture).not.toHaveBeenCalled();
  });
  it("does not submit a repeated click while a command is in flight", async () => {
    let resolve!: (value: { capture: MeetingCaptureState }) => void;
    vi.mocked(api.controlCapture).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    await mount();
    await choose();
    const record = button("Record").props.onClick;
    await act(async () => {
      record();
      record();
    });
    expect(api.controlCapture).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ capture: activeCapture() });
    });
  });
  it("retries an uncertain command with its original key and selection", async () => {
    vi.mocked(api.controlCapture).mockRejectedValueOnce(new Error("Response lost"));
    await mount();
    await choose();
    await click("Record");
    expect(button("Record").props.disabled).toBe(true);
    expect(renderer!.root.findAllByType(RadioCardGroup)).toHaveLength(0);
    await click("Retry capture command");
    expect(vi.mocked(api.controlCapture).mock.calls[1]![1]).toEqual(
      vi.mocked(api.controlCapture).mock.calls[0]![1]
    );
  });
  it("waits for matching native Pause acknowledgment", async () => {
    status = { ...status, capture: activeCapture() };
    await mount();
    await click("Pause");
    expect(label()).toBe("Pausing…");
    expect(button("Resume").props.disabled).toBe(true);
    await changeStatus({
      ...status,
      capture: { ...status.capture!, observed: { generation: 1, phase: "paused" } }
    });
    expect(label()).toBe("Pausing…");
    await changeStatus({
      ...status,
      capture: { ...status.capture!, observed: { generation: 2, phase: "paused" } }
    });
    expect(label()).toBe("Paused");
  });
  it("keeps Stop pending and the cutoff unchanged until native confirms", async () => {
    status = { ...status, capture: activeCapture() };
    await mount();
    await click("Stop and review");
    expect(label()).toBe("Stopping…");
    expect(button("Stop and review").props.disabled).toBe(true);
    expect(status.capture?.stopCutoffMs).toBe(1234);
    await changeStatus({
      ...status,
      capture: {
        ...status.capture!,
        elapsedMs: 9999,
        observed: { generation: 2, phase: "stopped" }
      }
    });
    expect(label()).toBe("Stopped");
    expect(status.capture?.stopCutoffMs).toBe(1234);
    expect(button("Resume")).toBeUndefined();
    expect(button("Record")).toBeUndefined();
  });
  it("keeps Stop available when the native connection is stale", async () => {
    status = {
      ...status,
      capture: { ...activeCapture(), lastSeenAt: new Date(Date.now() - 11000).toISOString() }
    };
    await mount();
    expect(label()).toBe("Capture status unconfirmed");
    expect(button("Stop and review").props.disabled).toBe(false);
    await click("Stop and review");
    expect(label()).toBe("Capture status unconfirmed");
  });
  it("ignores a late command result after signout clears its session", async () => {
    let resolve!: (value: { capture: MeetingCaptureState }) => void;
    vi.mocked(api.controlCapture).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    await mount();
    await choose();
    await click("Record");
    await act(async () => {
      renderer!.unmount();
      client.clear();
    });
    renderer = undefined;
    await act(async () => {
      resolve({ capture: activeCapture() });
    });
    expect(client.getQueryData(api.captureKeys.status(meeting.id))).toBeUndefined();
    expect(client.getQueryData(api.captureKeys.session(meeting.id))).toBeUndefined();
  });
  it("does not replace a newly approved device with an old grant’s late response", async () => {
    let resolve!: (value: { capture: MeetingCaptureState }) => void;
    vi.mocked(api.controlCapture).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    await mount();
    await choose();
    await click("Record");
    await changeStatus({
      ...status,
      capture: { ...captureFixture(), grantId: "new-grant", deviceName: "Different Mac" }
    });
    // Hold the subsequent refresh so it cannot conceal an unsafe intermediate cache write.
    vi.mocked(api.getCaptureStatus).mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      resolve({ capture: activeCapture() });
    });
    expect(
      client.getQueryData<MeetingCaptureBrowserStatus>(api.captureKeys.status(meeting.id))?.capture
        ?.grantId
    ).toBe("new-grant");
  });
  it("hides device metadata and invalidates pending callbacks on access denial", async () => {
    status = {
      ...status,
      pendingLinks: [
        {
          challengeId: "challenge",
          deviceId: "private-device",
          deviceName: "Private Mac",
          meetingId: meeting.id,
          expiresAt: new Date(Date.now() + 60000).toISOString()
        }
      ]
    };
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Private Mac");
    vi.mocked(api.getCaptureStatus).mockRejectedValue(new ApiError(403, "Unavailable"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: api.captureKeys.status(meeting.id) });
    });
    await flush();
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Private Mac");
    expect(button("Approve this device")).toBeUndefined();
    expect(button("Record")).toBeUndefined();
  });
  it("shows retained capture gaps after Stop without inventing complete coverage", async () => {
    status = {
      ...status,
      capture: {
        ...activeCapture(),
        desired: "stopped",
        observed: { generation: 1, phase: "stopped" },
        gaps: [
          {
            id: "gap",
            sourceId: "mic-source",
            epoch: 1,
            startMs: 1200,
            endMs: 3800,
            reason: "processing-failed"
          }
        ],
        gapLimitReached: false
      }
    };
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Some audio is missing");
    await click("Show 1 capture gap");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Transcription failed");
    expect(JSON.stringify(renderer!.toJSON())).toContain("0:01");
    expect(JSON.stringify(renderer!.toJSON())).toContain("0:03");
  });
  it("discloses omitted gap metadata at the server limit", async () => {
    status = { ...status, capture: { ...activeCapture(), gapLimitReached: true } };
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Additional missing ranges may not be listed"
    );
  });
  it("navigation does not issue a hidden Stop or Revoke", async () => {
    status = { ...status, capture: activeCapture() };
    await mount();
    expect(window.addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    await act(async () => {
      renderer!.unmount();
    });
    renderer = undefined;
    expect(api.controlCapture).not.toHaveBeenCalled();
  });
  it("shows a processing rejection with an actionable settings remedy", async () => {
    vi.mocked(api.controlCapture).mockRejectedValueOnce(
      new ApiError(503, "Unavailable", "meeting_capture_processing_unavailable")
    );
    await mount();
    await choose();
    await click("Record");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Settings → AI providers");
    expect(button("Retry capture command")).toBeUndefined();
  });
});

describe("capture selection and presentation", () => {
  it("never selects a source on behalf of the user", () => {
    expect(captureSelection(emptyCaptureChoice, captureFixture().inventory)).toBeNull();
    expect(
      captureSelection(
        { ...emptyCaptureChoice, mode: "microphone-only" },
        captureFixture().inventory
      )
    ).toBeNull();
  });
  it("allows an explicit system permission prompt but rejects denied permission", () => {
    const choice = {
      mode: "selected-app" as const,
      microphoneId: "mic-device",
      applicationId: "teams-process",
      notice: true
    };
    expect(
      captureSelection(choice, { ...captureFixture().inventory!, systemAudioPermission: "unknown" })
    ).not.toBeNull();
    expect(
      captureSelection(choice, { ...captureFixture().inventory!, systemAudioPermission: "denied" })
    ).toBeNull();
  });
  it("does not turn authorization revocation into proof the microphone stopped", () => {
    expect(captureStatusLabel({ ...activeCapture(), desired: "revoked" }, false)).toBe(
      "Authorization revoked"
    );
  });
  it("builds a handoff containing only the chosen meeting and current origin", () => {
    expect(captureHandoffUrl("https://moss.example:8443", meeting.id)).toBe(
      `moss-meeting://capture?instance=https%3A%2F%2Fmoss.example%3A8443&meetingId=${meeting.id}`
    );
  });
});
