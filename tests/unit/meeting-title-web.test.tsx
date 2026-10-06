// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingRecord } from "@moss/shared";
import { hasSessionUnsavedChanges } from "@moss/module-web-sdk";
import { getMeeting, meetingKeys } from "../../packages/meetings/src/web/client.js";
import { MeetingTitle } from "../../packages/meetings/src/web/meeting-title.js";

const meeting: MeetingRecord = {
  id: "11223344-1122-4122-8122-112233445566",
  title: "Original title",
  personalNotes: "",
  notesRevision: 0,
  createdAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z"
};
const draftKey = ["meetings", "title", meeting.id] as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let saves: {
  body: { title: string; expectedTitle: string };
  finish: (response: Response) => void;
}[];
let reads: ((response: Response) => void)[];

function View() {
  const record = useQuery({
    queryKey: meetingKeys.record(meeting.id),
    queryFn: () => getMeeting(meeting.id),
    staleTime: Infinity
  });
  return record.data ? <MeetingTitle meeting={record.data.meeting} /> : null;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <View />
      </QueryClientProvider>
    )
  );
  await settle();
}
function input() {
  return host.querySelector<HTMLInputElement>('input[aria-label="Meeting title"]')!;
}
async function edit(title: string) {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Edit meeting title"]')!.click()
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), title);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function save() {
  act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(meetingKeys.record(meeting.id), { meeting });
  saves = [];
  reads = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, options?: RequestInit) => {
      if (path === `/api/meetings/records/${meeting.id}/title` && options?.method === "PUT")
        return new Promise<Response>((finish) =>
          saves.push({ body: JSON.parse(String(options.body)), finish })
        );
      if (path === `/api/meetings/records/${meeting.id}`)
        return new Promise<Response>((finish) => reads.push(finish));
      throw new Error(`Unexpected title-test request: ${path}`);
    })
  );
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

describe("meeting title editing (synthetic DOM transport, not live proof)", () => {
  it("keeps every rapid title character before deferred query notifications flush", async () => {
    await mount();
    await edit("");
    const field = input();
    const title = "UAT meeting draft 82a1900a-f6a0-4353-86d3-af258952b98b";
    const errors: string[] = [];
    const report = (event: ErrorEvent) => {
      errors.push(event.message);
      event.preventDefault();
    };
    window.addEventListener("error", report);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    try {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      // act per character hides the React185 scheduling failure seen in the setup title.
      for (const character of title) {
        set.call(field, field.value + character);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } finally {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      window.removeEventListener("error", report);
    }
    expect(field.value).toBe(title);
    expect(errors).toEqual([]);
    expect(client.getQueryData(draftKey)).toMatchObject({ text: title });
    await settle();
    expect(field.value).toBe(title);
    expect(saves).toEqual([]);
  });

  it("sends one save when Enter and blur happen before the pending state renders", async () => {
    await mount();
    await edit("Only one write");
    const field = input();
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      field.blur();
    });
    expect(saves).toHaveLength(1);
    await act(async () =>
      saves[0]!.finish(json({ meeting: { ...meeting, title: "Only one write" } }))
    );
  });

  it("keeps the successful title visible while the follow-up record read is delayed", async () => {
    await mount();
    await edit("Saved title");
    save();
    expect(saves).toHaveLength(1);
    await act(async () =>
      saves[0]!.finish(json({ meeting: { ...meeting, title: "Saved title" } }))
    );
    await settle();
    expect(reads).toHaveLength(1);
    expect(host.querySelector('[aria-label="Edit meeting title"]')?.textContent).toBe(
      "Saved title"
    );
    await act(async () => reads[0]!(json({ meeting: { ...meeting, title: "Saved title" } })));
  });

  it("clears the unsaved marker when a title save finishes after leaving the meeting", async () => {
    await mount();
    await edit("Saved while away");
    save();
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <div>Another page</div>
        </QueryClientProvider>
      )
    );
    await act(async () =>
      saves[0]!.finish(json({ meeting: { ...meeting, title: "Saved while away" } }))
    );
    await settle();
    expect(hasSessionUnsavedChanges(client)).toBe(false);
    expect(client.getQueryData(draftKey)).toMatchObject({
      text: "Saved while away",
      base: "Saved while away",
      saving: false
    });
  });

  it.each([true, false])(
    "ignores an old title save after auth reset without changing the new save (success=%s)",
    async (success) => {
      await mount();
      await edit("Old session edit");
      save();
      await act(async () => {
        root.unmount();
        await client.resetQueries();
      });
      root = createRoot(host);
      client.setQueryData(meetingKeys.record(meeting.id), { meeting });
      await mount();
      await edit("New session edit");
      save();
      expect(saves).toHaveLength(2);
      const pending = client.getQueryData(draftKey);
      expect(input().disabled).toBe(true);
      await act(async () =>
        saves[0]!.finish(
          success
            ? json({ meeting: { ...meeting, title: "Old session edit" } })
            : json({ message: "Old save rejected" }, 400)
        )
      );
      await settle();
      expect(client.getQueryData(draftKey)).toEqual(pending);
      expect(input().disabled).toBe(true);
      await act(async () =>
        saves[1]!.finish(json({ meeting: { ...meeting, title: "New session edit" } }))
      );
    }
  );
});
