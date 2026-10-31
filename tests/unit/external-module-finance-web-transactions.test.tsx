// @vitest-environment jsdom
//
// #3176: the Transactions screen. Server data comes through a faked fetch at the network
// edge; the screen, store and queue helper run for real.
import "./helpers/install-module-runtime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dayYearLabel } from "../../external-modules/finance/src/web/format";
import { TransactionsScreen } from "../../external-modules/finance/src/web/screens/transactions";
import {
  detailsKey,
  rowFocusTarget
} from "../../external-modules/finance/src/web/transaction-rows";
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

async function render(
  props: NonNullable<Parameters<typeof TransactionsScreen>[0]> = {}
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<TransactionsScreen {...props} />);
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
  it("sends the labeled register filters to the server and exposes loaded export scope", async () => {
    fakeFetch({ ...base, transactions: rows, totalCount: 450 });
    const renderer = await render();
    const filtersButton = () =>
      renderer.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props["aria-expanded"] !== undefined &&
          textOf(node).startsWith("Filters")
      )[0]!;
    expect(filtersButton().props["aria-expanded"]).toBe(false);
    await act(async () => filtersButton().props.onClick());
    const picker = renderer.root.findAll(
      (node) => node.type === "select" && node.props["aria-label"] === "Filter by posting status"
    )[0]!;
    await act(async () => picker.props.onChange({ target: { value: "posted" } }));
    expect(
      calls.filter((call) => call.body.input?.postingState === "posted").length
    ).toBeGreaterThan(0);
    expect(text(renderer)).toContain("3 of 450 transactions");
    expect(text(renderer)).toContain("Clear filters");
    expect(textOf(filtersButton())).toBe("Filters · 1");
    // Closing the panel leaves the active filter as a removable chip.
    await act(async () => filtersButton().props.onClick());
    const chip = renderer.root.findAll(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Remove posting status filter Posted"
    )[0]!;
    expect(chip).toBeDefined();
    await act(async () => chip.props.onClick());
    expect(textOf(filtersButton())).toBe("Filters");
    const exportMenu = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Export transactions"
    )[0]!;
    await act(async () => exportMenu.props.onClick());
    expect(text(renderer)).toContain("Loaded rows");
    expect(text(renderer)).toContain("Full history…");
  });

  it("keeps the ledger to attention badges and puts the count out of sight when all rows load", async () => {
    fakeFetch({
      ...base,
      transactions: [
        rows[2],
        tx("p", { pending: true }),
        tx("m", { source: "manual", cleared: true })
      ],
      totalCount: 3
    });
    const renderer = await render();
    const out = text(renderer);
    expect(out).toContain("Pending");
    expect(out).not.toContain("Cleared");
    const status = renderer.root.findAll(
      (node) =>
        node.type === "span" &&
        node.props.role === "status" &&
        textOf(node) === "3 of 3 transactions"
    )[0]!;
    expect(status.parent!.props.className).toBe("fnm-visually-hidden");
  });
  it("distinguishes predictions from changed user categories and shows grouped review counts", async () => {
    fakeFetch({
      ...base,
      transactions: [...rows, tx("settled", { reviewState: "needs_look", categorizedBy: "user" })],
      needsLookCount: 3
    });
    const out = text(await render());
    expect(out).toContain("Needs a look (3)");
    expect(out).toContain("Confirm all 3");
    expect(out).not.toContain("Predicted");
    expect(out).not.toContain("Review needed");
    expect(out).not.toContain("Always for this merchant");
    expect(out).toContain("Change");
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

  describe("category picker keys", () => {
    const threeCategories = [...base.categories, { id: "fun", name: "Fun" }];
    const picker = (renderer: ReactTestRenderer) =>
      renderer.root.findAll(
        (node) =>
          node.props["aria-label"] === "Category for Payee c" && typeof node.type !== "string"
      )[0]!;
    // Chrome on Windows and Linux fires the change inside the arrow key's own task.
    const arrowTo = (renderer: ReactTestRenderer, value: string) =>
      act(async () => {
        picker(renderer).props.onKeyDown({ key: "ArrowUp" });
        picker(renderer).props.onChange({ target: { value } });
      });
    const press = (renderer: ReactTestRenderer, key: string) =>
      act(async () => picker(renderer).props.onKeyDown({ key }));
    const blur = (renderer: ReactTestRenderer) => act(async () => picker(renderer).props.onBlur());
    const nextTask = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const open = async () => {
      fakeFetch({ ...base, categories: threeCategories, transactions: rows, needsLookCount: 2 });
      return render();
    };

    it("holds arrow-key changes without saving, then saves the last one on Enter", async () => {
      const renderer = await open();
      await arrowTo(renderer, "dining");
      await arrowTo(renderer, "fun");
      expect(queueCalls()).toHaveLength(0);
      expect(picker(renderer).props.value).toBe("fun");
      await press(renderer, "Enter");
      expect(queueCalls()).toHaveLength(1);
      expect(queueCalls()[0]!.body.params).toMatchObject({
        transactionIds: ["c"],
        categoryIds: ["fun"]
      });
    });

    it("saves a held choice when the dropdown loses focus, and only once", async () => {
      const renderer = await open();
      await arrowTo(renderer, "dining");
      expect(queueCalls()).toHaveLength(0);
      await blur(renderer);
      expect(queueCalls()).toHaveLength(1);
      expect(queueCalls()[0]!.body.params).toMatchObject({ categoryIds: ["dining"] });
      await blur(renderer);
      await press(renderer, "Enter");
      expect(queueCalls()).toHaveLength(1);
    });

    it("puts the saved category back on Escape and sends nothing", async () => {
      const renderer = await open();
      await arrowTo(renderer, "dining");
      expect(picker(renderer).props.value).toBe("dining");
      await press(renderer, "Escape");
      expect(picker(renderer).props.value).toBe("groceries");
      await blur(renderer);
      await press(renderer, "Enter");
      expect(queueCalls()).toHaveLength(0);
    });

    it("sends nothing when the held choice ends on the saved category", async () => {
      const renderer = await open();
      await arrowTo(renderer, "dining");
      await arrowTo(renderer, "groceries");
      await press(renderer, "Enter");
      await blur(renderer);
      expect(queueCalls()).toHaveLength(0);
    });

    it("saves a pointer pick at once, even after earlier key presses", async () => {
      const renderer = await open();
      await arrowTo(renderer, "dining");
      await nextTask();
      await act(async () => picker(renderer).props.onChange({ target: { value: "fun" } }));
      expect(queueCalls()).toHaveLength(1);
      expect(queueCalls()[0]!.body.params).toMatchObject({ categoryIds: ["fun"] });
      await blur(renderer);
      expect(queueCalls()).toHaveLength(1);
    });

    it("treats the Enter that commits an open list as a pick", async () => {
      const renderer = await open();
      await act(async () => {
        picker(renderer).props.onKeyDown({ key: "Enter" });
        picker(renderer).props.onChange({ target: { value: "dining" } });
      });
      expect(queueCalls()).toHaveLength(1);
      expect(queueCalls()[0]!.body.params).toMatchObject({ categoryIds: ["dining"] });
    });
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
    expect(switches()).toHaveLength(0);
    await act(async () => {
      button(renderer, "Change").props.onClick();
    });
    expect(switches()[0]!.props.checked).toBe(false);
    await act(async () => {
      button(renderer, "Confirm").props.onClick();
    });
    expect(queueCalls()[0]!.body.params).not.toHaveProperty("createRule");

    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    __resetStoreForTests();
    const second = await render();
    await act(async () => {
      button(second, "Change").props.onClick();
    });
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

describe("transaction selection", () => {
  it("shows the selection bar only once the header box selects the editable rows", async () => {
    const revision = "a".repeat(32);
    fakeFetch({
      ...base,
      supportsBulk: true,
      transactions: [
        tx("a", { writeRevision: revision }),
        tx("b", { writeRevision: revision }),
        tx("pending", { pending: true, writeRevision: revision })
      ],
      totalCount: 3
    });
    const renderer = await render({ tools: { invoke: vi.fn() } as never });
    const bar = () =>
      renderer.root.findAll(
        (node) => node.type === "section" && node.props["aria-label"] === "Selected transactions"
      );
    expect(bar()).toHaveLength(0);
    const all = renderer.root.findAll(
      (node) => node.type === "input" && node.props["aria-label"] === "Select all editable rows"
    )[0]!;
    await act(async () => all.props.onChange({ target: { checked: true } }));
    expect(bar()).toHaveLength(1);
    expect(textOf(bar()[0]!)).toContain("2 selected");
    await act(async () => button(renderer, "Clear selection").props.onClick());
    expect(bar()).toHaveLength(0);
    await act(async () => renderer.unmount());
  });
});

describe("register read recovery", () => {
  it("offers an explicit read-only retry with friendly error copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    const renderer = await render();
    expect(text(renderer)).toContain("We couldn't load your transactions");
    expect(text(renderer)).not.toContain("Request failed");
    // An unknown count is not shown as zero.
    expect(text(renderer)).not.toContain("Needs a look (");
    fakeFetch({ ...base, transactions: rows, needsLookCount: 2 });
    await act(async () => button(renderer, "Retry register").props.onClick());
    expect(text(renderer)).toContain("Payee a");
    expect(text(renderer)).toContain("Needs a look (2)");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("finance.transactions.query");
    await act(async () => renderer.unmount());
  });
});

// react-test-renderer has no DOM, so real buttons stand in for the rows dialogs return focus to.
function standIn(attribute: string, value: string, visible = true): HTMLButtonElement {
  const element = document.createElement("button");
  element.setAttribute(attribute, value);
  element.getClientRects = () => (visible ? [{}] : []) as unknown as DOMRectList;
  document.body.append(element);
  return element;
}

describe("focus returns to the row after a dialog closes (review 7)", () => {
  afterEach(() => document.body.replaceChildren());

  it("keys a row by id, account and shared flag", () => {
    expect(detailsKey(tx("c") as never)).toBe(JSON.stringify(["c", "acc-1", false]));
    expect(detailsKey(tx("c", { shared: true }) as never)).toBe(
      JSON.stringify(["c", "acc-1", true])
    );
    expect(detailsKey(tx("c", { accountId: "acc-2" }) as never)).not.toBe(
      detailsKey(tx("c") as never)
    );
  });

  it("resolves the visible button when desktop and phone both render the row", () => {
    standIn("data-finance-details", "k", false);
    const shown = standIn("data-finance-details", "k");
    standIn("data-finance-details", "other");
    expect(rowFocusTarget("data-finance-details", "k")).toBe(shown);
  });

  it("falls back to the search box when the row is gone, and to nothing without one", () => {
    standIn("data-finance-details", "k", false);
    expect(rowFocusTarget("data-finance-details", "k")).toBeNull();
    const search = document.createElement("input");
    search.setAttribute("aria-label", "Search payees or notes");
    document.body.append(search);
    expect(rowFocusTarget("data-finance-details", "k")).toBe(search);
    expect(rowFocusTarget("data-finance-transfer-id", "t")).toBe(search);
  });

  it("returns focus to the row's details button when the split editor closes", async () => {
    fakeFetch({ ...base, transactions: rows, supportsSplits: true, totalCount: 3 });
    const target = standIn("data-finance-details", detailsKey(tx("c") as never));
    const renderer = await render({ tools: { invoke: vi.fn() } as never });
    const open = renderer.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["aria-label"] === "View transaction details for Payee c"
    )[0]!;
    await act(async () => open.props.onClick());
    await act(async () => button(renderer, "Split").props.onClick());
    expect(text(renderer)).toContain("Split transaction");
    expect(document.activeElement).not.toBe(target);
    await act(async () => button(renderer, "Cancel").props.onClick());
    expect(text(renderer)).not.toContain("Split transaction");
    expect(document.activeElement).toBe(target);
  });

  it("sends the transfer review back to the row that opened it, even after following a link", async () => {
    fakeFetch({
      ...base,
      transactions: [tx("t", { transferId: "tr-1", date: "2026-10-06" })],
      totalCount: 1
    });
    const origin = standIn("data-finance-transfer-id", "tr-1");
    const linked = standIn("data-finance-transfer-id", "tr-2");
    const renderer = await render({ tools: { invoke: vi.fn() } as never });
    const review = renderer.root.findAll(
      (node) => node.type === "button" && textOf(node) === "Review transfer"
    )[0]!;
    expect(review.props["aria-label"]).toBe(
      `Review transfer for Checking on ${dayYearLabel("2026-10-06", "long")}`
    );
    await act(async () => review.props.onClick());
    const returnFocusRef = () =>
      renderer.root.findAll((node) => node.props.closeLabel === "Close transfer review")[0]!.props
        .returnFocusRef as { current: HTMLElement | null };
    expect(returnFocusRef().current).toBe(origin);
    await act(async () =>
      renderer.root
        .findAll((node) => typeof node.props.onReview === "function")[0]!
        .props.onReview("tr-2")
    );
    expect(returnFocusRef().current).toBe(origin);
    expect(returnFocusRef().current).not.toBe(linked);
  });
});
