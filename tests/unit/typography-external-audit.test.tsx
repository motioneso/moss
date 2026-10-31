// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionsScreen } from "../../external-modules/finance/src/web/screens/transactions";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";
import { validateModuleAppMap } from "../../packages/module-registry/src/external/app-map";

let renderers: ReactTestRenderer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers) renderer.unmount();
  });
  renderers = [];
  __resetStoreForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function collect(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collect).join("");
  if (node && typeof node === "object" && "children" in node) return collect(node.children);
  return "";
}

const text = (renderer: ReactTestRenderer): string => collect(renderer.toJSON());

async function mount(element: ReturnType<typeof createElement>): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  renderers.push(renderer);
  return renderer;
}

function financeRead(transactions: Record<string, unknown>[] = []) {
  const reads: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes("/queues/")) {
        return { ok: true, status: 202, json: async () => ({ jobId: "review-job" }) };
      }
      const { input } = JSON.parse(init?.body ?? "{}") as { input: Record<string, unknown> };
      reads.push(input);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          invocation: {
            status: "succeeded",
            result: {
              month: input.month,
              transactions,
              categories: [{ id: "dining", name: "Dining" }],
              accounts: [{ accountId: "checking", name: "Checking" }],
              needsLookCount: transactions.length
            }
          }
        })
      };
    })
  );
  return reads;
}

async function selectReview(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.root.findAllByProps({ className: "jds-segmented__opt" })[1]!.props.onClick();
  });
}

function expectReviewEmpty(renderer: ReactTestRenderer): void {
  expect(text(renderer)).toContain("Nothing needs a look");
  expect(text(renderer)).toContain("No transactions in this view need review.");
  expect(text(renderer)).not.toContain("sure about everything");
}

describe("Finance review empty state scope", () => {
  it("describes an unsearched review view without conflating it with an unsynced month", async () => {
    financeRead();
    const renderer = await mount(createElement(TransactionsScreen));
    expect(text(renderer)).toContain("Add or import transactions in Accounts.");
    await selectReview(renderer);
    expectReviewEmpty(renderer);
    expect(text(renderer)).not.toContain("Add or import transactions in Accounts.");
  });

  it("keeps its claim scoped when search and month filters narrow the view", async () => {
    const reads = financeRead();
    const renderer = await mount(createElement(TransactionsScreen));
    await selectReview(renderer);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Search payees or notes" }).props.onChange({
        target: { value: "Coffee" }
      });
      renderer.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === "September 2026")!
        .props.onClick();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(reads.at(-1)).toMatchObject({
      month: "2026-09",
      search: "Coffee",
      needsLookOnly: true
    });
    expectReviewEmpty(renderer);
  });

  it("describes the view after the last visible transaction is locally confirmed", async () => {
    financeRead([
      {
        id: "last-visible",
        accountId: "checking",
        date: "2026-10-08",
        amountCents: 1250,
        isoCurrency: "USD",
        name: "Coffee",
        categoryId: "dining",
        reviewState: "needs_look"
      }
    ]);
    const renderer = await mount(createElement(TransactionsScreen));
    await selectReview(renderer);
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => collect(node) === "Confirm all 1")!
        .props.onClick();
    });
    expectReviewEmpty(renderer);
    expect(text(renderer)).not.toContain("Confirm all");
  });
});

it.each(["food", "finance", "job-search"])("keeps %s app-map metadata valid", (moduleId) => {
  const manifest = JSON.parse(
    readFileSync(resolve("external-modules", moduleId, "jarvis.module.json"), "utf8")
  ) as Record<string, unknown>;
  const errors: string[] = [];
  expect(validateModuleAppMap(manifest, moduleId, errors)).toBeDefined();
  expect(errors).toEqual([]);
});
