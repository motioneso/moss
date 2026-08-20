import { describe, expect, it, vi } from "vitest";
import { ChatGatewayNotifier } from "../../packages/chat/src/gateway-notifier.js";
import type { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";

const makeManager = () =>
  ({
    injectRecord: vi.fn()
  }) as unknown as ChatSessionManager;

describe("ChatGatewayNotifier", () => {
  it("routes composite session ids to their actor and surface", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit(surfaceSessionKey("u:1", "demo-module"), {
      kind: "action_request",
      actionRequestId: "ar_surface",
      toolName: "example.read",
      summary: "Read the value"
    });

    expect(manager.injectRecord).toHaveBeenCalledWith(
      "u:1",
      expect.objectContaining({ actionRequestId: "ar_surface" }),
      "demo-module"
    );
  });

  it("converts action_request and fans out to manager.injectRecord", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_request",
      actionRequestId: "ar_1",
      toolName: "example.write",
      summary: "Write the value 'hello'"
    });

    expect(manager.injectRecord).toHaveBeenCalledOnce();
    const call0 = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    const [actorUserId, record] = call0;
    expect(actorUserId).toBe("u1");
    expect(record.kind).toBe("action_request");
    expect(record.actionRequestId).toBe("ar_1");
    expect(record.toolName).toBe("example.write");
    expect(record.summary).toBe("Write the value 'hello'");
  });

  it("threads an optional preview through to the transcript record", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_request",
      actionRequestId: "ar_2",
      toolName: "email.draftReply",
      summary: "Draft a reply",
      preview: { to: "alice@example.test", subject: "Re: lunch", body: "See you at noon." }
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.preview).toEqual({
      to: "alice@example.test",
      subject: "Re: lunch",
      body: "See you at noon."
    });
  });

  it("omits preview when the action_request carries none", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_request",
      actionRequestId: "ar_3",
      toolName: "example.write",
      summary: "Write the value 'hello'"
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.preview).toBeUndefined();
  });

  it("converts action_result with outcome", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "executed"
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.kind).toBe("action_result");
    expect(record.outcome).toBe("executed");
    expect(record.actionRequestId).toBe("ar_1");
  });

  it("uses capped module-authored status text on the live structured result", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

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

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.result).toMatchObject({ status: "ok", revisionId: "review-1" });
    expect(record.text).toMatch(/^Criteria updated safely/);
    expect(record.text.length).toBe(160);
  });

  // #1661: this used to assert "Allowed by YOLO". Unattended mode was once the only thing that
  // produced this outcome, so the text could name it; a user's own approval of a native tool now
  // produces it too, and the record carries nothing saying which. Naming a cause the record does
  // not carry is the drift this issue is about, so the text stops guessing.
  it("reports an allowed outcome without claiming who allowed it", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "Read",
      outcome: "allowed"
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.outcome).toBe("allowed");
    expect(record.text).toBe("Allowed: Read");
    expect(record.text).not.toContain("YOLO");
  });

  // #1661: an error used to render with the denial sentence, so a tool that ran and failed was
  // announced in the same words as one the user refused — while the audit row for that same event
  // said `failed`. "Not changed" was the second problem: a write that failed part-way did change
  // things, and the host has no way to know it did not.
  it("distinguishes a failed call from a refused one", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "error",
      reason: "Tool example.write failed"
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.text).toBe("Failed: example.write — Tool example.write failed");
    expect(record.text).not.toContain("Not changed");
  });

  it("still names the tool on a failure that carries no reason", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "error"
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.text).toBe("Failed: example.write");
  });

  it("renders denied outcomes as a typed not-changed result", () => {
    const manager = makeManager();
    const notifier = new ChatGatewayNotifier(manager);

    notifier.emit("u1", {
      kind: "action_result",
      actionRequestId: "ar_1",
      toolName: "example.write",
      outcome: "denied",
      reason: "Denied by user."
    });

    const [, record] = (manager.injectRecord as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      TranscriptRecord
    ];
    expect(record.text).toBe("Not changed — Denied by user.");
  });
});
