// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  MeetingCaptureBrowserStatus,
  MeetingCaptureDevice,
  MeetingCaptureState,
  MeetingCapturePreferences,
  MeetingRecord
} from "@moss/shared";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import { CapturePanel } from "../../packages/meetings/src/web/capture-panel.js";
import { ModulePersistentControls } from "../../apps/web/src/shell/module-persistent-controls.js";
import {
  MeetingCaptureStrip,
  MeetingCaptureNavigationIndicator
} from "../../packages/meetings/src/web/capture-strip.js";
import { refreshCaptureStatus } from "../../packages/meetings/src/web/capture-status.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";
import { useCaptureSession } from "../../packages/meetings/src/web/capture-session.js";

const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Design review",
  personalNotes: "",
  notesRevision: 1,
  createdAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z"
};
const device: MeetingCaptureDevice = {
  deviceId: "22334455-1122-4122-8122-112233445566",
  deviceName: "Studio Mac",
  connectionId: "connection",
  revision: 1,
  capabilityRevision: 1,
  lastSeenAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  inventory: {
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
  }
};
function capture(overrides: Partial<MeetingCaptureState> = {}): MeetingCaptureState {
  return {
    grantId: "grant",
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    generation: 1,
    epoch: 1,
    desired: "recording",
    selection: { mode: "microphone-only", microphone: { deviceId: "stable-mic", sourceId: "mic" } },
    epochStartMs: 0,
    epochEndMs: null,
    stopCutoffMs: null,
    finalizationDeadline: null,
    finalization: "none",
    recordedDurationMs: 2500,
    revision: "1",
    transcriptRevision: 0,
    leaseMs: 30000,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    serverTime: new Date().toISOString(),
    elapsedMs: 80000,
    lastSeenAt: new Date().toISOString(),
    observed: { generation: 1, phase: "recording" },
    inventory: device.inventory,
    gaps: [],
    gapLimitReached: false,
    ...overrides
  };
}
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let preferences: MeetingCapturePreferences;
let devices: readonly MeetingCaptureDevice[];
let status: Omit<MeetingCaptureBrowserStatus, "capture"> & { capture: MeetingCaptureState | null };
let calls: { path: string; body: Record<string, unknown> | undefined }[];
type Transport = (path: string, options?: RequestInit) => Promise<Response>;
let transport: Mock<Transport>;
const json = (value: unknown, code = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status: code, headers });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preferences = {
    defaultCaptureMode: "microphone-only",
    summarizeOnStop: true,
    summaryTemplateId: "general",
    rememberedSource: {
      deviceId: device.deviceId,
      microphoneId: "stable-mic",
      mode: "microphone-only"
    }
  };
  devices = [device];
  status = {
    capture: null,
    pendingLinks: [],
    processingReady: true,
    revision: "0",
    retryAfterMs: 1000
  };
  calls = [];
  transport = vi.fn(async (raw: string, options?: RequestInit) => {
    const path = String(raw);
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ path, body });
    if (path === "/api/meetings/preferences") {
      if (body) preferences = body as unknown as MeetingCapturePreferences;
      return json(preferences);
    }
    if (path === "/api/me/sessions")
      return json({
        sessions: devices.map((item) => ({
          id: item.deviceId,
          isCurrent: false,
          createdAt: meeting.createdAt,
          lastSeenAt: item.lastSeenAt,
          expiresAt: item.expiresAt,
          ipAddress: null,
          userAgent: null,
          deviceLabel: item.deviceName,
          browser: null,
          os: "macOS",
          deviceKind: "laptop",
          source: "companion",
          companion: {
            product: "Trail Marker for Mac",
            displayName: item.deviceName,
            appVersion: "1.4",
            osVersion: "15",
            lastContactAt: item.lastSeenAt
          }
        }))
      });
    if (path === "/api/companion/recording-capabilities")
      return json({
        devices: devices.map((item) => ({
          deviceId: item.deviceId,
          deviceName: item.deviceName,
          state: "approved",
          revision: 1,
          policyVersion: 1
        }))
      });
    if (path === "/api/meetings/capture/devices") return json({ devices, processingReady: true });
    if (path === "/api/meetings/records")
      return json({ meeting: { ...meeting, title: body?.title }, created: true });
    if (path.endsWith("/capture/start")) {
      status = {
        ...status,
        revision: "1",
        capture: capture({
          observed: { generation: 0, phase: "idle" }
        })
      };
      return json({ capture: status.capture });
    }
    if (path.endsWith("/capture/control")) {
      if (body?.expectedGeneration !== status.capture?.generation)
        return json({ code: "meeting_capture_conflict" }, 409);
      const command = body?.command;
      const phase = command === "pause" ? "paused" : command === "record" ? "recording" : "stopped";
      status = {
        ...status,
        revision: String(Number(status.revision) + 1),
        capture: capture({
          ...status.capture!,
          selection:
            (body?.selection as MeetingCaptureState["selection"]) ?? status.capture!.selection,
          generation: status.capture!.generation + 1,
          desired: phase,
          observed: { generation: status.capture!.generation + 1, phase },
          stopCutoffMs: phase === "stopped" ? 80000 : null,
          finalization: phase === "stopped" ? "complete" : "none"
        })
      };
      return json({ capture: status.capture });
    }
    if (/\/capture(?:\?|$)/.test(path)) return json(status);
    if (path === `/api/meetings/records/${meeting.id}`) return json({ meeting });
    if (path === "/api/me/locale")
      return json({ locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" } });
    if (path.endsWith("/outputs"))
      return json({ artifacts: [], candidates: [], headVersion: 0, templates: [] });
    if (path.endsWith("/exports")) return json({ receipts: [] });
    if (path.includes("/transcript")) return json({ code: "meeting_transcript_unavailable" }, 404);
    if (path === "/api/meetings/history/search") return json({ meetings: [], nextCursor: null });
    throw new Error(`Unexpected unit transport request: ${path}`);
  });
  vi.stubGlobal("fetch", transport);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } }
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function mount(view: React.ReactNode, path = "/meetings") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{view}</MemoryRouter>
      </QueryClientProvider>
    )
  );
  await settle();
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
}
function captureStatusCalls() {
  return calls.filter((call) => /\/capture(?:\?|$)/.test(call.path));
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
function Shell() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/settings")}>Other module</button>
      <ModulePersistentControls disabledModuleIds={[]} />
      <Routes>
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/settings" element={<p>Settings</p>} />
      </Routes>
    </>
  );
}

