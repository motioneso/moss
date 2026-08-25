// @vitest-environment jsdom
// #1890: the confirm step in front of throwing a draft away. What matters here is that the
// dialog says there is no undo, that "Keep it" and "Throw it away" call different things, and
// that both buttons lock while the delete is in flight so it cannot be fired twice.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  ThrowAwayDraftDialog,
  type ThrowAwayDraftDialogProps
} from "../../apps/web/src/chat/throw-away-draft-dialog.js";

function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
}

function renderDialog(props: ThrowAwayDraftDialogProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(ThrowAwayDraftDialog, props));
  });
  return renderer;
}

const baseProps: ThrowAwayDraftDialogProps = {
  moduleId: "mod_123",
  onCancel: () => {},
  onConfirm: () => {}
};

// Matched on the rendered <button> rather than the shared Button component, so the test does
// not need @moss/ui resolvable from the root test suite (it is not a dependency of the root).
function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType("button")
    .find((instance) => renderedText(instance.props.children) === label);
}

describe("ThrowAwayDraftDialog", () => {
  it("says plainly that there is no undo", () => {
    const text = renderedText(renderDialog(baseProps).toJSON());
    expect(text).toContain("Throw this draft away?");
    expect(text).toContain("There is no undo");
  });

  it("keeps the draft on 'Keep it' and deletes it on 'Throw it away'", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const renderer = renderDialog({ ...baseProps, onCancel, onConfirm });

    const keep = findButton(renderer, "Keep it");
    const throwAway = findButton(renderer, "Throw it away");
    if (!keep || !throwAway) throw new Error("dialog buttons not found");

    act(() => keep.props.onClick());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => throwAway.props.onClick());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("locks both buttons while the delete is in flight", () => {
    const renderer = renderDialog({ ...baseProps, busy: true });
    const keep = findButton(renderer, "Keep it");
    const throwAway = findButton(renderer, "Throwing away...");
    expect(keep?.props.disabled).toBe(true);
    expect(throwAway?.props.disabled).toBe(true);
  });
});
