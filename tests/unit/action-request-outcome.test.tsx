// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Thread } from "@moss/ui";
import type { ChatMessageDto, TranscriptRecord } from "@moss/shared";
import { RecordRow } from "../../apps/web/src/chat/message-row.js";
import type * as ApiClient from "../../apps/web/src/api/client.js";
import { ApiError, resolveActionRequest } from "../../apps/web/src/api/client.js";
import {
  parseRecord,
  recordsFromMessages,
  upsertTranscriptRecord
} from "../../apps/web/src/chat/use-chat-stream.js";

vi.mock("../../apps/web/src/api/client.js", async (original) => ({
  ...(await original<typeof ApiClient>()),
  resolveActionRequest: vi.fn()
}));

const pending: TranscriptRecord = {
  kind: "action_request",
  text: "Delete custom theme",
  summary: "Delete custom theme",
  actionRequestId: "request-1",
  toolName: "app.callAction",
  outsideContentNotice: true,
  details: {
    target: "Full theme\n  name",
    fields: [
      { label: "Method", value: "DELETE" },
      { label: "Path", value: "/api/themes/raw-id" },
      { label: "Body: enabled", value: "false" }
    ]
  }
};
const steps: TranscriptRecord[] = [
  { kind: "thought", text: "Checking the theme." },
  { kind: "tool", text: "app.callAction DELETE /api/themes/raw-id" }
];
let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient;
function mount(records: readonly TranscriptRecord[]) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  }
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <Thread
          records={records}
          working={false}
          renderRecord={(record, _index, context) => (
            <RecordRow record={record} approvalOutcomeShown={context.approvalOutcomeShown} />
          )}
        />
      </QueryClientProvider>
    )
  );
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  client?.clear();
  root = undefined;
  vi.resetAllMocks();
});
function expectQuiet(label: string, count = 2, title: string | null = "Delete custom theme") {
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    title ? `${label} · ${title}` : label
  );
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.querySelector("dl")).toBeNull();
  expect(host.textContent).not.toMatch(
    /Method|DELETE|Path|Body|raw-id|app\.callAction|Executed|outside or unverified|Full theme/
  );
  expect(host.textContent).toContain(`Thinking${count} steps`);
}

