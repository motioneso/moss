import { describe, it, expect } from "vitest";
import {
  reduceSyncPage,
  toRecord,
  type PlaidTx
} from "../../external-modules/finance/src/domain/reduce.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
const raw: PlaidTx = {
  transaction_id: "posted",
  account_id: "checking",
  date: "2026-10-01",
  amount: 12,
  iso_currency_code: "USD",
  name: "Synthetic settlement",
  merchant_name: null,
  personal_finance_category: null,
  pending: false,
  pending_transaction_id: "pending"
};
const pending: TransactionRecord = {
  ...toRecord({
    ...raw,
    transaction_id: "pending",
    date: "2026-09-30",
    amount: 10,
    pending: true,
    pending_transaction_id: null
  }),
  categoryId: "groceries",
  categorizedBy: "user",
  reviewState: "confirmed",
  notes: "Synthetic private note"
};
const settle = (source: TransactionRecord, incoming = raw, posted?: TransactionRecord) =>
  reduceSyncPage(
    {
      "checking:2026-09": { transactions: [source] },
      "checking:2026-10": { transactions: posted ? [posted] : [] }
    },
    { added: [incoming], modified: [], removed: [] }
  );
describe("pending settlement source and review", () => {
  it.each([
    { ...pending, pending: false },
    { ...pending, source: "manual" as const },
    { ...pending, accountId: "other-account" }
  ])("does not consume a posted, manual or different-account source: %j", (source) => {
    const result = settle(source);
    expect(result.chunks["checking:2026-09"]!.transactions).toEqual([source]);
    expect(result.chunks["checking:2026-10"]!.transactions[0]!.categoryId).toBe(null);
  });
  it.each([raw, { ...raw, amount: 10, iso_currency_code: "EUR" }])(
    "retains user fields but reopens review when settlement money changes: %j",
    (incoming) => {
      const result = settle(pending, incoming);
      expect(result.chunks["checking:2026-10"]!.transactions[0]).toMatchObject({
        categoryId: "groceries",
        categorizedBy: "user",
        notes: pending.notes,
        reviewState: "needs_look"
      });
      expect(result.chunks["checking:2026-09"]!.transactions).toEqual([]);
      expect(
        reduceSyncPage(result.chunks, { added: [incoming], modified: [], removed: [] }).touched
      ).toEqual([]);
    }
  );
  it("keeps a newer posted user choice ahead of an old pending twin during replay", () => {
    const posted: TransactionRecord = {
      ...toRecord(raw),
      categoryId: "dining",
      categorizedBy: "user",
      reviewState: "confirmed",
      notes: "Synthetic newer review"
    };
    expect(settle(pending, raw, posted).chunks["checking:2026-10"]!.transactions[0]).toMatchObject({
      categoryId: "dining",
      reviewState: "confirmed",
      notes: posted.notes
    });
  });
  it("retains a confirmed user choice when settlement money is unchanged", () => {
    expect(
      settle(pending, { ...raw, amount: 10 }).chunks["checking:2026-10"]!.transactions[0]
    ).toMatchObject({ categoryId: "groceries", reviewState: "confirmed", notes: pending.notes });
  });
});
