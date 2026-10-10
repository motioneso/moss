// #3195: a delivered reminder arrives on the Main stream beside a live reply. Stored replies
// replace only the unsaved reply of their own turn; background messages dedupe by message id.

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageDto, ChatSurface, ChatThreadDto, TranscriptRecord } from "@moss/shared";

import {
  listChatThreadMessages,
  listChatThreads,
  resumeChat
} from "../../apps/web/src/api/client.js";
import {
  applyStreamRecord,
  mergeBackgroundRecords,
  mergeHydratedRecords
} from "../../apps/web/src/chat/stream-record-identity.js";
import {
  parseRecord,
  recordsFromMessages,
  useChatStream
} from "../../apps/web/src/chat/use-chat-stream.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../apps/web/src/api/client.js", () => ({
  chatStreamUrl: (surface?: string) => `/api/chat/stream${surface ? `?surface=${surface}` : ""}`,
  getMe: vi.fn(async () => ({
    user: { id: "user-1" },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  })),
  listChatThreadMessages: vi.fn(),
  listChatThreads: vi.fn(),
  listPendingActionRequests: vi.fn(async () => ({ actions: [] })),
  resumeChat: vi.fn()
}));

vi.mock("../../apps/web/src/api/workflows-client.js", () => ({
  listWorkflowApprovals: vi.fn(async () => [])
}));

afterEach(() => {
  vi.mocked(listChatThreadMessages).mockReset();
  vi.mocked(listChatThreads).mockReset();
  vi.mocked(resumeChat).mockReset();
  vi.unstubAllGlobals();
});

const user: TranscriptRecord = { kind: "user", text: "Plan my week" };
const liveReply: TranscriptRecord = { kind: "reply", text: "Working on it", turnId: "turn-1" };
const storedReply: TranscriptRecord = {
  kind: "reply",
  text: "Here is your week",
  turnId: "turn-1",
  messageId: "assistant-1"
};
const reminder: TranscriptRecord = {
  kind: "reply",
  text: "Reminder: stretch",
  messageId: "reminder-1",
  background: true
};

