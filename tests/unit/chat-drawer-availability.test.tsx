import { describe, expect, it } from "vitest";

import { chatAvailableFromRoute } from "../../apps/web/src/chat/chat-drawer.js";

describe("chatAvailableFromRoute", () => {
  it("returns true when the route resolves to an available model", () => {
    expect(
      chatAvailableFromRoute({
        route: { capability: "chat", available: true, reason: "matched-active-model", model: null }
      })
    ).toBe(true);
  });

  it("returns false when the route resolves to unavailable, regardless of reason", () => {
    expect(
      chatAvailableFromRoute({
        route: { capability: "chat", available: false, reason: "no-active-model", model: null }
      })
    ).toBe(false);
  });

  it("returns false when the route query has not resolved yet", () => {
    expect(chatAvailableFromRoute(undefined)).toBe(false);
  });
});
