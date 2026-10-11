import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

// No jsdom in this environment; ChatDrawer's private-mode effect registers a real
// `beforeunload` listener once privateMode goes true, which only this file's tests drive.
vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });

import { DEFAULT_CHAT_SURFACE, meetingChatSurface, type TranscriptRecord } from "@moss/shared";
import { Thread } from "@moss/ui";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof ApiClientModule>()).ApiError,
  sendChatTurn: vi.fn(async () => ({
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    reply: "ok",
    sourceFreshness: null
  })),
  cancelChatTurn: vi.fn(async () => undefined),
  clearChat: vi.fn(async () => undefined),
  endPrivateChat: vi.fn(async () => undefined),
  beaconEndPrivateChat: vi.fn(() => undefined),
  getChatPrivacyState: vi.fn(async () => ({ incognito: false })),
  listChatThreads: vi.fn(async () => ({ threads: [] })),
  listChatThreadMessages: vi.fn(async () => ({ messages: [] })),
  listChatSkills: vi.fn(async () => ({ skills: [] })),
  resumeChat: vi.fn(async () => ({})),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listCalendarEvents: vi.fn(async () => ({ events: [] })),
  lookupAiCapabilityRoute: vi.fn(async () => ({
    route: { capability: "chat", available: true, reason: "matched-active-model", model: null }
  })),
  getPersonaSettings: vi.fn(async () => ({
    persona: { assistantName: "Alfred", personaText: "" }
  })),
  getChatModelOverrideSettings: vi.fn(async () => ({
    settings: {
      overrideEnabled: false,
      currentOverrideModelId: null,
      effectiveOverrideModelId: null,
      defaultModel: null,
      selectedModel: null,
      selectableOverrideModels: []
    }
  })),
  getChatModelFavorites: vi.fn(async () => ({ modelIds: [] })),
  putChatModelFavorites: vi.fn(async (input: { modelIds: string[] }) => input)
}));

import { ApiError, listChatThreads, sendChatTurn } from "../../apps/web/src/api/client.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

