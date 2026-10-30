import { describe, expect, it } from "vitest";
import { duplicateCandidates } from "../../external-modules/finance/src/domain/duplicates.js";
import { toRecord, type PlaidTx } from "../../external-modules/finance/src/domain/reduce.js";
import {
  initialRegisterScope,
  transactionsCsv
} from "../../external-modules/finance/src/web/register.js";

const raw: PlaidTx = {
  transaction_id: "one",
  account_id: "synthetic",
  date: "2026-10-01",
  amount: 10.01,
  iso_currency_code: "USD",
  name: "Synthetic 123",
  merchant_name: null,
  pending: false,
  pending_transaction_id: null,
  personal_finance_category: null
};

describe("register review and export", () => {
  it("suggests exact duplicates without changing either record", () => {
    const rows = [toRecord(raw), toRecord({ ...raw, transaction_id: "two" })];
    expect([...duplicateCandidates(rows)]).toEqual(["one", "two"]);
    expect(rows).toHaveLength(2);
  });
  it.each([
    { account_id: "other" },
    { iso_currency_code: "EUR" },
    { amount: -10.01 },
    { name: "Synthetic 456" },
    { date: "2026-10-02" }
  ])("keeps distinct purchases out of duplicate suggestions: %s", (over) => {
    expect(
      duplicateCandidates([toRecord(raw), toRecord({ ...raw, transaction_id: "two", ...over })])
        .size
    ).toBe(0);
  });
  it("exports exact signed money, currency, posting/scope, and safe spreadsheet text", () => {
    const csv = transactionsCsv(
      [toRecord({ ...raw, name: '=SUM(1,2)\n"shop"', amount: -10.01, pending: true })],
      () => "@bank",
      () => "Dining"
    );
    expect(csv).toContain('"\'=SUM(1,2)\n""shop"""');
    expect(csv).toContain('"\'@bank"');
    expect(csv).toContain(',10.01,"USD","Pending","Own"');
    expect(csv.split("\r\n")).toHaveLength(3);
  });
  it("exports a split once with its allocations and preserves the bank total", () => {
    const row = {
      ...toRecord(raw),
      splits: [
        { categoryId: "food", amountCents: 1201 },
        { categoryId: "refund", amountCents: -200 }
      ]
    };
    const csv = transactionsCsv(
      [row],
      () => "Checking",
      (part) => part.categoryId ?? "None"
    );
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain('"Split",10.01,,"USD"');
    expect(csv).toContain('"food: 12.01 USD; refund: -2.00 USD"');
  });
  it("exports every cent of safe integer inflows and outflows", () => {
    const csv = transactionsCsv(
      [
        { ...toRecord(raw), amountCents: Number.MAX_SAFE_INTEGER - 1 },
        { ...toRecord(raw), id: "refund", amountCents: -(Number.MAX_SAFE_INTEGER - 1) }
      ],
      () => "Synthetic",
      () => "Uncategorized"
    );
    expect(csv).toContain(',90071992547409.90,,"USD"');
    expect(csv).toContain(',,90071992547409.90,"USD"');
  });
});

describe("owned account history links", () => {
  it("keeps an explicit owner-only scope and a valid calendar month", () => {
    expect(initialRegisterScope("?month=2026-10&accountId=manual%3Atest&scope=own")).toEqual({
      month: "2026-10",
      accountId: "manual:test",
      ownOnly: true
    });
  });
  it("rejects malformed dates and oversized identifiers without broadening authority", () => {
    expect(
      initialRegisterScope("?month=2026-13&accountId=" + "x".repeat(257) + "&scope=own")
    ).toEqual({ ownOnly: true });
    expect(initialRegisterScope("?scope=another-owner")).toEqual({ ownOnly: false });
  });
});
