// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Thread } from "@moss/ui";
import type { ChatMessageDto, TranscriptRecord } from "@moss/shared";
import { RecordRow } from "../../apps/web/src/chat/message-row.js";
import type * as ApiClient from "../../apps/web/src/api/client.js";
import { ApiError, resolveActionRequest } from "../../apps/web/src/api/client.js";
import { upsertTranscriptRecord } from "../../apps/web/src/chat/stream-record-identity.js";
import { parseRecord, recordsFromMessages } from "../../apps/web/src/chat/use-chat-stream.js";

vi.mock("../../apps/web/src/api/client.js", async (original) => ({
  ...(await original<typeof ApiClient>()),
  resolveActionRequest: vi.fn()
}));

const pending: TranscriptRecord = {
  kind: "action_request",
  text: "Delete custom theme",
  summary: "Delete custom theme",
  outcomeTitle: "Delete custom theme",
  actionRequestId: "request-1",
  toolName: "app.callAction",
  outsideContentNotice: true,
  details: {
    presentation: "human",
    target: "Full theme\n  name",
    fields: [{ label: "Enabled", value: "false" }]
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
function expectQuiet(
  label: string,
  count = 2,
  title: string | null = "Delete custom theme",
  reason?: string
) {
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    [label, title, reason].filter(Boolean).join(" · ")
  );
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.querySelector("dl")).toBeNull();
  const standalone = host.cloneNode(true) as HTMLElement;
  standalone.querySelectorAll("details").forEach((fold) => fold.remove());
  expect(standalone.textContent).not.toMatch(
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
      // Pending human disclosure remains exact until the outcome replaces the whole card.
      expect(host.textContent).toContain("Full theme\n  name");
      expect(host.textContent).toContain("Enabledfalse");
      const button = [...host.querySelectorAll("button")].find(
        (item) => item.textContent === (decision === "confirmed" ? "Approve" : "Reject")
      )!;
      act(() => {
        button.click();
        button.click();
      });
      await vi.waitFor(() => expect(resolveActionRequest).toHaveBeenCalledTimes(1));
      expect(resolveActionRequest).toHaveBeenCalledWith("request-1", decision);
      await vi.waitFor(() => expect(host.querySelectorAll("button:disabled")).toHaveLength(2));
      await act(async () => {
        finish();
      });
      await vi.waitFor(() => expectQuiet(label));
      expect(document.activeElement?.getAttribute("data-action-request-id")).toBe("request-1");
    }
  );

  it("keeps native button semantics and a narrow noninteractive outcome focus fix", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    mount([pending]);
    const controls = [...host.querySelectorAll("button")];
    expect(controls.map((button) => button.type)).toEqual(["button", "button"]);
    controls[1]!.focus();
    expect(document.activeElement).toBe(controls[1]);
    act(() => controls[1]!.click());
    await vi.waitFor(() =>
      expect(document.activeElement?.className).toBe("action-request-outcome")
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "You declined · Delete custom theme"
    );
    const styles = readFileSync(resolve("packages/ui/src/styles/components-chat.css"), "utf8");
    expect(styles).toMatch(
      /\.action-request-outcome\[tabindex="-1"\]:focus\s*\{\s*outline: none;\s*\}/
    );
    expect(styles).not.toMatch(/\.action-request-(?:card|actions)[^{]*:focus[^}]*outline:\s*none/);
    const controlsCss = readFileSync(resolve("packages/ui/src/styles/components-core.css"), "utf8");
    expect(controlsCss).toMatch(/\.jds-btn:focus-visible\s*\{[^}]*var\(--focus-ring\)/);
  });

  it.each([
    ["person", "executed", "Approved"],
    ["person", "denied", "You declined"],
    ["timeout", "denied", "Timed out"],
    ["cancelled", "denied", "Cancelled"],
    ["person", "error", "Approved, but it didn’t go through"]
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
      expectQuiet(
        label,
        2,
        "Delete custom theme",
        outcome === "error" ? "The app reported a problem." : undefined
      );
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
    await vi.waitFor(() => expectQuiet("Timed out"));
    expect(host.textContent).not.toContain("ask again");
  });

  it("keeps a transport failure actionable and never reports approval", async () => {
    vi.mocked(resolveActionRequest).mockRejectedValue(new ApiError(503, "Connection unavailable"));
    mount([...steps, pending]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Connection unavailable"));
    expect(host.querySelector("h2")?.textContent).toBe("Delete custom theme");
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

  it("restores an approved action failure with a plain reason and no technical payload", () => {
    const message: ChatMessageDto = {
      id: "failed-message",
      threadId: "thread",
      ownerUserId: "owner",
      role: "assistant",
      status: "stored",
      body: "",
      modelRoute: null,
      tools: [],
      activity: [
        ...steps,
        {
          kind: "action_result",
          text: "Failed: app.callAction",
          actionRequestId: "request-1",
          summary: "Delete custom theme",
          outcome: "error",
          decidedBy: "person",
          reason: "approval_changed: /api/themes/raw-id {body: secret}"
        }
      ],
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z"
    };
    mount(recordsFromMessages([message]).filter((record) => record.kind !== "reply"));
    expectQuiet(
      "Approved, but it didn’t go through",
      2,
      "Delete custom theme",
      "The item changed before the action could finish."
    );
  });

  it("retains a plain server outcome title when local confirmation finishes", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    mount([...steps, { ...pending, outcomeTitle: "Delete custom theme" }]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expectQuiet("Approved"));
  });

  it("updates the live card with a fixed reason when execution fails after approval", () => {
    mount([
      ...steps,
      { ...pending, outcomeTitle: "Delete custom theme" },
      {
        kind: "action_result",
        text: "Failed: app.callAction",
        actionRequestId: "request-1",
        summary: "Delete custom theme",
        outcome: "error",
        decidedBy: "person",
        reason: "approval_changed: https://private.test/api/raw-id {body: secret}"
      }
    ]);
    expectQuiet(
      "Approved, but it didn’t go through",
      2,
      "Delete custom theme",
      "The item changed before the action could finish."
    );
    expect(host.querySelector('[role="status"]')?.textContent).not.toMatch(
      /https|private|body|secret|approval_changed/
    );
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
    await vi.waitFor(() => expectQuiet("Approved"));
    mount([...steps, { ...pending, actionRequestId: "request-2" }]);
    expect(host.querySelector("h2")?.textContent).toBe("Delete custom theme");
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.querySelector('[data-action-request-id="request-2"]')).not.toBeNull();
  });

  it("never reuses a technical pending summary as the resolved outcome title", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    const request = {
      ...pending,
      outcomeTitle: undefined,
      summary: "app.callAction DELETE /api/themes/raw-id"
    };
    mount([...steps, request]);
    // Without a trusted title this old pending record can only be declined.
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expectQuiet("You declined", 2, null));
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

  it.each([
    ["Bash", "Bash: cat -- '/vault/notes/exact  file.md'\n  exact continuation"],
    ["Read", "Read: /vault/notes/" + "long-file-name".repeat(80) + ".md"]
  ])(
    "keeps the exact %s permission disclosure through the real row renderer",
    async (toolName, summary) => {
      vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
      const record = parseRecord(
        JSON.stringify({
          kind: "action_request",
          text: "Permission",
          actionRequestId: "native-request",
          nativePermission: true,
          toolName,
          summary
        })
      );
      if (!record) throw new Error("Expected native permission record");
      mount([record]);
      expect(host.querySelector(".action-request-summary")?.textContent).toBe(summary);
      expect(host.querySelector(".jds-card--pad-sm")).not.toBeNull();
      expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "Approve",
        "Reject"
      ]);
      act(() => host.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
      await vi.waitFor(() =>
        expect(resolveActionRequest).toHaveBeenCalledExactlyOnceWith("native-request", "rejected")
      );
      await vi.waitFor(() =>
        expect(host.querySelector('[role="status"]')?.textContent).toBe("You declined")
      );
      expect(host.textContent).not.toContain(summary);
    }
  );

  it("reopens a request with lost details as Reject-only, preserving its decline and focus destination", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    mount([pending]);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Approve",
      "Reject"
    ]);
    act(() => root?.unmount());
    host.remove();
    client.clear();
    root = undefined;

    mount([
      {
        kind: "action_request",
        text: "Technical metadata /api/themes/raw-id",
        summary: "Technical metadata /api/themes/raw-id",
        toolName: "app.callAction",
        actionRequestId: "request-1",
        approvalAvailable: false
      }
    ]);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Reject"
    ]);
    expect(host.textContent).toContain(
      "Details for this request aren’t available. Reject it and ask Moss again."
    );
    expect(host.textContent).not.toMatch(/Full theme|raw-id|app\.callAction|Timed out/);
    const reject = host.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      reject.click();
      reject.click();
    });
    await vi.waitFor(() =>
      expect(resolveActionRequest).toHaveBeenCalledExactlyOnceWith("request-1", "rejected")
    );
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe("You declined")
    );
    expect(document.activeElement?.getAttribute("data-action-request-id")).toBe("request-1");
    expect(document.activeElement?.className).toBe("action-request-outcome");
  });

  it("keeps incomplete restored requests decline-only", async () => {
    vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
    mount([{ ...pending, approvalAvailable: false }]);
    expect(host.textContent).toContain(
      "Details for this request aren’t available. Reject it and ask Moss again."
    );
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Reject"
    ]);
    expect(host.querySelector("dl")).toBeNull();
    expect(resolveActionRequest).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() =>
      expect(resolveActionRequest).toHaveBeenCalledWith("request-1", "rejected")
    );
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        "You declined · Delete custom theme"
      )
    );
  });

  it("does not call missing disclosure a timeout and keeps Approve hidden after a failed decline", async () => {
    vi.mocked(resolveActionRequest)
      .mockRejectedValueOnce(new ApiError(409, "Details unavailable", "approval_unavailable"))
      .mockRejectedValueOnce(new ApiError(503, "Try declining again"))
      .mockResolvedValueOnce(undefined);
    mount([pending]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Details for this request aren’t available.")
    );
    expect(host.textContent).not.toContain("Timed out");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Reject"
    ]);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Try declining again"));
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Reject"
    ]);
    expect(host.querySelector(".action-request-card")).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        "You declined · Delete custom theme"
      )
    );
    expect(vi.mocked(resolveActionRequest).mock.calls).toEqual([
      ["request-1", "confirmed"],
      ["request-1", "rejected"],
      ["request-1", "rejected"]
    ]);
  });

  it("keeps a restored request with full server disclosure normally approvable", () => {
    mount([{ ...pending, approvalAvailable: true }]);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Approve",
      "Reject"
    ]);
    expect(host.textContent).toContain("Full theme");
    expect(host.querySelector("dl")).not.toBeNull();
  });

  it.each([false, true])(
    "settles a policy refusal after a pending card (local approval %s)",
    async (clicked) => {
      vi.mocked(resolveActionRequest).mockResolvedValue(undefined);
      mount([...steps, pending]);
      if (clicked) {
        act(() => host.querySelector<HTMLButtonElement>("button")!.click());
        await vi.waitFor(() => expectQuiet("Approved"));
      }
      const result: TranscriptRecord = {
        kind: "action_result",
        text: "Denied: app.callAction",
        actionRequestId: "request-1",
        outcome: "denied",
        decidedBy: "policy",
        summary: "Change files",
        reason: "raw /api/private {body: secret}"
      };
      mount([...steps, pending, result]);
      expectQuiet("Not allowed: Change files", 2, null);
      expect(host.textContent).not.toMatch(/Approved|secret|raw \/api/);
      mount([...steps, { ...pending, actionRequestId: "fresh-request" }, result]);
      expect(host.querySelector(".action-request-card")).not.toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Not allowed: Change files");
    }
  );

  it.each([
    ["executed", "Done: Rename your meeting"],
    ["error", "Rename your meeting didn’t go through · The app reported a problem."]
  ] as const)(
    "shows a visible plain unattended %s result without an approval card",
    (outcome, text) => {
      mount([
        {
          kind: "action_result",
          text: "Executed: app.callAction",
          outcome,
          decidedBy: "policy",
          summary: "Rename your meeting",
          reason: "raw /api/private {body: secret}"
        }
      ]);
      expect(host.querySelector('[role="status"]')?.textContent).toBe(text);
      expect(host.querySelector(".action-request-card")).toBeNull();
      expect(host.querySelectorAll("button")).toHaveLength(0);
      expect(host.textContent).not.toMatch(/Approved|app\.callAction|\/api\/|secret|body/);
    }
  );

  it.each([
    ["person", "executed"],
    ["person", "denied"],
    ["person", "error"],
    ["timeout", "denied"],
    ["cancelled", "denied"],
    ["policy", "executed"],
    ["policy", "error"],
    ["policy", "denied"]
  ] as const)("keeps the %s/%s outcome before Moss’s reply after reload", (decidedBy, outcome) => {
    const result: TranscriptRecord = {
      kind: "action_result",
      text: "Technical result",
      actionRequestId: "request-1",
      summary: "Delete custom theme",
      outcome,
      decidedBy
    };
    const reply: TranscriptRecord = { kind: "reply", text: "Moss’s final reply." };
    mount([...steps, ...(decidedBy === "policy" ? [] : [pending]), result, reply]);
    const before = host.querySelector('[role="status"]')!.textContent!;
    expect(host.textContent!.indexOf(before)).toBeLessThan(host.textContent!.indexOf(reply.text));
    const history: ChatMessageDto = {
      id: "saved",
      threadId: "thread",
      ownerUserId: "owner",
      role: "assistant",
      status: "stored",
      body: reply.text,
      modelRoute: null,
      tools: [],
      activity: [...steps, result],
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z"
    };
    mount(recordsFromMessages([history]));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(before);
    expect(host.textContent!.indexOf(before)).toBeLessThan(host.textContent!.indexOf(reply.text));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.textContent).toContain("Thinking2 steps");
  });
});