import { Composer } from "../../apps/web/src/chat/composer.js";
import { MeetingChatDrawer } from "../../apps/web/src/chat/meeting-chat-drawer.js";
import {
  MeetingSourceLink,
  meetingCoverageLabel,
  validMeetingEvidencePath
} from "../../apps/web/src/chat/meeting-source-link.js";
import {
  validMeetingChatInput,
  setMeetingChatHook,
  useMeetingChat
} from "../../packages/module-web-sdk/src/meeting-chat.js";
const meetingId = "11223344-1122-4122-8122-112233445566";
const selection = { meetingId, selectionId: "selection-one", title: "Private review" };
const coverage = {
  ...selection,
  transcriptRevision: 4,
  cursor: 9,
  cutoffMs: 754000,
  throughMs: 750000,
  containsProvisional: true,
  omittedSegments: 2
};
const response = {
  reply: "A selected meeting answer",
  userMessageId: "user",
  assistantMessageId: "answer",
  meetingContext: coverage,
  answerProvenance: [],
  answerProvenanceCitedIds: []
};
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
const fetchMock = vi.fn();
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client?.clear();
  vi.clearAllMocks();
});
async function mount(
  gated = false,
  initialSelection = selection,
  records: readonly TranscriptRecord[] = []
) {
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          {gated ? (
            <MeetingChatDrawer selection={initialSelection} onClose={() => {}} isFounder={false} />
          ) : (
            <ChatDrawer
              open
              onClose={() => {}}
              records={records}
              clearRecords={() => {}}
              streamErrorCount={0}
              isFounder={false}
              surface={meetingChatSurface(meetingId)}
              meetingContext={selection}
            />
          )}
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return renderer!;
}
function availableMeeting(url: string, title = selection.title, id = meetingId) {
  return url.startsWith("/api/meetings/records/")
    ? { meeting: { id, title, personalNotes: "", notesRevision: 0 } }
    : { available: true };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
it("accepts native capture segment identifiers and rejects malformed evidence routes", () => {
  const path = (segmentId: string) =>
    `/meetings?id=${meetingId}&segmentId=${encodeURIComponent(segmentId)}&segmentRevision=1&startCharacter=0&endCharacter=12`;
  expect(validMeetingEvidencePath(path(`${meetingId}:0`))).toBe(true);
  expect(validMeetingEvidencePath(path(" "))).toBe(false);
  expect(validMeetingEvidencePath(path("a".repeat(257)))).toBe(false);
  expect(validMeetingEvidencePath(`${path(`${meetingId}:0`)}&id=${meetingId}`)).toBe(false);
  expect(validMeetingEvidencePath(`${path(`${meetingId}:0`)}&segmentId=other`)).toBe(false);
  expect(
    validMeetingEvidencePath(path("native").replace("segmentRevision=1", "segmentRevision=0"))
  ).toBe(false);
  expect(
    validMeetingEvidencePath(path("native").replace("endCharacter=12", "endCharacter=0"))
  ).toBe(false);
});
it("opens through the browser-safe host bridge without submitting a turn", () => {
  const openMeetingChat = vi.fn();
  setMeetingChatHook(() => ({ openMeetingChat, clearMeetingChat: () => {} }));
  useMeetingChat().openMeetingChat(selection);
  expect(openMeetingChat).toHaveBeenCalledWith(selection);
  expect(sendChatTurn).not.toHaveBeenCalled();
  expect(validMeetingChatInput(selection)).toBe(true);
  expect(validMeetingChatInput({ ...selection, meetingId: "../../other" })).toBe(false);
  expect(validMeetingChatInput({ ...selection, title: " " })).toBe(false);
});
it("uses the shared composer and sends only the bound meeting selection", async () => {
  fetchMock.mockImplementation(async () => json(response));
  const view = await mount();
  const composer = view.root.findByType(Composer);
  expect(composer.props.textOnly).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => composer.props.onSend("What was decided?"));
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/chat/turn");
  expect(JSON.parse(init.body)).toEqual({
    text: "What was decided?",
    surface: meetingChatSurface(meetingId),
    meetingContext: { meetingId, selectionId: selection.selectionId }
  });
  expect(sendChatTurn).not.toHaveBeenCalled();
  expect(JSON.stringify(view.toJSON())).toContain("Includes provisional text");
  expect(JSON.stringify(view.toJSON())).toContain("Partial context");
});
it("does not restore a late answer after New chat clears the meeting turn", async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("What was decided?"));
  await act(async () =>
    view.root
      .findAll((node) => node.type === "button" && node.props["aria-label"] === "New chat")[0]!
      .props.onClick()
  );
  await act(async () => finish(json(response)));
  expect(JSON.stringify(view.toJSON())).not.toContain("A selected meeting answer");
});
it.each([401, 403, 404])(
  "hides title and history after an authoritative %s access denial",
  async (status) => {
    fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
    const view = await mount(true);
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Private review"));
    fetchMock.mockImplementation(async () => json({ error: "Meeting unavailable" }, status));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["meeting-chat-access", selection.selectionId] });
    });
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Meeting unavailable"));
    expect(JSON.stringify(view.toJSON())).not.toContain("Private review");
  }
);
it.each([401, 403, 404])(
  "keeps a %s denial closed through later refreshes until a new selection",
  async (status) => {
    fetchMock.mockImplementation(async (url: string) =>
      json(url === "/api/chat/turn" ? response : availableMeeting(url))
    );
    const view = await mount(true);
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    await act(async () => view.root.findByType(Composer).props.onSend("What was decided?"));
    fetchMock.mockImplementation(async () => json({ error: "Meeting unavailable" }, status));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["meeting-chat-access", selection.selectionId] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    const access = client
      .getQueryCache()
      .find({ queryKey: ["meeting-chat-access", selection.selectionId] })!;
    fetchMock.mockImplementation(async () => json({ error: "Temporary failure" }, 503));
    // Force a late read even though this denied selection has disabled automatic polling.
    await act(async () => {
      await expect(access.fetch()).rejects.toMatchObject({ status: 503 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).not.toContain("Private review");
    expect(JSON.stringify(view.toJSON())).not.toContain("A selected meeting answer");
    await act(async () => {
      client.setQueryData(["meeting-chat-access", selection.selectionId], { available: true });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).not.toContain("Private review");
    expect(JSON.stringify(view.toJSON())).not.toContain("A selected meeting answer");
    expect(JSON.stringify(view.toJSON())).toContain("Meeting unavailable");
    fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
    await act(async () => {
      view.update(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <MeetingChatDrawer
              key="reopened-selection"
              selection={{ ...selection, selectionId: "reopened-selection" }}
              onClose={() => {}}
              isFounder={false}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    expect(JSON.stringify(view.toJSON())).toContain("Private review");
  }
);
it.each(["offline", 429, 500] as const)(
  "preserves the composer and completed turns through a transient %s access refresh failure",
  async (failure) => {
    fetchMock.mockImplementation(async (url: string) =>
      json(url === "/api/chat/turn" ? response : availableMeeting(url))
    );
    const view = await mount(true);
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    await act(async () => view.root.findByType(Composer).props.onSend("What was decided?"));
    const input = view.root.findByType("textarea");
    await act(async () => input.props.onChange({ target: { value: "My unsent follow-up" } }));
    fetchMock.mockImplementation(async () => {
      if (failure === "offline") throw new TypeError("Failed to fetch");
      return json({ error: "Try again" }, failure);
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["meeting-chat-access", selection.selectionId] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.root.findByType("textarea")).toBe(input);
    expect(input.props.value).toBe("My unsent follow-up");
    expect(JSON.stringify(view.toJSON())).toContain("A selected meeting answer");
    expect(JSON.stringify(view.toJSON())).toContain("Private review");
    expect(JSON.stringify(view.toJSON())).not.toContain("Meeting unavailable");
    fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["meeting-chat-access", selection.selectionId] });
    });
    expect(view.root.findByType("textarea")).toBe(input);
    expect(input.props.value).toBe("My unsent follow-up");
  }
);
it.each([
  new TypeError("Failed to fetch"),
  new ApiError(429, "Busy"),
  new ApiError(503, "Unavailable")
])("preserves unsent text through a transient history refresh failure: %s", async (error) => {
  fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
  const view = await mount(true);
  await vi.waitFor(() => expect(view.root.findAllByType("textarea")).toHaveLength(1));
  const input = view.root.findByType("textarea");
  await act(async () => input.props.onChange({ target: { value: "Keep my question" } }));
  vi.mocked(listChatThreads).mockRejectedValueOnce(error);
  await act(async () => {
    await client.refetchQueries({ queryKey: ["meeting-chat-history", selection.selectionId] });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(view.root.findByType("textarea")).toBe(input);
  expect(input.props.value).toBe("Keep my question");
  expect(JSON.stringify(view.toJSON())).not.toContain("Meeting unavailable");
});
it.each([401, 403, 404])(
  "hides the drawer after an authoritative %s history denial",
  async (status) => {
    fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
    const view = await mount(true);
    vi.mocked(listChatThreads).mockRejectedValueOnce(new ApiError(status, "Denied"));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["meeting-chat-history", selection.selectionId] });
    });
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Meeting unavailable"));
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).not.toContain("Private review");
  }
);
it.each(["access", "title", "history"])(
  "offers retry for an initial %s failure without claiming access was denied",
  async (source) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (source === "access" || (source === "title" && url.startsWith("/api/meetings/records/")))
        throw new TypeError("Failed to fetch");
      return json(availableMeeting(url));
    });
    if (source === "history")
      vi.mocked(listChatThreads).mockRejectedValueOnce(new ApiError(503, "Unavailable"));
    const view = await mount(true);
    await vi.waitFor(() =>
      expect(JSON.stringify(view.toJSON())).toContain("Couldn’t load meeting chat")
    );
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).not.toContain("Private review");
    expect(JSON.stringify(view.toJSON())).not.toContain("Meeting unavailable");
    fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((node) => node.children.join("") === "Retry loading meeting chat")!
        .props.onClick();
    });
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    expect(JSON.stringify(view.toJSON())).toContain("Private review");
  }
);
it("retains coverage and only accepts exact local evidence ranges", () => {
  expect(meetingCoverageLabel(coverage)).toBe(
    "Cutoff 12:34 · Latest included 12:30 · Revision 4 · Includes provisional text · Partial context"
  );
  expect(
    validMeetingEvidencePath(
      `/meetings?id=${meetingId}&segmentId=${meetingId}&segmentRevision=1&startCharacter=0&endCharacter=12`
    )
  ).toBe(true);
  expect(validMeetingEvidencePath("https://example.com/meetings?id=x")).toBe(false);
  expect(validMeetingEvidencePath(`/meetings?id=${meetingId}`)).toBe(false);
});

