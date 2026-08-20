// @vitest-environment jsdom
//
// #1759: a module page has to lead to its own settings page. Finance's own settings live on the
// host at /settings?section=modules&module=finance (external modules can never contribute a
// settings surface — packages/settings-ui/src/scanner.ts only scans packages/ and node_modules),
// so without this link the page a user is standing on has no way to reach them.
//
// The three screens are mocked: each one fetches on mount, and none of them is what this test is
// about. The header, the tabs and the router run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../external-modules/finance/src/web/screens/feed", () => ({
  FeedScreen: () => createElement("div", { "data-screen": "feed" })
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
    expect(hrefs).toContain("/settings?section=modules&module=finance");
  });
});
