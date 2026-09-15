// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BriefingDialog } from "../../apps/web/src/today/briefing-dialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

async function openDialog(
  opener: HTMLElement | null = null,
  onClose: () => void = () => undefined
) {
  const { container, root } = mount();
  await act(async () => {
    root.render(
      <BriefingDialog
        title="Morning briefing"
        opener={opener}
        onClose={onClose}
        footer={<button type="button">Back to Today</button>}
      >
        <button type="button">First action</button>
        <a href="#brief-reader-news">News</a>
        <button type="button">Last action</button>
      </BriefingDialog>
    );
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("BriefingDialog shell", () => {
  it("renders a labelled modal dialog", async () => {
    const { root } = await openDialog();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    const title = labelledBy ? document.getElementById(labelledBy) : null;
    expect(title?.textContent).toBe("Morning briefing");
    await act(async () => {
      root.unmount();
    });
  });

  it("moves focus to the title on open", async () => {
    const { root } = await openDialog();
    expect(document.activeElement?.textContent).toBe("Morning briefing");
    await act(async () => {
      root.unmount();
    });
  });

  it("traps Tab at both ends", async () => {
    const { root } = await openDialog();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    const byText = (text: string) =>
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === text
      ) as HTMLElement;
    await act(async () => {
      byText("Back to Today").focus();
    });
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      );
    });
    expect(document.activeElement?.textContent).toBe("Close");
    await act(async () => {
      byText("Close").focus();
    });
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });
    expect(document.activeElement?.textContent).toBe("Back to Today");
    await act(async () => {
      root.unmount();
    });
  });

  it("closes on Escape and on the close button", async () => {
    const onClose = vi.fn();
    const { root } = await openDialog(null, onClose);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const close = dialog.querySelector('button[aria-label="Close briefing reader"]') as HTMLElement;
    await act(async () => {
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => {
      root.unmount();
    });
  });

  it("returns focus to the opener after a re-render", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Read the full morning briefing";
    document.body.appendChild(opener);
    const onClose = vi.fn();
    const { root } = mount();
    await act(async () => {
      root.render(
        <div>
          <p>re-rendered today</p>
          <BriefingDialog title="Morning briefing" opener={opener} onClose={onClose} footer={null}>
            <button type="button">Only action</button>
          </BriefingDialog>
        </div>
      );
    });
    // Today re-renders underneath while the reader stays open.
    await act(async () => {
      root.render(
        <div>
          <p>re-rendered today again</p>
          <BriefingDialog title="Morning briefing" opener={opener} onClose={onClose} footer={null}>
            <button type="button">Only action</button>
          </BriefingDialog>
        </div>
      );
    });
    await act(async () => {
      root.unmount();
    });
    expect(document.activeElement).toBe(opener);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves the shared Dialog primitive alone", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", "packages/ui/src/dialog.tsx"]);
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync("apps/web/src/today/briefing-dialog.tsx", "utf8");
    expect(shell).not.toContain("packages/ui");
    expect(shell).not.toContain("jds-dialog");
  });

  it("marks the app root inert and locks scroll while open", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.appendChild(appRoot);
    const { root } = await openDialog();
    expect(appRoot.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => {
      root.unmount();
    });
    expect(appRoot.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });
});
