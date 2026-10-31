import { describe, expect, it } from "vitest";

import type { AccountRecord } from "../../external-modules/finance/src/domain/index.js";
import { deriveNetWorth } from "../../external-modules/finance/src/domain/index.js";

// FIN-05 (#1150): net-worth series from own snapshots (spec delta §"Net
// worth"). Pinned: carry-forward across gaps, NO back-fill before an
// account's first snapshot, credit/loan balances negated, headline = latest
// series point (from snapshots, never live AccountRecord.balanceCents).

function account(over: Partial<AccountRecord> & { accountId: string }): AccountRecord {
  return {
    itemId: "item-1",
    name: "Account",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "0000",
    balanceCents: 0,
    isoCurrency: "USD",
    updatedAt: "2026-07-18T00:00:00Z",
    ...over
  };
}

const WINDOW = ["2026-06", "2026-07"];

describe("deriveNetWorth", () => {
  it("refuses mixed-currency and overflowing net-worth sums", () => {
    expect(() =>
      deriveNetWorth(
        [account({ accountId: "usd" }), account({ accountId: "eur", isoCurrency: "EUR" })],
        {},
        WINDOW
      )
    ).toThrow(/currency/);
    expect(() =>
      deriveNetWorth(
        [account({ accountId: "a" }), account({ accountId: "b" })],
        {
          "a:2026-07": { days: { "2026-07-02": Number.MAX_SAFE_INTEGER } },
          "b:2026-07": { days: { "2026-07-02": 1 } }
        },
        WINDOW
      )
    ).toThrow(/safe integer/);
  });
  it("carries the last balance forward across snapshot gaps", () => {
    const series = deriveNetWorth(
      [account({ accountId: "a" }), account({ accountId: "b" })],
      {
        "a:2026-07": { days: { "2026-07-02": 1_000, "2026-07-09": 3_000 } },
        "b:2026-07": { days: { "2026-07-05": 500 } }
      },
      WINDOW
    );
    expect(series.points).toEqual([
      { date: "2026-07-02", totalCents: 1_000 },
      { date: "2026-07-05", totalCents: 1_500 },
      { date: "2026-07-09", totalCents: 3_500 }
    ]);
    expect(series.headlineCents).toBe(3_500);
  });

  it("never back-fills before an account's first snapshot", () => {
    const series = deriveNetWorth(
      [account({ accountId: "a" }), account({ accountId: "late" })],
      {
        "a:2026-07": { days: { "2026-07-01": 100 } },
        "late:2026-07": { days: { "2026-07-10": 900 } }
      },
      WINDOW
    );
    expect(series.points[0]).toEqual({ date: "2026-07-01", totalCents: 100 });
    expect(series.points[1]).toEqual({ date: "2026-07-10", totalCents: 1_000 });
  });

  it("negates credit and loan balances", () => {
    const series = deriveNetWorth(
      [account({ accountId: "cash" }), account({ accountId: "card", type: "credit" })],
      {
        "cash:2026-07": { days: { "2026-07-03": 10_000 } },
        "card:2026-07": { days: { "2026-07-03": 2_500 } }
      },
      WINDOW
    );
    expect(series.points).toEqual([{ date: "2026-07-03", totalCents: 7_500 }]);
  });

  it("carries pre-window snapshots into the window but never plots them", () => {
    const series = deriveNetWorth(
      [account({ accountId: "a" })],
      {
        "a:2026-05": { days: { "2026-05-20": 4_000 } },
        "a:2026-07": { days: { "2026-07-04": 6_000 } }
      },
      WINDOW
    );
    // 2026-05-20 is outside the window: no point for it, but a same-window
    // day from ANOTHER account would still see a's 4_000 carried forward.
    expect(series.points).toEqual([{ date: "2026-07-04", totalCents: 6_000 }]);
  });

  it("uses a pre-window balance for another account's in-window day", () => {
    const series = deriveNetWorth(
      [account({ accountId: "a" }), account({ accountId: "b" })],
      {
        "a:2026-05": { days: { "2026-05-20": 4_000 } },
        "b:2026-07": { days: { "2026-07-04": 6_000 } }
      },
      WINDOW
    );
    // b's July 4 point must include a's carried-forward May balance.
    expect(series.points).toEqual([{ date: "2026-07-04", totalCents: 10_000 }]);
  });

  it("ignores chunks for unknown accounts and yields null headline when empty", () => {
    const series = deriveNetWorth(
      [account({ accountId: "a" })],
      { "ghost:2026-07": { days: { "2026-07-01": 1 } } },
      WINDOW
    );
    expect(series).toEqual({ points: [], headlineCents: null });
  });
});
