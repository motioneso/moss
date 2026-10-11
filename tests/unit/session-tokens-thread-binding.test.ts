import { describe, expect, it } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";

function identity() {
  return {
    actorUserId: "actor-a",
    chatSessionId: "actor-a:chat",
    threadId: "thread-a",
    allowedToolNames: new Set(["settings.change"])
  };
}

describe("session token conversation binding", () => {
  it.each([undefined, null])("normalizes an absent thread to null (%s)", (threadId) => {
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint({ ...identity(), threadId });
    expect(tokens.verify(token).threadId).toBeNull();
  });

  it("snapshots identity at mint so the caller cannot retarget actor, thread or session", () => {
    const tokens = new SessionTokenRegistry();
    const supplied = identity();
    const token = tokens.mint(supplied);
    supplied.actorUserId = "actor-b";
    supplied.chatSessionId = "actor-b:chat";
    supplied.threadId = "thread-b";
    supplied.allowedToolNames = new Set(["different.tool"]);
    expect(tokens.verify(token)).toMatchObject({
      actorUserId: "actor-a",
      chatSessionId: "actor-a:chat",
      threadId: "thread-a"
    });
    expect([...tokens.verify(token).allowedToolNames!]).toEqual(["settings.change"]);
  });

  it("freezes the verified identity so consumers cannot retarget later calls", () => {
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint(identity());
    const verified = tokens.verify(token);
    for (const [key, value] of Object.entries({
      actorUserId: "actor-b",
      chatSessionId: "other",
      threadId: "thread-b",
      allowedToolNames: null
    })) {
      expect(Reflect.set(verified, key, value)).toBe(false);
    }
    expect(tokens.verify(token)).toMatchObject({
      actorUserId: "actor-a",
      chatSessionId: "actor-a:chat",
      threadId: "thread-a"
    });
  });

  it("retains the gate's deliberate allowlist growth without changing bound identity", () => {
    const tokens = new SessionTokenRegistry();
    const supplied = identity();
    const token = tokens.mint(supplied);
    supplied.allowedToolNames.add("app.callAction");
    expect(tokens.verify(token).allowedToolNames).toBe(supplied.allowedToolNames);
    expect(tokens.verify(token).allowedToolNames?.has("app.callAction")).toBe(true);
    expect(tokens.verify(token).threadId).toBe("thread-a");
  });

  it("keeps distinct thread bindings for tokens sharing the actor-plus-surface session", () => {
    const tokens = new SessionTokenRegistry();
    const first = tokens.mint(identity());
    const second = tokens.mint({ ...identity(), threadId: "thread-b" });
    expect(tokens.verify(first).threadId).toBe("thread-a");
    expect(tokens.verify(second).threadId).toBe("thread-b");
    tokens.revoke(first);
    expect(tokens.verify(second).threadId).toBe("thread-b");
  });
});