describe("quiet resolved approvals", () => {
  it.each([
    ["confirmed", "Approved"],
    ["rejected", "You declined"]
  ] as const)(
    "collapses immediately after %s, before an execution event arrives",
    async (decision, label) => {
      let finish!: () => void;
      vi.mocked(resolveActionRequest).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      mount([...steps, pending]);
      // The pending presentation deliberately retains exact disclosure until the separate card work.
      expect(host.textContent).toContain("Full theme\n  name");
      expect(host.textContent).toContain("Body: enabledfalse");
      const button = [...host.querySelectorAll("button")].find(
        (item) => item.textContent === (decision === "confirmed" ? "Approve" : "Reject")
      )!;
      act(() => {
        button.click();
        button.click();
      });
      await vi.waitFor(() => expect(resolveActionRequest).toHaveBeenCalledTimes(1));
      expect(resolveActionRequest).toHaveBeenCalledWith("request-1", decision);
      await act(async () => {
        finish();
      });
      await vi.waitFor(() => expectQuiet(label, 2, null));
      expect(document.activeElement?.getAttribute("data-action-request-id")).toBe("request-1");
    }
  );

  it.each([
    ["person", "executed", "Approved"],
    ["person", "denied", "You declined"],
    ["timeout", "denied", "Timed out"],
    ["cancelled", "denied", "Cancelled"],
    ["person", "error", "Approved"]
  ] as const)(
    "collapses from a streamed %s/%s decision without claiming execution success",
    (decidedBy, outcome, label) => {
      mount([...steps, pending]);
      const fold = host.querySelector("details")!;
      fold.open = true;
      const result = parseRecord(
        JSON.stringify({
          kind: "action_result",
          actionRequestId: "request-1",
          text: "Executed: app.callAction",
          toolName: "app.callAction",
          outcome,
          decidedBy,
          summary: "Delete custom theme",
          affectsModules: ["settings"]
        })
      )!;
      mount([...steps, pending, result]);
      expectQuiet(label);
      expect(host.querySelector("details")).toBe(fold);
      expect(fold.open).toBe(true);
      // Execution metadata is retained for refresh and audit; only its chat presentation changes.
      expect(result.outcome).toBe(outcome);
      expect(result.affectsModules).toEqual(["settings"]);
    }
  );

  it("collapses an owned expired request even when its timeout stream event was missed", async () => {
    vi.mocked(resolveActionRequest).mockRejectedValue(
      new ApiError(409, "This request expired — ask again.")
    );
    mount([...steps, { ...pending, summary: "app.callAction DELETE /api/themes/raw-id" }]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expectQuiet("Timed out", 2, null));
    expect(host.textContent).not.toContain("ask again");
  });

  it("keeps a transport failure actionable and never reports approval", async () => {
    vi.mocked(resolveActionRequest).mockRejectedValue(new ApiError(503, "Connection unavailable"));
    mount([...steps, pending]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Connection unavailable"));
    expect(host.textContent).toContain("Needs your approval");
    expect(host.querySelectorAll("button")).toHaveLength(2);
  });

  it("restores a terminal decision without replaying a card or technical result", () => {
    const message: ChatMessageDto = {
      id: "message",
      threadId: "thread",
      ownerUserId: "owner",
      modelRoute: null,
      role: "assistant",
      status: "stored",
      body: "",
      tools: [],
      activity: [
        ...steps,
        {
          kind: "action_result",
          text: "Executed: app.callAction",
          toolName: "app.callAction",
          actionRequestId: "request-1",
          summary: "Delete custom theme",
          outcome: "denied",
          decidedBy: "cancelled"
        }
      ],
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z"
    };
    mount(recordsFromMessages([message]).filter((record) => record.kind !== "reply"));
    expectQuiet("Cancelled");
  });

  it("correlates exact requests even when the terminal event precedes a stale pending card", () => {
    mount([
      ...steps,
      {
        kind: "action_result",
        text: "Executed: app.callAction",
        actionRequestId: "request-1",
        decidedBy: "person",
        outcome: "executed"
      },
      pending
    ]);
    expectQuiet("Approved", 2, null);
  });

  it("does not duplicate replayed cards or decisions after reconnect", () => {
    const emitted: TranscriptRecord[] = [
      {
        kind: "action_result",
        text: "Executed: app.callAction",
        actionRequestId: "request-1",
        summary: "Delete custom theme",
        decidedBy: "person",
        outcome: "executed"
      },
      {
        kind: "approved",
        text: "app.callAction approved",
        actionRequestId: "request-1",
        decidedBy: "person",
        outcome: "executed"
      }
    ];
    let records = [...steps];
    for (const record of [pending, ...emitted, pending, ...emitted])
      records = upsertTranscriptRecord(records, record);
    expect(records).toHaveLength(5);
    expect(records.filter((record) => record.kind === "approved")).toHaveLength(1);
    mount(records);
    expectQuiet("Approved", 3);
  });

  it("keeps a saved-project handoff alongside its single quiet approval outcome", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    mount([
      { ...pending, toolName: "workshop.buildModule", summary: "Create project" },
      {
        kind: "action_result",
        text: "Executed: workshop.buildModule",
        toolName: "workshop.buildModule",
        actionRequestId: "request-1",
        outcome: "executed",
        decidedBy: "person",
        result: {
          project: { id, title: "Garden planner" },
          created: true,
          destination: `/workshop/${id}`
        }
      }
    ]);
    expect(host.querySelector("a")?.getAttribute("href")).toBe(`/workshop/${id}`);
    expect(host.textContent).toContain("Open project");
    expect(host.textContent?.match(/Approved/g)).toHaveLength(1);
    expect(host.textContent).not.toContain("workshop.buildModule");
    expect(host.textContent).not.toContain("Executed");
  });

  it("never carries a previous card's local decision into a new request at the same position", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    mount([...steps, pending]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expectQuiet("Approved", 2, null));
    mount([...steps, { ...pending, actionRequestId: "request-2" }]);
    expect(host.textContent).toContain("Needs your approval");
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.querySelector('[data-action-request-id="request-2"]')).not.toBeNull();
  });

  it("never reuses a technical pending summary as the resolved outcome title", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    const request = { ...pending, summary: "app.callAction DELETE /api/themes/raw-id" };
    mount([...steps, request]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expectQuiet("Approved", 2, null));
    mount([
      ...steps,
      request,
      {
        kind: "action_result",
        text: "Executed: app.callAction",
        actionRequestId: "request-1",
        decidedBy: "person",
        outcome: "executed",
        summary: "Delete custom theme"
      }
    ]);
    expectQuiet("Approved");
  });

  it("drops native pending command details when a streamed decision has no server title", () => {
    mount([
      ...steps,
      { ...pending, toolName: "Bash", summary: "Bash: DELETE /api/themes/raw-id" },
      {
        kind: "action_result",
        text: "Executed: Bash",
        toolName: "Bash",
        actionRequestId: "request-1",
        decidedBy: "person",
        outcome: "allowed"
      }
    ]);
    expectQuiet("Approved", 2, null);
    expect(host.textContent).not.toContain("Bash");
  });
});
