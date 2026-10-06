// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecordingNoticeStatus } from "@moss/shared";
import { CaptureNotice } from "../../packages/meetings/src/web/capture-notice.js";
import {
  isRecordingNoticeAcknowledged,
  recordingNoticeKey,
  useRecordingNotice
} from "../../packages/meetings/src/web/recording-notice.js";

const initialNotice = (): MeetingRecordingNoticeStatus => ({
  currentNotice: {
    policyVersion: "v1",
    text: "Tell people before recording. Selected audio is transcribed."
  },
  acknowledgement: null
});
const acknowledged = (notice = initialNotice()): MeetingRecordingNoticeStatus => ({
  ...notice,
  acknowledgement: {
    policyVersion: notice.currentNotice.policyVersion,
    acknowledgedAt: "2026-10-06T10:00:00.000Z"
  }
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const noticePath = "/api/meetings/recording-notice";
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let serverNotice: MeetingRecordingNoticeStatus;
let writes: Record<string, unknown>[];
let transport: ReturnType<typeof vi.fn<(path: string, options?: RequestInit) => Promise<Response>>>;
function Readiness() {
  const notice = useRecordingNotice();
  return <button disabled={!notice.acknowledged}>Start</button>;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CaptureNotice />
          <Readiness />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
  await settle();
}
function checkbox() {
  return host.querySelector<HTMLInputElement>('input[aria-label="Recording notice"]')!;
}
function start() {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === "Start")!;
}
async function check() {
  await act(async () => checkbox().click());
  await settle();
}
async function reset() {
  await act(async () => {
    root.unmount();
    await client.resetQueries();
  });
  root = createRoot(host);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  serverNotice = initialNotice();
  writes = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  transport = vi.fn(async (path, options) => {
    if (path === "/api/me/locale")
      return json({ locale: { timezone: "UTC", region: "en-GB", dateFormat: "24" } });
    if (path !== noticePath) throw new Error(`Unexpected unit request ${path}`);
    if (options?.method === "PUT") {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      writes.push(body);
      if (body.policyVersion !== serverNotice.currentNotice.policyVersion)
        return json({ code: "meeting_capture_notice_required" }, 409);
      serverNotice = acknowledged(serverNotice);
    }
    return json(serverNotice);
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
describe("account recording notice (synthetic transport, not live proof)", () => {
  it("saves only the displayed policy version, waits for the server, then survives a fresh browser cache", async () => {
    let finish!: (response: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      options?.method === "PUT"
        ? new Promise<Response>((resolve) => {
            writes.push(JSON.parse(String(options.body)));
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount();
    expect(start().disabled).toBe(true);
    await check();
    expect(writes).toEqual([{ policyVersion: "v1" }]);
    expect(start().disabled).toBe(true);
    expect(checkbox().disabled).toBe(true);
    serverNotice = acknowledged();
    await act(async () => finish(json(serverNotice)));
    await settle();
    expect(start().disabled).toBe(false);
    expect(checkbox()).toBeNull();
    await act(async () => root.unmount());
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    root = createRoot(host);
    await mount();
    expect(start().disabled).toBe(false);
    expect(checkbox()).toBeNull();
    expect(writes).toHaveLength(1);
  });
  it("asks again for a changed current version, never just a different browser", async () => {
    serverNotice = {
      ...acknowledged(),
      currentNotice: { policyVersion: "v2", text: "A changed recording notice" }
    };
    await mount();
    expect(start().disabled).toBe(true);
    expect(host.textContent).toContain("A changed recording notice");
    await check();
    expect(writes).toEqual([{ policyVersion: "v2" }]);
    expect(start().disabled).toBe(false);
  });
  it("does not acknowledge cached v2 from a handler that displayed v1", async () => {
    await mount();
    const renderedV1 = checkbox();
    serverNotice = {
      currentNotice: { policyVersion: "v2", text: "New text that must be reviewed" },
      acknowledgement: null
    };
    act(() => {
      client.setQueryData(recordingNoticeKey, serverNotice);
      renderedV1.click();
    });
    await settle();
    expect(writes).toEqual([]);
    expect(start().disabled).toBe(true);
    expect(host.textContent).toContain("New text that must be reviewed");
    await check();
    expect(writes).toEqual([{ policyVersion: "v2" }]);
  });
  it("does not overwrite a newer GET with a delayed old-version PUT response", async () => {
    let finish!: (response: Response) => void;
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      options?.method === "PUT"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount();
    await check();
    serverNotice = {
      currentNotice: { policyVersion: "v2", text: "Latest policy" },
      acknowledgement: null
    };
    act(() => client.setQueryData(recordingNoticeKey, serverNotice));
    await settle();
    await act(async () => finish(json(acknowledged())));
    await settle();
    expect(client.getQueryData(recordingNoticeKey)).toEqual(serverNotice);
    expect(start().disabled).toBe(true);
  });
  it.each(["same", "newer"] as const)(
    "fences a pre-acknowledgement GET while retaining a %s current policy",
    async (version) => {
      let finishPut!: (response: Response) => void;
      let finishRead!: (response: Response) => void;
      let delayRead = false;
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) => {
        if (options?.method === "PUT")
          return new Promise<Response>((resolve) => {
            finishPut = resolve;
          });
        if (path === noticePath && delayRead) {
          delayRead = false;
          return new Promise<Response>((resolve) => {
            finishRead = resolve;
          });
        }
        return normal(path, options);
      });
      await mount();
      await check();
      delayRead = true;
      act(() => {
        void client.invalidateQueries({ queryKey: recordingNoticeKey });
      });
      await settle();
      serverNotice =
        version === "same"
          ? acknowledged()
          : {
              currentNotice: { policyVersion: "v2", text: "Changed after the acknowledgement" },
              acknowledgement: null
            };
      await act(async () => finishPut(json(acknowledged())));
      await settle();
      await act(async () => finishRead(json(version === "same" ? initialNotice() : serverNotice)));
      await settle();
      expect(client.getQueryData(recordingNoticeKey)).toEqual(serverNotice);
      expect(start().disabled).toBe(version === "newer");
    }
  );
  it.each([false, true])(
    "ignores an old PUT after reset while preserving the new account save (success=%s)",
    async (success) => {
      const pending: ((response: Response) => void)[] = [];
      const normal = transport.getMockImplementation()!;
      transport.mockImplementation((path, options) =>
        options?.method === "PUT"
          ? new Promise<Response>((resolve) => {
              pending.push(resolve);
            })
          : normal(path, options)
      );
      await mount();
      await check();
      await reset();
      await mount();
      await check();
      const key = ["meetings", "recording-notice-save"] as const;
      const nextSave = client.getQueryData(key);
      await act(async () =>
        pending[0]!(success ? json(acknowledged()) : json({ message: "Old failure" }, 503))
      );
      await settle();
      expect(client.getQueryData(key)).toEqual(nextSave);
      expect(isRecordingNoticeAcknowledged(client)).toBe(false);
      serverNotice = acknowledged();
      await act(async () => pending[1]!(json(serverNotice)));
      await settle();
      expect(isRecordingNoticeAcknowledged(client)).toBe(true);
    }
  );
  it.each([false, true])(
    "ignores a late GET from before account reset (success=%s)",
    async (success) => {
      let finish!: (response: Response) => void;
      const normal = transport.getMockImplementation()!;
      transport.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
      await mount();
      await reset();
      transport.mockImplementation(normal);
      await mount();
      await act(async () =>
        finish(success ? json(acknowledged()) : json({ message: "Old failure" }, 503))
      );
      await settle();
      expect(start().disabled).toBe(true);
      expect(client.getQueryData(recordingNoticeKey)).toEqual(initialNotice());
    }
  );
  it("keeps Start disabled on a notice read failure and can retry", async () => {
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation((path, options) =>
      path === noticePath
        ? Promise.resolve(json({ message: "Offline" }, 503))
        : normal(path, options)
    );
    await mount();
    expect(start().disabled).toBe(true);
    expect(host.textContent).toContain("Couldn’t check the recording notice");
    transport.mockImplementation(normal);
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Try again")!
        .click()
    );
    await settle();
    expect(checkbox()).not.toBeNull();
    expect(start().disabled).toBe(true);
  });
});
