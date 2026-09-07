import { describe, expect, it, vi } from "vitest";

import { ChatGatewayNotifier } from "./gateway-notifier.js";

describe("ChatGatewayNotifier", () => {
  const card = {
    kind: "action_request",
    actionRequestId: "act-1",
    toolName: "workshop.runCommand",
    summary: "Run this project command: pnpm build"
  };

  it("fans main-chat keys out by actor and surface", () => {
    const injectRecord = vi.fn();
    const notifier = new ChatGatewayNotifier({ injectRecord } as never);
    notifier.emit("actor-1", card as never);
    expect(injectRecord).toHaveBeenCalledTimes(1);
    expect(injectRecord.mock.calls[0]?.[0]).toBe("actor-1");
    expect(injectRecord.mock.calls[0]).toHaveLength(2);
  });

  it("puts Workshop session keys in the project stream bucket, unparsed", () => {
    const injectRecord = vi.fn();
    const notifier = new ChatGatewayNotifier({ injectRecord } as never);
    // proj-9 would parse as a surface; a hex-leading project id too. The card
    // must not depend on parsing: without the explicit bucket this test fails.
    for (const key of ["workshop:actor-1:proj-9", "workshop:actor-1:abcdef01"]) {
      injectRecord.mockClear();
      notifier.emit(key, card as never);
      expect(injectRecord).toHaveBeenCalledTimes(1);
      expect(injectRecord.mock.calls[0]?.[0]).toBe(key);
      expect(injectRecord.mock.calls[0]?.[2]).toBe("workshop");
    }
  });

  it("drops records with no transcript mapping", () => {
    const injectRecord = vi.fn();
    const notifier = new ChatGatewayNotifier({ injectRecord } as never);
    notifier.emit("workshop:actor-1:proj-9", { kind: "thinking" } as never);
    expect(injectRecord).not.toHaveBeenCalled();
  });
});
