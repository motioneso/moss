import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { DEFAULT_CHAT_SURFACE, type MeResponse } from "@moss/shared";

// Exercise mounted shell state, real router navigation, and its public chat controls. Drawer
// contents and unrelated chrome are replaced at their boundaries; these are not live UI proofs.
vi.mock("../../apps/web/src/chat/chat-drawer.js", () => ({ ChatDrawer: () => null }));
vi.mock("../../apps/web/src/chat/meeting-chat-drawer.js", () => ({
  MeetingChatDrawer: () => null
}));
vi.mock("../../apps/web/src/chat/use-page-context-sync.js", () => ({
  usePageContextSync: () => {}
}));
vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => ""
}));
vi.mock("../../apps/web/src/shell/shell-nav.js", () => ({ ShellNav: () => null }));
vi.mock("../../apps/web/src/shell/command-palette.js", () => ({ CommandPalette: () => null }));
vi.mock("../../apps/web/src/shell/module-persistent-controls.js", () => ({
  ModulePersistentControls: () => null
}));

const { useChatStreamMock } = vi.hoisted(() => ({ useChatStreamMock: vi.fn() }));
vi.mock("../../apps/web/src/chat/use-chat-stream.js", () => ({
  useChatStream: useChatStreamMock
}));

import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";
import { MeetingChatDrawer } from "../../apps/web/src/chat/meeting-chat-drawer.js";
import { AppShell } from "../../apps/web/src/shell/app-shell.js";
import {
  useChatControls,
  type ChatControls
} from "../../apps/web/src/shell/chat-controls-context.js";

const MEETING_ID = "11223344-1122-4122-8122-112233445566";
const OTHER_MEETING_ID = "22334455-2233-4233-8233-223344556677";
const ROUTE = `/meetings?id=${MEETING_ID}`;
const ME: MeResponse = {
  user: {
    id: "user-1",
    email: "first@example.com",
    emailVerified: true,
    name: "First User",
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};
const OTHER_USER: MeResponse = {
  ...ME,
  user: { ...ME.user, id: "user-2", email: "second@example.com", name: "Second User" }
};

let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let navigate: NavigateFunction;
let controls: ChatControls;
function RouteControls() {
  navigate = useNavigate();
  controls = useChatControls();
  return null;
}

function element(route: string, me: MeResponse = ME) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppShell me={me} modules={[]} modulesLoading={false}>
          <RouteControls />
        </AppShell>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function mount(route = ROUTE) {
  await act(async () => {
    renderer = create(element(route));
  });
}

async function toggleChat() {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Open chat")!
      .props.onClick();
  });
}

function meetingDrawer(): ComponentProps<typeof MeetingChatDrawer> {
  return renderer!.root.findByType(MeetingChatDrawer).props as ComponentProps<
    typeof MeetingChatDrawer
  >;
}

