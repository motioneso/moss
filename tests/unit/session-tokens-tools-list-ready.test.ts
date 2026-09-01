import { describe, expect, it } from "vitest";
import { SessionTokenRegistry } from "../../packages/ai/src/gateway/session-tokens.js";

/**
 * #2159 — the tools/list readiness primitive on SessionTokenRegistry: a per-token flag set by
 * `markToolsListObserved` (called from the MCP transport's tools/list handler) and read via
 * `waitForToolsListObserved` (awaited by ChatSessionManager.launchSession before a session is
 * considered ready for its first message).
 */
function mint(registry: SessionTokenRegistry): string {
  return registry.mint({ actorUserId: "u1", chatSessionId: "u1:drawer", allowedToolNames: null });
}

describe("SessionTokenRegistry tools/list readiness (#2159)", () => {
  it("resolves true immediately when tools/list was already observed", async () => {
    const registry = new SessionTokenRegistry();
    const token = mint(registry);
    registry.markToolsListObserved(token);

    await expect(registry.waitForToolsListObserved(token, 1_000)).resolves.toBe(true);
  });

  it("resolves true once markToolsListObserved fires after the wait has started", async () => {
    const registry = new SessionTokenRegistry();
    const token = mint(registry);

    const waiting = registry.waitForToolsListObserved(token, 5_000);
    registry.markToolsListObserved(token);

    await expect(waiting).resolves.toBe(true);
  });

  it("resolves false after the timeout if tools/list is never observed", async () => {
    const registry = new SessionTokenRegistry();
    const token = mint(registry);

    await expect(registry.waitForToolsListObserved(token, 25)).resolves.toBe(false);
  });

  it("resolves false immediately for an unknown token", async () => {
    const registry = new SessionTokenRegistry();
    await expect(registry.waitForToolsListObserved("jst_nonexistent", 1_000)).resolves.toBe(false);
  });

  it("is idempotent: a second markToolsListObserved is a harmless no-op", () => {
    const registry = new SessionTokenRegistry();
    const token = mint(registry);
    registry.markToolsListObserved(token);
    expect(() => registry.markToolsListObserved(token)).not.toThrow();
  });
});
