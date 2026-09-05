// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { InfoTip } from "../../packages/ui/src/info-tip.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(<InfoTip label="How a folder becomes available">Explanation text.</InfoTip>)
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const trigger = () => document.querySelector<HTMLButtonElement>("[aria-label]")!;
const panel = () => document.querySelector('[role="tooltip"]');
const pointerDown = (target: EventTarget) =>
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });

describe("InfoTip", () => {
  it("starts closed and opens the explanation on click", () => {
    mount();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    act(() => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.textContent).toBe("Explanation text.");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    mount();
    act(() => trigger().click());
    act(() => {
      trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside click", () => {
    mount();
    act(() => trigger().click());
    expect(panel()).not.toBeNull();
    pointerDown(document.body);
    expect(panel()).toBeNull();
  });
});