function ordinaryDrawer(): ComponentProps<typeof ChatDrawer> {
  expect(renderer!.root.findAllByType(MeetingChatDrawer)).toHaveLength(0);
  return renderer!.root.findByType(ChatDrawer).props as ComponentProps<typeof ChatDrawer>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: (query: string) => ({
      matches: query === "(min-width: 1280px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  });
  useChatStreamMock.mockReturnValue({
    records: [],
    clearRecords: vi.fn(),
    streamErrorCount: 0
  });
  client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, gcTime: 0 } }
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("AppShell meeting context", () => {
  it("opens a route-selected meeting in the normal docked chat control", async () => {
    await mount();
    expect(ordinaryDrawer().open).toBe(false);
    await toggleChat();
    expect(meetingDrawer().selection).toMatchObject({
      meetingId: MEETING_ID,
      title: "About this meeting"
    });
    expect(meetingDrawer().docked).toBe(true);
    expect(meetingDrawer().onToggleExpanded).toEqual(expect.any(Function));
    expect(useChatStreamMock).toHaveBeenLastCalledWith(DEFAULT_CHAT_SURFACE, false);
  });

  it.each([`/today?id=${MEETING_ID}`, "/meetings", "/meetings?id=invalid"])(
    "keeps ordinary chat on %s",
    async (route) => {
      await mount(route);
      await toggleChat();
      expect(ordinaryDrawer().open).toBe(true);
      expect(ordinaryDrawer().surface).toBe(DEFAULT_CHAT_SURFACE);
      expect(useChatStreamMock).toHaveBeenLastCalledWith(DEFAULT_CHAT_SURFACE, true);
    }
  );

  it("removes context while keeping chat open and resumes the ordinary stream", async () => {
    await mount();
    await toggleChat();
    await act(async () => meetingDrawer().onRemoveContext!());
    expect(ordinaryDrawer().open).toBe(true);
    expect(ordinaryDrawer().docked).toBe(true);
    expect(useChatStreamMock).toHaveBeenLastCalledWith(DEFAULT_CHAT_SURFACE, true);
  });

  it("keeps context removed after closing and reopening chat on the same route", async () => {
    await mount();
    await toggleChat();
    await act(async () => meetingDrawer().onRemoveContext!());
    await act(async () => ordinaryDrawer().onClose());
    await toggleChat();
    expect(ordinaryDrawer().open).toBe(true);
  });

  it("keeps context removed through evidence-query changes on the same meeting", async () => {
    await mount();
    await toggleChat();
    await act(async () => meetingDrawer().onRemoveContext!());
    await act(async () => navigate(`${ROUTE}&segmentId=${OTHER_MEETING_ID}&segmentRevision=2`));
    expect(ordinaryDrawer().open).toBe(true);
  });

  it("restores automatic context only after leaving the dismissed meeting route", async () => {
    await mount();
    await toggleChat();
    const selectionId = meetingDrawer().selection.selectionId;
    await act(async () => meetingDrawer().onRemoveContext!());
    await act(async () => navigate("/today"));
    expect(ordinaryDrawer().open).toBe(true);
    await act(async () => navigate(ROUTE));
    expect(meetingDrawer().selection.meetingId).toBe(MEETING_ID);
    expect(meetingDrawer().selection.selectionId).not.toBe(selectionId);
  });

  it("changes the selection token for a different meeting, but not evidence navigation", async () => {
    await mount();
    await toggleChat();
    const selectionId = meetingDrawer().selection.selectionId;
    await act(async () => navigate(`${ROUTE}&segmentId=${OTHER_MEETING_ID}`));
    expect(meetingDrawer().selection.selectionId).toBe(selectionId);
    await act(async () => navigate(`/meetings?id=${OTHER_MEETING_ID}`));
    expect(meetingDrawer().selection.meetingId).toBe(OTHER_MEETING_ID);
    expect(meetingDrawer().selection.selectionId).not.toBe(selectionId);
  });

  it("drops explicit meeting context as soon as navigation leaves its route", async () => {
    await mount();
    await act(async () =>
      controls.openMeetingChat!({ meetingId: MEETING_ID, title: "Private meeting title" })
    );
    expect(meetingDrawer().selection.title).toBe("Private meeting title");
    await act(async () => navigate(`/today?id=${MEETING_ID}`));
    expect(ordinaryDrawer().open).toBe(true);
  });

  it("discards explicit title and selection identity when the account changes", async () => {
    await mount();
    await act(async () =>
      controls.openMeetingChat!({ meetingId: MEETING_ID, title: "First account meeting" })
    );
    const selectionId = meetingDrawer().selection.selectionId;
    await act(async () => renderer!.update(element(ROUTE, OTHER_USER)));
    expect(meetingDrawer().selection.title).toBe("About this meeting");
    expect(meetingDrawer().selection.selectionId).not.toBe(selectionId);
  });

  it("does not carry one account's dismissed context into another account", async () => {
    await mount();
    await toggleChat();
    await act(async () => meetingDrawer().onRemoveContext!());
    expect(ordinaryDrawer().open).toBe(true);
    await act(async () => renderer!.update(element(ROUTE, OTHER_USER)));
    expect(meetingDrawer().selection.meetingId).toBe(MEETING_ID);
  });

  it("ignores a clear request for a meeting other than the current selection", async () => {
    await mount();
    await toggleChat();
    const selectionId = meetingDrawer().selection.selectionId;
    await act(async () => controls.clearMeetingChat!(OTHER_MEETING_ID));
    expect(meetingDrawer().selection.selectionId).toBe(selectionId);
  });

  it("closes a cleared meeting and does not silently reattach it on ordinary reopen", async () => {
    await mount();
    await toggleChat();
    await act(async () => controls.clearMeetingChat!(MEETING_ID));
    expect(ordinaryDrawer().open).toBe(false);
    await toggleChat();
    expect(ordinaryDrawer().open).toBe(true);
  });

  it("allows an explicit new meeting selection to restore removed context", async () => {
    await mount();
    await toggleChat();
    const selectionId = meetingDrawer().selection.selectionId;
    await act(async () => meetingDrawer().onRemoveContext!());
    await act(async () =>
      controls.openMeetingChat!({ meetingId: MEETING_ID, title: "Selected again" })
    );
    expect(meetingDrawer().selection.title).toBe("Selected again");
    expect(meetingDrawer().selection.selectionId).not.toBe(selectionId);
  });

  it.each(["meeting", "account"] as const)(
    "ignores an old clear callback after the %s changes",
    async (boundary) => {
      await mount();
      await toggleChat();
      // A deletion can finish after its dialog unmounts. Its original callback must not
      // close the chat the user has since opened in another meeting or account.
      const clearPreviousMeeting = controls.clearMeetingChat!;
      await act(async () => {
        if (boundary === "meeting") await navigate(`/meetings?id=${OTHER_MEETING_ID}`);
        else renderer!.update(element(ROUTE, OTHER_USER));
      });
      const selectionId = meetingDrawer().selection.selectionId;
      await act(async () => clearPreviousMeeting(MEETING_ID));
      expect(meetingDrawer().selection.selectionId).toBe(selectionId);
    }
  );
});