it("renders no network image from a meeting answer", async () => {
  fetchMock.mockImplementation(async () =>
    json({ ...response, reply: "![private](https://example.com/collect?text=secret)" })
  );
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("Summarize"));
  expect(view.root.findAllByType("img")).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).not.toContain("https://example.com/collect");
});
it("lets a subscription-model user remove context and continue ordinary chat", async () => {
  const error =
    "Meeting questions currently require an API-key chat model. " +
    "Remove the ‘About this meeting’ chip to continue ordinary chat with your selected model.";
  fetchMock.mockImplementation(async () => json({ error, code: "meeting_chat_unsupported" }, 422));
  function RemovableMeeting() {
    const [attached, setAttached] = useState(true);
    return (
      <ChatDrawer
        key={attached ? "meeting" : "ordinary"}
        open
        onClose={() => {}}
        records={[]}
        clearRecords={() => {}}
        streamErrorCount={0}
        isFounder={false}
        surface={attached ? meetingChatSurface(meetingId) : DEFAULT_CHAT_SURFACE}
        meetingContext={attached ? selection : undefined}
        onRemoveMeetingContext={() => setAttached(false)}
      />
    );
  }
  const view = await mount();
  await act(async () =>
    view.update(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RemovableMeeting />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
  await act(async () => view.root.findByType(Composer).props.onSend("Summarize"));
  expect(view.root.findByType(Composer).props.sendError).toBe(error);
  expect(sendChatTurn).not.toHaveBeenCalled();
  await act(async () =>
    view.root.findByProps({ "aria-label": "Remove meeting context" }).props.onClick()
  );
  expect(JSON.stringify(view.toJSON())).not.toContain("About this meeting");
  await act(async () => view.root.findByType(Composer).props.onSend("An ordinary question"));
  expect(sendChatTurn).toHaveBeenCalledWith(
    "An ordinary question",
    undefined,
    undefined,
    DEFAULT_CHAT_SURFACE
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("announces the current meeting title for automatically selected route context", async () => {
  fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url, "Design review")));
  const view = await mount(true, { ...selection, title: "About this meeting" });
  await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
  expect(view.root.findByProps({ className: "jds-sr-only" }).children.join("")).toBe(
    ": Design review"
  );
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/meetings/records/${meetingId}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});

it("refreshes an edited meeting title without replacing the composer or its draft", async () => {
  fetchMock.mockImplementation(async (url: string) => json(availableMeeting(url)));
  const view = await mount(true, { ...selection, title: "About this meeting" });
  await vi.waitFor(() => expect(view.root.findAllByType("textarea")).toHaveLength(1));
  const input = view.root.findByType("textarea");
  await act(async () => input.props.onChange({ target: { value: "Keep my question" } }));
  fetchMock.mockImplementation(async (url: string) =>
    json(availableMeeting(url, "Renamed review"))
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["meeting-chat-title", meetingId] });
  });
  await vi.waitFor(() =>
    expect(view.root.findByProps({ className: "jds-sr-only" }).children.join("")).toBe(
      ": Renamed review"
    )
  );
  expect(view.root.findByType("textarea")).toBe(input);
  expect(input.props.value).toBe("Keep my question");
});

