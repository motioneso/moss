// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../../packages/ui/src/empty-state.js";

function render(children?: unknown, actions?: unknown) {
  return new DOMParser().parseFromString(
    renderToStaticMarkup(
      createElement(
        EmptyState,
        { title: "Nothing here", description: "Add one.", actions: actions as never },
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

  it("renders no slot for an empty array", () => {
    expect(render([]).querySelector(".jds-empty__actions")).toBeNull();
  });

  it("renders no slot when every child is false or null", () => {
    expect(render([false, null]).querySelector(".jds-empty__actions")).toBeNull();
  });

  it("renders actions alone in the slot", () => {
    const doc = render(undefined, createElement("button", null, "Add"));
    expect(doc.querySelectorAll(".jds-empty__actions button")).toHaveLength(1);
  });

  it("renders children alone in the slot", () => {
    const doc = render(createElement("button", null, "Retry"));
    expect(doc.querySelectorAll(".jds-empty__actions button")).toHaveLength(1);
  });

  it("renders actions then children in one slot", () => {
    const doc = render(
      createElement("button", null, "Second"),
      createElement("button", null, "First")
    );
    expect(doc.querySelectorAll(".jds-empty__actions")).toHaveLength(1);
    const texts = [...doc.querySelectorAll(".jds-empty__actions button")].map((b) => b.textContent);
    expect(texts).toEqual(["First", "Second"]);
    expect(doc.querySelector(".jds-empty")?.children).toHaveLength(3);
  });

  it("renders no slot when actions and children are both empty", () => {
    expect(render([false, null], false).querySelector(".jds-empty__actions")).toBeNull();
  });
});
