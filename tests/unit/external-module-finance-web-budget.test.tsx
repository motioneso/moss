// @vitest-environment jsdom
//
// #3173: the Budget screen's states. Server data comes through a faked fetch at the
// network edge; the screen, router and store run for real.
import "./helpers/install-module-runtime";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BudgetScreen } from "../../external-modules/finance/src/web/screens/budget";
import {
  invalidateQueries,
  __resetStoreForTests
} from "../../external-modules/finance/src/web/store";

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
    revision: 7,
    fingerprint: "a".repeat(32),
    isoCurrency: "USD",
    hasBank: true,
    hasBudget: true,
    readyToAssignCents: 123_456,
    needsLookCount: 2,
    accounts: [
      {
        isoCurrency: "USD",
        accountId: "a",
        name: "Checking",
        balanceCents: 500_000,
        asOf: "2026-10-05",
        stale: false
      },
      {
        isoCurrency: "USD",
        accountId: "b",
        name: "Savings",
        balanceCents: 90_000,
        asOf: "2026-10-05",
        stale: true
      }
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

function fakeFetch(respond: () => { status: number; body: unknown; retryAfter?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const { status: code, body, retryAfter } = respond();
      return {
        ok: code >= 200 && code < 300,
        status: code,
        headers: { get: () => retryAfter ?? null },
        json: async () => body
      };
    })
  );
}

async function render(tools?: ExternalModuleToolsHandleV1): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(BudgetScreen, { tools }));
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

  it("stays on Budget with categories at zero when a bank is linked but no budget exists (review finding 1)", async () => {
    window.history.pushState({}, "", "/m/finance");
    fakeFetch(() => ({
      status: 200,
      body: {
        invocation: {
          status: "succeeded",
          result: status({ hasBudget: false, state: { categories: {} } })
        }
      }
    }));
    const out = text(await render());
    expect(window.location.pathname).toBe("/m/finance");
    expect(out).toContain("Groceries");
  });

  it("shows a broken state when the read fails", async () => {
    fakeFetch(() => ({ status: 500, body: {} }));
    expect(text(await render())).toContain("Something went wrong");
  });
});

