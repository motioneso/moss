// Issue 2375: Moss replies in Workshop projects showed their formatting marks literally.
// The shared thread's default rows turn reply markdown into formatting; the marks must never
// print as characters on screen.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Thread } from "@moss/ui";
import { MarkdownMessage } from "../../apps/web/src/chat/markdown-message.js";

describe("numeric Moss replies", () => {
  for (const text of ["4.", "42.", "4)"]) {
    it(`keeps ${text} visible in Main`, () => {
      expect(renderToString(createElement(MarkdownMessage, { text }))).toContain(`<p>${text}</p>`);
    });

    it(`keeps ${text} visible in shared threads`, () => {
      expect(
        renderToString(createElement(Thread, { records: [{ kind: "reply", text }] }))
      ).toContain(`<p>${text}</p>`);
    });
  }

  it("preserves ordered lists and escaped untrusted content in both renderers", () => {
    for (const render of [
      (text: string) => renderToString(createElement(MarkdownMessage, { text })),
      (text: string) =>
        renderToString(createElement(Thread, { records: [{ kind: "reply", text }] }))
    ]) {
      expect(render("1. First\n2. Second")).toContain("<li>First</li>");
      expect(render("1. First\n2. Second")).toContain("<li>Second</li>");
      expect(render("4.5")).toContain("<p>4.5</p>");
      expect(render("  4. \n")).toContain("<p>4.</p>");
      expect(render("    4.")).toContain("<code>4.\n</code>");
      expect(render("<script>alert(1)</script>")).not.toContain("<script>");
      expect(render("[link](javascript:alert(1))")).not.toContain("javascript:");
    }
  });
});

describe("shared thread Moss replies (issue 2375)", () => {
  it("renders bold marks as bold text, not literal characters", () => {
    const html = renderToString(
      createElement(Thread, {
        records: [{ kind: "reply", text: "This is **important** news." }]
      })
    );
    expect(html).toContain("<strong>important</strong>");
    expect(html).not.toContain("**important**");
  });

  it("renders list marks as a list, not literal characters", () => {
    const html = renderToString(
      createElement(Thread, {
        records: [{ kind: "reply", text: "Two ideas:\n\n- First\n- Second" }]
      })
    );
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("<li>Second</li>");
  });

  it("keeps the shell's link guarantees in module threads", () => {
    const html = renderToString(
      createElement(Thread, {
        records: [
          {
            kind: "reply",
            text: "See [this](javascript:alert(1)) and [that](https://example.com)."
          }
        ]
      })
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
  });
});
