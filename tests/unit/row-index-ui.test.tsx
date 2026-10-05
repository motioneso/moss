import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RowIndex, RowIndexItem } from "../../packages/ui/src/row-index.js";

describe("RowIndex", () => {
  it("renders title, excerpt and meta in that order", () => {
    const html = renderToString(
      createElement(
        RowIndex,
        null,
        createElement(RowIndexItem, {
          title: "First project",
          excerpt: "An opening request",
          meta: "Sep 6"
        })
      )
    );
    const titleIndex = html.indexOf("First project");
    const excerptIndex = html.indexOf("An opening request");
    const metaIndex = html.indexOf("Sep 6");
    expect(titleIndex).toBeGreaterThan(-1);
    expect(excerptIndex).toBeGreaterThan(titleIndex);
    expect(metaIndex).toBeGreaterThan(excerptIndex);
  });
  it.each([
    [{}, 'class="jds-index"'],
    [{ variant: "facts" }, 'class="jds-index jds-index--facts"'],
    [{ density: "compact" }, 'class="jds-index jds-index--compact"'],
    [
      { variant: "facts", density: "compact" },
      'class="jds-index jds-index--facts jds-index--compact"'
    ]
  ] as const)("preserves variant and density options: %j", (options, expectedClass) => {
    const html = renderToString(createElement(RowIndex, { ...options, children: "Row" }));
    expect(html).toContain(expectedClass);
  });
});
