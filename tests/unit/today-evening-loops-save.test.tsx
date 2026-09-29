// @vitest-environment jsdom
// #2782 - a failed save on an evening open loop must show an error and keep the choices.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCALE_SETTINGS, type LocaleSettingsDto, type TaskDto } from "@moss/shared";

import { EveningSupportSections } from "../../apps/web/src/today/evening-mode.js";

const locale: LocaleSettingsDto = { ...DEFAULT_LOCALE_SETTINGS, timezone: "UTC" };
const loop = {
  id: "t1",
  title: "Book the bike service",
  dueAt: "2026-06-28T19:00:00.000Z"
} as TaskDto;

function text(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return text((node as { children?: unknown }).children);
}

function mount(onDecide: () => Promise<unknown>): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      createElement(EveningSupportSections, {
        openLoopsDek: null,
        carryingForward: [loop],
        locale,
        busyTaskId: null,
        onOpenTask: () => undefined,
        onDecide
      })
    );
  });
  return tree;
}

const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll((n) => n.type === "button" && text(n.children) === label);

describe("evening open loop save", () => {
  it("shows an error and keeps the choices when the save is rejected", async () => {
    const onDecide = vi.fn(() => Promise.reject(new Error("boom")));
    const tree = mount(onDecide);

    await act(async () => {
      button(tree, "Tomorrow")[0]!.props.onClick();
    });

    const out = text(tree.toJSON());
    expect(onDecide).toHaveBeenCalledOnce();
    expect(out).toContain("Could not save that");
    expect(out).not.toContain("Moved to tomorrow.");
    expect(button(tree, "Tomorrow")).toHaveLength(1);
    expect(button(tree, "Choose a day")).toHaveLength(1);
    expect(button(tree, "Let it go")).toHaveLength(1);
  });

  it("shows the note and hides the choices only after the save succeeds", async () => {
    const tree = mount(() => Promise.resolve({}));

    await act(async () => {
      button(tree, "Let it go")[0]!.props.onClick();
    });

    const out = text(tree.toJSON());
    expect(out).toContain("Let go.");
    expect(button(tree, "Tomorrow")).toHaveLength(0);
  });
});