describe("minimal capture browser regressions (synthetic transport, not live proof)", () => {
  it("completes a pending New meeting without stealing navigation after route unmount", async () => {
    const normal = transport.getMockImplementation()!;
    let finish!: (response: Response) => void;
    transport.mockImplementation((path, options) =>
      path === "/api/meetings/records"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    const invalidated = vi.spyOn(client, "invalidateQueries");
    await mount(<Shell />);
    await click("New meeting");
    await click("Other module");
    expect(host.querySelector("#meeting-personal-notes")).toBeNull();
    await act(async () => finish(json({ meeting, created: true })));
    await settle();
    expect(host.querySelector("#meeting-personal-notes")).toBeNull();
    expect(host.textContent).toContain("Settings");
    expect(client.getQueryData(["meetings", "new-meeting"])).toEqual({ phase: "idle" });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["meetings", "history"] });
  });

  it.each([
    ["device-unavailable", "Mac unlinked or device access expired"],
    ["recording-permission-revoked", "Recording permission revoked"],
    ["session-ended", "Recording browser session ended"],
    ["connection-replaced", "Mac recording connection replaced"],
    ["expired", "Recording session expired"],
    [undefined, "Recording authorization revoked"]
  ] as const)(
    "shows the authoritative terminal reason %s and clears live navigation",
    async (reason, label) => {
      status.capture = capture();
      await mount(
        <>
          <CapturePanel meeting={meeting} onLiveChange={() => {}} />
          <MeetingCaptureStrip />
          <MeetingCaptureNavigationIndicator />
        </>,
        "/settings"
      );
      expect(host.querySelector(".meetings-recording-strip")).not.toBeNull();
      expect(host.querySelector(".meetings-recording-indicator")).not.toBeNull();
      status = {
        ...status,
        revision: "revoked",
        capture: capture({ desired: "revoked", revocationReason: reason, finalization: "complete" })
      };
      act(() => refreshCaptureStatus(client, meeting.id));
      await settle();
      expect(host.textContent).toContain(`${label}. Recording stopped.`);
      expect(host.querySelector(".meetings-recording-strip")).toBeNull();
      expect(host.querySelector(".meetings-recording-indicator")).toBeNull();
      expect(button("Start recording")).toBeUndefined();
      expect(button("Resume")).toBeUndefined();
      expect(host.textContent).toContain("New meeting");
      if (reason !== "device-unavailable") expect(host.textContent).not.toContain("Mac unlinked");
    }
  );

  it.each([
    ["Recording", "recording", "recording", 1, 1, true],
    ["Paused", "paused", "paused", 2, 2, false],
    ["Starting…", "recording", "idle", 2, 1, false],
    ["Stopping…", "stopped", "recording", 2, 1, false]
  ] as const)(
    "uses truthful %s navigation state",
    async (label, desired, phase, generation, observedGeneration, pulse) => {
      status.capture = capture({
        desired,
        generation,
        observed: { generation: observedGeneration, phase }
      });
      client.setQueryData(captureKeys.active, { meetingId: meeting.id, title: meeting.title });
      await mount(
        <>
          <MeetingCaptureStrip />
          <MeetingCaptureNavigationIndicator />
        </>,
        "/settings"
      );
      const indicator = host.querySelector('[role="img"]');
      expect(indicator?.getAttribute("aria-label")).toBe(label);
      expect(!!indicator?.querySelector(".jds-indicator--live")).toBe(pulse);
      expect(button("Pause")).toBeUndefined();
      expect(button("Stop")).toBeUndefined();
    }
  );
  it("does not claim recording when its status cannot be confirmed", async () => {
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      /\/capture(?:\?|$)/.test(path)
        ? Promise.resolve(json({ message: "Unavailable" }, 503))
        : normal(path, options)
    );
    client.setQueryData(captureKeys.active, { meetingId: meeting.id, title: meeting.title });
    await mount(
      <>
        <MeetingCaptureStrip />
        <MeetingCaptureNavigationIndicator />
      </>,
      "/settings"
    );
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Recording status unconfirmed"
    );
    expect(host.querySelector(".jds-indicator--live")).toBeNull();
  });
  it("fences detached capture actions after an authenticated cache replacement", async () => {
    let latest!: ReturnType<typeof useCaptureSession>;
    function Session() {
      latest = useCaptureSession(meeting.id);
      return null;
    }
    await mount(<Session />);
    const prior = latest;
    await act(async () => {
      await client.resetQueries();
    });
    await settle();
    expect(prior.currentSession()).toBe(false);
    const before = calls.length;
    await act(async () => {
      await prior.control({ grantId: "grant", command: "record", expectedGeneration: 1 });
      await prior.stop();
      prior.retry();
    });
    expect(calls).toHaveLength(before);
    expect(client.getQueryData(captureKeys.active)).toBeUndefined();
  });
  it("uses the Mac’s reported default microphone without a source-selection screen", async () => {
    preferences = { ...preferences, rememberedSource: null, defaultCaptureMode: "computer-audio" };
    devices = [
      {
        ...device,
        inventory: {
          ...device.inventory,
          ...{ defaultMicrophoneId: "stable-mic" },
          microphones: [
            ...device.inventory.microphones,
            { deviceId: "other-mic", sourceId: "other-input", label: "Other microphone" }
          ]
        }
      }
    ];
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(button("Start recording").disabled).toBe(false);
    expect(host.textContent).toContain("Ready");
    expect(host.querySelectorAll("select")).toHaveLength(0);
    await click("Start recording");
    expect(calls.filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(1);
    expect(calls.some((call) => call.path === "/api/meetings/preferences" && call.body)).toBe(
      false
    );
  });
  it.each([
    "null default",
    "missing default",
    "duplicate default",
    "saved microphone absent",
    "system permission denied"
  ])("fails ready-state closed for %s without choosing a substitute", async (reason) => {
    preferences = { ...preferences, rememberedSource: null, defaultCaptureMode: "computer-audio" };
    const microphones =
      reason === "null default"
        ? device.inventory.microphones
        : reason === "duplicate default"
          ? [...device.inventory.microphones, device.inventory.microphones[0]!]
          : [
              ...device.inventory.microphones,
              { deviceId: "other-mic", sourceId: "other-input", label: "Other microphone" }
            ];
    devices = [
      {
        ...device,
        inventory: {
          ...device.inventory,
          microphones,
          ...(reason === "missing default"
            ? {}
            : { defaultMicrophoneId: reason === "null default" ? null : "stable-mic" }),
          ...(reason === "system permission denied"
            ? { systemAudioPermission: "denied" as const }
            : {})
        }
      }
    ];
    if (reason === "saved microphone absent")
      preferences = {
        ...preferences,
        rememberedSource: {
          deviceId: device.deviceId,
          microphoneId: "missing-mic",
          mode: "computer-audio"
        }
      };
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(button("Start recording").disabled).toBe(true);
    expect(host.textContent).toContain("The audio source is unavailable");
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
    expect(calls.some((call) => call.path === "/api/meetings/preferences" && call.body)).toBe(
      false
    );
  });
  it("New meeting opens a ready page without capture or per-meeting settings", async () => {
    await mount(<Shell />);
    await click("New meeting");
    expect(calls.filter((call) => call.path === "/api/meetings/records")).toHaveLength(1);
    expect(calls.find((call) => call.path === "/api/meetings/records")?.body).toMatchObject({
      title: "Untitled meeting"
    });
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
    expect(host.querySelector("#meeting-personal-notes")).not.toBeNull();
    expect(host.querySelector('input[type="radio"]')).toBeNull();
    expect(button("Start recording")).toBeDefined();
  });
  it("coalesces repeated New meeting clicks before a render without starting recording", async () => {
    const normal = transport.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let creations = 0;
    transport.mockImplementation((path, options) => {
      if (path !== "/api/meetings/records") return normal(path, options);
      creations += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await mount(<Shell />);
    act(() => {
      button("New meeting").click();
      button("New meeting").click();
    });
    await settle();
    expect(creations).toBe(1);
    await act(async () => finish(json({ meeting, created: true })));
    await settle();
    expect(host.querySelector("#meeting-personal-notes")).not.toBeNull();
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
  });
  it("shows linking guidance while preserving existing notes for an unlinked Mac", async () => {
    preferences = {
      ...preferences,
      rememberedSource: null,
      defaultCaptureMode: null
    };
    devices = [];
    await mount(<Shell />);
    expect(host.textContent).toContain("Link your Mac");
    expect(host.textContent).toContain("Open Trail Marker");
    expect(button("Download app")).toBeDefined();
    await click("Download app");
    expect(host.textContent).toContain("Link your Mac");
    expect(button("New meeting")).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(<Shell />, `/meetings?id=${meeting.id}`);
    expect(host.querySelector("#meeting-personal-notes")).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("Set up Meetings");
    expect(calls.filter((call) => call.path === "/api/meetings/records")).toHaveLength(0);
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
    expect(calls.some((call) => call.path === "/api/meetings/preferences" && call.body)).toBe(
      false
    );
  });
  it("Start sends only one idempotency key and leaves notes visible", async () => {
    await mount(<Shell />, `/meetings?id=${meeting.id}`);
    const notes = host.querySelector("#meeting-personal-notes");
    await click("Start recording");
    const request = calls.find((call) => call.path.endsWith("/capture/start"));
    expect(Object.keys(request!.body!)).toEqual(["requestKey"]);
    expect(host.querySelector("#meeting-personal-notes")).toBe(notes);
  });
  it("coalesces repeated Start recording clicks before a render", async () => {
    const normal = transport.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let starts = 0;
    transport.mockImplementation((path, options) => {
      if (!path.endsWith("/capture/start")) return normal(path, options);
      starts += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    act(() => {
      button("Start recording").click();
      button("Start recording").click();
    });
    await settle();
    expect(starts).toBe(1);
    await act(async () => finish(json({ capture: capture() })));
    await settle();
    expect(starts).toBe(1);
  });
  it("keeps paused recording controls without source summaries or a Change action", async () => {
    status.capture = capture({
      desired: "paused",
      generation: 2,
      observed: { generation: 2, phase: "paused" }
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(button("Resume").disabled).toBe(false);
    expect(button("Stop").disabled).toBe(false);
    expect(host.textContent).not.toContain("Desk microphone");
    expect(host.textContent).not.toContain("Resume will use");
    expect(host.textContent).not.toContain("Change");
  });
  it("starts fresh linked Macs directly without setup gates or changing preferences", async () => {
    preferences = {
      ...preferences,
      defaultCaptureMode: "computer-audio",
      rememberedSource: null
    };
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(button("Start recording").disabled).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("Change");
    expect(host.textContent).not.toContain("Complete your meeting setup");
    await click("Start recording");
    expect(calls.filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some((call) => call.path === "/api/meetings/preferences" && call.body)).toBe(
      false
    );
  });
  it.each([true, false])("ignores a late create after auth reset (success=%s)", async (success) => {
    const normal = transport.getMockImplementation()!;
    let finish!: (response: Response) => void;
    transport.mockImplementation((path, options) =>
      path === "/api/meetings/records"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount(<Shell />);
    await click("New meeting");
    await act(async () => {
      root.unmount();
      await client.resetQueries();
    });
    root = createRoot(host);
    await mount(<Shell />);
    await act(async () =>
      finish(
        json(success ? { meeting, created: true } : { message: "Old failure" }, success ? 200 : 400)
      )
    );
    await settle();
    expect(client.getQueryData(["meetings", "new-meeting"])).toEqual({ phase: "idle" });
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
  });
  it.each(["start", "resume"] as const)(
    "drops late %s success/failure after the real auth reset",
    async (action) => {
      if (action === "resume")
        status.capture = capture({
          desired: "paused",
          generation: 2,
          observed: { generation: 2, phase: "paused" }
        });
      const normal = transport.getMockImplementation()!;
      let finish!: (response: Response) => void;
      transport.mockImplementation((path, options) => {
        const body = options?.body
          ? (JSON.parse(String(options.body)) as { command?: string })
          : null;
        return path.endsWith("/capture/start") ||
          (path.endsWith("/capture/control") && body?.command === "record")
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : normal(path, options);
      });
      await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
      await click(action === "start" ? "Start recording" : "Resume");
      await act(async () => {
        root.unmount();
        await client.resetQueries();
      });
      root = createRoot(host);
      await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
      const before = client.getQueryData(captureKeys.session(meeting.id));
      await act(async () => finish(json({ capture: capture({ generation: 3 }) })));
      await settle();
      expect(client.getQueryData(captureKeys.session(meeting.id))).toEqual(before);
      expect(
        client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(meeting.id))?.capture
          ?.generation
      ).not.toBe(3);
    }
  );
  it("shows only a return timer away from the recording and clears it after Stop", async () => {
    status.capture = capture();
    await mount(<Shell />, `/meetings?id=${meeting.id}`);
    await click("Other module");
    expect(host.querySelector('[aria-label^="Return to meeting: Design review"]')).not.toBeNull();
    expect(button("Pause")).toBeUndefined();
    expect(button("Stop")).toBeUndefined();
    status.capture = capture({
      desired: "stopped",
      observed: { generation: 1, phase: "stopped" },
      finalization: "complete"
    });
    act(() => refreshCaptureStatus(client, meeting.id));
    await settle();
    expect(host.querySelector('[aria-label^="Return to meeting: Design review"]')).toBeNull();
  });
  it("Stop supersedes a lost Pause response using the current generation", async () => {
    status.capture = capture();
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/control") && JSON.parse(String(options?.body)).command === "pause") {
        await normal(path, options);
        return new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        );
      }
      return normal(path, options);
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    await click("Pause");
    expect(button("Stop").disabled).toBe(false);
    await click("Stop");
    expect(
      calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body?.command)
    ).toEqual(["pause", "stop", "stop"]);
    expect(status.capture?.desired).toBe("stopped");
  });

  it("shares one bounded status stream across panel and strip and fetches each transcript revision once", async () => {
    vi.useFakeTimers();
    status.capture = capture({ transcriptRevision: 2 });
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const normal = transport.getMockImplementation()!;
    let statusRequestsStarted = 0;
    transport.mockImplementation(async (path: string, options?: RequestInit) => {
      if (/\/capture(?:\?|$)/.test(path)) statusRequestsStarted += 1;
      if (path.includes("/capture?")) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20000);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
      }
      return normal(path, options);
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/history"]}>
            <MeetingCaptureStrip />
            <CapturePanel meeting={meeting} onLiveChange={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(statusRequestsStarted).toBe(4);
    expect(
      invalidated.mock.calls.filter(([filters]) => filters?.queryKey?.[1] === "transcript")
    ).toHaveLength(1);
  });

  it("suspends browser status reads while hidden and resumes when visible", async () => {
    vi.useFakeTimers();
    status.capture = capture();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <CapturePanel meeting={meeting} onLiveChange={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    const before = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(calls.length).toBe(before);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(calls.length).toBe(before + 1);
  });

  it("advances only an acknowledged recording clock and freezes it across slow snapshots and Pause", async () => {
    vi.useFakeTimers();
    status.capture = capture({ recordedDurationMs: 2000 });
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path: string, options?: RequestInit) =>
      path.includes("/capture?")
        ? new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
        : normal(path, options)
    );
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <CapturePanel meeting={meeting} onLiveChange={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(2200));
    expect(host.querySelector('[aria-label="Recorded duration"]')!.textContent).toBe("0:04");
    const paused = capture({
      recordedDurationMs: 4200,
      generation: 2,
      desired: "paused",
      observed: { generation: 2, phase: "paused" }
    });
    act(() => client.setQueryData(captureKeys.status(meeting.id), { ...status, capture: paused }));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(host.querySelector('[aria-label="Recorded duration"]')!.textContent).toBe("0:04");
  });

  it("keeps a newer grant when an older Start response arrives late", async () => {
    const normal = transport.getMockImplementation()!;
    let finish!: (value: Response) => void;
    transport.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/capture/start")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    await click("Start recording");
    const newer = capture({ grantId: "newer-grant", deviceName: "Other Mac" });
    status = { ...status, capture: newer };
    act(() => client.setQueryData(captureKeys.status(meeting.id), { ...status, capture: newer }));
    await act(async () => finish(json({ capture: capture() })));
    await settle();
    expect(
      client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(meeting.id))?.capture
        ?.grantId
    ).toBe("newer-grant");
  });

  it("fences a dropped Start on Stop and never recreates it when its response arrives late", async () => {
    const normal = transport.getMockImplementation()!;
    let sentStart: Record<string, unknown> | undefined;
    let finishLate!: (response: Response) => void;
    let startRequests = 0;
    const cancelled = new Set<string>();
    transport.mockImplementation((path: string, options?: RequestInit) => {
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : undefined;
      if (path.endsWith("/capture/start")) {
        startRequests += 1;
        if (startRequests === 1) {
          sentStart = body;
          return new Promise<Response>((resolve) => {
            finishLate = resolve;
          });
        }
      }
      if (path.endsWith("/capture/cancel-start")) {
        calls.push({ path, body });
        cancelled.add(String(body?.requestKey));
        return Promise.resolve(json({ cancelled: true, capture: null }));
      }
      return normal(path, options);
    });
    await mount(<Shell />, `/meetings?id=${meeting.id}`);
    await click("Start recording");
    await click("Stop");
    expect(calls.filter((call) => call.path.endsWith("/capture/cancel-start"))).toHaveLength(1);
    expect(cancelled.has(String(sentStart?.requestKey))).toBe(true);
    expect(startRequests).toBe(1);
    await act(async () => finishLate(json({ code: "meeting_capture_conflict" }, 409)));
    await settle();
    expect(status.capture).toBeNull();
    expect(client.getQueryData(captureKeys.active)).toBeNull();
    expect(calls.filter((call) => call.path.endsWith("/capture/control"))).toHaveLength(0);
    expect(button("Stop")).toBeUndefined();
  });

  it("ends polling and offers New when finalization completes without a native acknowledgement", async () => {
    vi.useFakeTimers();
    status.capture = capture({
      desired: "stopped",
      observed: null,
      finalization: "complete",
      recordedDurationMs: 0
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <CapturePanel meeting={meeting} onLiveChange={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(host.textContent).toContain("Ended");
    expect(button("Stop")).toBeUndefined();
    expect([...host.querySelectorAll("a")].some((link) => link.textContent === "New meeting")).toBe(
      true
    );
    const before = captureStatusCalls().length;
    await act(async () => vi.advanceTimersByTimeAsync(90000));
    expect(captureStatusCalls()).toHaveLength(before);
  });

  it("can explicitly Resume an acknowledged preclaim Pause without auto-starting", async () => {
    status.capture = capture({ observed: null, recordedDurationMs: 0 });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    await click("Pause");
    expect(host.querySelector('[aria-label="Paused"]')).not.toBeNull();
    expect(button("Resume").disabled).toBe(false);
    expect(
      calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body?.command)
    ).toEqual(["pause"]);
    await click("Resume");
    expect(
      calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body?.command)
    ).toEqual(["pause", "record"]);
  });

  it("keeps Resume disabled after an error-only report until a current-generation pause acknowledgement", async () => {
    // These protocol states are exercised through the real APIs in meeting-capture-auto-pause.
    // This synthetic UI test guards the button, not the server's acknowledgement transition.
    status.capture = capture({
      desired: "paused",
      generation: 2,
      observed: { generation: 1, phase: "error", errorCode: "capture_failed" }
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(button("Resume").disabled).toBe(true);
    await click("Resume");
    expect(calls.filter((call) => call.body?.command === "record")).toHaveLength(0);
    for (const observed of [
      { generation: 1, phase: "paused" },
      { generation: 2, phase: "error", errorCode: "capture_failed" }
    ] as const) {
      status.capture = capture({ ...status.capture!, observed });
      act(() => client.setQueryData(captureKeys.status(meeting.id), { ...status }));
      await settle();
      expect(button("Resume").disabled).toBe(true);
    }
    status.capture = capture({
      ...status.capture!,
      observed: { generation: 2, phase: "paused" }
    });
    act(() => client.setQueryData(captureKeys.status(meeting.id), { ...status }));
    await settle();
    expect(button("Resume").disabled).toBe(false);
    expect(calls.filter((call) => call.body?.command === "record")).toHaveLength(0);
    await click("Resume");
    expect(calls.filter((call) => call.body?.command === "record")).toHaveLength(1);
    expect(calls.find((call) => call.body?.command === "record")?.body).toMatchObject({
      expectedGeneration: 2,
      command: "record"
    });
  });

  it("coalesces repeated Stop clicks and keeps its cutoff unchanged", async () => {
    status.capture = capture();
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    act(() => {
      button("Stop").click();
      button("Stop").click();
    });
    await settle();
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1);
    expect(status.capture?.stopCutoffMs).toBe(80000);
  });

  it("stops terminal polling and honors a 60-second Retry-After across manual refresh", async () => {
    vi.useFakeTimers();
    status.capture = capture({
      desired: "stopped",
      observed: { generation: 1, phase: "stopped" },
      finalization: "complete"
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <CapturePanel meeting={meeting} onLiveChange={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    const before = captureStatusCalls().length;
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(captureStatusCalls()).toHaveLength(before);
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (path, options) => {
      if (!/\/capture(?:\?|$)/.test(path)) return normal(path, options);
      calls.push({ path, body: undefined });
      return json({ message: "Rate limited" }, 429, { "Retry-After": "60" });
    });
    act(() => refreshCaptureStatus(client, meeting.id));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    const limited = captureStatusCalls().length;
    act(() => refreshCaptureStatus(client, meeting.id));
    await act(async () => vi.advanceTimersByTimeAsync(59000));
    expect(captureStatusCalls()).toHaveLength(limited);
    await act(async () => vi.advanceTimersByTimeAsync(1100));
    expect(captureStatusCalls()).toHaveLength(limited + 1);
  });
});
