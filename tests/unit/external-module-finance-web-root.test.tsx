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

  it("shows Budget, Transactions and Accounts tabs, with Budget at the module home (#3173)", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() } }));
    });

    const labels = renderer.root
      .findAll((node) => node.props.className === "jds-segmented__opt")
      .map((node) => node.props.children as string);
    expect(labels).toEqual(["Budget", "Transactions", "Accounts"]);
    expect(
      renderer.root.findAll((node) => node.props["data-screen"] === "budget")
    ).not.toHaveLength(0);
  });
});
