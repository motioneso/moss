// @vitest-environment jsdom
// #1438: the pure builder tests in page-context.test.ts cannot catch a CAPTURE_SELECTOR that
// fails to match real markup — that was the actual bug (calendar event cards are plain <div>s).
// These exercise the DOM adapter against markup shaped like today-page.tsx's event cards.
import { describe, expect, it, vi } from "vitest";

// page-context imports app-route-metadata, which reaches the shared virtual module fixture. Keep
// this focused test isolated from unrelated module-web alias coverage (notably sports).
vi.mock("../../apps/web/src/app-route-metadata.js", () => ({
  resolvePageHeading: () => ({ title: "Today" })
}));

import { capturePageContextSnapshot } from "../../apps/web/src/chat/page-context.js";

function eventCard(declared: string | null): string {
  const attribute = declared === null ? "" : ` data-jarvis-capture-text="${declared}"`;
  return `
    <div class="day-ev"${attribute}>
      <div class="day-ev__t">9:00<span class="ap"> am</span></div>
      <div>
        <div class="day-ev__title">Standup</div>
        <div class="day-ev__where">Zoom</div>
      </div>
      <div class="day-ev__who">30m</div>
    </div>`;
}

describe("capturePageContextSnapshot declared-text channel (#1438)", () => {
  it("captures an event card that matches no structural tag", () => {
    document.body.innerHTML = eventCard("Tomorrow: 9:00 am — Standup — Zoom — 30m");
    expect(capturePageContextSnapshot().visibleText).toContain(
      "Tomorrow: 9:00 am — Standup — Zoom — 30m"
    );
  });

  it("leaves an un-opted-in event card invisible, as before the fix", () => {
    document.body.innerHTML = eventCard(null);
    const snapshot = capturePageContextSnapshot();
    expect(snapshot.visibleText).toEqual([]);
    expect(snapshot.buttons).toEqual([]);
  });

  it("keeps declared text when scraped prose would otherwise fill the bucket", () => {
    const prose = Array.from({ length: 40 }, (_, i) => `<p>paragraph ${i}</p>`).join("");
    document.body.innerHTML = prose + eventCard("Tomorrow: 9:00 am — Standup");
    const snapshot = capturePageContextSnapshot();
    expect(snapshot.visibleText[0]).toBe("Tomorrow: 9:00 am — Standup");
  });

  it("still honours the data-jarvis-no-capture opt-out on a declared element", () => {
    document.body.innerHTML = `<div data-jarvis-no-capture>${eventCard("Tomorrow: 9:00 am — Standup")}</div>`;
    expect(capturePageContextSnapshot().visibleText).toEqual([]);
  });
});
