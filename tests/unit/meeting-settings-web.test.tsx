// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListMySessionsResponse,
  MeetingCaptureDevice,
  MeetingCapturePreferences,
  MeetingOutputsResponse,
  MeetingRecordingNoticeStatus,
  RecordingCapabilitiesResponse,
  UpdateMeetingCapturePreferences
} from "@moss/shared";
import { MeetingSetup } from "../../packages/meetings/src/web/meeting-setup.js";
import MeetingSettings from "../../packages/meetings/src/web/meeting-settings.js";
import { meetingSettingsKeys } from "../../packages/meetings/src/web/meeting-settings-state.js";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";

const now = "2026-10-06T12:00:00.000Z";
const device: MeetingCaptureDevice = {
  deviceId: "22334455-1122-4122-8122-112233445566",
  deviceName: "Studio Mac",
  connectionId: "connected-mac",
  revision: 1,
  capabilityRevision: 1,
  lastSeenAt: now,
  expiresAt: "2026-10-07T12:00:00.000Z",
  inventory: {
    microphones: [{ deviceId: "desk-mic", sourceId: "input", label: "Desk microphone" }],
    applications: [
      {
        applicationId: "com.example.meeting",
        appProcessTreeId: "call-process",
        label: "Meeting app"
      }
    ],
    computerAudio: { available: true, excludedProcessTreeIds: ["moss", "trail-marker"] },
    microphonePermission: "granted",
    systemAudioPermission: "granted"
  }
};
const newPreferences = (): MeetingCapturePreferences => ({
  defaultCaptureMode: null,
  rememberedSource: null,
  summarizeOnStop: true,
  summaryTemplateId: "general",
  setupCompletedAt: null
});
const savedPreferences = (): MeetingCapturePreferences => ({
  ...newPreferences(),
  defaultCaptureMode: "computer-audio",
  rememberedSource: { deviceId: device.deviceId, microphoneId: "desk-mic", mode: "computer-audio" },
  setupCompletedAt: now
});
const storedNotice = (): MeetingRecordingNoticeStatus => ({
  currentNotice: {
    policyVersion: "v1",
    text: "Tell people when recording. Selected audio goes to your transcription service."
  },
  acknowledgement: { policyVersion: "v1", acknowledgedAt: now }
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const preferencesPath = "/api/meetings/preferences";
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let preferences: MeetingCapturePreferences;
let notice: MeetingRecordingNoticeStatus;
let devices: readonly MeetingCaptureDevice[];
let sessions: ListMySessionsResponse;
let capabilities: RecordingCapabilitiesResponse;
let availability: Pick<MeetingOutputsResponse, "generationAvailability" | "templates">;
let processingReady: boolean;
let calls: { path: string; method: string; body?: Record<string, unknown> }[];
let transport: ReturnType<typeof vi.fn<(path: string, options?: RequestInit) => Promise<Response>>>;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function mount(view: ReactNode = <MeetingSetup onCompleted={() => {}} />) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{view}</MemoryRouter>
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
function checkbox(label: string) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}
async function toggle(label: string) {
  await act(async () => checkbox(label).click());
  await settle();
}
async function select(id: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLSelectElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
const writes = () => calls.filter((call) => call.path === preferencesPath && call.method === "PUT");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preferences = newPreferences();
  notice = { ...storedNotice(), acknowledgement: null };
  devices = [device];
  processingReady = true;
  sessions = {
    sessions: [
      {
        id: device.deviceId,
        isCurrent: false,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: "2026-10-07T12:00:00.000Z",
        ipAddress: null,
        userAgent: null,
        deviceLabel: device.deviceName,
        browser: null,
        os: "macOS",
        deviceKind: "laptop",
        source: "companion",
        companion: {
          product: "Trail Marker for Mac",
          displayName: device.deviceName,
          appVersion: "1.4",
          osVersion: "15",
          lastContactAt: now
        }
      }
    ]
  };
  capabilities = {
    devices: [
      {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        state: "approved",
        revision: 1,
        policyVersion: 1
      }
    ]
  };
  availability = {
    generationAvailability: "available",
    templates: [
      { id: "general", version: 1, name: "General meeting" },
      { id: "project-review", version: 1, name: "Project review" }
    ]
  };
  calls = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } }
  });
  transport = vi.fn(async (path, options) => {
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ path, method: options?.method ?? "GET", body });
    if (path === preferencesPath) {
      if (body) {
        const update = body as UpdateMeetingCapturePreferences;
        preferences = {
          ...preferences,
          ...(update.defaultCaptureMode !== undefined
            ? { defaultCaptureMode: update.defaultCaptureMode }
            : {}),
          ...(update.rememberedSource !== undefined
            ? { rememberedSource: update.rememberedSource }
            : {}),
          summarizeOnStop: update.summarizeOnStop ?? preferences.summarizeOnStop,
          summaryTemplateId: update.summaryTemplateId ?? preferences.summaryTemplateId,
          setupCompletedAt: update.completeSetup ? now : preferences.setupCompletedAt
        };
      }
      return json(preferences);
    }
    if (path === "/api/meetings/recording-notice") {
      if (body)
        notice = {
          ...notice,
          acknowledgement: { policyVersion: String(body.policyVersion), acknowledgedAt: now }
        };
      return json(notice);
    }
    if (path === "/api/meetings/capture/devices") return json({ devices, processingReady });
    if (path === "/api/me/sessions") return json(sessions);
    if (path === "/api/companion/recording-capabilities") return json(capabilities);
    if (path === "/api/meetings/output-availability") return json(availability);
    if (path === "/api/me/locale")
      return json({ locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" } });
    throw new Error(`Unexpected synthetic settings request ${path}`);
  });
  vi.stubGlobal("fetch", transport);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Meetings setup and settings (synthetic transport, not live Mac proof)", () => {
  it("defaults summary on, completes setup after stored notice, and never creates or starts a meeting", async () => {
    const onCompleted = vi.fn();
    await mount(<MeetingSetup onCompleted={onCompleted} />);
    expect(host.textContent).toContain("Set up Meetings");
    expect(checkbox("Write a summary when I stop").checked).toBe(true);
    expect(host.querySelector<HTMLSelectElement>("#meeting-settings-microphone")?.value).toBe(
      "desk-mic"
    );
    expect(host.querySelector<HTMLInputElement>('input[value="computer-audio"]')?.checked).toBe(
      true
    );
    expect(button("Finish setup").disabled).toBe(true);
    await toggle("Recording notice");
    expect(button("Finish setup").disabled).toBe(false);
    await click("Finish setup");
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(writes()[0]?.body).toEqual({
      defaultCaptureMode: "computer-audio",
      rememberedSource: {
        deviceId: device.deviceId,
        microphoneId: "desk-mic",
        mode: "computer-audio"
      },
      summarizeOnStop: true,
      summaryTemplateId: "general",
      completeSetup: true
    });
    expect(client.getQueryData(meetingKeys.preferences)).toMatchObject({ setupCompletedAt: now });
    expect(
      calls.some(
        (call) => call.path.endsWith("/capture/start") || call.path === "/api/meetings/records"
      )
    ).toBe(false);
    expect(host.textContent).not.toContain("System default");
  });
  it("reuses the current account notice and makes it reviewable with its stored date", async () => {
    notice = storedNotice();
    await mount();
    expect(checkbox("Recording notice")).toBeNull();
    expect(host.textContent).toContain("Recording notice acknowledged");
    expect(host.textContent).toContain("2026");
    await click("Review recording notice");
    expect(host.textContent).toContain(notice.currentNotice.text);
    await click("Finish setup");
    expect(
      calls.filter(
        (call) => call.path === "/api/meetings/recording-notice" && call.method === "PUT"
      )
    ).toHaveLength(0);
  });
  it("uses microphone-only only after explicitly skipping unavailable computer audio", async () => {
    notice = storedNotice();
    devices = [{ ...device, inventory: { ...device.inventory, systemAudioPermission: "denied" } }];
    await mount();
    expect(button("Finish setup").disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[value="computer-audio"]')?.checked).toBe(
      true
    );
    await click("Skip computer audio");
    expect(host.textContent).toContain(
      "Computer audio skipped. Meetings will use your microphone only."
    );
    expect(button("Finish setup").disabled).toBe(false);
    await click("Finish setup");
    expect(writes()[0]?.body?.rememberedSource).toMatchObject({ mode: "microphone-only" });
  });
  it("does not replace a missing saved microphone with an available one", async () => {
    notice = storedNotice();
    preferences = {
      ...savedPreferences(),
      rememberedSource: {
        deviceId: device.deviceId,
        mode: "computer-audio",
        microphoneId: "missing-mic"
      }
    };
    await mount();
    expect(host.querySelector<HTMLSelectElement>("#meeting-settings-microphone")?.value).toBe(
      "missing-mic"
    );
    expect(host.textContent).toContain("Saved microphone is unavailable");
    expect(button("Finish setup").disabled).toBe(true);
    await select("meeting-settings-microphone", "desk-mic");
    expect(button("Finish setup").disabled).toBe(false);
  });
  it("shows unavailable and ambiguous selected apps without falling back", async () => {
    notice = storedNotice();
    preferences = {
      ...savedPreferences(),
      defaultCaptureMode: "selected-app",
      rememberedSource: {
        deviceId: device.deviceId,
        mode: "selected-app",
        microphoneId: "desk-mic",
        applicationId: "missing-app"
      }
    };
    await mount();
    expect(host.textContent).toContain("Saved meeting app is unavailable");
    expect(button("Finish setup").disabled).toBe(true);
    await select("meeting-settings-app", "com.example.meeting");
    expect(button("Finish setup").disabled).toBe(false);
    devices = [
      {
        ...device,
        inventory: {
          ...device.inventory,
          applications: [
            ...device.inventory.applications,
            { ...device.inventory.applications[0]!, appProcessTreeId: "another-process" }
          ]
        }
      }
    ];
    await click("Check again");
    expect(host.textContent).toContain("More than one instance of this app is open");
    expect(button("Finish setup").disabled).toBe(true);
  });
  it("shows genuine linked device, permissions and provider readiness without unsupported controls", async () => {
    capabilities = { devices: [{ ...capabilities.devices[0]!, state: "revoked" }] };
    devices = [];
    processingReady = false;
    availability = { ...availability, generationAvailability: "model-unavailable" };
    await mount();
    expect(host.textContent).toContain("Studio Mac");
    expect(host.textContent).toContain("Trail Marker 1.4");
    expect(host.textContent).toContain("Update recording access in Profile settings");
    expect(host.textContent).toContain("Not confirmed yet");
    expect(host.textContent).toContain("Needs a transcription route");
    expect(host.textContent).toContain("Needs a summary-capable model");
    expect(host.textContent).toContain("CLI models cannot write meeting summaries today");
    expect(button("Unlink")).toBeUndefined();
    expect(button("Open System Settings")).toBeUndefined();
    expect(host.querySelector('a[href="/settings?section=profile"]')).not.toBeNull();
    expect(button("Finish setup").disabled).toBe(true);
  });
  it("lets settings change summary defaults with an unchanged offline source and run setup again", async () => {
    notice = storedNotice();
    preferences = savedPreferences();
    devices = [];
    await mount(<MeetingSettings />);
    expect(host.textContent).toContain("Saved Mac is not connected");
    await toggle("Write a summary when I stop");
    await select("meeting-settings-summary-style", "project-review");
    await click("Save settings");
    expect(writes()[0]?.body).toEqual({
      summarizeOnStop: false,
      summaryTemplateId: "project-review"
    });
    expect(host.textContent).toContain("Meeting settings saved");
    await click("Run setup again");
    expect(host.textContent).toContain("Set up Meetings");
    expect(button("Finish setup").disabled).toBe(true);
    await click("Cancel");
    expect(button("Run setup again")).toBeDefined();
    expect(writes()).toHaveLength(1);
  });
  it("changes only the summary switch when inventory refresh fails, without replacing newer server defaults", async () => {
    notice = storedNotice();
    preferences = savedPreferences();
    await mount(<MeetingSettings />);
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === "/api/meetings/capture/devices"
        ? Promise.resolve(json({ message: "Mac offline" }, 503))
        : normal(path, options)
    );
    await click("Check again");
    expect(host.textContent).toContain("Couldn’t confirm the latest Mac connection");
    expect(host.textContent).toContain("Connection not confirmed");
    preferences = {
      ...preferences,
      summaryTemplateId: "project-review",
      rememberedSource: {
        deviceId: "another-mac",
        microphoneId: "another-mic",
        mode: "microphone-only"
      }
    };
    await toggle("Write a summary when I stop");
    expect(button("Save settings").disabled).toBe(false);
    await click("Save settings");
    expect(writes()[0]?.body).toEqual({ summarizeOnStop: false });
    expect(preferences.summaryTemplateId).toBe("project-review");
    expect(preferences.rememberedSource?.microphoneId).toBe("another-mic");
  });
  it("requires notice for a source change while summary-only edits remain independent", async () => {
    preferences = savedPreferences();
    await mount(<MeetingSettings />);
    await toggle("Write a summary when I stop");
    expect(button("Save settings").disabled).toBe(false);
    await click("Save settings");
    expect(writes()[0]?.body).toEqual({ summarizeOnStop: false });
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[value="microphone-only"]')!.click()
    );
    await settle();
    expect(button("Save settings").disabled).toBe(true);
    await toggle("Recording notice");
    await click("Save settings");
    expect(writes()[1]?.body).toEqual({
      defaultCaptureMode: "microphone-only",
      rememberedSource: {
        deviceId: device.deviceId,
        microphoneId: "desk-mic",
        mode: "microphone-only"
      }
    });
  });
  it("keeps a completed setup receipt when a pre-save preferences read returns late", async () => {
    notice = storedNotice();
    let finish!: (response: Response) => void;
    let delayRead = false;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath && !options?.method && delayRead
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount();
    delayRead = true;
    act(() => {
      void client.invalidateQueries({ queryKey: meetingKeys.preferences });
    });
    await settle();
    await click("Finish setup");
    expect(client.getQueryData(meetingKeys.preferences)).toMatchObject({ setupCompletedAt: now });
    await act(async () => finish(json(newPreferences())));
    await settle();
    expect(client.getQueryData(meetingKeys.preferences)).toMatchObject({ setupCompletedAt: now });
  });
  it("refreshes the canonical notice when policy changes before Finish reaches the server", async () => {
    notice = storedNotice();
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath && options?.method === "PUT"
        ? Promise.resolve(json({ code: "meeting_capture_notice_required" }, 409))
        : normal(path, options)
    );
    const onCompleted = vi.fn();
    await mount(<MeetingSetup onCompleted={onCompleted} />);
    notice = {
      ...notice,
      currentNotice: { policyVersion: "v2", text: "Updated recording notice" }
    };
    await click("Finish setup");
    expect(onCompleted).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Updated recording notice");
    expect(host.textContent).toContain("Review the current recording notice");
    expect(button("Finish setup").disabled).toBe(true);
  });
  it("refreshes clean server defaults without replacing an unsaved explicit choice", async () => {
    preferences = savedPreferences();
    notice = storedNotice();
    await mount(<MeetingSettings />);
    preferences = { ...preferences, summaryTemplateId: "project-review" };
    await click("Check again");
    expect(host.querySelector<HTMLSelectElement>("#meeting-settings-summary-style")?.value).toBe(
      "project-review"
    );
    await select("meeting-settings-summary-style", "general");
    preferences = { ...preferences, summarizeOnStop: false };
    await click("Check again");
    expect(host.querySelector<HTMLSelectElement>("#meeting-settings-summary-style")?.value).toBe(
      "general"
    );
    await click("Save settings");
    expect(writes()[0]?.body).toEqual({ summaryTemplateId: "general" });
    expect(preferences.summarizeOnStop).toBe(false);
  });
  it("shows loading and a retryable preferences error without replacing saved choices", async () => {
    let finish!: (response: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount();
    expect(host.textContent).toContain("Loading your meeting settings");
    expect(button("Finish setup")).toBeUndefined();
    await act(async () => finish(json({ message: "Offline" }, 503)));
    await settle();
    expect(host.textContent).toContain("Couldn’t load your meeting settings");
    transport.mockImplementation(normal);
    await click("Retry loading settings");
    expect(button("Finish setup")).toBeDefined();
    expect(writes()).toHaveLength(0);
  });
  it("keeps selected defaults after save failure and retries once without duplicate concurrent saves", async () => {
    notice = storedNotice();
    let finish!: (response: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath && options?.method === "PUT"
        ? new Promise<Response>((resolve) => {
            calls.push({ path, method: "PUT", body: JSON.parse(String(options.body)) });
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount();
    await toggle("Write a summary when I stop");
    act(() => {
      button("Finish setup").click();
      button("Finish setup").click();
    });
    expect(writes()).toHaveLength(1);
    await act(async () => finish(json({ message: "Temporary failure" }, 503)));
    await settle();
    expect(host.textContent).toContain("Your choices are kept");
    expect(checkbox("Write a summary when I stop").checked).toBe(false);
    transport.mockImplementation(normal);
    await click("Finish setup");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.body).toEqual(writes()[0]?.body);
  });
  it.each([false, true])(
    "ignores late settings responses after actual auth reset (success=%s)",
    async (success) => {
      notice = storedNotice();
      const pending: ((response: Response) => void)[] = [];
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) =>
        path === preferencesPath && options?.method === "PUT"
          ? new Promise<Response>((resolve) => {
              pending.push(resolve);
            })
          : normal(path, options)
      );
      const onCompleted = vi.fn();
      await mount(<MeetingSetup onCompleted={onCompleted} />);
      act(() => button("Finish setup").click());
      await act(async () => {
        root.unmount();
        await client.resetQueries();
      });
      root = createRoot(host);
      await mount(<MeetingSetup onCompleted={onCompleted} />);
      await toggle("Write a summary when I stop");
      act(() => button("Finish setup").click());
      const newer = client.getQueryData(meetingSettingsKeys.draft);
      await act(async () =>
        pending[0]!(success ? json(savedPreferences()) : json({ message: "Old failure" }, 400))
      );
      await settle();
      expect(client.getQueryData(meetingSettingsKeys.draft)).toEqual(newer);
      expect(onCompleted).not.toHaveBeenCalled();
      preferences = { ...savedPreferences(), summarizeOnStop: false };
      await act(async () => pending[1]!(json(preferences)));
      await settle();
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(meetingKeys.preferences)).toEqual(preferences);
    }
  );
  it.each([
    ["/api/me/sessions", 401],
    ["/api/companion/recording-capabilities", 403],
    ["/api/meetings/capture/devices", 403]
  ] as const)(
    "masks cached Mac/source metadata when %s denies access (%s)",
    async (deniedPath, status) => {
      notice = storedNotice();
      preferences = savedPreferences();
      await mount(<MeetingSettings />);
      expect(host.textContent).toContain("Studio Mac");
      expect(host.textContent).toContain("Desk microphone");
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) =>
        path === deniedPath
          ? Promise.resolve(json({ message: "Access denied" }, status))
          : normal(path, options)
      );
      await click("Check again");
      expect(host.textContent).not.toContain("Studio Mac");
      expect(host.textContent).toContain("Mac access could not be verified");
      expect(host.textContent).not.toContain("Desk microphone");
      expect(host.textContent).not.toContain("Meeting recording enabled");
      expect(host.querySelector("#meeting-settings-microphone")).toBeNull();
      await toggle("Write a summary when I stop");
      await click("Save settings");
      expect(writes()[0]?.body).toEqual({ summarizeOnStop: false });
    }
  );
  it("does not render the previous account's linked Mac after actual auth reset", async () => {
    notice = storedNotice();
    await mount();
    expect(host.textContent).toContain("Studio Mac");
    await act(async () => {
      root.unmount();
      await client.resetQueries();
    });
    root = createRoot(host);
    sessions = { sessions: [] };
    capabilities = { devices: [] };
    devices = [];
    preferences = newPreferences();
    notice = { ...storedNotice(), acknowledgement: null };
    await mount();
    expect(host.textContent).not.toContain("Studio Mac");
    expect(host.textContent).not.toContain("Desk microphone");
    expect(host.textContent).toContain("No Mac is linked");
    expect(button("Finish setup").disabled).toBe(true);
  });
  it("checks the latest cached source inventory at Finish before sending", async () => {
    notice = storedNotice();
    await mount();
    act(() => {
      client.setQueryData(captureKeys.devices, { devices: [], processingReady: true });
      button("Finish setup").click();
    });
    await settle();
    expect(writes()).toHaveLength(0);
  });
  it("limits the global navigation flex rule to its text label, not recording indicators", () => {
    const css = readFileSync("apps/web/src/styles.css", "utf8");
    expect(css).not.toContain(".module-link span {");
    expect(css).toContain(".module-link > .module-link__label {");
    const link = document.createElement("a");
    link.className = "module-link";
    const label = document.createElement("span");
    label.className = "module-link__label";
    const indicator = document.createElement("span");
    indicator.className = "jds-indicator";
    const dot = document.createElement("span");
    indicator.appendChild(dot);
    link.append(label, indicator);
    expect([...link.querySelectorAll(".module-link > .module-link__label")]).toEqual([label]);
  });
});
