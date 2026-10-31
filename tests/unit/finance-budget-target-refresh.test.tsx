// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { BudgetTargets } from "../../external-modules/finance/src/web/budget-targets";
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
describe("target metadata save and refresh", () => {
  it("suppresses immediate duplicates/dismissal and waits for a new saved fingerprint before the next form", async () => {
    let finish!: (result: ModuleToolOutcome) => void;
    const invoke = vi.fn(
      () =>
        new Promise<ModuleToolOutcome>((resolve) => {
          finish = resolve;
        })
    );
    const props = {
      month: "2026-10",
      currency: "USD",
      revision: 1,
      fingerprint: "a".repeat(32),
      categories: [{ id: "groceries", name: "Groceries" }],
      targets: [],
      tools: { invoke }
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(BudgetTargets, props));
    });
    await act(async () => button(renderer, "Add a target").props.onClick());
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Target amount" })
        .props.onChange({ currentTarget: { value: "1.01" } })
    );
    const save = button(renderer, "Save target").props.onClick,
      cancel = button(renderer, "Cancel").props.onClick;
    await act(async () => {
      void save();
      void save();
      cancel();
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ "aria-label": "Target amount" })).toBeTruthy();
    await act(async () => finish({ status: "succeeded", result: { status: "ok" } }));
    expect(button(renderer, "Add a target").props.disabled).toBe(true);
    await act(async () =>
      renderer.update(
        createElement(BudgetTargets, { ...props, revision: 2, fingerprint: "b".repeat(32) })
      )
    );
    expect(button(renderer, "Add a target").props.disabled).toBe(false);
  });
});
