// @vitest-environment jsdom
//
// #1759: a module page has to lead to its own settings page, which Finance now owns (#3186).
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
  it("links to its own settings page from the header", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() } }));
    });

    const hrefs = renderer.root
      .findAllByType("a")
      .map((node) => node.props.href as string | undefined);
    expect(hrefs).toContain("/m/finance/settings");
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
