// @vitest-environment jsdom
// #3217 WEB-11 / WEB-30: a failed check-in save keeps the modal open and shows an error, and a
// dose shows the medication's own clock time rather than the UTC clock.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { CheckinModal } from "../../apps/web/src/wellness/checkin-modal.js";
import { slotClock } from "../../apps/web/src/wellness/wellness-today.js";

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as { children?: unknown }).children);
}

describe("check-in modal save failure", () => {
  const initial = {
    emotion: "happy" as const,
    feeling: "Joyful",
    sensations: [],
    intensity: 3,
    note: "keep me"
  };

  async function press(onSave: () => Promise<unknown>, onClose: () => void) {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        createElement(CheckinModal, {
          open: true,
          onClose,
          onSave,
          initial,
          seedEmotion: null,
          theme: "light"
        })
      );
    });
    const save = tree.root.findAll(
      (n) => n.type === "button" && textOf(n.children).includes("Update check-in")
    )[0]!;
    await act(async () => {
      save.props.onClick();
    });
    return tree;
  }

  it("stays open with an error when the save fails", async () => {
    const onClose = vi.fn();
    const tree = await press(() => Promise.reject(new Error("boom")), onClose);
    expect(onClose).not.toHaveBeenCalled();
    expect(textOf(tree.toJSON())).toContain("Couldn't save your check-in");
  });

  it("closes when the save succeeds", async () => {
    const onClose = vi.fn();
    await press(() => Promise.resolve(), onClose);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("slotClock", () => {
  it("prefers the medication's local clock time over the UTC clock", () => {
    expect(slotClock({ scheduledFor: "2026-10-09T15:00:00.000Z", localTime: "08:00" })).toBe(
      "08:00"
    );
  });

  it("falls back to the UTC clock on older payloads", () => {
    expect(slotClock({ scheduledFor: "2026-10-09T15:00:00.000Z" })).toBe("15:00");
    expect(slotClock({ scheduledFor: null })).toBe("");
  });
});