describe("Budget screen reviewed saves", () => {
  const box = (renderer: ReactTestRenderer) =>
    renderer.root.findAll(
      (n) => n.type === "input" && n.props["aria-label"] === "Assigned to Groceries"
    )[0]!;
  async function type(renderer: ReactTestRenderer, value: string) {
    await act(async () => box(renderer).props.onFocus({ currentTarget: { select() {} } }));
    await act(async () => box(renderer).props.onChange({ currentTarget: { value } }));
    await act(async () => box(renderer).props.onKeyDown({ key: "Enter", preventDefault() {} }));
  }
  it("keeps totals committed during review and sends the displayed base and review tokens", async () => {
    let stored = status();
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: stored } }
    }));
    let finish!: (outcome: ModuleToolOutcome) => void;
    const invoke = vi.fn(
      () =>
        new Promise<ModuleToolOutcome>((resolve) => {
          finish = resolve;
        })
    );
    const renderer = await render({ invoke });
    await type(renderer, "700");
    expect(box(renderer).props.value).toBe("700");
    expect(box(renderer).props.disabled).toBe(true);
    expect(text(renderer)).toContain("$231.73");
    expect(text(renderer)).not.toContain("$281.73");
    expect(invoke).toHaveBeenCalledWith("finance.budget.assign", {
      month: expect.any(String),
      categoryId: "groceries",
      amountCents: 70000,
      previousCents: 65000,
      expectedRevision: 7,
      expectedFingerprint: "a".repeat(32)
    });
    stored = status({
      revision: 8,
      state: {
        categories: {
          ...stored.state.categories,
          groceries: { assignedCents: 70000, activityCents: 41827, availableCents: 28173 }
        }
      }
    });
    await act(async () => finish({ status: "succeeded", result: { status: "ok" } }));
    expect(box(renderer).props.value).toBe("$700.00");
    expect(text(renderer)).toContain("$281.73");
  });
  it.each(["cancelled", "rejected"] as const)(
    "keeps typed input after a %s write",
    async (statusCode) => {
      fakeFetch(() => ({
        status: 200,
        body: { invocation: { status: "succeeded", result: status() } }
      }));
      const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: statusCode }));
      const renderer = await render({ invoke });
      await type(renderer, "700");
      expect(box(renderer).props.value).toBe("700");
      expect(text(renderer)).toContain(statusCode === "cancelled" ? "Cancelled" : "Not saved");
      expect(text(renderer)).toContain("$231.73");
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  );
  it("freezes ambiguous writes until saved records are checked, without an automatic retry", async () => {
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const renderer = await render({ invoke });
    await type(renderer, "700");
    expect(box(renderer).props.disabled).toBe(true);
    expect(text(renderer)).toContain("could not be confirmed");
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((b) => b.children.includes("Check saved records"))!
        .props.onClick()
    );
    expect(box(renderer).props.disabled).toBe(false);
    expect(box(renderer).props.value).toBe("700");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("keeps typed amounts tied to their review through a background refresh", async () => {
    let stored = status();
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: stored } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const renderer = await render({ invoke });
    await act(async () => box(renderer).props.onChange({ currentTarget: { value: "700" } }));
    stored = status({
      revision: 8,
      fingerprint: "b".repeat(32),
      state: {
        categories: {
          ...stored.state.categories,
          groceries: { assignedCents: 66000, activityCents: 41827, availableCents: 24173 }
        }
      }
    });
    await act(async () => invalidateQueries());
    expect(box(renderer).props.value).toBe("700");
    expect(box(renderer).props.disabled).toBe(true);
    await act(async () => box(renderer).props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(invoke).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Saved budget changed");
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((b) => b.children.includes("Check saved records"))!
        .props.onClick()
    );
    expect(box(renderer).props.value).toBe("700");
    expect(box(renderer).props.disabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => box(renderer).props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(invoke).toHaveBeenCalledWith(
      "finance.budget.assign",
      expect.objectContaining({
        amountCents: 70000,
        previousCents: 66000,
        expectedRevision: 8,
        expectedFingerprint: "b".repeat(32)
      })
    );
  });
  it("ends a failed records check without clearing uncertain writes or retained input", async () => {
    let code = 200;
    fakeFetch(() => ({
      status: code,
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const renderer = await render({ invoke });
    await type(renderer, "700");
    code = 503;
    const check = () =>
      renderer.root.findAllByType("button").find((b) => b.children.includes("Check saved records"));
    await act(async () => check()!.props.onClick());
    expect(check()).toBeTruthy();
    expect(check()!.props.disabled).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
    code = 200;
    await act(async () => check()!.props.onClick());
    expect(box(renderer).props.value).toBe("700");
    expect(box(renderer).props.disabled).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("discards local amounts without treating an uncertain save as resolved", async () => {
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const renderer = await render({ invoke });
    await type(renderer, "700");
    const discard = renderer.root
      .findAllByType("button")
      .find((b) => b.children.includes("Discard typed amounts"));
    expect(discard).toBeTruthy();
    await act(async () => discard!.props.onClick());
    expect(box(renderer).props.value).toBe("$650.00");
    expect(box(renderer).props.disabled).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("requires reviewing other typed categories after one assignment changes the saved budget", async () => {
    let stored = status();
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: stored } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => {
      if (invoke.mock.calls.length === 1) {
        stored = status({
          revision: 8,
          fingerprint: "b".repeat(32),
          state: {
            categories: {
              ...stored.state.categories,
              groceries: { assignedCents: 70000, activityCents: 41827, availableCents: 28173 }
            }
          }
        });
        return { status: "succeeded", result: { status: "ok" } };
      }
      return { status: "cancelled" };
    });
    const renderer = await render({ invoke });
    const dining = () =>
      renderer.root.findAll(
        (n) => n.type === "input" && n.props["aria-label"] === "Assigned to Dining & coffee"
      )[0]!;
    await act(async () => box(renderer).props.onChange({ currentTarget: { value: "700" } }));
    await act(async () => dining().props.onChange({ currentTarget: { value: "300" } }));
    await act(async () => box(renderer).props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(box(renderer).props.value).toBe("$700.00");
    expect(dining().props.value).toBe("300");
    expect(dining().props.disabled).toBe(true);
    await act(async () => dining().props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(invoke).toHaveBeenCalledOnce();
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((b) => b.children.includes("Check saved records"))!
        .props.onClick()
    );
    await act(async () => dining().props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(
      "finance.budget.assign",
      expect.objectContaining({
        categoryId: "dining",
        previousCents: 22000,
        amountCents: 30000,
        expectedRevision: 8,
        expectedFingerprint: "b".repeat(32)
      })
    );
  });
  it("honors a read cooldown and requires another explicit check after a busy response", async () => {
    vi.useFakeTimers();
    let code = 200;
    fakeFetch(() => ({
      status: code,
      retryAfter: "2",
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    let renderer!: ReactTestRenderer;
    try {
      renderer = await render({ invoke });
      await type(renderer, "700");
      const check = () =>
        renderer.root
          .findAllByType("button")
          .find((b) => b.children.includes("Check saved records"))!;
      code = 429;
      await act(async () => check().props.onClick());
      expect(check().props.disabled).toBe(true);
      const reads = vi.mocked(fetch).mock.calls.length;
      code = 200;
      await act(async () => check().props.onClick());
      expect(vi.mocked(fetch).mock.calls.length).toBe(reads);
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(check().props.disabled).toBe(false);
      expect(vi.mocked(fetch).mock.calls.length).toBe(reads);
      await act(async () => check().props.onClick());
      expect(box(renderer).props.value).toBe("700");
      expect(box(renderer).props.disabled).toBe(false);
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
    }
  });
  it("rejects invalid amounts without invoking a write", async () => {
    fakeFetch(() => ({
      status: 200,
      body: { invocation: { status: "succeeded", result: status() } }
    }));
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const renderer = await render({ invoke });
    await type(renderer, "lots");
    expect(invoke).not.toHaveBeenCalled();
    expect(box(renderer).props.value).toBe("lots");
    expect(text(renderer)).toContain("Enter an amount");
  });
});
