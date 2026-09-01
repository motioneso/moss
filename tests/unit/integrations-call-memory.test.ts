import { describe, expect, it } from "vitest";

import { createCallMemory, INTEGRATION_SUMMARY } from "@moss/integrations";

function clock(startMs = 0) {
  let ms = startMs;
  return { now: () => ms, advance: (deltaMs: number) => (ms += deltaMs) };
}

const scopeA = { actorUserId: "user-a", chatSessionId: "sess-1" };
const scopeB = { actorUserId: "user-b", chatSessionId: "sess-1" };

describe("createCallMemory", () => {
  it("serves a repeated short read from the store instead of re-running it", () => {
    const c = clock();
    const memory = createCallMemory({ now: c.now });
    const key = memory.callKey("conn-1", "get_state", { room: "kitchen" });

    expect(memory.check(scopeA, "conn-1", key, "read", false)).toEqual({ kind: "run" });
    memory.record(scopeA, "conn-1", key, {
      ok: true,
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk,
      detail: { on: true }
    });

    expect(memory.check(scopeA, "conn-1", key, "read", false)).toEqual({
      kind: "serve",
      summary: INTEGRATION_SUMMARY.blockedRead,
      detail: { on: true }
    });
  });

  it("serves summary only for a repeated read whose stored detail is long", () => {
    const memory = createCallMemory();
    const key = memory.callKey("conn-1", "get_history", {});
    memory.record({ actorUserId: "u", chatSessionId: "s" }, "conn-1", key, {
      ok: true,
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk,
      detail: "x".repeat(600)
    });

    const decision = memory.check(
      { actorUserId: "u", chatSessionId: "s" },
      "conn-1",
      key,
      "read",
      false
    );
    expect(decision).toEqual({ kind: "serve", summary: INTEGRATION_SUMMARY.blockedRead });
  });

  it("re-runs a stored read once a successful performed call happens on the same connection", () => {
    const memory = createCallMemory();
    const scope = { actorUserId: "u", chatSessionId: "s" };
    const readKey = memory.callKey("conn-1", "get_state", {});
    const writeKey = memory.callKey("conn-1", "turn_off", {});

    memory.record(scope, "conn-1", readKey, {
      ok: true,
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk,
      detail: { on: true }
    });
    memory.record(scope, "conn-1", writeKey, {
      ok: true,
      action: "performed",
      summary: INTEGRATION_SUMMARY.performedOk,
      detail: null
    });

    expect(memory.check(scope, "conn-1", readKey, "read", false)).toEqual({ kind: "run" });
  });

  it("blocks a repeated performed call and allows it again after skipSuppression", () => {
    const memory = createCallMemory();
    const scope = { actorUserId: "u", chatSessionId: "s" };
    const key = memory.callKey("conn-1", "turn_off", {});
    memory.record(scope, "conn-1", key, {
      ok: true,
      action: "performed",
      summary: INTEGRATION_SUMMARY.performedOk,
      detail: null
    });

    expect(memory.check(scope, "conn-1", key, "performed", false)).toEqual({
      kind: "serve",
      summary: INTEGRATION_SUMMARY.blockedPerformed
    });
    expect(memory.check(scope, "conn-1", key, "performed", true)).toEqual({ kind: "run" });
  });

  it("does not treat a failed performed call as a blockable duplicate", () => {
    const memory = createCallMemory();
    const scope = { actorUserId: "u", chatSessionId: "s" };
    const key = memory.callKey("conn-1", "turn_off", {});
    memory.record(scope, "conn-1", key, {
      ok: false,
      action: "performed",
      summary: INTEGRATION_SUMMARY.callFailed,
      detail: "boom"
    });

    expect(memory.check(scope, "conn-1", key, "performed", false)).toEqual({ kind: "run" });
  });

  it("builds the same key regardless of argument order", () => {
    const memory = createCallMemory();
    const a = memory.callKey("conn-1", "search", { q: "cats", limit: 5 });
    const b = memory.callKey("conn-1", "search", { limit: 5, q: "cats" });
    expect(a).toBe(b);
  });

  it("expires an entry 30s after it was last recorded", () => {
    const c = clock();
    const memory = createCallMemory({ now: c.now, windowMs: 30_000 });
    const scope = { actorUserId: "u", chatSessionId: "s" };
    const key = memory.callKey("conn-1", "get_state", {});
    memory.record(scope, "conn-1", key, {
      ok: true,
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk,
      detail: {}
    });

    c.advance(29_999);
    expect(memory.check(scope, "conn-1", key, "read", false).kind).toBe("serve");

    c.advance(2);
    expect(memory.check(scope, "conn-1", key, "read", false)).toEqual({ kind: "run" });
  });

  it("never refreshes the window on a blocked check, only on a real record", () => {
    const c = clock();
    const memory = createCallMemory({ now: c.now, windowMs: 30_000 });
    const scope = { actorUserId: "u", chatSessionId: "s" };
    const key = memory.callKey("conn-1", "turn_off", {});
    memory.record(scope, "conn-1", key, {
      ok: true,
      action: "performed",
      summary: INTEGRATION_SUMMARY.performedOk,
      detail: null
    });

    c.advance(20_000);
    expect(memory.check(scope, "conn-1", key, "performed", false).kind).toBe("serve");
    c.advance(20_000); // 40s since record, even though a check happened at 20s
    expect(memory.check(scope, "conn-1", key, "performed", false)).toEqual({ kind: "run" });
  });

  it("never leaks one user's stored result to another user, even with the same chat session id", () => {
    const memory = createCallMemory();
    const key = memory.callKey("conn-1", "get_state", {});
    memory.record(scopeA, "conn-1", key, {
      ok: true,
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk,
      detail: { secret: true }
    });

    expect(memory.check(scopeB, "conn-1", key, "read", false)).toEqual({ kind: "run" });
  });

  it("never leaks between two chat sessions for the same user", () => {
    const memory = createCallMemory();
    const key = memory.callKey("conn-1", "get_state", {});
    memory.record({ actorUserId: "user-a", chatSessionId: "sess-1" }, "conn-1", key, {
      ok: true,
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk,
      detail: {}
    });

    expect(
      memory.check({ actorUserId: "user-a", chatSessionId: "sess-2" }, "conn-1", key, "read", false)
    ).toEqual({ kind: "run" });
  });
});