it("keeps the title, conversation and draft through a transient title refresh failure", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    json(url === "/api/chat/turn" ? response : availableMeeting(url))
  );
  const view = await mount(true);
  await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
  await act(async () => view.root.findByType(Composer).props.onSend("What was decided?"));
  const input = view.root.findByType("textarea");
  await act(async () => input.props.onChange({ target: { value: "Keep my question" } }));
  fetchMock.mockImplementation(async () => json({ error: "Temporary failure" }, 503));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["meeting-chat-title", meetingId] });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(view.root.findByType("textarea")).toBe(input);
  expect(input.props.value).toBe("Keep my question");
  expect(JSON.stringify(view.toJSON())).toContain("Private review");
  expect(JSON.stringify(view.toJSON())).toContain("A selected meeting answer");
});

it.each(["meeting", "account"])(
  "discards a late title after the %s selection changes",
  async (boundary) => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/meetings/records/")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : json({ available: true })
    );
    const view = await mount(true, { ...selection, title: "About this meeting" });
    await vi.waitFor(() => expect(finish).toEqual(expect.any(Function)));
    const next = {
      meetingId: boundary === "account" ? meetingId : "22334455-2233-4233-8233-223344556677",
      selectionId: "new-selection",
      title: "About this meeting"
    };
    fetchMock.mockImplementation(async (url: string) =>
      json(availableMeeting(url, "Current meeting", next.meetingId))
    );
    await act(async () =>
      view.update(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <MeetingChatDrawer
              key={next.selectionId}
              selection={next}
              onClose={() => {}}
              isFounder={false}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    await act(async () =>
      finish(json(availableMeeting(`/api/meetings/records/${meetingId}`, "Previous private title")))
    );
    expect(JSON.stringify(view.toJSON())).not.toContain("Previous private title");
    expect(view.root.findByProps({ className: "jds-sr-only" }).children.join("")).toBe(
      ": Current meeting"
    );
  }
);

