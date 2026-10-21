// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_SURFACE,
  normalizeChatSurface,
  type ChatVoiceRequestStatus
} from "@moss/shared";
import { VoiceRequests } from "../../apps/web/src/chat/voice-requests.js";
import { VoiceRequestLink } from "../../apps/web/src/chat/voice-request-link.js";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";
import { HomeRedirect } from "../../apps/web/src/home-redirect.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@moss/module-web-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestJson: request
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const receipt: ChatVoiceRequestStatus = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceDeviceId: "ring",
  recordingId: "amsg_1700000000_note",
  threadId: "22222222-2222-4222-8222-222222222222",
  transcript: "Remind me tomorrow.",
  state: "ready-to-send",
  capturedAt: null,
  userMessageId: null,
  assistantMessageId: null,
  statusMessage: "Review before sending."
};
const open = vi.fn();
const props = {
  ownerId: "owner",
  surface: DEFAULT_CHAT_SURFACE,
  mainThreadId: receipt.threadId,
  selectedThreadId: receipt.threadId,
  privateMode: false,
  selectionPending: false,
  privacyConfirmed: true,
  onOpenThread: open
};
let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;
async function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  await render(element);
}
async function render(element: React.ReactNode) {
  await act(async () => {
    root!.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function see(text: string) {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  client?.clear();
  request.mockReset();
  open.mockReset();
});

describe("Main voice request review", () => {
  it("keeps a root deep link across the Today redirect while its owned lookup is pending", async () => {
    let resolve!: (value: ChatVoiceRequestStatus) => void;
    request.mockReturnValue(new Promise<ChatVoiceRequestStatus>((done) => (resolve = done)));
    function Location() {
      const location = useLocation();
      return <output>{location.pathname + location.search + location.hash}</output>;
    }
    await mount(
      <MemoryRouter initialEntries={[`/?voiceRequest=${receipt.id}#ring`]}>
        <VoiceRequestLink ownerId="owner" enabled onOpenThread={open} />
        <Location />
        <Routes>
          <Route index element={<HomeRedirect />} />
          <Route path="today" element={null} />
        </Routes>
      </MemoryRouter>
    );
    expect(container.querySelector("output")?.textContent).toBe(
      `/today?voiceRequest=${receipt.id}#ring`
    );
    expect(open).not.toHaveBeenCalled();
    await act(async () => resolve(receipt));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(receipt.threadId));
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.textContent).toBe("/today#ring")
    );
    expect(request.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });
  it("loads and discloses evidence without sending; only the explicit button dispatches", async () => {
    request.mockImplementation(async (_path: string, options?: { method: string }) =>
      options?.method === "POST" ? receipt : { requests: [receipt] }
    );
    await mount(<VoiceRequests {...props} />);
    await see("(1)");
    await click("Ring voice requests");
    await see(receipt.transcript);
    expect(request.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
    await click("Send to Main");
    expect(request).toHaveBeenCalledWith(`/api/chat/voice-requests/${receipt.id}/send`, {
      method: "POST"
    });
    expect(open).not.toHaveBeenCalled();
  });
  it("refreshes the durable status after a lost Send response", async () => {
    let sent = false;
    request.mockImplementation(async (_path: string, options?: { method: string }) => {
      if (options?.method === "POST") {
        sent = true;
        throw new Error("lost response");
      }
      return {
        requests: [
          {
            ...receipt,
            state: sent ? "queued" : "ready-to-send",
            statusMessage: sent ? "Waiting for Main" : receipt.statusMessage
          }
        ]
      };
    });
    await mount(<VoiceRequests {...props} />);
    await see("(1)");
    await click("Ring voice requests");
    await click("Send to Main");
    await see("Waiting for Main");
    expect(container.textContent).not.toContain("Send to Main");
    expect(request.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("opens a persisted reply through the existing thread selection", async () => {
    request.mockResolvedValue({ requests: [{ ...receipt, state: "replied" }] });
    await mount(<VoiceRequests {...props} />);
    await see("(1)");
    await click("Ring voice requests");
    await click("Open reply");
    expect(open).toHaveBeenCalledWith(receipt.threadId);
    expect(request.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });
  it.each([
    { privateMode: true },
    { selectionPending: true },
    { privacyConfirmed: false },
    { selectedThreadId: "other-thread" },
    { ownerId: undefined },
    { surface: normalizeChatSurface(moduleChatSurface("people", "person")) }
  ])("does not fetch or render voice evidence in an ineligible selection %j", async (override) => {
    await mount(<VoiceRequests {...props} {...override} />);
    expect(container.textContent).toBe("");
    expect(request).not.toHaveBeenCalled();
  });
  it("separates owner caches and hides a former owner's expanded evidence", async () => {
    request
      .mockResolvedValueOnce({ requests: [receipt] })
      .mockImplementation(() => new Promise(() => {}));
    await mount(<VoiceRequests {...props} />);
    await see("(1)");
    await click("Ring voice requests");
    await see(receipt.transcript);
    await render(<VoiceRequests {...props} ownerId="new-owner" />);
    expect(container.textContent).not.toContain(receipt.transcript);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey)
    ).toEqual(
      expect.arrayContaining([
        ["chat", "voice-requests", "owner"],
        ["chat", "voice-requests", "new-owner"]
      ])
    );
  });
  it("resolves an owned deep link to a thread without sending", async () => {
    request.mockResolvedValue(receipt);
    await mount(
      <MemoryRouter initialEntries={[`/?voiceRequest=${receipt.id}`]}>
        <VoiceRequestLink ownerId="owner" enabled onOpenThread={open} />
      </MemoryRouter>
    );
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(receipt.threadId));
    expect(request).toHaveBeenCalledWith(`/api/chat/voice-requests/${receipt.id}`);
    expect(request.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });
  it("does not trust a thread id or send instruction supplied by the URL", async () => {
    await mount(
      <MemoryRouter initialEntries={["/?voiceRequest=send-this&threadId=foreign"]}>
        <VoiceRequestLink ownerId="owner" enabled onOpenThread={open} />
      </MemoryRouter>
    );
    expect(container.textContent).toContain("Could not open");
    expect(request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await click("Dismiss");
    expect(container.textContent).toBe("");
  });
});
