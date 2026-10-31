// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "../../packages/ui/src/empty-state.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: Parameters<Root["render"]>[0]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("EmptyState", () => {
  it("puts actions in their own row after the text", () => {
    mount(
      <EmptyState
        title="No bills yet"
        description="Nothing planned"
        actions={<button>Add</button>}
      />
    );
    const empty = document.querySelector(".jds-empty")!;
    expect([...empty.children].map((child) => child.className)).toEqual([
      "jds-empty__title",
      "jds-empty__sub",
      "jds-empty__actions"
    ]);
    expect(empty.querySelector(".jds-empty__actions button")?.textContent).toBe("Add");
  });

  it("renders no actions row without actions", () => {
    mount(<EmptyState title="Nothing yet" />);
    expect(document.querySelector(".jds-empty__actions")).toBeNull();
  });
});
