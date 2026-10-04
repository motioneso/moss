import { describe, expect, it } from "vitest";

import { SessionTokenRegistry } from "../../packages/ai/src/index.js";
import { buildCheckTokenMinter } from "../../packages/chat/src/routes.js";
import { buildCheckTokenMinter as buildInternalCheckTokenMinter } from "../../packages/chat/src/check-token-minter.js";

describe("check token minter", () => {
  it("preserves the routes module's minter export", () => {
    expect(buildCheckTokenMinter).toBe(buildInternalCheckTokenMinter);
  });

  it("mints a token limited to exactly the named tools", () => {
    const tokens = new SessionTokenRegistry();
    const minter = buildCheckTokenMinter(tokens, "http://mcp.test/api/mcp");
    const { token, mcpServerUrl } = minter.mint("user-1", "check-1", ["app.getMapSlice"]);

    const identity = tokens.verify(token);
    expect(mcpServerUrl).toBe("http://mcp.test/api/mcp");
    expect(identity.actorUserId).toBe("user-1");
    expect([...(identity.allowedToolNames ?? [])]).toEqual(["app.getMapSlice"]);
  });

  it("never mints an unrestricted token, even for an empty list", () => {
    const tokens = new SessionTokenRegistry();
    const { token } = buildCheckTokenMinter(tokens, "u").mint("user-1", "check-2", []);
    expect(tokens.verify(token).allowedToolNames).not.toBeNull();
    expect(tokens.verify(token).allowedToolNames?.size).toBe(0);
  });

  it("stops the token working once the check session is revoked", () => {
    const tokens = new SessionTokenRegistry();
    const minter = buildCheckTokenMinter(tokens, "u");
    const { token } = minter.mint("user-1", "check-3", ["app.getMapSlice"]);
    minter.revoke("check-3");
    expect(() => tokens.verify(token)).toThrow();
  });
});
