import { describe, expect, it } from "vitest";
import {
  InvalidSessionTokenError,
  SessionTokenRegistry
} from "../../packages/ai/src/gateway/session-tokens.js";

/**
 * Fixed-expiry mint for tokens handed to outside processes (the ACP tool
 * server bearer): the end time must not move no matter how often the token is
 * used, so a leaked token goes stale on its own.
 */
function fixedRegistry(ttlMs: number): { registry: SessionTokenRegistry; advance: (ms: number) => void } {
  let now = 0;
  const registry = new SessionTokenRegistry({ clock: { now: () => now } });
  return { registry, advance: (ms: number) => void (now += ms) };
}

function identity() {
  return { actorUserId: "u1", chatSessionId: "u1:workshop", allowedToolNames: new Set(["workshop.run"]) };
}

describe("SessionTokenRegistry fixed expiry", () => {
  it("does not push the end time out when the token is used", () => {
    const { registry, advance } = fixedRegistry(1_000);
    const token = registry.mint(identity(), { ttlMs: 1_000, fixedExpiry: true });

    advance(900);
    expect(registry.verify(token).actorUserId).toBe("u1");
    advance(50);
    expect(registry.verify(token).actorUserId).toBe("u1");
    // A sliding token would now live until ~1950; the fixed one ends at 1000.
    advance(51);
    expect(() => registry.verify(token)).toThrow(InvalidSessionTokenError);
  });

  it("keeps the sliding refresh for normal tokens", () => {
    const { registry, advance } = fixedRegistry(1_000);
    const token = registry.mint(identity());

    advance(900);
    expect(registry.verify(token).actorUserId).toBe("u1");
    advance(900);
    expect(registry.verify(token).actorUserId).toBe("u1");
  });

  it("still revokes a fixed token explicitly", () => {
    const { registry } = fixedRegistry(1_000);
    const token = registry.mint(identity(), { fixedExpiry: true });
    registry.revoke(token);
    expect(() => registry.verify(token)).toThrow(InvalidSessionTokenError);
  });
});
