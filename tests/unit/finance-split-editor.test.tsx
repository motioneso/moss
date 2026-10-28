// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWriteQueues } from "../../external-modules/finance/src/web/api";
import {
  saveSplit,
  SplitEditor,
  type SplitTransaction
} from "../../external-modules/finance/src/web/split-editor";

const transaction: SplitTransaction = {
  id: "synthetic",
  accountId: "cash",
  date: "2026-10-01",
  amountCents: 1001,
  isoCurrency: "USD",
  name: "Synthetic shop",
  categoryId: "groceries"
};
const parts = [
  { categoryId: "groceries", amountCents: 700 },
  { categoryId: "dining", amountCents: 301 }
];
afterEach(() => {
  resetWriteQueues();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("split editor", () => {
  it("keeps save unavailable until categories and exact total are valid", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(SplitEditor, {
          transaction,
          categories: [
            { id: "groceries", name: "Groceries" },
            { id: "dining", name: "Dining" }
          ],
          onClose: vi.fn(),
          onSaved: vi.fn()
        })
      );
    });
    const save = () =>
      renderer.root.findAllByType("button").find((b) => b.children.includes("Save split"))!;
    expect(save().props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findAllByType("select")[1]!.props.onChange({ target: { value: "dining" } });
      renderer.root.findAllByType("input")[0]!.props.onChange({ target: { value: "7.00" } });
      renderer.root.findAllByType("input")[1]!.props.onChange({ target: { value: "3.00" } });
    });
    expect(save().props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findAllByType("input")[1]!.props.onChange({ target: { value: "3.01" } });
    });
    expect(save().props.disabled).toBe(false);
    expect(transaction.amountCents).toBe(1001);
    await act(async () => renderer.unmount());
  });

  it("fails closed on an older host and never submits a legacy queue job", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await saveSplit(transaction, parts)).toContain("Update Moss");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("awaits the committed tool result with the exact optimistic concurrency fields", async () => {
    const invoke = vi.fn(async () => ({
      status: "succeeded" as const,
      result: { status: "ok", parts: 2 }
    }));
    expect(await saveSplit(transaction, parts, { invoke })).toBeNull();
    expect(invoke).toHaveBeenCalledWith("finance.transaction.split", {
      transactionId: "synthetic",
      accountId: "cash",
      month: "2026-10",
      expectedAmountCents: 1001,
      expectedCurrency: "USD",
      expectedRevision: 0,
      categoryIds: ["groceries", "dining"],
      amountsCents: [700, 301]
    });
  });

  it("keeps the editor draft on a conflict, cancellation or uncertain result", async () => {
    expect(
      await saveSplit(transaction, parts, {
        invoke: async () => ({ status: "rejected", moduleCode: "stale_transaction" })
      })
    ).toContain("currency or allocation changed");
    expect(
      await saveSplit(transaction, parts, { invoke: async () => ({ status: "cancelled" }) })
    ).toContain("cancelled");
    expect(
      await saveSplit(transaction, parts, { invoke: async () => ({ status: "failed" }) })
    ).toContain("check the result before retrying");
    expect(
      await saveSplit(transaction, parts, {
        invoke: async () => ({ status: "succeeded", result: { status: "queued" } })
      })
    ).toContain("could not be confirmed");
  });
});
