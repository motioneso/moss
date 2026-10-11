// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSearch } from "../../apps/web/src/settings/settings-search.js";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const items = [
  { id: "first", label: "Alpha", description: "common", group: "Personal", keywords: [] },
  { id: "second", label: "Bravo", description: "common", group: "Personal", keywords: [] }
];
function key(input: HTMLElement, value: string) {
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
    )
  );
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
});
describe("audit settings active option", () => {
  it("associates keyboard selection with the focused input and clears closed selection", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const select = vi.fn();
    act(() => root?.render(<SettingsSearch items={items} onSelect={select} />));
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "common"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(2);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options[0]!.id).not.toBe("");
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(document.activeElement).toBe(input);
    key(input, "Enter");
    expect(select).toHaveBeenCalledWith("second");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });
  it("has no dangling active descendant with no matches", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(<SettingsSearch items={[]} onSelect={vi.fn()} />));
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "none"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });
});
