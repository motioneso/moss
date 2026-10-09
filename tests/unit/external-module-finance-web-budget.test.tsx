// @vitest-environment jsdom
//
// #3173: the Budget screen's states. Server data comes through a faked fetch at the
// network edge; the screen, router and store run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BudgetScreen } from "../../external-modules/finance/src/web/screens/budget";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const category = (id: string, name: string, tableGroup: string) => ({
  id,
  name,
  group: "x",
  archived: false,
  tableGroup
});

function status(over: Record<string, unknown> = {}) {
  return {
    month: "2026-10",
    hasBank: true,
    hasBudget: true,
    readyToAssignCents: 123_456,
    needsLookCount: 2,
    accounts: [
      { accountId: "a", name: "Checking", balanceCents: 500_000, asOf: "2026-10-05", stale: false },
      { accountId: "b", name: "Savings", balanceCents: 90_000, asOf: "2026-10-05", stale: true }
    ],
    categories: [
      category("groceries", "Groceries", "Everyday"),
      category("dining", "Dining & coffee", "Everyday"),
      category("savings", "Savings", "Savings"),
      category("income", "Income", "Income")
    ],
    state: {
      categories: {
        groceries: { assignedCents: 65_000, activityCents: 41_827, availableCents: 23_173 },
        dining: { assignedCents: 22_000, activityCents: 24_650, availableCents: -2_650 },
        savings: { assignedCents: 30_000, activityCents: 0, availableCents: 900_000 },
        income: { assignedCents: 0, activityCents: -400_000, availableCents: 400_000 }
      }
    },
    ...over
  };
}

function fakeFetch(respond: () => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const { status: code, body } = respond();
      return { ok: code >= 200 && code < 300, status: code, json: async () => body };
    })
  );
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(BudgetScreen));
  });
  await act(async () => {});
  return renderer;
}

// Visible text plus class names, so assertions can read both words and styling hooks.
function collect(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collect).join("");
  const element = node as { props?: { className?: string }; children?: unknown };
  return `[${element.props?.className ?? ""}]${collect(element.children)}`;
}
const text = (renderer: ReactTestRenderer): string => collect(renderer.toJSON());

afterEach(() => {
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

describe("Budget screen (#3173)", () => {
  it("shows ready to assign, groups, the over badge and the carried-over badge", async () => {
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    const out = text(await render());

    expect(out).toContain("$1,234.56");
    expect(out).toContain("Dining & coffee");
    expect(out).toContain("$26.50 over");
    expect(out).toContain("$8,700.00 carried over");
    // Income is not an envelope.
    expect(out).not.toContain("Income");
    // Needs you block and the balances rail.
    expect(out).toContain("Needs a look");
    expect(out).toContain("Balances");
  });

  it("marks a stale bank on its balance row", async () => {
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    expect(text(await render())).toContain("jds-indicator--error");
  });

  it("goes to Getting started when there is no bank", async () => {
    window.history.pushState({}, "", "/m/finance");
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: status({ hasBank: false }) } }
    }));
    await render();
    expect(window.location.pathname).toBe("/m/finance/start");
  });

  it("shows a broken state when the read fails", async () => {
    fakeFetch(() => ({ status: 500, body: {} }));
    expect(text(await render())).toContain("Something went wrong");
  });
});
