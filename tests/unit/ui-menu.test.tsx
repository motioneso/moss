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
    act(() => trigger().click());
    expect(list()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
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

  it("closes on Escape and returns focus to the trigger", () => {
    mount();
    act(() => trigger().click());
    expect(list()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("does not swallow an outside click meant for another control", () => {
    const outsideClick = vi.fn();
    const outsideButton = document.createElement("button");
    outsideButton.addEventListener("click", outsideClick);
    document.body.appendChild(outsideButton);

    mount();
    act(() => trigger().click());
    expect(list()).not.toBeNull();
    act(() => {
      outsideButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      outsideButton.click();
    });
    expect(list()).toBeNull();
    expect(outsideClick).toHaveBeenCalledOnce();

    outsideButton.remove();
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

describe("Menu keyboard model", () => {
  const key = (target: Element, value: string) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
      );
    });
  it("focuses an item on open, wraps arrows and supports Home/End", () => {
    mount();
    act(() => trigger().click());
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-controls")).toBe(list()?.id);
    key(items[0]!, "ArrowUp");
    expect(document.activeElement).toBe(items[1]);
    key(items[1]!, "Home");
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, "End");
    expect(document.activeElement).toBe(items[1]);
    key(items[1]!, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);
  });
  it("opens at the end with ArrowUp and releases Tab from the menu", () => {
    mount();
    trigger().focus();
    key(trigger(), "ArrowUp");
    expect(document.activeElement?.textContent).toBe("Not useful");
    key(document.activeElement!, "Tab");
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
  it("skips disabled items and supports a named content trigger above its anchor", () => {
    mount();
    act(() =>
      root?.render(
        <Menu
          triggerLabel="Account"
          triggerContent={<span>Owner</span>}
          triggerVariant="content"
          placement="top"
          items={[
            { id: "disabled", label: "Unavailable", disabled: true },
            { id: "enabled", label: "Settings" }
          ]}
          onSelect={vi.fn()}
        />
      )
    );
    const account = document.querySelector<HTMLButtonElement>('[aria-label="Account"]')!;
    act(() => account.click());
    expect(document.activeElement?.textContent).toBe("Settings");
    expect(list()?.classList.contains("jds-menu__list--top")).toBe(true);
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Settings");
  });
});
