// @vitest-environment jsdom
//
// #3176: the Transactions screen. Server data comes through a faked fetch at the network
// edge; the screen, store and queue helper run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TransactionsScreen } from "../../external-modules/finance/src/web/screens/transactions";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const tx = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  accountId: "acc-1",
  date: "2026-10-08",
  amountCents: 1250,
  isoCurrency: "USD",
  name: `Payee ${id}`,
  categoryId: "dining",
  reviewState: "confirmed",
  ...over
});

const base = {
  month: "2026-10",
  categories: [
    { id: "dining", name: "Dining" },
    { id: "groceries", name: "Groceries" }
  ],
  accounts: [{ accountId: "acc-1", name: "Checking" }]
};

const rows = [
  tx("a", { reviewState: "needs_look" }),
  tx("b", { reviewState: "needs_look", categoryId: "groceries", date: "2026-10-07" }),
  tx("c", { amountCents: -400000, categoryId: "groceries", date: "2026-10-07" })
];

interface Call {
  url: string;
  body: Record<string, unknown> & {
    params?: Record<string, unknown>;
    input?: Record<string, unknown>;
  };
}
let calls: Call[] = [];

function fakeFetch(result: Record<string, unknown>, queueStatus = 202) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ url, body });
      if (url.includes("/queues/")) {
        return { ok: queueStatus === 202, status: queueStatus, json: async () => ({ jobId: "j" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ invocation: { status: "succeeded", result } })
      };
    })
  );
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(TransactionsScreen));
  });
  await act(async () => {});
  return renderer;
}

function collect(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collect).join("");
  return collect((node as { children?: unknown }).children);
}
const text = (renderer: ReactTestRenderer): string => collect(renderer.toJSON());

const textOf = (node: { children: unknown[] }): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : textOf(child as { children: unknown[] })))
    .join("");

const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll((node) => node.type === "button" && textOf(node) === label)[0]!;

const queueCalls = () => calls.filter((call) => call.url.includes("/queues/"));

afterEach(() => {
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

describe("Transactions screen (#3176)", () => {
  it("groups by day, flags guesses as Predicted and shows the count and Confirm all", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    const out = text(await render());
    expect(out).toContain("Needs a look (2)");
    expect(out).toContain("Confirm all 2");
    expect(out).toContain("Predicted");
    expect(out).toContain("Always for this merchant");
    expect(out).toContain("+$4,000.00");
    expect(out).toContain("Checking");
  });

  it("Confirm all sends exactly the visible Needs a look rows, with no rule", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    const renderer = await render();
    await act(async () => {
      button(renderer, "Confirm all 2").props.onClick();
    });
    const [call] = queueCalls();
    expect(call!.url).toContain("finance.review-apply");
    expect(call!.body.params).toEqual({
      transactionIds: ["a", "b"],
      accountIds: ["acc-1", "acc-1"],
      months: [expect.any(String), expect.any(String)],
      categoryIds: ["dining", "groceries"]
    });
    // Rows confirmed here leave the count and the button at once.
    expect(text(renderer)).not.toContain("Confirm all");
    expect(text(renderer)).toContain("Needs a look (0)");
  });

  it("puts the rows back when the confirm request fails (review finding 6)", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 }, 500);
    const renderer = await render();
    await act(async () => {
      button(renderer, "Confirm all 2").props.onClick();
    });
    await act(async () => {});
    expect(text(renderer)).toContain("Confirm all 2");
    expect(text(renderer)).toContain("Needs a look (2)");
  });

  it("lets a confirmed row change category, sending the new one (review A7)", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    const renderer = await render();
    const picker = renderer.root.findAll(
      (node) => node.props["aria-label"] === "Category for Payee c" && typeof node.type !== "string"
    )[0]!;
    await act(async () => {
      picker.props.onChange({ target: { value: "dining" } });
    });
    const [call] = queueCalls();
    expect(call!.body.params).toMatchObject({
      transactionIds: ["c"],
      categoryIds: ["dining"]
    });
    expect(call!.body.params).not.toHaveProperty("createRule");
  });

  it("offers Show more when the month has more rows than loaded (review A11)", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2, totalCount: 450 });
    const renderer = await render();
    const queryInputs = () =>
      calls
        .filter((call) => !call.url.includes("/queues/"))
        .map((call) => (call.body.input as { limit?: number }).limit);
    expect(queryInputs()).toEqual([200]);
    await act(async () => {
      button(renderer, "Show more").props.onClick();
    });
    await act(async () => {});
    expect(queryInputs().at(-1)).toBe(400);
  });

  it("hides Show more when everything is loaded", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2, totalCount: 3 });
    expect(text(await render())).not.toContain("Show more");
  });

  it("hides Confirm all when nothing needs a look", async () => {
    fakeFetch({ ...base, transactions: [rows[2]], needsLookCount: 0 });
    const out = text(await render());
    expect(out).not.toContain("Confirm all");
    expect(out).toContain("Needs a look (0)");
  });

  it("the merchant switch starts off, and a single Confirm makes a rule only when it is on", async () => {
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    const renderer = await render();
    const switches = () =>
      renderer.root.findAll(
        (node) =>
          node.type === "input" &&
          node.props["aria-label"] === "Always use this category for Payee a"
      );
    expect(switches()[0]!.props.checked).toBe(false);
    await act(async () => {
      button(renderer, "Confirm").props.onClick();
    });
    expect(queueCalls()[0]!.body.params).not.toHaveProperty("createRule");

    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    __resetStoreForTests();
    const second = await render();
    await act(async () => {
      second.root
        .findAll(
          (node) =>
            node.type === "input" &&
            node.props["aria-label"] === "Always use this category for Payee a"
        )[0]!
        .props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      button(second, "Confirm").props.onClick();
    });
    expect(queueCalls()[0]!.body.params).toMatchObject({
      transactionIds: ["a"],
      createRule: true
    });
  });

  it("asks only for Needs a look rows under that filter", async () => {
    fakeFetch({ ...base, transactions: rows.slice(0, 2), needsLookCount: 2 });
    const renderer = await render();
    const segmented = renderer.root.findAll(
      (node) => node.props.className === "jds-segmented__opt"
    );
    await act(async () => {
      segmented[1]!.props.onClick();
    });
    await act(async () => {});
    const reads = calls.filter((call) => !call.url.includes("/queues/"));
    expect(reads.at(-1)!.body.input).toMatchObject({ needsLookOnly: true });
  });
});
