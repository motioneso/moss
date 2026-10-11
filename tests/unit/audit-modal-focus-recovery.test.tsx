// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../../packages/ui/src/dialog.js";
import { PeekPanel } from "../../packages/ui/src/peek-panel.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
function mount(children: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(children));
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.replaceChildren();
  root = undefined;
});

describe("audit shared modal active-control recovery", () => {
  it.each(["disabled", "removed"])(
    "retains focus and Escape after a focused control is %s",
    async (kind) => {
      const closed = vi.fn();
      function Example() {
        const [open, setOpen] = useState(false);
        const [posted, setPosted] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>Open</button>
            {open ? (
              <Dialog
                title="Task comments"
                onClose={() => {
                  closed();
                  setOpen(false);
                }}
              >
                {kind === "removed" && posted ? (
                  <p>Posted</p>
                ) : (
                  <button disabled={posted} onClick={() => setPosted(true)}>
                    Post
                  </button>
                )}
              </Dialog>
            ) : null}
          </>
        );
      }
      mount(<Example />);
      const opener = document.querySelector<HTMLButtonElement>("button")!;
      act(() => {
        opener.focus();
        opener.click();
      });
      const post = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
      act(() => {
        post.focus();
        post.click();
      });
      await settle();
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(document.activeElement).toBe(panel);
      act(() =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        )
      );
      await settle();
      expect(closed).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(opener);
    }
  );

  it("keeps intentional connected focus while another control is removed", async () => {
    function Example() {
      const [removed, setRemoved] = useState(false);
      return (
        <Dialog title="Editing" onClose={vi.fn()}>
          {removed ? null : <button onClick={() => setRemoved(true)}>Remove row</button>}
          <input aria-label="Comment" />
        </Dialog>
      );
    }
    mount(<Example />);
    const remove = document.querySelector<HTMLButtonElement>("button")!;
    const input = document.querySelector<HTMLInputElement>("input")!;
    act(() => {
      remove.click();
      input.focus();
    });
    await settle();
    expect(document.activeElement).toBe(input);
  });

  it("does not reclaim focus from a nonmodal Peek after content changes", async () => {
    function Example() {
      const [removed, setRemoved] = useState(false);
      return (
        <>
          <button>Outside</button>
          <PeekPanel aria-label="Peek" onClose={vi.fn()}>
            {removed ? null : <button onClick={() => setRemoved(true)}>Remove</button>}
          </PeekPanel>
        </>
      );
    }
    mount(<Example />);
    const buttons = document.querySelectorAll<HTMLButtonElement>("button");
    act(() => {
      buttons[1]!.click();
      buttons[0]!.focus();
    });
    await settle();
    expect(document.activeElement).toBe(buttons[0]);
  });
});
