// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { BulkCategoryDialog } from "../../external-modules/finance/src/web/transaction-bulk";

const row = {
  id: "synthetic",
  name: "Synthetic market",
  date: "2026-10-01",
  amountCents: 1234,
  isoCurrency: "USD",
  writeRevision: "a".repeat(32)
};
const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(label))!;
async function render(outcome: ModuleToolOutcome) {
  const props = {
    rows: [row],
    category: { id: "dining", name: "Dining" },
    previousCategory: "Groceries",
    tools: { invoke: vi.fn(async () => outcome) },
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onUncertain: vi.fn()
  };
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(createElement(BulkCategoryDialog, props));
  });
  return { r, props };
}
describe("individual captured category review", () => {
  it("keeps the captured category, revision and before label after cancellation and refresh", async () => {
    const { r, props } = await render({ status: "cancelled" });
    await act(async () =>
      r.update(
        createElement(BulkCategoryDialog, {
          ...props,
          rows: [{ ...row, writeRevision: "b".repeat(32) }],
          category: { id: "savings", name: "Savings" },
          previousCategory: "Changed background label"
        })
      )
    );
    await act(async () => button(r, "Confirm category change").props.onClick());
    expect(props.tools.invoke).toHaveBeenCalledWith("finance.transactions.bulk-category", {
      categoryId: "dining",
      rows: [{ id: row.id, writeRevision: row.writeRevision }]
    });
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toContain("Groceries → Dining");
    expect(button(r, "Back to transactions")).toBeDefined();
    await act(async () => r.unmount());
  });
  it("suppresses immediate duplicate calls and announces success only after persistence", async () => {
    const { r, props } = await render({ status: "cancelled" });
    let finish!: (outcome: ModuleToolOutcome) => void;
    props.tools.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => {
      const submit = button(r, "Confirm category change").props.onClick;
      submit();
      submit();
      button(r, "Back to transactions").props.onClick();
    });
    expect(props.tools.invoke).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
    await act(async () => finish({ status: "succeeded", result: { status: "ok" } }));
    expect(props.onSaved).toHaveBeenCalledOnce();
    await act(async () => r.unmount());
  });
  it.each([
    { status: "failed" },
    { status: "rejected", moduleCode: "stale_transactions" }
  ] as const)("blocks uncertain or stale responses without retrying", async (outcome) => {
    const { r, props } = await render(outcome);
    await act(async () => button(r, "Confirm category change").props.onClick());
    expect(button(r, "Confirm category change").props.disabled).toBe(true);
    await act(async () => button(r, "Confirm category change").props.onClick());
    expect(props.tools.invoke).toHaveBeenCalledOnce();
    expect(props.onUncertain).toHaveBeenCalledOnce();
    expect(props.onSaved).not.toHaveBeenCalled();
    await act(async () => r.unmount());
  });
});
