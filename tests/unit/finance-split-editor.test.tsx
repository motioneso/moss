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

  it("does not call queue admission a successful save", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/queues/")
          ? { ok: true, status: 202, json: async () => ({ jobId: "synthetic-job" }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                invocation: { status: "succeeded", result: { transactions: [transaction] } }
              })
            }
      )
    );
    const pending = saveSplit(transaction, parts);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toContain("not confirmed yet");
  });

  it("confirms the persisted allocation, and detects a concurrent bank correction", async () => {
    vi.useFakeTimers();
    let saved = { ...transaction, splits: parts, splitRevision: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/queues/")
          ? { ok: true, status: 202, json: async () => ({ jobId: "synthetic-job" }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                invocation: { status: "succeeded", result: { transactions: [saved] } }
              })
            }
      )
    );
    const success = saveSplit(transaction, parts);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await success).toBeNull();
    saved = { ...saved, amountCents: 1200 };
    const conflict = saveSplit(transaction, parts);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await conflict).toContain("bank amount changed");
  });
});
