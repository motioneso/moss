import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Thread } from "../../apps/web/src/chat/message-row.js";
import type { TranscriptRecord } from "../../apps/web/src/chat/use-chat-stream.js";

function render(records: readonly TranscriptRecord[], working?: boolean): string {
  return renderToString(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Thread, { records, working })
    )
  );
}

describe("chat drawer: Thinking line (note 1)", () => {
  it("reads Thinking... as quiet text, not a pill, while the turn is running", () => {
    const html = render([{ kind: "thinking", text: "Checking the news" }], true);
    expect(html).toContain("Thinking...");
    expect(html).toContain("chatd-peek__summary--quiet");
    expect(html).not.toContain("Behind the scenes");
    // Still expands to the step list.
    expect(html).toContain("Checking the news");
  });

  it("stays in the thread after the reply lands", () => {
    const html = render(
      [
        { kind: "user", text: "News?" },
        { kind: "thinking", text: "Checking the news" },
        { kind: "tool", text: "news.headlines" },
        { kind: "reply", text: "Here are the headlines.", messageId: "m1" }
      ],
      false
    );
    expect(html).toContain("Thinking");
    expect(html).not.toContain("Thinking...");
    expect(html).toContain("2 steps");
    expect(html).toContain("Checking the news");
    expect(html.indexOf("Thinking")).toBeLessThan(html.indexOf("Here are the headlines."));
  });

  it("treats a trailing step group as finished when the drawer says nothing is running", () => {
    const html = render([{ kind: "thinking", text: "Checking" }], false);
    expect(html).not.toContain("Thinking...");
    expect(html).toContain("1 step");
  });
});

describe("chat drawer: status lines in the thread (note 2)", () => {
  it("renders status items inline and keeps thinking/tool items in the steps list", () => {
    const html = render(
      [
        { kind: "status", text: "I'll get today's top headlines for you." },
        { kind: "thinking", text: "Choosing a source" },
        { kind: "tool", text: "news.headlines" },
        { kind: "reply", text: "Done.", messageId: "m1" }
      ],
      false
    );
    const status = html.indexOf("I&#x27;ll get today&#x27;s top headlines for you.");
    expect(status).toBeGreaterThan(-1);
    expect(html).toContain('class="chatd-status"');
    // The status line sits before the collapsed steps and the steps count excludes it.
    expect(status).toBeLessThan(html.indexOf("chatd-peek--quiet"));
    expect(html).toContain("2 steps");
    expect(html.indexOf("Choosing a source")).toBeGreaterThan(html.indexOf("chatd-peek__body"));
  });
});

describe("chat drawer: feedback menu on the assistant message (note 3)", () => {
  it("renders the menu pinned to the assistant message corner", () => {
    const html = render([{ kind: "reply", text: "Here you go.", messageId: "m1" }], false);
    expect(html).toContain("feedback-menu feedback-menu--corner");
    // The item list ("More like this" / "Not useful") is a Menu primitive popover that only
    // renders once opened by a click, so a static server render only shows its trigger button.
    expect(html).toContain('aria-label="Feedback"');
  });

  it("hides the corner menu until hover/focus and always shows it without a hover device", () => {
    const css = readFileSync("apps/web/src/styles/kit-chat.css", "utf8");
    expect(css).toMatch(/\.feedback-menu--corner\s*\{[^}]*position: absolute/);
    expect(css).toMatch(/\.feedback-menu--corner\s*\{[^}]*opacity: 0/);
    expect(css).toContain(".chatd-msg:hover .feedback-menu--corner");
    expect(css).toContain(".chatd-msg:focus-within .feedback-menu--corner");
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.feedback-menu--corner\s*\{\s*opacity: 1/);
  });
});
