// tests/unit/external-module-finance-web-format.test.ts
import { describe, expect, it } from "vitest";

import { applyPending, settlePending } from "../../external-modules/finance/src/web/assign.js";

import {
  centsToAmountInput,
  parseAmountToCents
} from "../../external-modules/finance/src/web/format.js";

// FIN-03 (#1148) Task 4: the assign-input parser is the web side of the
// budget-apply params gate — anything it accepts must be a legal amountCents
// (integer, |cents| ≤ 100_000_000), and anything else must come back null so
// the screen keeps the previous value instead of enqueueing a bad job.

describe("parseAmountToCents", () => {
  it("parses plain dollars, currency symbols, and thousands separators", () => {
    expect(parseAmountToCents("50")).toBe(5000);
    expect(parseAmountToCents("$1,234.56")).toBe(123456);
    expect(parseAmountToCents(" 1 234.5 ")).toBe(123450);
    expect(parseAmountToCents(".75")).toBe(75);
    expect(parseAmountToCents("0")).toBe(0);
  });

  it("accepts negative amounts (un-assigning money back to TBB)", () => {
    expect(parseAmountToCents("-20")).toBe(-2000);
    expect(parseAmountToCents("-$3.25")).toBe(-325);
  });

  it("rejects empty, garbage, and sub-cent precision", () => {
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("   ")).toBeNull();
    expect(parseAmountToCents("abc")).toBeNull();
    expect(parseAmountToCents("12.3.4")).toBeNull();
    expect(parseAmountToCents("1e3")).toBeNull();
    expect(parseAmountToCents("5.999")).toBeNull();
    expect(parseAmountToCents("-")).toBeNull();
    expect(parseAmountToCents(".")).toBeNull();
  });

  it("rejects amounts beyond the manifest bound (±$1M in cents)", () => {
    expect(parseAmountToCents("1000000")).toBe(100_000_000);
    expect(parseAmountToCents("1000000.01")).toBeNull();
    expect(parseAmountToCents("-1000000.01")).toBeNull();
  });
});

describe("centsToAmountInput", () => {
  it("round-trips with the parser", () => {
    expect(centsToAmountInput(123456)).toBe("1234.56");
    expect(centsToAmountInput(0)).toBe("0.00");
    expect(centsToAmountInput(-2000)).toBe("-20.00");
    expect(parseAmountToCents(centsToAmountInput(37655))).toBe(37655);
  });
});

// #3174: typing an assigned amount in place on Budget.
describe("typed budget amounts", () => {
  it("a pending amount replaces the assigned total and moves available by the difference", () => {
    const line = { id: "groceries", assigned: 65_000, available: 23_173 };
    expect(applyPending(line, { groceries: 70_000 })).toEqual({
      assigned: 70_000,
      available: 28_173
    });
    expect(applyPending(line, { dining: 1 })).toEqual({ assigned: 65_000, available: 23_173 });
  });

  it("settling splits pending amounts into confirmed and mismatched by the server totals", () => {
    expect(
      settlePending({ groceries: 70_000, dining: 5_000, fun: 0 }, { groceries: 70_000, dining: 1 })
    ).toEqual({ confirmed: ["groceries", "fun"], mismatched: ["dining"] });
  });
});