it.each([401, 403, 404])(
  "hides title and history when the meeting record returns %s",
  async (status) => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/meetings/records/")
        ? json({ error: "Meeting unavailable" }, status)
        : json({ available: true })
    );
    const view = await mount(true);
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Meeting unavailable"));
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).not.toContain(selection.title);
    expect(listChatThreads).not.toHaveBeenCalled();
  }
);

it("retains a failed meeting question above the error without leaving the turn running", async () => {
  fetchMock.mockImplementation(async () => json({ error: "Please try again" }, 503));
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("What was decided?"));
  const transcript = view.root.findByType(Thread);
  expect(transcript.props.records).toEqual([
    expect.objectContaining({ kind: "user", text: "What was decided?" })
  ]);
  expect(transcript.props.working).toBe(false);
  expect(view.root.findByType(Composer).props.isSending).toBe(false);
  expect(view.root.findByType(Composer).props.sendError).toBe("Please try again");
  const content = JSON.stringify(view.toJSON());
  expect(content.indexOf("What was decided?")).toBeLessThan(content.indexOf("Please try again"));
});

it("keeps repeated failed questions distinct from matching history and a successful retry", async () => {
  const question = "What was decided?";
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  const view = await mount(false, selection, [
    { kind: "user", text: question, messageId: "saved-user" },
    { kind: "reply", text: "A previous answer", messageId: "saved-answer" }
  ]);
  await act(async () => view.root.findByType(Composer).props.onSend(question));
  expect(view.root.findByType(Thread).props.records).toHaveLength(3);
  expect(view.root.findByType(Thread).props.working).toBe(true);
  await act(async () => finish(json({ error: "Please try again" }, 503)));
  fetchMock.mockImplementation(async () => json({ error: "Please try again" }, 503));
  await act(async () => view.root.findByType(Composer).props.onSend(question));
  expect(
    view.root.findByType(Thread).props.records.filter((r: { kind: string }) => r.kind === "user")
  ).toHaveLength(3);
  fetchMock.mockImplementation(async () =>
    json({ ...response, userMessageId: "retry-user", assistantMessageId: "retry-answer" })
  );
  await act(async () => view.root.findByType(Composer).props.onSend(question));
  const records = view.root.findByType(Thread).props.records;
  expect(records.map((r: { kind: string }) => r.kind)).toEqual([
    "user",
    "reply",
    "user",
    "user",
    "user",
    "reply"
  ]);
  expect(view.root.findByType(Composer).props.sendError).toBeNull();
  expect(view.root.findByType(Thread).props.working).toBe(false);
});

