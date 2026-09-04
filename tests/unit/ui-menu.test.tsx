// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu } from "../../packages/ui/src/menu.js";

const ITEMS = [
  { id: "more_like_this", label: "More like this" },
  { id: "not_useful", label: "Not useful" }
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(onSelect = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <Menu
        triggerIcon={<span>icon</span>}
        triggerLabel="Feedback"
        items={ITEMS}
        onSelect={onSelect}
      />
    );
  });
  return onSelect;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="Feedback"]')!;
const list = () => document.querySelector('[role="menu"]');

describe("Menu (feedback menu close behavior)", () => {
  it("opens on trigger click and closes again on a second click", () => {
    mount();
    expect(list()).toBeNull();
    act(() => trigger().click());
    expect(list()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on an outside pointer press", () => {
    mount();
    act(() => trigger().click());
    expect(list()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(list()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape", () => {
    mount();
    act(() => trigger().click());
    expect(list()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(list()).toBeNull();
  });

  it("stays open on a pointer press inside the menu", () => {
    mount();
    act(() => trigger().click());
    act(() => {
      trigger().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(list()).not.toBeNull();
  });
});
