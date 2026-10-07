import { describe, expect, it, vi } from "vitest";
import { ChatGatewayNotifier } from "../../packages/chat/src/gateway-notifier.js";
import type { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";

const makeManager = () => {
  const injectRecord = vi.fn();
  return {
    injectRecord,
    injectOriginRecord: vi.fn(
      async (actor: string, _thread: string, record: TranscriptRecord, surface?: string) => {
        if (surface) injectRecord(actor, record, surface);
        else injectRecord(actor, record);
      }
    )
  } as unknown as ChatSessionManager;
};
const makeNotifier = (manager: ChatSessionManager) =>
  new ChatGatewayNotifier(manager, async () => ({ found: true, threadId: "origin-thread" }));

describe("ChatGatewayNotifier", () => {
  it("routes composite session ids to their actor and surface", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit(surfaceSessionKey("u:1", "demo-module"), {
      kind: "action_request",
      outsideContentNotice: false,
      actionRequestId: "ar_surface",
      toolName: "example.read",
      summary: "Read the value"
    });

    await notifier.flush();
    expect(manager.injectRecord).toHaveBeenCalledWith(
      "u:1",
      expect.objectContaining({ actionRequestId: "ar_surface" }),
      "demo-module"
    );
  });

  it("converts action_request and fans out to manager.injectRecord", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_request",
      outsideContentNotice: false,
      actionRequestId: "ar_1",
      toolName: "example.write",
      summary: "Write the value 'hello'",
      outcomeTitle: "Write your note"
    });

    await notifier.flush();
    expect(manager.injectRecord).toHaveBeenCalledOnce();
    const call0 = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    const [actorUserId, record] = call0;
    await notifier.flush();
    expect(actorUserId).toBe("u1");
    await notifier.flush();
    expect(record.kind).toBe("action_request");
    await notifier.flush();
    expect(record.actionRequestId).toBe("ar_1");
    await notifier.flush();
    expect(record.toolName).toBe("example.write");
    await notifier.flush();
    expect(record.summary).toBe("Write the value 'hello'");
    await notifier.flush();
    expect(record.outcomeTitle).toBe("Write your note");
  });

  it("threads an optional preview through to the transcript record", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_request",
      outsideContentNotice: false,
      actionRequestId: "ar_2",
      toolName: "email.draftReply",
      summary: "Draft a reply",
      preview: { to: "alice@example.test", subject: "Re: lunch", body: "See you at noon." }
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.preview).toEqual({
      to: "alice@example.test",
      subject: "Re: lunch",
      body: "See you at noon."
    });
  });

  it("omits preview when the action_request carries none", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_request",
      outsideContentNotice: false,
      actionRequestId: "ar_3",
      toolName: "example.write",
      summary: "Write the value 'hello'"
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.preview).toBeUndefined();
  });

  it("converts action_result with outcome", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "executed"
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.kind).toBe("action_result");
    await notifier.flush();
    expect(record.outcome).toBe("executed");
    await notifier.flush();
    expect(record.actionRequestId).toBe("ar_1");
  });

  it("uses capped module-authored status text on the live structured result", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_resume",
      toolName: "demo-module.resume.critique",
      outcome: "executed",
      result: {
        status: "ok",
        revisionId: "review-1",
        statusText: `  Criteria\nupdated ${"safely ".repeat(30)}`
      }
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.result).toMatchObject({ status: "ok", revisionId: "review-1" });
    await notifier.flush();
    expect(record.text).toMatch(/^Criteria updated safely/);
    await notifier.flush();
    expect(record.text.length).toBe(160);
  });

  // #1661: this used to assert "Allowed by YOLO". Unattended mode was once the only thing that
  // produced this outcome, so the text could name it; a user's own approval of a native tool now
  // produces it too, and the record carries nothing saying which. Naming a cause the record does
  // not carry is the drift this issue is about, so the text stops guessing.
  it("reports an allowed outcome without claiming who allowed it", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "Read",
      outcome: "allowed"
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.outcome).toBe("allowed");
    await notifier.flush();
    expect(record.text).toBe("Allowed: Read");
    await notifier.flush();
    expect(record.text).not.toContain("YOLO");
  });

  // #1661: an error used to render with the denial sentence, so a tool that ran and failed was
  // announced in the same words as one the user refused — while the audit row for that same event
  // said `failed`. "Not changed" was the second problem: a write that failed part-way did change
  // things, and the host has no way to know it did not.
  it("distinguishes a failed call from a refused one", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "error",
      reason: "Tool example.write failed"
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.text).toBe("Failed: example.write — Tool example.write failed");
    await notifier.flush();
    expect(record.text).not.toContain("Not changed");
  });

  it("still names the tool on a failure that carries no reason", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "error"
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.text).toBe("Failed: example.write");
  });

  it("renders denied outcomes as a typed not-changed result", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);

    // A neutral sentence: this test covers the rendering, not the gateway's
    // wording, so the emitted record must not speak for the gateway.
    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "denied",
      reason: "Example refused."
    });

    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record.text).toBe("Not changed — Example refused.");
  });
});

