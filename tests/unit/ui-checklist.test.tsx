// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checklist } from "@moss/ui";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const ITEMS = [
  { id: "claude", label: "Claude Sonnet 4.6", count: 48, checked: true },
  { id: "embed", label: "nomic-embed-text", count: 9, checked: false },
  { id: "no-model", label: "No model (tool only)", count: 15, checked: true }
];

function mountChecklist(overrides: Partial<React.ComponentProps<typeof Checklist>> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onTickAll: vi.fn(),
    onDone: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
  mount(
    <Checklist
      items={ITEMS}
      ariaLabel="Models to show"
      onToggle={handlers.onToggle}
      onTickAll={handlers.onTickAll}
      onDone={handlers.onDone}
      onClose={handlers.onClose}
    />
  );
  return handlers;
}

describe("Checklist primitive (#2956 slice D)", () => {
  it("lists every model with its count and tick state", () => {
    mountChecklist();

    expect(host?.textContent).toContain("Claude Sonnet 4.6");
    expect(host?.textContent).toContain("48");
    expect(host?.textContent).toContain("No model (tool only)");
    const boxes = host?.querySelectorAll('input[type="checkbox"]') ?? [];
    expect(boxes).toHaveLength(3);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("reports a tick to the caller and keeps the list open", () => {
    const handlers = mountChecklist();

    const boxes = host?.querySelectorAll('input[type="checkbox"]') ?? [];
    act(() => {
      (boxes[1] as HTMLInputElement).click();
    });
    expect(handlers.onToggle).toHaveBeenCalledWith("embed");
    expect(host?.querySelector(".jds-checklist")).not.toBeNull();
  });

  it("ticks all and finishes from the foot buttons", () => {
    const handlers = mountChecklist();

    act(() => {
      host
        ?.querySelectorAll(".jds-checklist__foot button")[0]
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onTickAll).toHaveBeenCalledTimes(1);
    act(() => {
      host
        ?.querySelectorAll(".jds-checklist__foot button")[1]
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const handlers = mountChecklist();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
