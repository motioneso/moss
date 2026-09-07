import { describe, expect, it, vi } from "vitest";

import { ChatGatewayNotifier, parseWorkshopSessionOwner } from "./gateway-notifier.js";

describe("parseWorkshopSessionOwner", () => {
  it("returns the owner for Workshop session keys", () => {
    expect(parseWorkshopSessionOwner("workshop:actor-1:proj-9")).toBe("actor-1");
  });

  it("returns null for anything else", () => {
    expect(parseWorkshopSessionOwner("actor-1:default")).toBeNull();
    expect(parseWorkshopSessionOwner("workshop::proj")).toBeNull();
    expect(parseWorkshopSessionOwner("workshop:actor-1")).toBeNull();
    expect(parseWorkshopSessionOwner("other:actor-1:proj")).toBeNull();
    expect(parseWorkshopSessionOwner("")).toBeNull();
  });
});

describe("ChatGatewayNotifier Workshop routing", () => {
  const card = {
    kind: "action_request",
    actionRequestId: "act-1",
    toolName: "workshop.runCommand",
    summary: "Run this project command: pnpm build"
  };

  it("routes Workshop cards to the owning actor's chat surface", () => {
    const injectRecord = vi.fn();
    const notifier = new ChatGatewayNotifier({ injectRecord } as never);
    notifier.emit("workshop:actor-1:proj-9", card as never);
    expect(injectRecord).toHaveBeenCalledTimes(1);
    expect(injectRecord.mock.calls[0]?.[0]).toBe("actor-1");
  });

  it("leaves main-chat keys on today's path", () => {
    const injectRecord = vi.fn();
    const notifier = new ChatGatewayNotifier({ injectRecord } as never);
    notifier.emit("actor-1", card as never);
    expect(injectRecord).toHaveBeenCalledTimes(1);
    expect(injectRecord.mock.calls[0]?.[0]).toBe("actor-1");
    expect(injectRecord.mock.calls[0]).toHaveLength(2);
  });

  it("drops records with no transcript mapping", () => {
    const injectRecord = vi.fn();
    const notifier = new ChatGatewayNotifier({ injectRecord } as never);
    notifier.emit("workshop:actor-1:proj-9", { kind: "thinking" } as never);
    expect(injectRecord).not.toHaveBeenCalled();
  });
});
