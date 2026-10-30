// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import {
  TransactionDetails,
  captureTransactionDetails,
  type DetailTransaction
} from "../../external-modules/finance/src/web/transaction-details";
const record: DetailTransaction = {
  id: "synthetic",
  name: "Synthetic market",
  date: "2026-10-01",
  amountCents: 1234,
  isoCurrency: "USD",
  categoryId: "groceries",
  source: "manual",
  cleared: true
};
const props = (row: DetailTransaction = record) => ({
  row,
  accountName: "Synthetic checking",
  categoryName: "Groceries",
  categories: [
    { id: "groceries", name: "Groceries" },
    { id: "refund", name: "Refund" }
  ]
});
async function inspect(row: DetailTransaction, check: (r: ReactTestRenderer) => void) {
  let r!: ReactTestRenderer;
  try {
    await act(async () => {
      r = create(
        createElement(TransactionDetails, {
          captured: captureTransactionDetails(props(row)),
          onClose: vi.fn()
        })
      );
    });
    check(r);
  } finally {
    if (r) await act(async () => r.unmount());
  }
}
describe("captured transaction details", () => {
  it("renders the full multiline private note as read-only literal text", async () => {
    const notes = "<script>synthetic text</script>\n" + "多".repeat(1333);
    await inspect({ ...record, notes }, (r) => {
      const field = r.root.findByType("textarea");
      expect(field.props.value).toBe(notes);
      expect(field.props.readOnly).toBe(true);
      expect(r.root.findAllByType("script")).toHaveLength(0);
      expect(JSON.stringify(r.toJSON())).toContain("Money out");
      expect(JSON.stringify(r.toJSON())).toContain("$12.34");
    });
  });
  it("does not expose private notes from even a malformed household projection", async () => {
    await inspect({ ...record, shared: true, notes: "Synthetic forbidden household note" }, (r) => {
      expect(r.root.findAllByType("textarea")).toHaveLength(0);
      expect(JSON.stringify(r.toJSON())).toContain("Private notes are not shared.");
      expect(JSON.stringify(r.toJSON())).not.toContain("Synthetic forbidden household note");
      expect(JSON.stringify(r.toJSON())).toContain("Household · read only");
    });
  });
  it("explains empty notes and a zero movement", async () => {
    await inspect({ ...record, amountCents: 0, notes: "" }, (r) => {
      expect(JSON.stringify(r.toJSON())).toContain("No private note.");
      expect(JSON.stringify(r.toJSON())).toContain("No money movement");
    });
  });
  it.each([
    [{ pending: true }, "Pending"],
    [{ cleared: false }, "Uncleared"],
    [{ cleared: false, reconciledAt: "2026-10-01T12:00:00Z" }, "Reconciled"],
    [{ source: "provider" as const }, "Posted"]
  ])("distinguishes posting from manual statement status %s", async (patch, expected) => {
    await inspect({ ...record, ...patch }, (r) =>
      expect(JSON.stringify(r.toJSON())).toContain(expected)
    );
  });
  it("keeps the opened snapshot and signed split/refund allocations when props change", async () => {
    let r!: ReactTestRenderer;
    const row = {
      ...record,
      amountCents: -1234,
      notes: "Synthetic original note",
      splits: [
        { categoryId: "groceries", amountCents: -1334 },
        { categoryId: "refund", amountCents: 100 }
      ]
    };
    const captured = captureTransactionDetails(props(row));
    const onClose = vi.fn();
    try {
      await act(async () => {
        r = create(createElement(TransactionDetails, { captured, onClose }));
      });
      row.splits[0]!.amountCents = 9999;
      row.notes = "Synthetic newer note";
      const newer = captureTransactionDetails({
        ...props(row),
        accountName: "Synthetic renamed account"
      });
      await act(async () => r.update(createElement(TransactionDetails, { captured, onClose })));
      const shown = JSON.stringify(r.toJSON());
      expect(shown).toContain("Money in");
      expect(shown).toContain("$12.34");
      expect(shown).toContain("-$13.34");
      expect(shown).not.toContain("Synthetic newer note");
      expect(shown).not.toContain("Synthetic renamed account");
      expect(r.root.findByType("textarea").props.value).toBe("Synthetic original note");
      await act(async () =>
        r.root
          .findAllByType("button")
          .find((b) => b.children.includes("Back to register"))!
          .props.onClick()
      );
      expect(onClose).toHaveBeenCalledExactlyOnceWith();
      await act(async () =>
        r.update(createElement(TransactionDetails, { captured: newer, onClose }))
      );
      expect(r.root.findByType("textarea").props.value).toBe("Synthetic newer note");
    } finally {
      if (r) await act(async () => r.unmount());
    }
  });
});
