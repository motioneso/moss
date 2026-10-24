import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { VisualReply } from "../../apps/web/src/chat/visual-reply.js";

describe("visual compatibility", () => {
  it("renders readable fallback from an incompatible HTTP envelope", () => {
    const html = renderToStaticMarkup(
      createElement(VisualReply, {
        record: {
          kind: "reply",
          text: "Six hours.",
          messageId: "saved",
          visualReply: {
            version: 2,
            fallbackText: "Your data: hours: 6 (not independently verified)"
          } as never
        }
      })
    );
    expect(html).toContain("Visual unavailable");
    expect(html).toContain("hours: 6");
    expect(html).toContain("not independently verified");
    expect(html).toContain("Copy reply");
  });
});
