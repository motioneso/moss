// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListMySessionsResponse,
  MeetingCaptureDevice,
  MeetingCapturePreferences,
  RecordingCapabilitiesResponse,
  UpdateMeetingCapturePreferences
} from "@moss/shared";
import MeetingSettings from "../../packages/meetings/src/web/meeting-settings.js";
import { meetingSettingsKeys } from "../../packages/meetings/src/web/meeting-settings-state.js";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";
import { meetingLinkKeys } from "../../packages/meetings/src/web/meeting-link-state.js";

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
  defaultCaptureMode: "computer-audio",
  rememberedSource: null,
  summarizeOnStop: true,
  summaryTemplateId: "general"
});
const savedPreferences = (): MeetingCapturePreferences => ({
  ...newPreferences(),
  defaultCaptureMode: "computer-audio",
  rememberedSource: { deviceId: device.deviceId, microphoneId: "desk-mic", mode: "computer-audio" }
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const preferencesPath = "/api/meetings/preferences";
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let preferences: MeetingCapturePreferences;
let devices: readonly MeetingCaptureDevice[];
let sessions: ListMySessionsResponse;
let capabilities: RecordingCapabilitiesResponse;
let processingReady: boolean;
let calls: { path: string; method: string; body?: Record<string, unknown> }[];
let transport: ReturnType<typeof vi.fn<(path: string, options?: RequestInit) => Promise<Response>>>;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function mount(view: ReactNode = <MeetingSettings />) {
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
async function select(id: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLSelectElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
function summarySwitch() {
  return host.querySelector<HTMLInputElement>(
    'input[aria-label="Summarize automatically after Stop"]'
  )!;
}
async function toggleSummary() {
  await act(async () => summarySwitch().click());
  await settle();
}
const writes = () => calls.filter((call) => call.path === preferencesPath && call.method === "PUT");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preferences = newPreferences();
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
          summaryTemplateId: update.summaryTemplateId ?? preferences.summaryTemplateId
        };
      }
      return json(preferences);
    }
    if (path === "/api/meetings/capture/devices") return json({ devices, processingReady });
    if (path.startsWith("/api/me/sessions/") && options?.method === "DELETE") {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      sessions = { sessions: sessions.sessions.filter((item) => item.id !== id) };
      capabilities = { devices: capabilities.devices.filter((item) => item.deviceId !== id) };
      devices = devices.filter((item) => item.deviceId !== id);
      return json({ success: true });
    }
    if (path === "/api/me/sessions") return json(sessions);
    if (path === "/api/companion/recording-capabilities") return json(capabilities);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("minimal Meetings settings (synthetic transport, not live Mac proof)", () => {
  it("shows linked status, audio source, automatic summary switch and Unlink Mac", async () => {
    await mount();
    expect(host.textContent).toContain("Studio Mac");
    expect(host.textContent).toContain("Linked");
    const source = host.querySelector<HTMLSelectElement>("#meeting-settings-audio-source")!;
    expect(source.value).toBe("computer-audio");
    expect([...source.options].map((option) => option.textContent)).toEqual([
      "Microphone + system audio",
      "Microphone only"
    ]);
    expect([...host.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Unlink Mac"
    ]);
    expect(host.querySelectorAll("select")).toHaveLength(1);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(summarySwitch().checked).toBe(true);
    expect(host.textContent).not.toMatch(
      /notice|acknowledge|Finish setup|summary style|Moss address|Choose a microphone|Run setup/i
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => /notice|output-availability/.test(call.path))).toBe(false);
  });
  it("saves only automatic summary OFF and ON, preserves audio and template, and reloads the saved value", async () => {
    preferences = { ...savedPreferences(), summaryTemplateId: "project-review" };
    const originalSource = structuredClone(preferences.rememberedSource);
    await mount();
    await toggleSummary();
    expect(writes().map((call) => call.body)).toEqual([{ summarizeOnStop: false }]);
    expect(summarySwitch().checked).toBe(false);
    expect(preferences.summarizeOnStop).toBe(false);
    expect(preferences.rememberedSource).toEqual(originalSource);
    expect(preferences.summaryTemplateId).toBe("project-review");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(summarySwitch().checked).toBe(false);
    await toggleSummary();
    expect(writes().at(-1)?.body).toEqual({ summarizeOnStop: true });
    expect(preferences.summarizeOnStop).toBe(true);
    expect(calls.some((call) => /capture\/(start|control)$|\/records$/.test(call.path))).toBe(
      false
    );
  });
  it("keeps failed summary OFF visible, disables concurrent writes and retries only the pending choice", async () => {
    let finish!: (value: Response) => void;
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
    await act(async () => {
      summarySwitch().click();
      summarySwitch().click();
    });
    await settle();
    expect(writes()).toHaveLength(1);
    expect(summarySwitch().disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    expect(button("Unlink Mac").disabled).toBe(true);
    await act(async () => finish(json({ message: "Unavailable" }, 503)));
    await settle();
    expect(summarySwitch().checked).toBe(false);
    expect(preferences.summarizeOnStop).toBe(true);
    expect(host.textContent).toContain("the saved setting still applies");
    await act(async () => client.refetchQueries({ queryKey: meetingKeys.preferences }));
    await settle();
    expect(summarySwitch().checked).toBe(false);
    transport.mockImplementation(normal);
    await click("Retry");
    expect(writes().map((call) => call.body)).toEqual([
      { summarizeOnStop: false },
      { summarizeOnStop: false }
    ]);
    expect(preferences.summarizeOnStop).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it.each([true, false])(
    "ignores late summary saves after an account reset (success=%s)",
    async (success) => {
      let finish!: (value: Response) => void;
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) =>
        path === preferencesPath && options?.method === "PUT"
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : normal(path, options)
      );
      await mount();
      await toggleSummary();
      await act(async () => client.resetQueries());
      await settle();
      const newer = client.getQueryData(meetingSettingsKeys.draft);
      await act(async () =>
        finish(
          success
            ? json({ ...newPreferences(), summarizeOnStop: false })
            : json({ message: "Old failure" }, 503)
        )
      );
      await settle();
      expect(client.getQueryData(meetingSettingsKeys.draft)).toEqual(newer);
      expect(summarySwitch().checked).toBe(true);
      expect(host.textContent).not.toContain("Couldn’t save automatic summary");
    }
  );
  it("retains a confirmed summary choice across ordinary unmount and prevents an old read replacing it", async () => {
    await mount();
    let finish!: (value: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath && options?.method !== "PUT"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    act(() => {
      void client.refetchQueries({ queryKey: meetingKeys.preferences });
    });
    await settle();
    await toggleSummary();
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => finish(json(newPreferences())));
    transport.mockImplementation(normal);
    await mount();
    expect(summarySwitch().checked).toBe(false);
    expect(
      client.getQueryData<MeetingCapturePreferences>(meetingKeys.preferences)?.summarizeOnStop
    ).toBe(false);
  });
  it.each([true, false])(
    "keeps a pending summary write across ordinary navigation (success=%s)",
    async (success) => {
      let finish!: (value: Response) => void;
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
      await toggleSummary();
      await act(async () => root.unmount());
      root = createRoot(host);
      await mount();
      expect(summarySwitch().disabled).toBe(true);
      expect(summarySwitch().checked).toBe(false);
      await act(async () =>
        finish(
          success
            ? json({ ...newPreferences(), summarizeOnStop: false })
            : json({ message: "Unavailable" }, 503)
        )
      );
      await settle();
      expect(summarySwitch().disabled).toBe(false);
      expect(summarySwitch().checked).toBe(false);
      expect(writes()).toHaveLength(1);
      if (success) {
        expect(
          client.getQueryData<MeetingCapturePreferences>(meetingKeys.preferences)?.summarizeOnStop
        ).toBe(false);
        expect(host.querySelector('[role="alert"]')).toBeNull();
      } else {
        expect(host.textContent).toContain("the saved setting still applies");
        transport.mockImplementation(normal);
        await click("Retry");
        expect(writes().at(-1)?.body).toEqual({ summarizeOnStop: false });
        expect(preferences.summarizeOnStop).toBe(false);
      }
    }
  );
  it.each(["audio", "summary"])(
    "names both unsaved settings after %s fails first, then retries both choices",
    async (first) => {
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) => {
        if (path === preferencesPath && options?.method === "PUT") {
          calls.push({ path, method: "PUT", body: JSON.parse(String(options.body)) });
          return Promise.resolve(json({ message: "Unavailable" }, 503));
        }
        return normal(path, options);
      });
      await mount();
      if (first === "audio") {
        await select("meeting-settings-audio-source", "microphone-only");
        await toggleSummary();
      } else {
        await toggleSummary();
        await select("meeting-settings-audio-source", "microphone-only");
      }
      const choices = { defaultCaptureMode: "microphone-only", summarizeOnStop: false };
      expect(writes().at(-1)?.body).toEqual(choices);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn’t save your audio source or automatic summary. Your choices are kept here; the saved settings still apply."
      );
      expect(preferences.defaultCaptureMode).toBe("computer-audio");
      expect(preferences.summarizeOnStop).toBe(true);
      expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("microphone-only");
      expect(summarySwitch().checked).toBe(false);
      transport.mockImplementation(normal);
      await click("Retry");
      expect(writes().at(-1)?.body).toEqual(choices);
      expect(preferences).toMatchObject(choices);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    }
  );

  it("saves only the chosen mode immediately, preserving exact legacy microphone and unrelated preferences", async () => {
    preferences = savedPreferences();
    await mount();
    await select("meeting-settings-audio-source", "microphone-only");
    expect(writes().map((call) => call.body)).toEqual([{ defaultCaptureMode: "microphone-only" }]);
    expect(preferences.rememberedSource).toEqual({
      deviceId: device.deviceId,
      microphoneId: "desk-mic",
      mode: "computer-audio"
    });
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("microphone-only");
    expect(preferences.summarizeOnStop).toBe(true);
    expect(calls.some((call) => /capture\/(start|control)$|\/records$/.test(call.path))).toBe(
      false
    );
  });
  it("preserves a saved selected app until an explicit supported mode change", async () => {
    preferences = {
      ...savedPreferences(),
      defaultCaptureMode: "selected-app",
      rememberedSource: {
        deviceId: device.deviceId,
        microphoneId: "desk-mic",
        mode: "selected-app",
        applicationId: "com.example.meeting"
      }
    };
    await mount();
    const source = host.querySelector<HTMLSelectElement>("#meeting-settings-audio-source")!;
    expect(source.value).toBe("selected-app");
    expect(source.selectedOptions[0]?.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
    await select("meeting-settings-audio-source", "computer-audio");
    expect(writes()[0]?.body).toEqual({ defaultCaptureMode: "computer-audio" });
    expect(preferences.rememberedSource?.mode).toBe("selected-app");
    expect(preferences.rememberedSource?.applicationId).toBe("com.example.meeting");
    expect(source.value).toBe("computer-audio");
    expect(source.querySelector('[value="selected-app"]')).toBeNull();
  });
  it("keeps a linked offline Mac visible and lets mode changes save without selecting new hardware", async () => {
    devices = [];
    preferences = savedPreferences();
    await mount();
    expect(host.textContent).toContain("Studio Mac");
    expect(host.textContent).toContain("Linked");
    expect(button("Unlink Mac").disabled).toBe(false);
    await select("meeting-settings-audio-source", "microphone-only");
    expect(writes()[0]?.body).toEqual({ defaultCaptureMode: "microphone-only" });
  });
  it("shows no linked Mac without inventing a download or address field in Settings", async () => {
    sessions = { sessions: [] };
    devices = [];
    capabilities = { devices: [] };
    await mount();
    expect(host.textContent).toContain("No Mac linked");
    expect(button("Unlink Mac")).toBeUndefined();
    expect(host.querySelectorAll("a, input:not([type=checkbox])")).toHaveLength(0);
    expect(summarySwitch().checked).toBe(true);
  });
  it("keeps a failed audio choice and retries without concurrent duplicate writes", async () => {
    let finish!: (value: Response) => void;
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
    act(() => {
      const source = host.querySelector<HTMLSelectElement>("#meeting-settings-audio-source")!;
      source.value = "microphone-only";
      source.dispatchEvent(new Event("change", { bubbles: true }));
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(writes()).toHaveLength(1);
    expect(host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    await act(async () => finish(json({ message: "Unavailable" }, 503)));
    await settle();
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("microphone-only");
    expect(host.textContent).toContain("Couldn’t save your audio source");
    transport.mockImplementation(normal);
    await click("Retry");
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.body).toEqual(writes()[0]?.body);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("loads fresh server defaults without replacing an unsaved failed choice", async () => {
    await mount();
    preferences = { ...preferences, defaultCaptureMode: "microphone-only" };
    await act(async () => {
      await client.refetchQueries({ queryKey: meetingKeys.preferences });
    });
    await settle();
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("microphone-only");
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath && options?.method === "PUT"
        ? Promise.resolve(json({ message: "Unavailable" }, 500))
        : normal(path, options)
    );
    await select("meeting-settings-audio-source", "computer-audio");
    await act(async () => {
      await client.refetchQueries({ queryKey: meetingKeys.preferences });
    });
    await settle();
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("computer-audio");
  });
  it("keeps a confirmed mode when an older preference read returns late", async () => {
    await mount();
    let finish!: (value: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath && options?.method !== "PUT"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    act(() => {
      void client.refetchQueries({ queryKey: meetingKeys.preferences });
    });
    await settle();
    await select("meeting-settings-audio-source", "microphone-only");
    await act(async () => finish(json(newPreferences())));
    await settle();
    expect(
      client.getQueryData<MeetingCapturePreferences>(meetingKeys.preferences)?.defaultCaptureMode
    ).toBe("microphone-only");
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("microphone-only");
  });
  it("shows a retryable preference read error without writing defaults", async () => {
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === preferencesPath
        ? Promise.resolve(json({ message: "Unavailable" }, 503))
        : normal(path, options)
    );
    await mount();
    expect(host.textContent).toContain("Couldn’t load your meeting settings");
    expect(host.querySelector("select")).toBeNull();
    transport.mockImplementation(normal);
    await click("Retry loading settings");
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("computer-audio");
    expect(writes()).toHaveLength(0);
  });
  it.each([
    "/api/me/sessions",
    "/api/companion/recording-capabilities",
    "/api/meetings/capture/devices"
  ])("masks private metadata and rejects stale actions after denial from %s", async (path) => {
    await mount();
    const source = host.querySelector<HTMLSelectElement>("select")!;
    const unlink = button("Unlink Mac");
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((target, options) =>
      target === path ? Promise.resolve(json({ message: "Denied" }, 403)) : normal(target, options)
    );
    await act(async () => {
      await client.refetchQueries({
        predicate: (query) =>
          [meetingLinkKeys.sessions, meetingLinkKeys.capabilities, captureKeys.devices].some(
            (key) => JSON.stringify(query.queryKey) === JSON.stringify(key)
          )
      });
      source.value = "microphone-only";
      source.dispatchEvent(new Event("change", { bubbles: true }));
      unlink.click();
    });
    await settle();
    expect(host.textContent).toContain("Mac access could not be verified");
    expect(host.textContent).not.toContain("Studio Mac");
    expect(host.querySelector("select")).toBeNull();
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
  it.each([true, false])(
    "ignores a late mode write after a mounted auth reset (success=%s)",
    async (success) => {
      let finish!: (value: Response) => void;
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) =>
        path === preferencesPath && options?.method === "PUT"
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : normal(path, options)
      );
      await mount();
      await select("meeting-settings-audio-source", "microphone-only");
      sessions = { sessions: [] };
      devices = [];
      capabilities = { devices: [] };
      await act(async () => {
        await client.resetQueries();
      });
      await settle();
      const newer = client.getQueryData(meetingSettingsKeys.draft);
      await act(async () =>
        finish(
          success
            ? json({ ...newPreferences(), defaultCaptureMode: "microphone-only" })
            : json({ message: "Old failure" }, 503)
        )
      );
      await settle();
      expect(client.getQueryData(meetingSettingsKeys.draft)).toEqual(newer);
      expect(host.textContent).not.toContain("Studio Mac");
      expect(host.textContent).not.toContain("Couldn’t save");
    }
  );
  it("unlinks the exact named Mac and retains preferences and saved content", async () => {
    preferences = savedPreferences();
    const original = structuredClone(preferences);
    const second = {
      ...sessions.sessions[0]!,
      id: "33445566-1122-4122-8122-112233445566",
      deviceLabel: "Other Mac",
      companion: { ...sessions.sessions[0]!.companion!, displayName: "Other Mac" }
    };
    sessions = { sessions: [...sessions.sessions, second] };
    const notes = { meeting: { personalNotes: "Keep these notes" } };
    const transcript = { snapshot: { segments: [{ text: "Keep this transcript" }] } };
    client.setQueryData(meetingKeys.record("meeting"), notes);
    client.setQueryData(meetingKeys.transcript("meeting"), transcript);
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Unlink Studio Mac"]')!.click()
    );
    await settle();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[role="dialog"] button.jds-btn--danger')!.click()
    );
    await settle();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([
      { path: `/api/me/sessions/${device.deviceId}`, method: "DELETE", body: undefined }
    ]);
    expect(sessions.sessions).toEqual([second]);
    expect(preferences).toEqual(original);
    expect(writes()).toHaveLength(0);
    expect(client.getQueryData(meetingKeys.record("meeting"))).toEqual(notes);
    expect(client.getQueryData(meetingKeys.transcript("meeting"))).toEqual(transcript);
  });
  it("cancels Unlink by button, Escape or backdrop without making a request", async () => {
    await mount();
    for (const close of ["button", "escape", "backdrop"]) {
      await click("Unlink Mac");
      expect(document.activeElement?.textContent).toBe("Cancel");
      await act(async () => {
        if (close === "button") button("Cancel").click();
        else if (close === "escape")
          document.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          );
        else host.querySelector<HTMLElement>(".jds-dialog-scrim")!.click();
      });
      await settle();
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    }
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });
  it("coalesces Unlink confirmations, leaves an uncertain result linked and permits retry", async () => {
    let finish!: (value: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      options?.method === "DELETE"
        ? new Promise<Response>((resolve) => {
            calls.push({ path, method: "DELETE" });
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount();
    await click("Unlink Mac");
    act(() => {
      const confirm = host.querySelector<HTMLButtonElement>(
        '[role="dialog"] button.jds-btn--danger'
      )!;
      confirm.click();
      confirm.click();
    });
    await settle();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => {
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      host.querySelector<HTMLElement>(".jds-dialog-scrim")!.click();
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => finish(json({ message: "Unavailable" }, 503)));
    await settle();
    expect(host.textContent).toContain("Couldn’t confirm Unlink");
    expect(sessions.sessions).toHaveLength(1);
    transport.mockImplementation(normal);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[role="dialog"] button.jds-btn--danger')!.click()
    );
    await settle();
    expect(sessions.sessions).toHaveLength(0);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("aborts a timed-out Unlink, keeps the link and permits retry", async () => {
    let signal: AbortSignal | undefined;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      options?.method === "DELETE"
        ? new Promise<Response>((_resolve, reject) => {
            calls.push({ path, method: "DELETE" });
            signal = options.signal ?? undefined;
            signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
        : normal(path, options)
    );
    await mount();
    await click("Unlink Mac");
    vi.useFakeTimers();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[role="dialog"] button.jds-btn--danger')!.click()
    );
    expect(signal?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(12000));
    vi.useRealTimers();
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(host.textContent).toContain("Couldn’t confirm Unlink");
    expect(sessions.sessions).toHaveLength(1);
    expect(client.getQueryData(meetingLinkKeys.sessions)).toEqual(sessions);
    expect(button("Cancel").disabled).toBe(false);
    transport.mockImplementation(normal);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[role="dialog"] button.jds-btn--danger')!.click()
    );
    await settle();
    expect(sessions.sessions).toHaveLength(0);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("rechecks the exact companion session before Unlink confirmation", async () => {
    await mount();
    await click("Unlink Mac");
    const confirm = host.querySelector<HTMLButtonElement>(
      '[role="dialog"] button.jds-btn--danger'
    )!;
    await act(async () => {
      client.setQueryData(meetingLinkKeys.sessions, {
        sessions: [{ ...sessions.sessions[0]!, source: "browser" }]
      });
      confirm.click();
    });
    await settle();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it.each(["auth reset", "navigation"])(
    "ignores late Unlink results after %s",
    async (boundary) => {
      for (const success of [false, true]) {
        let finish!: (value: Response) => void;
        let signal: AbortSignal | undefined;
        const normal = transport.getMockImplementation()!;
        transport.mockImplementation((path, options) =>
          options?.method === "DELETE"
            ? new Promise<Response>((resolve) => {
                finish = resolve;
                signal = options.signal ?? undefined;
              })
            : normal(path, options)
        );
        await mount();
        await click("Unlink Mac");
        act(() =>
          host.querySelector<HTMLButtonElement>('[role="dialog"] button.jds-btn--danger')!.click()
        );
        await settle();
        await act(async () => {
          root.unmount();
          if (boundary === "auth reset") await client.resetQueries();
        });
        expect(signal?.aborted).toBe(true);
        root = createRoot(host);
        transport.mockImplementation(normal);
        await mount();
        const newer = client.getQueryData(meetingLinkKeys.action);
        await act(async () =>
          finish(success ? json({ success: true }) : json({ message: "Old failure" }, 500))
        );
        await settle();
        expect(client.getQueryData(meetingLinkKeys.action)).toEqual(newer);
        expect(client.getQueryData(meetingLinkKeys.sessions)).toEqual(sessions);
        expect(host.textContent).not.toContain("Couldn’t confirm Unlink");
        expect(host.textContent).not.toContain("Studio Mac unlinked");
      }
    }
  );
  it("hides an old confirmation after auth resets to a different account", async () => {
    await mount();
    await click("Unlink Mac");
    sessions = { sessions: [] };
    capabilities = { devices: [] };
    devices = [];
    await act(async () => {
      await client.resetQueries();
    });
    await settle();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("Studio Mac");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });
  it("does not write preferences when effects replay under StrictMode", async () => {
    await mount(
      <StrictMode>
        <MeetingSettings />
      </StrictMode>
    );
    expect(writes()).toHaveLength(0);
    expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("computer-audio");
  });
  it("keeps the navigation layout scoped to its label", () => {
    const css = readFileSync("apps/web/src/styles.css", "utf8");
    expect(css).not.toContain(".module-link span {");
    expect(css).toContain(".module-link > .module-link__label {");
  });
});
