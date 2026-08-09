import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Masthead } from "../../packages/ui/src/masthead.js";

function textOnly(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("Masthead", () => {
  it("renders a real space between title and accent", () => {
    const html = renderToString(
      createElement(Masthead, { eyebrow: "Good morning", title: "ONE", accent: "ON THE BOOKS" })
    );
    const text = textOnly(html);
    expect(text).toContain("ONE ON THE BOOKS");
    expect(text).not.toContain("ONEON");
  });
});