describe("ChatGatewayNotifier app-action SSE fields", () => {
  it("carries server details and false outside-content notice unchanged", async () => {
    const manager = makeManager();
    const details = { target: "Theme <b>name</b>", fields: [{ label: "Name", value: "Evening" }] };
    const notifier = makeNotifier(manager);
    notifier.emit("u1", {
      kind: "action_request",
      actionRequestId: "app-1",
      toolName: "app.callAction",
      summary: "Change theme",
      details,
      outsideContentNotice: false
    });
    await notifier.flush();
    expect(manager.injectRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        kind: "action_request",
        text: "Approve or deny: Change theme",
        details,
        outsideContentNotice: false
      })
    );
  });

  it("carries module refresh identifiers on successful action results", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);
    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "app-1",
      toolName: "app.callAction",
      outcome: "executed",
      affectsModules: ["settings"],
      affectsQueryKeys: ["settings.themes"]
    });
    await notifier.flush();
    expect(manager.injectRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        affectsModules: ["settings"],
        affectsQueryKeys: ["settings.themes"]
      })
    );
  });

  it("retains only the resolved title independently of handler text and execution failure", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);
    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "app-1",
      toolName: "app.callAction",
      summary: "  Remove\n saved theme  ",
      outcome: "error",
      decidedBy: "person",
      reason: "Action could not finish.",
      result: { statusText: "Untrusted replacement title" }
    });
    await notifier.flush();
    expect(manager.injectRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        actionRequestId: "app-1",
        summary: "Remove saved theme",
        outcome: "error",
        decidedBy: "person"
      })
    );
  });

  it("does not invent an action title from the handler status or tool name", async () => {
    const manager = makeManager();
    const notifier = makeNotifier(manager);
    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "app-1",
      toolName: "app.callAction",
      outcome: "executed",
      result: { statusText: "Untrusted replacement title" }
    });
    await notifier.flush();
    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    await notifier.flush();
    expect(record).not.toHaveProperty("summary");
  });
});

describe("ChatGatewayNotifier durable origins", () => {
  const result = {
    kind: "action_result" as const,
    actionRequestId: "old-action",
    toolName: "news.follow",
    outcome: "denied" as const,
    decidedBy: "timeout" as const,
    summary: "Follow news topic"
  };

  it("routes an old timeout only to its stored origin, never a surface or supplied replacement", async () => {
    const manager = makeManager();
    const lookup = vi.fn(async () => ({ found: true, threadId: "conversation-A" }));
    const notifier = new ChatGatewayNotifier(manager, lookup);
    notifier.emit(surfaceSessionKey("owner", "drawer"), {
      ...result,
      originThreadId: "conversation-B"
    });
    await notifier.flush();
    expect(lookup).toHaveBeenCalledWith(
      "owner",
      "old-action",
      surfaceSessionKey("owner", "drawer")
    );
    expect(manager.injectOriginRecord).toHaveBeenCalledWith(
      "owner",
      "conversation-A",
      expect.objectContaining({ decidedBy: "timeout" }),
      "drawer"
    );
  });

  it.each([true, false])("drops an unknown legacy origin (row found %s)", async (found) => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager, async () => ({ found, threadId: null }));
    notifier.emit("owner", { ...result, originThreadId: "current-B" });
    await notifier.flush();
    expect(manager.injectOriginRecord).not.toHaveBeenCalled();
  });

  it("does not infer origin when the owner-scoped lookup fails", async () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager, async () => {
      throw new Error("unavailable");
    });
    notifier.emit("owner", result);
    await notifier.flush();
    expect(manager.injectOriginRecord).not.toHaveBeenCalled();
  });

  it("accepts a trusted unattended origin only when no persisted request exists", async () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager, async () => ({ found: false }));
    notifier.emit("owner", { ...result, decidedBy: "policy", originThreadId: "conversation-A" });
    await notifier.flush();
    expect(manager.injectOriginRecord).toHaveBeenCalledWith(
      "owner",
      "conversation-A",
      expect.objectContaining({ decidedBy: "policy" }),
      undefined
    );
    expect(
      (manager.injectOriginRecord as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
    ).not.toHaveProperty("originThreadId");
  });
  it("does not let another owner's stalled lookup block an outcome", async () => {
    const manager = makeManager();
    let finish!: (value: { found: boolean; threadId: string }) => void;
    const stalled = new Promise<{ found: boolean; threadId: string }>((resolve) => {
      finish = resolve;
    });
    const notifier = new ChatGatewayNotifier(manager, async (actor) =>
      actor === "slow-owner" ? stalled : { found: true, threadId: "fast-thread" }
    );
    notifier.emit("slow-owner", result);
    notifier.emit("fast-owner", result);
    await vi.waitFor(() =>
      expect(manager.injectOriginRecord).toHaveBeenCalledWith(
        "fast-owner",
        "fast-thread",
        expect.anything(),
        undefined
      )
    );
    expect(manager.injectOriginRecord).toHaveBeenCalledTimes(1);
    finish({ found: true, threadId: "slow-thread" });
    await notifier.flush();
    expect(manager.injectOriginRecord).toHaveBeenCalledTimes(2);
  });
});
