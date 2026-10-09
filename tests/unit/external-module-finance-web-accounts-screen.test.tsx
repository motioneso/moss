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
          status: "reauth-required",
          lastSyncAt: "2026-10-05T09:00:00Z",
          message: "The login details of this item have changed."
        }
      ]
    });
    const { renderer, openAssistant } = await render();
    const text = textOf(renderer);
    expect(text).toContain("Sign-in expired");
    expect(text).toContain("The login details of this item have changed.");
    expect(text).toContain("As of October 5");
    expect(text).toContain("xxx7302");

    const reconnect = renderer.root
      .findAllByType("button")
      .find((node) => JSON.stringify(node.props.children).includes("Reconnect"));
    expect(reconnect).toBeDefined();
    act(() => reconnect!.props.onClick());
    expect(openAssistant).toHaveBeenCalledWith({ starterPrompt: "Reconnect my bank account" });
  });

  it("offers Add a bank when nothing is connected", async () => {
    stubAccountsRead({ accounts: [], banks: [] });
    const { renderer } = await render();
    expect(textOf(renderer)).toContain("Add a bank");
  });
});
