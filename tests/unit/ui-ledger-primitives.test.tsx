// @vitest-environment jsdom
//
// The quiet select, the selection bar and the button-style menu trigger.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu } from "../../packages/ui/src/menu.js";
import { Select } from "../../packages/ui/src/select.js";
import { SelectionBar } from "../../packages/ui/src/selection-bar.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Select quiet", () => {
  it("adds the quiet hooks to the wrapper and the field only when asked", () => {
    const el = mount(
      <>
        <Select aria-label="Plain" defaultValue="a">
          <option value="a">A</option>
        </Select>
        <Select quiet aria-label="Quiet" defaultValue="a">
          <option value="a">A</option>
        </Select>
      </>
    );
    const plain = el.querySelector<HTMLSelectElement>('[aria-label="Plain"]')!;
    const quiet = el.querySelector<HTMLSelectElement>('[aria-label="Quiet"]')!;
    expect(plain.className).toBe("jds-select");
    expect(plain.parentElement!.className).toBe("jds-selectwrap");
    expect(quiet.className).toBe("jds-select jds-select--quiet");
    expect(quiet.parentElement!.className).toBe("jds-selectwrap jds-selectwrap--quiet");
    expect(quiet.hasAttribute("quiet")).toBe(false);
  });
});

describe("SelectionBar", () => {
  it("renders a labelled region around its actions", () => {
    const el = mount(
      <SelectionBar aria-label="Selected rows">
        <button type="button">Clear selection</button>
      </SelectionBar>
    );
    const bar = el.querySelector("section.jds-selbar")!;
    expect(bar.getAttribute("aria-label")).toBe("Selected rows");
    expect(bar.textContent).toBe("Clear selection");
  });
});

describe("Menu button trigger", () => {
  it("draws a secondary button with visible text and opens the items", () => {
    const onSelect = vi.fn();
    const el = mount(
      <Menu
        triggerVariant="button"
        triggerContent="Export"
        triggerLabel="Export rows"
        items={[{ id: "csv", label: "Loaded rows" }]}
        onSelect={onSelect}
      />
    );
    const trigger = el.querySelector<HTMLButtonElement>('[aria-label="Export rows"]')!;
    expect(trigger.className).toBe("jds-btn jds-btn--secondary");
    expect(trigger.textContent).toBe("Export");
    expect(trigger.querySelector("svg")).not.toBeNull();
    act(() => trigger.click());
    expect(trigger.className).toBe("jds-btn jds-btn--secondary jds-btn--active");
    const item = el.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => item.click());
    expect(onSelect).toHaveBeenCalledWith("csv");
  });
});
