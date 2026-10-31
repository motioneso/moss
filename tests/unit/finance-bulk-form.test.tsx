// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import {
  TransactionBulkBar,
  type BulkRow
} from "../../external-modules/finance/src/web/transaction-bulk";
const rows: BulkRow[] = [
  {
    id: "synthetic",
    name: "Synthetic market",
    date: "2026-10-15",
    amountCents: 123,
    isoCurrency: "USD",
    writeRevision: "a".repeat(32)
  }
];
const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(label))!;
async function render(status: ModuleToolOutcome) {
  const props = {
    selected: rows,
    loaded: rows,
    categories: [{ id: "groceries", name: "Groceries" }],
    tools: { invoke: vi.fn(async () => status) },
    onLoaded: vi.fn(),
    onClear: vi.fn(),
    onSaved: vi.fn(),
    onLockChange: vi.fn()
  };
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(createElement(TransactionBulkBar, props));
  });
  await act(async () =>
    r.root
      .findByProps({ "aria-label": "Category for selected transactions" })
      .props.onChange({ currentTarget: { value: "groceries" } })
  );
  await act(async () => button(r, "Review category change").props.onClick());
  return { r, props };
}
describe("bulk category review lifecycle", () => {
  it("keeps captured row revisions and category after cancellation and incoming refresh", async () => {
    const { r, props } = await render({ status: "cancelled" });
    await act(async () =>
      r.update(
        createElement(TransactionBulkBar, {
          ...props,
          selected: [{ ...rows[0]!, writeRevision: "b".repeat(32) }]
        })
      )
    );
    await act(async () => button(r, "Confirm category change").props.onClick());
    expect(props.tools.invoke).toHaveBeenLastCalledWith("finance.transactions.bulk-category", {
      categoryId: "groceries",
      rows: [{ id: "synthetic", writeRevision: "a".repeat(32) }]
    });
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onClear).not.toHaveBeenCalled();
    expect(button(r, "Confirm category change").props.disabled).toBe(false);
    await act(async () => button(r, "Confirm category change").props.onClick());
    expect(props.tools.invoke).toHaveBeenCalledTimes(2);
    await act(async () => r.unmount());
  });
  it.each(["failed", "stale"] as const)(
    "freezes a %s result until an explicit saved-record check",
    async (kind) => {
      const status: ModuleToolOutcome =
        kind === "failed"
          ? { status: "failed" }
          : { status: "rejected", moduleCode: "stale_transactions" };
      const { r, props } = await render(status);
      await act(async () => button(r, "Confirm category change").props.onClick());
      expect(button(r, "Confirm category change").props.disabled).toBe(true);
      await act(async () => button(r, "Confirm category change").props.onClick());
      expect(props.tools.invoke).toHaveBeenCalledTimes(1);
      expect(props.onLockChange).toHaveBeenCalledWith(true);
      await act(async () => button(r, "Back to selection").props.onClick());
      expect(button(r, "Review category change").props.disabled).toBe(true);
      await act(async () => button(r, "Check saved records and clear review").props.onClick());
      expect(props.onClear).toHaveBeenCalledTimes(1);
      expect(props.onLockChange).toHaveBeenLastCalledWith(false);
      await act(async () => r.unmount());
    }
  );
});