it("clears failed meeting questions on New chat and ignores a late failure from the old turn", async () => {
  fetchMock.mockImplementation(async () => json({ error: "First send failed" }, 503));
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("First private question"));
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  await act(async () => view.root.findByType(Composer).props.onSend("Second private question"));
  await act(async () =>
    view.root
      .findAll((node) => node.type === "button" && node.props["aria-label"] === "New chat")[0]!
      .props.onClick()
  );
  await act(async () => finish(json({ error: "Late failure" }, 503)));
  expect(view.root.findAllByType(Thread)).toHaveLength(0);
  expect(view.root.findByType(Composer).props.sendError).toBeNull();
});

it.each([401, 403, 404])(
  "hides failed question text after a later %s access denial",
  async (status) => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/chat/turn" ? json({ error: "Try again" }, 503) : json(availableMeeting(url))
    );
    const view = await mount(true);
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    await act(async () => view.root.findByType(Composer).props.onSend("Private failed question"));
    expect(JSON.stringify(view.toJSON())).toContain("Private failed question");
    fetchMock.mockImplementation(async () => json({ error: "Unavailable" }, status));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["meeting-chat-access", selection.selectionId] });
    });
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(0));
    expect(JSON.stringify(view.toJSON())).not.toContain("Private failed question");
  }
);

it.each(["meeting", "account"])(
  "discards failed questions and late failures after a %s change",
  async (boundary) => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/chat/turn" ? json({ error: "Try again" }, 503) : json(availableMeeting(url))
    );
    const view = await mount(true);
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    await act(async () => view.root.findByType(Composer).props.onSend("Previous private question"));
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/chat/turn"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : json(availableMeeting(url))
    );
    await act(async () => view.root.findByType(Composer).props.onSend("Late private question"));
    const next = {
      ...selection,
      meetingId: boundary === "account" ? meetingId : "22334455-2233-4233-8233-223344556677",
      selectionId: "next-selection"
    };
    await act(async () =>
      view.update(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <MeetingChatDrawer
              key={next.selectionId}
              selection={next}
              onClose={() => {}}
              isFounder={false}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );
    await vi.waitFor(() => expect(view.root.findAllByType(Composer)).toHaveLength(1));
    await act(async () => finish(json({ error: "Late private failure" }, 503)));
    expect(view.root.findAllByType(Thread)).toHaveLength(0);
    expect(view.root.findByType(Composer).props.sendError).toBeNull();
  }
);

