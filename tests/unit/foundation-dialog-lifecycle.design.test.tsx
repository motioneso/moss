// @vitest-environment jsdom
import { act, StrictMode, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../../packages/ui/src/dialog.js";
import { PeekPanel } from "../../packages/ui/src/peek-panel.js";
import { Menu } from "../../packages/ui/src/menu.js";
import { ColorPopover } from "../../packages/ui/src/color-box.js";
import { useDialogLifecycle } from "../../packages/ui/src/use-dialog-lifecycle.js";
import { Button } from "../../packages/ui/src/button.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const key = (target: Element, value: string, shiftKey = false) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })
    );
  });
const click = (target: HTMLElement) => act(() => target.click());
function mount(children: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(children));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.replaceChildren();
  document.body.style.overflow = "";
  root = undefined;
});

describe("shared modal lifecycle", () => {
  it("names/describes the dialog, chooses a safe surface and wraps keyboard focus", () => {
    mount(
      <Dialog title="Delete project?" description="This cannot be undone." onClose={vi.fn()}>
        <button disabled>Unavailable</button>
        <button>Keep it</button>
        <button>Delete</button>
      </Dialog>
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Delete project?"
    );
    expect(document.getElementById(panel.getAttribute("aria-describedby")!)?.textContent).toBe(
      "This cannot be undone."
    );
    expect(document.activeElement).toBe(panel);
    const buttons = panel.querySelectorAll("button");
    key(panel, "Tab");
    expect(document.activeElement).toBe(buttons[1]);
    key(buttons[1]!, "Tab", true);
    expect(document.activeElement).toBe(buttons[2]);
    key(buttons[2]!, "Tab");
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("keeps an all-disabled dialog focusable and owns Escape while pending", () => {
    const close = vi.fn();
    mount(
      <Dialog title="Saving" onClose={close} dismissOnEscape={false} dismissOnBackdrop={false}>
        <button disabled>Saving</button>
      </Dialog>
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    key(panel, "Tab");
    expect(document.activeElement).toBe(panel);
    key(panel, "Escape");
    click(document.querySelector<HTMLElement>(".jds-dialog-scrim")!);
    expect(close).not.toHaveBeenCalled();
  });

  it("uses the caller's safe Button ref and restores the opener over repeated opens", async () => {
    function Example() {
      const [open, setOpen] = useState(false);
      const cancel = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open ? (
            <Dialog title="Confirm" onClose={() => setOpen(false)} initialFocusRef={cancel}>
              <Button variant="danger">Delete</Button>
              <Button ref={cancel}>Keep it</Button>
            </Dialog>
          ) : null}
        </>
      );
    }
    document.body.style.overflow = "auto";
    mount(
      <StrictMode>
        <Example />
      </StrictMode>
    );
    const opener = document.querySelector("button")!;
    for (let i = 0; i < 3; i++) {
      opener.focus();
      click(opener);
      expect(document.activeElement?.textContent).toBe("Keep it");
      expect(document.body.style.overflow).toBe("hidden");
      await act(async () => key(document.activeElement!, "Escape"));
      expect(document.activeElement).toBe(opener);
      expect(document.body.style.overflow).toBe("auto");
    }
  });

  it("dismisses only a nested menu on the first Escape", () => {
    const close = vi.fn();
    mount(
      <Dialog title="Details" onClose={close}>
        <Menu
          triggerLabel="Actions"
          triggerIcon="..."
          items={[{ id: "one", label: "One" }]}
          onSelect={vi.fn()}
        />
      </Dialog>
    );
    click(document.querySelector<HTMLElement>('[aria-label="Actions"]')!);
    key(document.querySelector('[role="menuitem"]')!, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    key(document.activeElement!, "Escape");
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps nested dialogs independent and does not let restoration steal replacement focus", async () => {
    function Example() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog title="Outer" onClose={vi.fn()}>
          <button onClick={() => setInner(true)}>Open inner</button>
          {inner ? (
            <Dialog title="Inner" onClose={() => setInner(false)}>
              <button>Inner control</button>
            </Dialog>
          ) : null}
        </Dialog>
      );
    }
    mount(<Example />);
    const opener = document.querySelector("button")!;
    opener.focus();
    click(opener);
    expect(document.activeElement).toBe(document.querySelectorAll('[role="dialog"]')[1]);
    await act(async () => key(document.activeElement!, "Escape"));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("preserves native form ancestry and ignores inside clicks for scrim dismissal", () => {
    const submitted = vi.fn();
    const close = vi.fn();
    mount(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted();
        }}
      >
        <Dialog title="Save" onClose={close} footer={<Button type="submit">Save</Button>}>
          <input aria-label="Name" />
        </Dialog>
      </form>
    );
    click(document.querySelector("button")!);
    expect(submitted).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    click(document.querySelector<HTMLElement>(".jds-dialog-scrim")!);
    expect(close).toHaveBeenCalledOnce();
  });

  it("redirects escaped focus and safely tolerates a removed opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    mount(
      <Dialog title="Details" onClose={vi.fn()}>
        <button>Inside</button>
      </Dialog>
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    opener.remove();
    await act(async () => root?.render(null));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves nonmodal Peek focus alone, and owns the scrim only in modal mode", () => {
    mount(
      <PeekPanel aria-label="Event details">
        <button>Details</button>
      </PeekPanel>
    );
    expect(document.querySelector(".cal-peek-scrim")).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(document.body);
    const close = vi.fn();
    act(() =>
      root?.render(
        <PeekPanel modal onClose={close} aria-label="Event details">
          <button>Close</button>
        </PeekPanel>
      )
    );
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    key(document.activeElement!, "Escape");
    expect(close).toHaveBeenCalledOnce();
    click(document.querySelector<HTMLElement>(".cal-peek-scrim")!);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("lets a nested nonmodal color popover own Escape without closing its parent", () => {
    const close = vi.fn();
    const popClose = vi.fn();
    mount(
      <Dialog title="Appearance" onClose={close}>
        <ColorPopover
          title="Accent"
          value="#294b39"
          palette={[]}
          onPick={vi.fn()}
          onInput={vi.fn()}
          onClose={popClose}
        />
      </Dialog>
    );
    const popover = document.querySelector<HTMLElement>('[aria-label="Accent color"]')!;
    popover.focus();
    key(popover, "Escape");
    expect(popClose).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
  it("isolates siblings without hiding inline form ancestors and restores prior attributes", async () => {
    const outside = document.createElement("section");
    outside.setAttribute("aria-hidden", "false");
    const alreadyHidden = document.createElement("section");
    alreadyHidden.setAttribute("inert", "original");
    alreadyHidden.setAttribute("aria-hidden", "true");
    document.body.append(outside, alreadyHidden);
    mount(
      <form>
        <button>Background form action</button>
        <Dialog title="Inline" onClose={vi.fn()}>
          <button>Inside</button>
        </Dialog>
      </form>
    );
    expect(outside.hasAttribute("inert")).toBe(true);
    expect(outside.getAttribute("aria-hidden")).toBe("true");
    expect(host?.querySelector("form")?.hasAttribute("inert")).toBe(false);
    expect(host?.querySelector("form > button")?.hasAttribute("inert")).toBe(true);
    const inserted = document.createElement("button");
    await act(async () => document.body.append(inserted));
    expect(inserted.hasAttribute("inert")).toBe(true);
    await act(async () => root?.render(null));
    expect(outside.hasAttribute("inert")).toBe(false);
    expect(outside.getAttribute("aria-hidden")).toBe("false");
    expect(alreadyHidden.getAttribute("inert")).toBe("original");
    expect(alreadyHidden.getAttribute("aria-hidden")).toBe("true");
    expect(inserted.hasAttribute("inert")).toBe(false);
  });

  it("exempts only an aria-hidden noninteractive backdrop and cleans up nested unmounts", async () => {
    const close = vi.fn();
    function Navigation() {
      const ref = useRef<HTMLElement>(null);
      const backdrop = useRef<HTMLDivElement>(null);
      const onKeyDown = useDialogLifecycle({ ref, backdropRef: backdrop, onClose: close });
      return (
        <>
          <div ref={backdrop} aria-hidden="true" onClick={close} data-backdrop="true" />
          <aside
            ref={ref}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            <button>Link</button>
            <Dialog title="Nested" onClose={vi.fn()}>
              <button>Child</button>
            </Dialog>
          </aside>
        </>
      );
    }
    mount(
      <StrictMode>
        <Navigation />
      </StrictMode>
    );
    const backdrop = host!.querySelector<HTMLElement>("[data-backdrop]")!;
    // The outer scrim is background while its nested dialog is topmost.
    expect(backdrop.hasAttribute("inert")).toBe(true);
    await act(async () =>
      root?.render(
        <PeekPanel modal onClose={close} aria-label="Event">
          <button>Event</button>
        </PeekPanel>
      )
    );
    const peekBackdrop = host!.querySelector<HTMLElement>(".cal-peek-scrim")!;
    expect(peekBackdrop.hasAttribute("inert")).toBe(false);
    click(peekBackdrop);
    expect(close).toHaveBeenCalledOnce();
    await act(async () => root?.render(null));
    expect(document.body.querySelector("[inert]")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
  it("offers an explicitly named close control and respects its pending state", () => {
    const close = vi.fn();
    mount(
      <Dialog title="Check in" onClose={close} closeLabel="Close check-in" closeDisabled>
        <p>Details</p>
      </Dialog>
    );
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Close check-in"]')!;
    expect(button.disabled).toBe(true);
    click(button);
    expect(close).not.toHaveBeenCalled();
    act(() =>
      root?.render(
        <Dialog title="Check in" onClose={close} closeLabel="Close check-in">
          <p>Details</p>
        </Dialog>
      )
    );
    click(button);
    expect(close).toHaveBeenCalledOnce();
  });
  it("shares isolation and scroll ownership across independently bundled UI copies", async () => {
    vi.resetModules();
    const { useDialogLifecycle: independentLifecycle } =
      await import("../../packages/ui/src/use-dialog-lifecycle.js");
    expect(independentLifecycle).not.toBe(useDialogLifecycle);
    function ModuleDialog() {
      const ref = useRef<HTMLDivElement>(null);
      const onKeyDown = independentLifecycle({ ref });
      return (
        <div
          ref={ref}
          tabIndex={-1}
          role="dialog"
          aria-label="Module child"
          aria-modal="true"
          onKeyDown={onKeyDown}
        >
          <button>Module action</button>
        </div>
      );
    }
    mount(
      <Dialog title="Host dialog" onClose={vi.fn()}>
        <button>Host action</button>
        <ModuleDialog />
      </Dialog>
    );
    const child = document.querySelector<HTMLElement>('[aria-label="Module child"]')!;
    expect(document.activeElement).toBe(child);
    expect(child.closest("[inert]")).toBeNull();
    expect(host!.querySelector(".jds-dialog__head")?.hasAttribute("inert")).toBe(true);
    await act(async () => root?.render(null));
    expect(document.body.style.overflow).toBe("");
    expect(document.body.querySelector("[inert]")).toBeNull();
  });
  it("refreshes the opener when a persistent nested surface is enabled repeatedly", async () => {
    function Inner({ open, onClose }: { open: boolean; onClose: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      const onKeyDown = useDialogLifecycle({ ref, enabled: open, onClose });
      return open ? (
        <div
          ref={ref}
          role="dialog"
          aria-label="Persistent inner"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <button onClick={onClose}>Close inner</button>
        </div>
      ) : null;
    }
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <Dialog title="Outer" onClose={vi.fn()}>
          <button onClick={() => setOpen(true)}>Open persistent inner</button>
          <Inner open={open} onClose={() => setOpen(false)} />
        </Dialog>
      );
    }
    mount(<Example />);
    const opener = host!.querySelector<HTMLButtonElement>("button")!;
    for (let i = 0; i < 3; i++) {
      opener.focus();
      click(opener);
      const inner = host!.querySelector<HTMLElement>('[aria-label="Persistent inner"]')!;
      expect(document.activeElement).toBe(inner);
      await act(async () => click(inner.querySelector("button")!));
      expect(document.activeElement).toBe(opener);
    }
  });

  it("removes a previous modal's native-inert barrier before focusing a sibling surface", async () => {
    const nativeFocus = HTMLElement.prototype.focus;
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement
    ) {
      // jsdom does not implement inert. Model the browser's refusal to focus an inert subtree.
      if (!this.closest("[inert]")) nativeFocus.call(this);
    });
    try {
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <Dialog title="Sibling A" onClose={vi.fn()}>
              <button onClick={() => setOpen(true)}>Open sibling B</button>
            </Dialog>
            <div data-sibling-host="true">
              {open ? (
                <Dialog title="Sibling B" onClose={() => setOpen(false)}>
                  <button onClick={() => setOpen(false)}>Close sibling B</button>
                </Dialog>
              ) : null}
            </div>
          </>
        );
      }
      mount(<Example />);
      const opener = host!.querySelector<HTMLButtonElement>("button")!;
      expect(host!.querySelector("[data-sibling-host]")?.hasAttribute("inert")).toBe(true);
      for (let i = 0; i < 2; i++) {
        opener.focus();
        click(opener);
        const sibling = host!.querySelectorAll<HTMLElement>('[role="dialog"]')[1]!;
        expect(document.activeElement).toBe(sibling);
        expect(sibling.closest("[inert]")).toBeNull();
        await act(async () => click(sibling.querySelector("button")!));
        expect(document.activeElement).toBe(opener);
      }
    } finally {
      focus.mockRestore();
    }
  });
});
