// Issue 2375: Moss replies in Workshop projects showed their formatting marks literally.
// The shared thread's default rows turn reply markdown into formatting; the marks must never
// print as characters on screen.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Thread } from "@moss/ui";

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
