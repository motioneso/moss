// @vitest-environment jsdom
//
// Accounts screen focus hand-offs in a real DOM. Closing the account manager, or finishing a
// reconciliation that the manager started, puts focus back on the row menu button that began it.
// Server data comes through a faked fetch and a faked tools handle in each tool's own shape; the
// screen, store and dialogs run for real.
import "./helpers/install-module-runtime";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountsScreen } from "../../external-modules/finance/src/web/screens/accounts";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const manual = (accountId: string, name: string) => ({
  accountId,
  itemId: null,
  source: "manual",
  name,
  mask: null,
  type: "other",
  subtype: "cash",
  balanceCents: 2000,
  isoCurrency: "USD"
});
const accountReview = (accountId: string, name: string) => ({
  accountId,
  name,
  type: "other",
  subtype: "cash",
  isoCurrency: "USD",
  balanceCents: 2000,
  openingBalanceCents: 0,
  openingDate: "2026-10-01",
  balanceAsOf: "2026-10-30 UTC",
  archivedAt: null,
  lastReconciledDate: null,
  lastEntryDate: null,
  revision: "a".repeat(32),
  canClose: false,
  blockers: ["unreconciled"],
  futurePlanCount: 0
});
const statementReview = (accountId: string, name: string) => ({
  status: "ok",
  statementDate: "2026-10-30",
  today: "2026-10-30",
  view: {
    accountId,
    name,
    isoCurrency: "USD",
    debt: false,
    openingDate: "2026-10-01",
    lastReconciledDate: null,
    revision: 1,
    baselineCents: 0,
    recordedCents: 2000,
    totalEntries: 0,
    entries: []
  }
});

function fakeFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const tool = decodeURIComponent(/assistant-tools\/([^/]+)\/invoke/.exec(url)?.[1] ?? "");
      const input = JSON.parse(init?.body ?? "{}").input ?? {};
      const result =
        tool === "finance.accounts.list"
          ? {
              accounts: [manual("wallet", "Wallet"), manual("jar", "Jar")],
              banks: [],
              supportsManualManagement: true
            }
          : tool === "finance.manual.account-review"
            ? {
                status: "ok",
                today: "2026-10-30",
                account: accountReview(
                  input.accountId,
                  input.accountId === "jar" ? "Jar" : "Wallet"
                )
              }
            : { status: "ok" };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ invocation: { status: "succeeded", result } })
      };
    })
  );
}

const tools: ExternalModuleToolsHandleV1 = {
  invoke: vi.fn(
    async (_tool: string, input: Record<string, unknown>): Promise<ModuleToolOutcome> => ({
      status: "succeeded",
      result: statementReview(String(input.accountId), input.accountId === "jar" ? "Jar" : "Wallet")
    })
  )
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
  fakeFetch();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<AccountsScreen hostActions={{ openAssistant: vi.fn() }} tools={tools} />)
  );
  await act(async () => {});
  await act(async () => {});
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

async function click(target: Element) {
  await act(async () => {
    (target as HTMLElement).click();
  });
  await act(async () => {});
  await act(async () => {});
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const named = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label
  )!;
const titleOf = (node: HTMLElement | null) =>
  node?.querySelector(".jds-dialog__title")?.textContent;

/** Opens a row's action menu the way a pointer user does: focus the button, press it, pick an item. */
async function chooseFromRowMenu(account: string, item: string) {
  const trigger = named(`Actions for ${account}`);
  trigger.focus();
  await click(trigger);
  await click(named(item));
  return trigger;
}

/** Walks from the open account manager to the statement dialog through "Reconcile this account". */
async function reconcileFromManager() {
  await click(named("Review closing", dialog()!));
  await click(named("Reconcile this account", dialog()!));
}

describe("Accounts screen dialogs return focus", () => {
  beforeEach(mount);

  it("returns focus to the row menu button when the account manager closes", async () => {
    const trigger = await chooseFromRowMenu("Wallet", "Manage Wallet");
    expect(titleOf(dialog())).toBe("Manage manual account");
    await click(named("Close", dialog()!));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the row menu button after a reconciliation the manager started", async () => {
    const trigger = await chooseFromRowMenu("Wallet", "Manage Wallet");
    await reconcileFromManager();
    expect(titleOf(dialog())).toBe("Reconcile a statement");
    await click(named("Close", dialog()!));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to a row's own button when a row opens the dialog after the manager did", async () => {
    await chooseFromRowMenu("Wallet", "Manage Wallet");
    await reconcileFromManager();
    await click(named("Close", dialog()!));
    const other = await chooseFromRowMenu("Jar", "Reconcile Jar");
    expect(titleOf(dialog())).toBe("Reconcile a statement");
    await click(named("Close", dialog()!));
    expect(document.activeElement).toBe(other);
  });
});
