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
import { registerCaptureNoticeRegressions } from "./meeting-capture-notice-web-cases.js";
import { MeetingSetup } from "../../packages/meetings/src/web/meeting-setup.js";
import { MeetingsPage } from "../../packages/meetings/src/web/meetings-page.js";
import { CapturePanel } from "../../packages/meetings/src/web/capture-panel.js";
import { ModulePersistentControls } from "../../apps/web/src/shell/module-persistent-controls.js";
import { MeetingCaptureStrip } from "../../packages/meetings/src/web/capture-strip.js";
import { refreshCaptureStatus } from "../../packages/meetings/src/web/capture-status.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";
import {
  captureSelection,
  emptyCaptureChoice
} from "../../packages/meetings/src/web/capture-presentation.js";

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
    if (path === "/api/meetings/capture/devices") return json({ devices, processingReady: true });
    if (path === "/api/meetings/records")
      return json({ meeting: { ...meeting, title: body?.title }, created: true });
    if (path.endsWith("/capture/start")) {
      status = {
        ...status,
        revision: "1",
        capture: capture({
          selection: body?.selection as MeetingCaptureState["selection"],
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
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
async function acknowledgeNotice(scope: ParentNode = host) {
  const notice = scope.querySelector<HTMLInputElement>('input[aria-label="Recording notice"]');
  expect(notice).not.toBeNull();
  if (!notice!.checked) await act(async () => notice!.click());
  if (vi.isFakeTimers()) await act(async () => vi.advanceTimersByTimeAsync(1));
  else await settle();
}
function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  for (const character of text)
    act(() => {
      setter.call(input, input.value + character);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
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

describe("capture browser DOM regressions (synthetic unit transport; not live Mac proof)", () => {
  registerCaptureNoticeRegressions({
    capture,
    meeting,
    json,
    mount,
    acknowledgeNotice,
    click,
    button,
    settle,
    transport: () => transport,
    client: () => client,
    host: () => host,
    root: () => root,
    setRoot: (value) => {
      root = value;
    },
    setCapture: (value) => {
      status.capture = value;
    },
    getCapture: () => status.capture,
    calls: () => calls
  });
  it("keeps every rapidly typed title character before deferred query notifications", async () => {
    await mount(<MeetingSetup onCreated={() => {}} />);
    const input = host.querySelector<HTMLInputElement>("#meeting-title")!;
    type(input, "A fast meeting title");
    expect(input.value).toBe("A fast meeting title");
    expect(client.getQueryData(["meetings", "setup-draft"])).toMatchObject({ title: input.value });
    await settle();
    expect(input.value).toBe("A fast meeting title");
  });
  it("keeps rapid notes and search edits through list navigation", async () => {
    await mount(<Shell />, `/meetings?id=${meeting.id}`);
    await click("My notes");
    const notes = host.querySelector<HTMLTextAreaElement>("#meeting-personal-notes")!;
    type(notes, "All my notes survive");
    expect(notes.value).toBe("All my notes survive");
    await click("View meeting history");
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    type(search, "quick search");
    expect(search.value).toBe("quick search");
  });
  it.each(["microphone-only", "selected-app", "computer-audio"] as const)(
    "one Start uses remembered %s sources in this tab",
    async (mode) => {
      preferences = {
        defaultCaptureMode: mode,
        rememberedSource: {
          deviceId: device.deviceId,
          microphoneId: "stable-mic",
          mode,
          ...(mode === "selected-app" ? { applicationId: "com.example.meeting" } : {})
        }
      };
      const opened = vi.spyOn(window, "open").mockImplementation(() => null);
      const onCreated = vi.fn();
      await mount(<MeetingSetup onCreated={onCreated} />);
      expect(host.textContent).toContain("Studio Mac");
      expect(host.textContent).toContain("Desk microphone");
      expect(host.querySelector('[role="switch"]')).toBeNull();
      expect(button("Start meeting").disabled).toBe(true);
      expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
      const notice = host.querySelector<HTMLInputElement>('input[aria-label="Recording notice"]')!;
      expect(notice).not.toBeNull();
      expect(notice.checked).toBe(false);
      await act(async () => notice.click());
      await settle();
      expect(button("Start meeting").disabled).toBe(false);
      await acknowledgeNotice();
      await click("Start meeting");
      const starts = calls.filter((call) => call.path.endsWith("/capture/start"));
      expect(starts).toHaveLength(1);
      expect(starts[0]!.body?.noticeAcknowledged).toBe(true);
      expect(starts[0]!.body?.selection).toMatchObject({
        mode,
        microphone: { deviceId: "stable-mic", sourceId: "mic" }
      });
      if (mode === "selected-app")
        expect(starts[0]!.body?.selection).toMatchObject({
          applicationId: "com.example.meeting",
          appProcessTreeId: "current-process"
        });
      expect(calls.find((call) => call.path === "/api/meetings/records")?.body?.title).toBe(
        "New meeting"
      );
      expect(onCreated).toHaveBeenCalledWith(meeting.id);
      expect(opened).not.toHaveBeenCalled();
      opened.mockRestore();
    }
  );
  it.each(["device", "microphone", "application"])(
    "never falls back when the remembered %s is missing",
    async (missing) => {
      preferences = {
        defaultCaptureMode: "selected-app",
        rememberedSource: {
          deviceId: device.deviceId,
          microphoneId: "stable-mic",
          applicationId: "com.example.meeting",
          mode: "selected-app"
        }
      };
      devices =
        missing === "device"
          ? []
          : [
              {
                ...device,
                inventory: {
                  ...device.inventory,
                  ...(missing === "microphone"
                    ? {
                        microphones: [
                          { deviceId: "other", sourceId: "other", label: "Other microphone" }
                        ]
                      }
                    : { applications: [] })
                }
              }
            ];
      await mount(<MeetingSetup onCreated={() => {}} />);
      expect(button("Start meeting").disabled).toBe(true);
      expect(host.textContent).toContain("unavailable");
      expect(button("Change") || button("Done changing sources")).toBeDefined();
      expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
    }
  );

  it("never starts on connection and never chooses a first device or source", async () => {
    preferences = { defaultCaptureMode: null };
    await mount(<MeetingSetup onCreated={() => {}} />);
    expect(button("Start meeting").disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>("#meeting-capture-device")!.value).toBe("");
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
  });
  it("coalesces repeated Start clicks before the draft response", async () => {
    let finish!: (value: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path: string, options?: RequestInit) =>
      path === "/api/meetings/records"
        ? new Promise<Response>((resolve) => {
            calls.push({ path, body: JSON.parse(String(options?.body)) });
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount(<MeetingSetup onCreated={() => {}} />);
    await acknowledgeNotice();
    act(() => {
      button("Start meeting").click();
      button("Start meeting").click();
    });
    expect(calls.filter((call) => call.path === "/api/meetings/records")).toHaveLength(1);
    await act(async () => finish(json({ meeting, created: true })));
    await settle();
    expect(calls.filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(1);
  });
  it("does not restore another signed-in session after a late draft response", async () => {
    let finish!: (value: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path: string, options?: RequestInit) =>
      path === "/api/meetings/records"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    const created = vi.fn();
    await mount(<MeetingSetup onCreated={created} />);
    await acknowledgeNotice();
    act(() => button("Start meeting").click());
    await act(async () => {
      root.unmount();
      client.clear();
    });
    root = createRoot(host);
    await act(async () => finish(json({ meeting, created: true })));
    await settle();
    expect(created).not.toHaveBeenCalled();
    expect(client.getQueryData(captureKeys.active)).toBeUndefined();
    expect(calls.some((call) => call.path.endsWith("/capture/start"))).toBe(false);
  });

  it("retries a transient Start automatically with the exact same key and source", async () => {
    const normal = transport.getMockImplementation()!;
    let attempts = 0;
    transport.mockImplementation((path: string, options?: RequestInit) => {
      if (path.endsWith("/capture/start") && attempts++ < 2) {
        calls.push({ path, body: JSON.parse(String(options?.body)) });
        return Promise.resolve(json({ message: "Temporary failure" }, 503));
      }
      return normal(path, options);
    });
    await mount(<MeetingSetup onCreated={() => {}} />);
    vi.useFakeTimers();
    await acknowledgeNotice();
    act(() => button("Start meeting").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const starts = calls.filter((call) => call.path.endsWith("/capture/start"));
    expect(starts).toHaveLength(3);
    expect(starts[1]!.body).toEqual(starts[0]!.body);
    expect(starts[2]!.body).toEqual(starts[0]!.body);
  });
  it.each(["clear", "resetQueries"] as const)(
    "rejects a late Start response after owner session %s",
    async (reset) => {
      const normal = transport.getMockImplementation()!;
      let finish!: (value: Response) => void;
      transport.mockImplementation((path: string, options?: RequestInit) =>
        path.endsWith("/capture/start")
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : normal(path, options)
      );
      await mount(<MeetingSetup onCreated={() => {}} />);
      await acknowledgeNotice();
      await click("Start meeting");
      await act(async () => {
        root.unmount();
        if (reset === "clear") client.clear();
        else await client.resetQueries();
      });
      root = createRoot(host);
      await act(async () => finish(json({ capture: capture() })));
      await settle();
      expect(client.getQueryData(captureKeys.active)).toBeUndefined();
      expect(client.getQueryData(captureKeys.status(meeting.id))).toBeUndefined();
    }
  );
  it("keeps recording and Pause/Stop controls through list and module navigation", async () => {
    status.capture = capture();
    await mount(<Shell />, `/meetings?id=${meeting.id}`);
    await click("View meeting history");
    expect(host.querySelector('[aria-label="Active meeting recording"]')).not.toBeNull();
    expect(button("Pause")).toBeDefined();
    await click("Other module");
    expect(host.textContent).toContain("Settings");
    expect(button("Stop and review")).toBeDefined();
    expect(calls.filter((call) => call.path.endsWith("/capture/control"))).toHaveLength(0);
    await click("Pause");
    expect(host.textContent).toContain("Paused");
    await click("Stop and review");
    expect(host.textContent).toContain("Stopped");
    expect(
      calls
        .filter((call) => call.path.endsWith("/capture/control"))
        .map((call) => call.body?.command)
    ).toEqual(["pause", "stop"]);
  });
  it("separates delayed transcription and freezes acknowledged duration on failure", async () => {
    status.capture = capture({
      recordedDurationMs: 4200,
      observed: { generation: 1, phase: "error" },
      processing: { status: "delayed" }
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(host.textContent).toContain("Capture interrupted");
    expect(host.textContent).toContain("Transcription delayed");
    expect(host.querySelector('[aria-label="Recorded duration"]')!.textContent).toBe("0:04");
    expect(button("Stop and review").disabled).toBe(false);
    expect(host.textContent).not.toContain("1:20");
    expect(button("Change")).toBeDefined();
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
    expect(button("Stop and review").disabled).toBe(false);
    await click("Stop and review");
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
  it("keeps Start disabled while the selected Mac finalizes its prior recording", async () => {
    devices = [
      {
        ...device,
        busy: true,
        capturePhase: "finalizing",
        finalizationDeadline: new Date(Date.now() + 60000).toISOString()
      }
    ];
    await mount(<MeetingSetup onCreated={() => {}} />);
    expect(button("Start meeting").disabled).toBe(true);
    expect(host.textContent).toContain("finishing the previous transcript");
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
    await mount(<MeetingSetup onCreated={() => {}} />);
    await acknowledgeNotice();
    await click("Start meeting");
    const newer = capture({ grantId: "newer-grant", deviceName: "Other Mac" });
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
    await mount(<Shell />);
    await acknowledgeNotice();
    await click("Start meeting");
    await click("Stop and review");
    expect(calls.filter((call) => call.path.endsWith("/capture/cancel-start"))).toHaveLength(1);
    expect(cancelled.has(String(sentStart?.requestKey))).toBe(true);
    expect(startRequests).toBe(1);
    await act(async () => finishLate(json({ code: "meeting_capture_conflict" }, 409)));
    await settle();
    expect(status.capture).toBeNull();
    expect(client.getQueryData(captureKeys.active)).toBeNull();
    expect(calls.filter((call) => call.path.endsWith("/capture/control"))).toHaveLength(0);
    expect(button("Stop and review")).toBeUndefined();
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
    expect(host.textContent).toContain("Recording authority ended");
    expect(button("Stop and review")).toBeUndefined();
    expect([...host.querySelectorAll("a")].some((link) => link.textContent === "New meeting")).toBe(
      true
    );
    const before = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(90000));
    expect(calls.length).toBe(before);
  });
  it("can explicitly Resume an acknowledged preclaim Pause without auto-starting", async () => {
    status.capture = capture({ observed: null, recordedDurationMs: 0 });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    await click("Pause");
    expect(host.textContent).toContain("Paused");
    expect(button("Resume").disabled).toBe(true);
    await acknowledgeNotice();
    expect(button("Resume").disabled).toBe(false);
    expect(
      calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body?.command)
    ).toEqual(["pause"]);
    await acknowledgeNotice();
    await click("Resume");
    expect(
      calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body?.command)
    ).toEqual(["pause", "record"]);
  });
  it.each(["panel", "strip"] as const)(
    "a second browser narrowing the same grant cannot make stale %s Resume broaden capture",
    async (surface) => {
      status.capture = capture({
        selection: {
          mode: "computer-audio",
          microphone: { deviceId: "stable-mic", sourceId: "mic" },
          outputSourceId: "output",
          scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss", "trail-marker"] }
        }
      });
      await mount(<Shell />, `/meetings?id=${meeting.id}`);
      const secondClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } }
      });
      const secondHost = document.createElement("div");
      document.body.appendChild(secondHost);
      const secondRoot = createRoot(secondHost);
      const secondButton = (label: string) =>
        [...secondHost.querySelectorAll("button")].find((item) => item.textContent === label)!;
      try {
        await act(async () =>
          secondRoot.render(
            <QueryClientProvider client={secondClient}>
              <MemoryRouter>
                <CapturePanel meeting={meeting} onLiveChange={() => {}} />
              </MemoryRouter>
            </QueryClientProvider>
          )
        );
        await settle();
        await act(async () => secondButton("Pause").click());
        await settle();
        await act(async () => secondButton("Change").click());
        await settle();
        act(() =>
          secondHost.querySelector<HTMLInputElement>('input[value="microphone-only"]')!.click()
        );
        await settle();
        await acknowledgeNotice(secondHost);
        await act(async () => secondButton("Resume").click());
        await settle();
        expect(status.capture?.selection?.mode).toBe("microphone-only");
        if (surface === "strip") await click("Other module");
        act(() => refreshCaptureStatus(client, meeting.id));
        await settle();
        await click("Pause");
        await acknowledgeNotice();
        await click("Resume");
        const resumed = calls.filter(
          (call) => call.path.endsWith("/capture/control") && call.body?.command === "record"
        );
        expect(resumed).toHaveLength(2);
        expect(resumed[1]!.body?.selection).toMatchObject({ mode: "microphone-only" });
      } finally {
        await act(async () => secondRoot.unmount());
        secondClient.clear();
        secondHost.remove();
      }
    }
  );
  it("preserves a visible unsent source Change within the same paused generation", async () => {
    status.capture = capture();
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    await click("Pause");
    await click("Change");
    act(() => host.querySelector<HTMLInputElement>('input[value="computer-audio"]')!.click());
    await settle();
    act(() => refreshCaptureStatus(client, meeting.id));
    await settle();
    await acknowledgeNotice();
    await click("Resume");
    expect(
      calls.filter((call) => call.path.endsWith("/capture/control")).at(-1)?.body?.selection
    ).toMatchObject({ mode: "computer-audio" });
  });

  it("coalesces repeated Stop clicks and keeps its cutoff unchanged", async () => {
    status.capture = capture();
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    act(() => {
      button("Stop and review").click();
      button("Stop and review").click();
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
    const before = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(calls.length).toBe(before);
    transport.mockImplementation(async () => {
      calls.push({ path: "rate-limit", body: undefined });
      return json({ message: "Rate limited" }, 429, { "Retry-After": "60" });
    });
    act(() => button("Refresh capture status").click());
    await act(async () => vi.advanceTimersByTimeAsync(10));
    const limited = calls.length;
    act(() => button("Refresh capture status").click());
    await act(async () => vi.advanceTimersByTimeAsync(59000));
    expect(calls.length).toBe(limited);
    await act(async () => vi.advanceTimersByTimeAsync(1100));
    expect(calls.length).toBe(limited + 1);
  });
});

describe("stable source resolution", () => {
  it("allows the first explicit Start to request microphone permission, but blocks denied access", () => {
    const choice = {
      ...emptyCaptureChoice,
      mode: "microphone-only" as const,
      microphoneId: "stable-mic"
    };
    expect(
      captureSelection(choice, { ...device.inventory, microphonePermission: "unknown" })
    ).not.toBeNull();
    expect(
      captureSelection(choice, { ...device.inventory, microphonePermission: "denied" })
    ).toBeNull();
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
        ...device.inventory,
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
        ...device.inventory,
        applications: [
          ...device.inventory.applications,
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
    expect(captureSelection(choice, device.inventory)).toMatchObject({
      appProcessTreeId: "current-process"
    });
    expect(
      captureSelection(choice, {
        ...device.inventory,
        applications: [
          { applicationId: "com.other", appProcessTreeId: "current-process", label: "Other app" }
        ]
      })
    ).toBeNull();
  });
});
