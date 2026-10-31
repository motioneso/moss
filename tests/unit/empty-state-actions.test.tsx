// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../../packages/ui/src/empty-state.js";

function render(children?: unknown) {
  return new DOMParser().parseFromString(
    renderToStaticMarkup(
      createElement(
        EmptyState,
        { title: "Nothing here", description: "Add one." },
        children as never
      )
    ),
    "text/html"
  );
}

describe("EmptyState action slot", () => {
  it("renders children inside one action slot", () => {
    const doc = render(createElement("button", null, "Try again"));
    const slots = doc.querySelectorAll(".jds-empty > .jds-empty__actions");
    expect(slots).toHaveLength(1);
    expect(slots[0]?.querySelector("button")?.textContent).toBe("Try again");
  });

  it("renders no slot without children", () => {
    expect(render().querySelector(".jds-empty__actions")).toBeNull();
  });
});
