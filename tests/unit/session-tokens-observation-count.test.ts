import { describe, expect, it } from "vitest";

import {
  SessionTokenRegistry,
  type SessionIdentity
} from "../../packages/ai/src/gateway/session-tokens.js";

const identity: SessionIdentity = {
  actorUserId: "user-1",
  chatSessionId: "session-1",
  allowedToolNames: null
};

describe("SessionTokenRegistry — #2164 r21 per-turn observation counter", () => {
  it("starts a fresh token's observation count at 0", () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint(identity);
    expect(registry.getToolsListObservationCount(token)).toBe(0);
  });

  it("returns 0 for an unknown token", () => {
    const registry = new SessionTokenRegistry();
    expect(registry.getToolsListObservationCount("jst_unknown")).toBe(0);
  });

  it("increments the count on every markToolsListObserved call, not just the first", () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint(identity);
    registry.markToolsListObserved(token);
    expect(registry.getToolsListObservationCount(token)).toBe(1);
    registry.markToolsListObserved(token);
    registry.markToolsListObserved(token);
    expect(registry.getToolsListObservationCount(token)).toBe(3);
  });

  it("waitForToolsListObservedSince resolves true immediately once the count already exceeds the baseline", async () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint(identity);
    registry.markToolsListObserved(token);
    await expect(registry.waitForToolsListObservedSince(token, 0)).resolves.toBe(true);
  });

  it("waitForToolsListObservedSince resolves true once a later observation lands", async () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint(identity);
    registry.markToolsListObserved(token); // count = 1, this turn's baseline
    const baseline = registry.getToolsListObservationCount(token);
    const wait = registry.waitForToolsListObservedSince(token, baseline, 1000);
    registry.markToolsListObserved(token); // count = 2, a fresh attach for the next turn
    await expect(wait).resolves.toBe(true);
  });

  it("waitForToolsListObservedSince resolves false after timeout when no new observation lands", async () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint(identity);
    registry.markToolsListObserved(token);
    const baseline = registry.getToolsListObservationCount(token);
    await expect(registry.waitForToolsListObservedSince(token, baseline, 10)).resolves.toBe(false);
  });

  it("waitForToolsListObservedSince resolves false immediately for an unknown token", async () => {
    const registry = new SessionTokenRegistry();
    await expect(registry.waitForToolsListObservedSince("jst_unknown", 0, 10)).resolves.toBe(false);
  });

  it("waitForToolsListObserved keeps its existing ever-observed contract, unaffected by the counter", async () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint(identity);
    await expect(registry.waitForToolsListObserved(token, 10)).resolves.toBe(false);
    registry.markToolsListObserved(token);
    await expect(registry.waitForToolsListObserved(token)).resolves.toBe(true);
    registry.markToolsListObserved(token);
    registry.markToolsListObserved(token);
    await expect(registry.waitForToolsListObserved(token)).resolves.toBe(true);
  });
});
