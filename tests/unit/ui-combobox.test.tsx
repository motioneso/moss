// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Combobox } from "../../packages/ui/src/combobox.js";

const OPTIONS = [
  {
    value: "America/Los_Angeles",
    label: "(UTC-08:00) America/Los_Angeles",
    keywords: "los angeles"
  },
  { value: "Europe/London", label: "(UTC+00:00) Europe/London", keywords: "london" },
  { value: "Asia/Tokyo", label: "(UTC+09:00) Asia/Tokyo", keywords: "tokyo" }
];

function Harness() {
  const [value, setValue] = useState("Europe/London");
  return (
    <>
      <output data-testid="value">{value}</output>
      <Combobox aria-label="Time zone" value={value} options={OPTIONS} onChange={setValue} />
    </>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Harness />));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const trigger = () => document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
const search = () => document.querySelector<HTMLInputElement>('[role="searchbox"]')!;
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

describe("Combobox", () => {
  it("shows the selected label closed and lists every option when opened", () => {
    mount();
    expect(trigger().textContent).toContain("Europe/London");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    act(() => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false"
    ]);
    expect(document.activeElement).toBe(search());
  });

  it("filters by label or keywords and picks with the mouse", () => {
    mount();
    act(() => trigger().click());
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search(), "tok");
      search().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options().map((o) => o.textContent)).toEqual(["(UTC+09:00) Asia/Tokyo"]);
    act(() => options()[0]!.click());
    expect(document.querySelector('[data-testid="value"]')!.textContent).toBe("Asia/Tokyo");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("moves with arrow keys, picks with Enter, and closes on Escape", () => {
    mount();
    act(() => trigger().click());
    expect(options()[1]!.className).toContain("--active");
    key(search(), "ArrowDown");
    expect(options()[2]!.className).toContain("--active");
    key(search(), "Enter");
    expect(document.querySelector('[data-testid="value"]')!.textContent).toBe("Asia/Tokyo");
    act(() => trigger().click());
    key(search(), "Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[data-testid="value"]')!.textContent).toBe("Asia/Tokyo");
  });

  it("recovers keyboard selection after a search finds no matches and then does", () => {
    mount();
    act(() => trigger().click());
    const setQuery = (text: string) => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(search(), text);
        search().dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    setQuery("zzz-no-such-place");
    expect(options()).toHaveLength(0);
    key(search(), "ArrowDown");
    setQuery("tok");
    expect(options().map((o) => o.textContent)).toEqual(["(UTC+09:00) Asia/Tokyo"]);
    key(search(), "Enter");
    expect(document.querySelector('[data-testid="value"]')!.textContent).toBe("Asia/Tokyo");
  });

  it("closes on an outside pointer press without changing the value", () => {
    mount();
    act(() => trigger().click());
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[data-testid="value"]')!.textContent).toBe("Europe/London");
  });
});
