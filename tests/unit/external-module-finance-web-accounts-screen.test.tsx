// @vitest-environment jsdom
//
// #3177: the Accounts screen renders the real accounts read. The fetch layer is stubbed with the
// read tool's own response shape; the screen, store and view model run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountsScreen } from "../../external-modules/finance/src/web/screens/accounts";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

function stubAccountsRead(result: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ invocation: { status: "succeeded", result } })
    }))
  );
}

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

type Instance = ReactTestRenderer["root"];

function innerText(node: Instance | string): string {
  return typeof node === "string" ? node : node.children.map(innerText).join("");
}

function buttonNamed(renderer: ReactTestRenderer, text: string): Instance | undefined {
  return renderer.root.findAllByType("button").find((node) => innerText(node) === text);
}

async function render(openAssistant = vi.fn()) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(AccountsScreen, { hostActions: { openAssistant } }));
  });
  await act(async () => {});
  return { renderer, openAssistant };
}

afterEach(() => {
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

describe("Accounts screen (#3177)", () => {
  it("labels individual currencies and separates own totals while excluding shared balances", async () => {
    const base = { itemId: "i1", type: "depository", mask: null };
    stubAccountsRead({
      accounts: [
        { ...base, accountId: "usd", name: "Checking", balanceCents: 10000, isoCurrency: "USD" },
        { ...base, accountId: "eur", name: "Travel", balanceCents: 2345, isoCurrency: "EUR" },
        {
          ...base,
          accountId: "loan",
          name: "Loan",
          type: "loan",
          balanceCents: 1200,
          isoCurrency: "EUR"
        },
        {
          ...base,
          accountId: "shared",
          name: "Shared",
          balanceCents: 99999,
          isoCurrency: "EUR",
          shared: true
        }
      ]
    });
    const { renderer } = await render();
    const text = textOf(renderer);
    expect(text).toContain("Net worth · EUR");
    expect(text).toContain("Net worth · USD");
    expect(text).toContain("€11.45");
    expect(text).toContain("€23.45");
    expect(text).toContain("-€12.00");
    expect(text).toContain("$100.00");
    expect(text).not.toContain("$111.45");
    expect(text).not.toContain("999.99");
    expect(text).not.toContain("no exchange-rate conversion");
  });

  it("groups accounts by kind under a single-currency net worth with assets and debts", async () => {
    stubAccountsRead({
      accounts: [
        {
          accountId: "chk",
          itemId: "i1",
          name: "Checking",
          mask: "4821",
          type: "depository",
          balanceCents: 50000,
          isoCurrency: "USD"
        },
        {
          accountId: "card",
          itemId: "i1",
          name: "Card",
          mask: null,
          type: "credit",
          balanceCents: 12000,
          isoCurrency: "USD"
        },
        {
          accountId: "wallet",
          itemId: null,
          source: "manual",
          name: "Wallet",
          mask: null,
          type: "other",
          subtype: "cash",
          balanceCents: 2000,
          isoCurrency: "USD"
        }
      ],
      banks: [
        {
          itemId: "i1",
          institutionId: "ins_1",
          institutionName: "Sandbox First Bank",
          status: "connected",
          lastSyncAt: new Date().toISOString(),
          message: null
        }
      ],
      supportsManualManagement: true
    });
    const { renderer } = await render();
    const text = textOf(renderer);
    expect(text).toContain('"Net worth"');
    expect(text).not.toContain("Net worth · USD");
    expect(text).toContain("$400.00");
    const figures = renderer.root.findByProps({ "aria-label": "Assets and debts" });
    const cells = (type: "dt" | "dd") =>
      figures.findAllByType(type).map((node) => node.children.join(""));
    expect(cells("dt")).toEqual(["Assets", "Debts"]);
    expect(cells("dd")).toEqual(["$520.00", "$120.00"]);
    expect(text).toContain("Credit cards");
    expect(text).toContain("Sandbox First Bank · Synced just now");
    expect(text).toContain("Manual");

    const labels = renderer.root
      .findAllByType("button")
      .map((node) => node.props["aria-label"] as string | undefined);
    expect(labels).toContain("View transactions for Checking");
    expect(labels).toContain("Actions for Wallet");
    expect(labels).not.toContain("Actions for Checking");
    expect(labels).toContain("Add account");
    expect(labels).not.toContain("Add transaction to Wallet");
  });

  it("explains an unavailable total without dropping account rows", async () => {
    const base = { itemId: "i1", type: "depository", isoCurrency: "USD", mask: null };
    stubAccountsRead({
      accounts: [
        {
          ...base,
          accountId: "large",
          name: "Large synthetic account",
          balanceCents: Number.MAX_SAFE_INTEGER
        },
        { ...base, accountId: "extra", name: "Extra synthetic account", balanceCents: 1 }
      ]
    });
    const { renderer } = await render();
    expect(textOf(renderer)).toContain("Unavailable");
    expect(textOf(renderer)).toContain("A combined balance exceeds supported precision");
    expect(textOf(renderer)).toContain("Large synthetic account");
    expect(textOf(renderer)).toContain("Extra synthetic account");
  });

  it("shows an expired bank with its stored message, as-of date and a working Reconnect", async () => {
    stubAccountsRead({
      accounts: [
        {
          accountId: "a1",
          itemId: "i1",
          name: "Savings",
          mask: "7302",
          type: "depository",
          balanceCents: 921000,
          isoCurrency: "USD"
        }
      ],
      banks: [
        {
          itemId: "i1",
          institutionId: "ins_1",
          institutionName: "Maple Credit Union",
          status: "reauth-required",
          lastSyncAt: "2026-10-05T09:00:00Z",
          message: "The login details of this item have changed."
        }
      ]
    });
    const { renderer, openAssistant } = await render();
    const text = textOf(renderer);
    expect(text).toContain("Maple Credit Union · Sign-in expired");
    expect(text).toContain("The login details of this item have changed.");
    expect(text).toContain("As of October 5");
    expect(text).toContain("xxx7302");

    const reconnect = buttonNamed(renderer, "Reconnect");
    expect(reconnect).toBeDefined();
    expect(reconnect!.props["aria-label"]).toBe("Reconnect Maple Credit Union");
    act(() => reconnect!.props.onClick());
    expect(openAssistant).toHaveBeenCalledWith({
      starterPrompt: "Reconnect my Maple Credit Union account"
    });

    // The status line and its message sit in one evenly spaced block.
    const block = renderer.root.findAll(
      (node) => node.type === "div" && innerText(node).includes("The login details")
    );
    expect(block.some((node) => String(node.props.className).includes("fnm-block--tight"))).toBe(
      true
    );
  });

  it("names each bank on its Reconnect button and starts that bank's reconnect", async () => {
    const base = { type: "depository", isoCurrency: "USD", mask: null, balanceCents: 1000 };
    const expired = { institutionId: "ins", status: "reauth-required", message: null };
    stubAccountsRead({
      accounts: [
        { ...base, accountId: "a1", itemId: "i1", name: "Savings" },
        { ...base, accountId: "a2", itemId: "i2", name: "Everyday" }
      ],
      banks: [
        { ...expired, itemId: "i1", institutionName: "Maple Credit Union", lastSyncAt: null },
        { ...expired, itemId: "i2", institutionName: "Harbor Bank", lastSyncAt: null }
      ]
    });
    const { renderer, openAssistant } = await render();
    const reconnects = renderer.root
      .findAllByType("button")
      .filter((node) => innerText(node) === "Reconnect");
    expect(reconnects.map((node) => node.props["aria-label"])).toEqual([
      "Reconnect Maple Credit Union",
      "Reconnect Harbor Bank"
    ]);
    act(() => reconnects[1]!.props.onClick());
    expect(openAssistant).toHaveBeenLastCalledWith({
      starterPrompt: "Reconnect my Harbor Bank account"
    });
    act(() => reconnects[0]!.props.onClick());
    expect(openAssistant).toHaveBeenLastCalledWith({
      starterPrompt: "Reconnect my Maple Credit Union account"
    });
  });

  it("gives every account table column a header for screen readers", async () => {
    stubAccountsRead({
      accounts: [
        {
          accountId: "chk",
          itemId: "i1",
          name: "Checking",
          mask: "4821",
          type: "depository",
          balanceCents: 50000,
          isoCurrency: "USD"
        }
      ],
      banks: [
        {
          itemId: "i1",
          institutionId: "ins_1",
          institutionName: "Sandbox First Bank",
          status: "connected",
          lastSyncAt: new Date().toISOString(),
          message: null
        }
      ]
    });
    const { renderer } = await render();
    const headers = renderer.root.findAllByType("th");
    expect(headers.map(innerText)).toEqual(["Account", "Balance", "Actions"]);
    for (const header of headers) {
      expect(header.props.scope).toBe("col");
      expect(header.props.className).toBe("jds-sr-only");
    }
    expect(renderer.root.findAllByType("thead")).toHaveLength(1);
  });

  it("offers a manual account and a bank connection when there are no accounts", async () => {
    stubAccountsRead({ accounts: [], banks: [] });
    const { renderer, openAssistant } = await render();
    const text = textOf(renderer);
    expect(text).toContain("Add manual account");
    expect(text).not.toContain("Record transfer");
    const connect = buttonNamed(renderer, "Connect a bank");
    act(() => connect!.props.onClick());
    expect(openAssistant).toHaveBeenCalledWith({ starterPrompt: "Connect my bank account" });
  });
});
