// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { TransactionConfirm } from "../../external-modules/finance/src/web/transaction-confirm";
import { transactionsConfirmHandler } from "../../external-modules/finance/src/worker/handlers/transaction-bulk.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const rows = [
  {
    id: "one",
    writeRevision: "a".repeat(32),
    name: "Synthetic review",
    date: "2026-10-30",
    categoryId: "groceries",
    amountCents: 1251,
    isoCurrency: "USD"
  }
];
const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((b) => b.children.join("") === label)!;
async function render(outcome: ModuleToolOutcome) {
  const props = {
    rows,
    categories: [{ id: "groceries", name: "Groceries" }],
    tools: { invoke: vi.fn(async () => outcome) },
    readVersion: {},
    readSnapshot: {},
    readFailed: false,
    onReload: vi.fn(),
    onSaved: vi.fn()
  };
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(createElement(TransactionConfirm, props));
  });
  return { r, props };
}
describe("captured confirmation lifecycle", () => {
  it("captures bounded rows, revisions and labels, retaining them after host cancellation", async () => {
    const { r, props } = await render({ status: "cancelled" });
    await act(async () =>
      r.update(
        createElement(TransactionConfirm, {
          ...props,
          rows: Array.from({ length: 201 }, (_, i) => ({ ...rows[0]!, id: String(i) }))
        })
      )
    );
    await act(async () => button(r, "Review 200 categories").props.onClick());
    await act(async () =>
      r.update(
        createElement(TransactionConfirm, {
          ...props,
          rows: [{ ...rows[0]!, writeRevision: "b".repeat(32) }],
          categories: [{ id: "groceries", name: "Changed label" }]
        })
      )
    );
    await act(async () => button(r, "Confirm reviewed categories").props.onClick());
    expect(props.tools.invoke).toHaveBeenCalledWith("finance.transactions.confirm", {
      rows: Array.from({ length: 200 }, (_, i) => ({
        id: String(i),
        writeRevision: "a".repeat(32)
      }))
    });
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toContain("Groceries");
    expect(JSON.stringify(r.toJSON())).toContain("Cancelled. Your captured review is kept");
    expect(button(r, "Confirm reviewed categories").props.disabled).toBe(false);
    await act(async () => r.unmount());
  });
  it("claims confirmation only after persisted success and suppresses double submission", async () => {
    const { r, props } = await render({ status: "succeeded", result: { status: "ok" } });
    let finish!: (result: ModuleToolOutcome) => void;
    props.tools.invoke.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        })
    );
    await act(async () => button(r, "Review 1 category").props.onClick());
    await act(async () => {
      button(r, "Confirm reviewed categories").props.onClick();
    });
    expect(props.onSaved).not.toHaveBeenCalled();
    await act(async () => {
      button(r, "Confirming categories…").props.onClick();
    });
    expect(props.tools.invoke).toHaveBeenCalledOnce();
    await act(async () => finish({ status: "succeeded", result: { status: "ok" } }));
    expect(props.onSaved).toHaveBeenCalledWith(["one"]);
    await act(async () => r.unmount());
  });
  it("keeps a stale batch blocked until an explicitly requested fresh successful read", async () => {
    const { r, props } = await render({
      status: "rejected",
      moduleCode: "stale_transactions"
    });
    await act(async () => button(r, "Review 1 category").props.onClick());
    await act(async () => button(r, "Confirm reviewed categories").props.onClick());
    expect(button(r, "Confirm reviewed categories").props.disabled).toBe(true);
    await act(async () => button(r, "Back to register").props.onClick());
    await act(async () => button(r, "Check saved records").props.onClick());
    expect(props.onReload).toHaveBeenCalledOnce();
    expect(button(r, "Checking saved records…").props.disabled).toBe(true);
    const failed = { ...props, readVersion: null, readSnapshot: {}, readFailed: true };
    await act(async () => r.update(createElement(TransactionConfirm, failed)));
    expect(button(r, "Review 1 category").props.disabled).toBe(true);
    await act(async () => button(r, "Check saved records").props.onClick());
    // The old failed snapshot must not count as the retry finishing.
    expect(button(r, "Checking saved records…").props.disabled).toBe(true);
    await act(async () =>
      r.update(createElement(TransactionConfirm, { ...props, readVersion: {}, readSnapshot: {} }))
    );
    expect(button(r, "Review 1 category").props.disabled).toBe(false);
    expect(props.onSaved).not.toHaveBeenCalled();
    await act(async () => r.unmount());
  });
  it("rejects malformed and duplicate references before storage", async () => {
    const store = vi.fn(async () => ({}));
    const run = transactionsConfirmHandler({ store } as unknown as WorkerPorts);
    for (const value of [
      [],
      [{ id: "", writeRevision: "a".repeat(32) }],
      [{ id: "x", writeRevision: "old" }],
      [rows[0], rows[0]]
    ])
      await expect(run({ rows: value })).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
    await expect(run({ rows: [{ id: "one", writeRevision: "a".repeat(32) }] })).rejects.toThrow(
      "Update Finance storage"
    );
  });
});
