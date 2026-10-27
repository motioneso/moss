import { describe, expect, it } from "vitest";

import { nextStickToBottom } from "../../apps/web/src/chat/use-chat-autoscroll.js";

describe("nextStickToBottom", () => {
  it("keeps following when content grows under a view that did not move up", () => {
    // Our own scroll lands after the content grew another 79px.
    expect(
      nextStickToBottom({ stick: true, previousTop: 995, top: 995, distanceFromBottom: 79 })
    ).toBe(true);
  });

  it("stops following when the user scrolls up", () => {
    expect(
      nextStickToBottom({ stick: true, previousTop: 995, top: 600, distanceFromBottom: 474 })
    ).toBe(false);
  });

  it("resumes following when the user scrolls back near the bottom", () => {
    expect(
      nextStickToBottom({ stick: false, previousTop: 600, top: 1000, distanceFromBottom: 20 })
    ).toBe(true);
  });

  it("stays off while the user reads above the bottom", () => {
    expect(
      nextStickToBottom({ stick: false, previousTop: 600, top: 700, distanceFromBottom: 300 })
    ).toBe(false);
  });
});
