import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #2253: both finished-game score rows had two layout faults that only show up in a real
// browser at phone width, so they are pinned here against the stylesheet itself.
const css = readFileSync("packages/sports/src/web/styles/sports-4-grid.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  return match?.groups?.body ?? "";
}

describe("finished-game score row layout", () => {
  it("keeps the logos and score centred when a game has no scorer names", () => {
    // With no scorer lists there are no side spacers left to balance the row, so without this
    // the whole group slid to the left edge of the card.
    expect(rule(".sp-tk__result")).toContain("justify-content: center");
    expect(rule(".sp-feat__result")).toContain("justify-content: center");
  });

  it("wraps a long scorer name instead of trimming it to dots", () => {
    // Round 2 of #2253: the columns either side of the logos are only about seventy pixels wide
    // on the Sports page, and one-line-plus-dots cut even the short target line to "Isa…". Names
    // wrap now; the last-resort break keeps one long word from shoving the logos off centre.
    for (const selector of [
      ".sp-tk__scorers--home",
      ".sp-tk__scorers--away",
      ".sp-feat__scorers--home",
      ".sp-feat__scorers--away"
    ]) {
      expect(rule(selector)).toContain("align-items: stretch");
      expect(rule(selector)).not.toContain("align-items: flex-");
    }
    for (const selector of [".sp-tk__scorers li", ".sp-feat__scorers li"]) {
      expect(rule(selector)).toContain("min-width: 0");
      expect(rule(selector)).toContain("max-width: 100%");
    }
    for (const selector of [".sp-tk__scorers li > span", ".sp-feat__scorers li > span"]) {
      expect(rule(selector)).toContain("white-space: normal");
      expect(rule(selector)).toContain("overflow-wrap: break-word");
      expect(rule(selector)).not.toContain("text-overflow: ellipsis");
    }
  });
});