it("leaves ordinary chat's failed-send behavior unchanged", async () => {
  const view = await mount();
  await act(async () =>
    view.update(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ChatDrawer
            key="ordinary"
            open
            onClose={() => {}}
            records={[]}
            clearRecords={() => {}}
            streamErrorCount={0}
            isFounder={false}
            surface={DEFAULT_CHAT_SURFACE}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
  vi.mocked(sendChatTurn).mockRejectedValueOnce(new Error("Ordinary send failed"));
  await act(async () => view.root.findByType(Composer).props.onSend("Ordinary question"));
  expect(view.root.findAllByType(Thread)).toHaveLength(0);
  expect(view.root.findByType(Composer).props.sendError).toBe("Ordinary send failed");
  expect(view.root.findByType(Composer).props.isSending).toBe(false);
});

it("exposes no feedback or memory controls on scoped turns", async () => {
  fetchMock.mockImplementation(async () => json(response));
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("Summarize"));
  expect(
    view.root.findAll(
      (node) =>
        typeof node.props.className === "string" && node.props.className.includes("feedback-menu")
    )
  ).toHaveLength(0);
});
it("cannot navigate on an old source response after selection is removed", async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  const locations: string[] = [];
  function Location() {
    locations.push(useLocation().pathname);
    return null;
  }
  const card = {
    supportId: "S1",
    sourceKind: "meeting" as const,
    sourceLabel: "00:12",
    title: "Transcript",
    state: "confirmed_source" as const,
    canDereference: true
  };
  const element = (show: boolean) => (
    <MemoryRouter>
      <Location />
      {show ? <MeetingSourceLink card={card} messageId="answer" /> : null}
    </MemoryRouter>
  );
  await act(async () => {
    renderer = create(element(true));
  });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  await act(async () => renderer!.update(element(false)));
  await act(async () =>
    finish(
      json({
        deepLinkPath: `/meetings?id=${meetingId}&segmentId=${meetingId}&segmentRevision=1&startCharacter=0&endCharacter=12`
      })
    )
  );
  expect(locations).not.toContain("/meetings");
});
it("cannot show a completed turn after the drawer selection unmounts", async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("Summarize"));
  await act(async () => view.update(<div>Another selection</div>));
  await act(async () => finish(json(response)));
  expect(JSON.stringify(view.toJSON())).toContain("Another selection");
  expect(JSON.stringify(view.toJSON())).not.toContain("A selected meeting answer");
});

it("never labels an old completion as the newly selected meeting", async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
  );
  const view = await mount();
  await act(async () => view.root.findByType(Composer).props.onSend("Summarize first meeting"));
  const next = {
    meetingId: "22334455-2233-4233-8233-223344556677",
    selectionId: "selection-two",
    title: "Another review"
  };
  await act(async () =>
    view.update(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ChatDrawer
            key={next.selectionId}
            open
            onClose={() => {}}
            records={[]}
            clearRecords={() => {}}
            streamErrorCount={0}
            isFounder={false}
            surface={meetingChatSurface(next.meetingId)}
            meetingContext={next}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
  await act(async () => finish(json(response)));
  expect(JSON.stringify(view.toJSON())).toContain("Another review");
  expect(JSON.stringify(view.toJSON())).not.toContain("Private review");
  expect(JSON.stringify(view.toJSON())).not.toContain("A selected meeting answer");
});

it("keeps legacy meeting history inert even without coverage metadata", async () => {
  const view = await mount();
  await act(async () =>
    view.update(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ChatDrawer
            open
            onClose={() => {}}
            records={[
              { kind: "user", text: "Private question", messageId: "u-old" },
              {
                kind: "reply",
                text: "![leak](https://example.com/collect?text=private)",
                messageId: "a-old"
              }
            ]}
            clearRecords={() => {}}
            streamErrorCount={0}
            isFounder={false}
            surface={meetingChatSurface(meetingId)}
            meetingContext={selection}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
  expect(view.root.findAllByType("img")).toHaveLength(0);
  expect(
    view.root.findAll(
      (node) =>
        typeof node.props.className === "string" && node.props.className.includes("feedback-menu")
    )
  ).toHaveLength(0);
});

it("dereferences a citation and opens the pinned range", async () => {
  const deepLinkPath = `/meetings?id=${meetingId}&segmentId=${encodeURIComponent(`${meetingId}:0`)}&segmentRevision=4&startCharacter=3&endCharacter=12`;
  fetchMock.mockImplementation(async () => json({ deepLinkPath }));
  vi.stubGlobal("fetch", fetchMock);
  const locations: string[] = [];
  function Location() {
    const location = useLocation();
    locations.push(location.pathname + location.search);
    return null;
  }
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Location />
        <MeetingSourceLink
          messageId="answer"
          card={{
            supportId: "S1",
            sourceKind: "meeting",
            sourceLabel: "00:12",
            title: "Transcript",
            state: "confirmed_source",
            canDereference: true
          }}
        />
      </MemoryRouter>
    );
  });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/chat/messages/answer/provenance/S1/dereference");
  expect(locations).toContain(deepLinkPath);
});