function message(overrides: Partial<ChatMessageDto> & { id: string }): ChatMessageDto {
  return {
    threadId: "main-thread",
    ownerUserId: "user-1",
    role: "assistant",
    status: "stored",
    body: "body",
    modelRoute: null,
    tools: [],
    activity: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

const reminderMessage = message({
  id: "reminder-1",
  body: "Reminder: stretch",
  origin: { version: 1, kind: "reminder", event: "delivered", reminderId: "r-1", late: false }
});

describe("applyStreamRecord", () => {
  it("never lets a stored reminder replace an unsaved live reply", () => {
    const next = applyStreamRecord([user, liveReply], reminder);
    expect(next).toEqual([user, liveReply, reminder]);
  });

  it("replaces the unsaved reply of the same turn with its stored version", () => {
    const next = applyStreamRecord([user, liveReply, reminder], storedReply);
    expect(next).toEqual([user, storedReply, reminder]);
  });

  it("leaves an unsaved reply of a different turn alone", () => {
    const older: TranscriptRecord = { kind: "reply", text: "Unsaved earlier", turnId: "turn-0" };
    const next = applyStreamRecord([older, user, liveReply], { ...storedReply, turnId: "turn-9" });
    expect(next).toEqual([older, user, liveReply, { ...storedReply, turnId: "turn-9" }]);
  });

  it("does not replace an unsaved reply with a stored reply that names no turn", () => {
    const untagged: TranscriptRecord = { kind: "reply", text: "Gate answer", messageId: "gate-1" };
    const next = applyStreamRecord([user, liveReply], untagged);
    expect(next).toEqual([user, liveReply, untagged]);
  });

  it("shows a replayed reminder once", () => {
    const once = applyStreamRecord([user, liveReply], reminder);
    expect(applyStreamRecord(once, { ...reminder })).toEqual(once);
  });
});

describe("mergeHydratedRecords", () => {
  it("keeps history when only a reminder arrived before it, without a second copy", () => {
    const history = recordsFromMessages([message({ id: "a-0", body: "Earlier" }), reminderMessage]);
    const merged = mergeHydratedRecords([reminder], history);
    expect(merged.map((record) => record.messageId)).toEqual(["a-0", "reminder-1"]);
  });

  it("keeps history and appends a reminder that history does not hold yet", () => {
    const history = recordsFromMessages([message({ id: "a-0", body: "Earlier" })]);
    const merged = mergeHydratedRecords([reminder], history);
    expect(merged.map((record) => record.messageId)).toEqual(["a-0", "reminder-1"]);
  });
});

describe("mergeBackgroundRecords", () => {
  it("adds only missing reminders from history and never ordinary replies", () => {
    const history = recordsFromMessages([message({ id: "a-0", body: "Earlier" }), reminderMessage]);
    const merged = mergeBackgroundRecords([user, liveReply], history);
    expect(merged).toEqual([user, liveReply, expect.objectContaining({ messageId: "reminder-1" })]);
    expect(mergeBackgroundRecords(merged, history)).toEqual(merged);
  });
});

describe("record identity on the wire", () => {
  it("parses the turn id and the background mark", () => {
    expect(
      parseRecord(JSON.stringify({ kind: "reply", text: "x", turnId: "turn-1", background: true }))
    ).toMatchObject({ turnId: "turn-1", background: true });
    expect(
      parseRecord(JSON.stringify({ kind: "reply", text: "x", background: "yes" }))?.background
    ).toBeUndefined();
  });

  it("marks a delivered reminder in history as a background message", () => {
    const [record] = recordsFromMessages([reminderMessage]);
    expect(record).toMatchObject({ messageId: "reminder-1", background: true });
    const [ordinary] = recordsFromMessages([message({ id: "a-0", body: "Earlier" })]);
    expect(ordinary?.background).toBeUndefined();
  });
});

describe("Main stream reconnect", () => {
  class FakeEventSource {
    static readonly CLOSED = 2;
    static instances: FakeEventSource[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeEventSource.instances.push(this);
    }
    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }

  afterEach(() => {
    FakeEventSource.instances = [];
  });

  function Probe(props: { surface: ChatSurface }) {
    const { records } = useChatStream(props.surface);
    return createElement("div", null, records.map((record) => record.text).join("|"));
  }

  const mainThread: ChatThreadDto = {
    id: "main-thread",
    ownerUserId: "user-1",
    title: "Main",
    incognito: false,
    isMain: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastActiveAt: new Date(0).toISOString(),
    lastMessagePreview: null
  };

  it("catches up a reminder missed while disconnected, once", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [mainThread] });
    vi.mocked(listChatThreadMessages).mockResolvedValueOnce({
      messages: [message({ id: "a-0", body: "Earlier" })]
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Probe, { surface: "drawer" as ChatSurface }));
    });
    await vi.waitFor(() => expect(JSON.stringify(renderer!.toJSON())).toContain("Earlier"));
    const source = FakeEventSource.instances[0]!;
    await act(async () => source.onopen?.());

    vi.mocked(listChatThreadMessages).mockResolvedValue({
      messages: [message({ id: "a-0", body: "Earlier" }), reminderMessage]
    });
    await act(async () => {
      source.onerror?.();
      source.onopen?.();
    });
    await vi.waitFor(() =>
      expect(JSON.stringify(renderer!.toJSON())).toContain("Reminder: stretch")
    );

    await act(async () => {
      source.onerror?.();
      source.onopen?.();
      source.onmessage?.({ data: JSON.stringify(reminder) });
    });
    await vi.waitFor(() => expect(listChatThreadMessages).toHaveBeenCalledTimes(3));
    const text = JSON.stringify(renderer!.toJSON());
    expect(text.split("Reminder: stretch")).toHaveLength(2);
    expect(text).toContain("Earlier");
  });

  it("does not catch up a side chat stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const side = { ...mainThread, id: "side-thread", isMain: false };
    vi.mocked(listChatThreads).mockResolvedValue({ threads: [side] });
    vi.mocked(listChatThreadMessages).mockResolvedValue({ messages: [] });
    await act(async () => {
      create(createElement(Probe, { surface: "m-1111111111111111" as ChatSurface }));
    });
    await vi.waitFor(() => expect(listChatThreadMessages).toHaveBeenCalledTimes(1));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onopen?.();
      source.onerror?.();
      source.onopen?.();
    });
    expect(listChatThreadMessages).toHaveBeenCalledTimes(1);
  });
});
