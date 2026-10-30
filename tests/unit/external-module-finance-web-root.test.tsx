// @vitest-environment jsdom
//
// #1759: module settings are reached by the shell's header cog, never a link inside the module.
//
// The three screens are mocked: each one fetches on mount, and none of them is what this test is
// about. The header, the tabs and the router run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../external-modules/finance/src/web/screens/transactions", () => ({
  TransactionsScreen: () => createElement("div", { "data-screen": "transactions" })
}));
vi.mock("../../external-modules/finance/src/web/screens/budget", () => ({
  BudgetScreen: () => createElement("div", { "data-screen": "budget" })
}));
vi.mock("../../external-modules/finance/src/web/screens/reports", () => ({
  ReportsScreen: () => createElement("div", { "data-screen": "reports" })
}));

import * as financeStore from "../../external-modules/finance/src/web/store";
import { Root } from "../../external-modules/finance/src/web/root";

describe("Finance module root (#1759)", () => {
  it("renders no Settings link of its own; the shell header cog is the only entry", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() } }));
    });

    const settingsLinks = renderer.root.findAllByType("a").filter((node) => {
      const text = JSON.stringify(node.props.children ?? "");
      return /settings/i.test(text) || /\/settings$/.test(String(node.props.href ?? ""));
    });
    expect(settingsLinks).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props.className === "fnm-header")).toHaveLength(0);
  });

  it("shows Budget, Transactions, Accounts and Reports tabs, with Budget at the module home", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() } }));
    });

    const labels = renderer.root
      .findAll((node) => node.props.className === "jds-segmented__opt")
      .map((node) => node.props.children as string);
    expect(labels).toEqual(["Budget", "Transactions", "Accounts", "Reports", "Upcoming"]);
    expect(
      renderer.root.findAll((node) => node.props["data-screen"] === "budget")
    ).not.toHaveLength(0);
  });
});

describe("Finance assistant refresh contract", () => {
  it("skips the initial key and invalidates once per changed host key", async () => {
    const invalidate = vi.spyOn(financeStore, "invalidateQueries").mockImplementation(() => {});
    const props = { hostActions: { openAssistant: vi.fn() } };
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(createElement(Root, { ...props, refreshKey: 4 }));
      });
      expect(invalidate).not.toHaveBeenCalled();
      await act(async () => renderer.update(createElement(Root, { ...props, refreshKey: 4 })));
      expect(invalidate).not.toHaveBeenCalled();
      await act(async () => renderer.update(createElement(Root, { ...props, refreshKey: 5 })));
      expect(invalidate).toHaveBeenCalledTimes(1);
      await act(async () => renderer.update(createElement(Root, { ...props, refreshKey: 6 })));
      expect(invalidate).toHaveBeenCalledTimes(2);
      await act(async () => renderer.update(createElement(Root, props)));
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
      invalidate.mockRestore();
    }
  });
});
