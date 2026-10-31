import { describe, it, expect, vi } from "vitest";
import {
  ledgerNetWorthInputs,
  netWorthCoverage
} from "../../external-modules/finance/src/domain/net-worth-ledger.js";
import { deriveNetWorth } from "../../external-modules/finance/src/domain/net-worth.js";
import { reportsNetWorthHandler } from "../../external-modules/finance/src/worker/handlers/reports.js";
import type {
  AccountRecord,
  SnapshotChunk
} from "../../external-modules/finance/src/domain/records.js";
import type { ManualDailyMovement } from "../../external-modules/finance/src/domain/manual-ledger.js";
import type { FinanceStore } from "../../external-modules/finance/src/domain/store-port.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const account = (accountId: string, extra: Partial<AccountRecord> = {}): AccountRecord => ({
  accountId,
  itemId: null,
  name: `Synthetic ${accountId}`,
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: null,
  balanceCents: 999999,
  isoCurrency: "USD",
  updatedAt: "2026-10-30T00:00:00Z",
  source: "manual",
  openingDate: "2026-09-01",
  openingBalanceCents: 10000,
  ...extra
});
const move = (
  accountId: string,
  date: string,
  amountCents: string,
  valid = true
): ManualDailyMovement => ({ accountId, date, amountCents, valid });
const accounts = [account("cash"), account("card", { type: "credit", openingBalanceCents: 5000 })];
const movements = [
  move("cash", "2026-09-30", "100"),
  move("cash", "2026-10-10", "900"),
  move("cash", "2026-10-11", "-100"),
  move("card", "2026-10-10", "700"),
  move("card", "2026-10-11", "-100")
];
const window = ["2026-09", "2026-10"],
  today = "2026-10-30";
function derive(
  a: AccountRecord[] = accounts,
  m: ManualDailyMovement[] = movements,
  snapshots: Record<string, SnapshotChunk> = {},
  supported = true
) {
  const input = ledgerNetWorthInputs(a, snapshots, m, today, window, supported);
  const series = deriveNetWorth(a, input.chunks, window, input.referenceDays);
  return { ...series, coverage: netWorthCoverage(input, a, series.points.at(-1)?.date ?? null) };
}
function scriptedPorts(
  a: AccountRecord[],
  m: ManualDailyMovement[] = [],
  snapshots: Record<string, SnapshotChunk> = {}
) {
  const read = vi.fn(async () => m);
  const store = {
    listAccounts: async () => a,
    manual: { netWorthMovements: read },
    listSnapshotChunks: async () =>
      Object.keys(snapshots).map((key) => ({
        accountId: key.slice(0, key.lastIndexOf(":")),
        month: key.slice(key.lastIndexOf(":") + 1)
      })),
    getSnapshotChunk: async (id: string, month: string) => snapshots[`${id}:${month}`]?.days ?? null
  } as unknown as FinanceStore;
  const ports = {
    now: () => new Date("2026-10-30T00:00:00Z"),
    localTimezone: "UTC",
    store: async () => store,
    mirror: {
      list: () => {
        throw new Error("Net worth must not read shared mirrors");
      }
    }
  } as unknown as WorkerPorts;
  return { ports, read };
}
describe("manual ledger net worth", () => {
  it("reconstructs assets, liabilities, refunds and pre-window carry without using live balance rows", () => {
    const result = derive();
    expect(result.headlineCents).toBe(3500);
    expect(result.points.find((p) => p.date === "2026-09-01")?.totalCents).toBe(5000);
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "cash",
          balanceCents: 9100,
          contributionCents: 9100,
          asOf: today,
          included: true
        }),
        expect.objectContaining({
          accountId: "card",
          balanceCents: 5600,
          contributionCents: -5600,
          asOf: today,
          included: true
        })
      ])
    );
    const history = ledgerNetWorthInputs(accounts, {}, movements, today, ["2026-10"], true);
    const october = deriveNetWorth(accounts, history.chunks, ["2026-10"], history.referenceDays);
    expect(october.points[0]).toEqual({ date: "2026-10-01", totalCents: 4900 });
  });
  it("conserves net worth across equal opposite manual account transfers", () => {
    expect(
      derive(accounts, [
        ...movements,
        move("cash", "2026-10-12", "2000"),
        move("card", "2026-10-12", "-2000")
      ]).headlineCents
    ).toBe(3500);
  });
  it("uses actual provider snapshots once, replaces legacy manual snapshots, and never invents missing valuations", () => {
    const bank = account("bank", {
      source: "provider",
      openingDate: undefined,
      openingBalanceCents: undefined
    });
    const result = derive([...accounts, bank], movements, {
      "bank:2026-09": { days: { "2026-09-15": 1000 } },
      "cash:2026-09": { days: { "2026-09-01": 888888 } }
    });
    expect(result.headlineCents).toBe(4500);
    expect(result.coverage.find((c) => c.accountId === "bank")).toMatchObject({
      source: "snapshot",
      asOf: "2026-09-15",
      contributionCents: 1000
    });
    const missing = derive([...accounts, bank]);
    expect(missing.headlineCents).toBe(3500);
    expect(missing.coverage.find((c) => c.accountId === "bank")).toMatchObject({
      included: false,
      reason: "no_snapshot"
    });
  });
  it("preserves a real zero balance and omits unsupported or missing manual baselines", () => {
    expect(derive([account("zero", { openingBalanceCents: 0 })], []).headlineCents).toBe(0);
    const missing = derive([account("missing", { openingBalanceCents: undefined })], []);
    expect(missing.headlineCents).toBeNull();
    expect(missing.coverage[0]).toMatchObject({ included: false, reason: "opening_missing" });
    expect(
      derive(accounts, movements, {}, false).coverage.every(
        (c) => c.reason === "storage_update_required"
      )
    ).toBe(true);
  });
  it("handles opening/year/leap boundaries and ignores future ledger and snapshot values", () => {
    const a = [account("leap", { openingDate: "2023-12-31", openingBalanceCents: 1000 })];
    const history = ledgerNetWorthInputs(
      a,
      {},
      [move("leap", "2024-02-29", "-25"), move("leap", "2024-03-02", "500")],
      "2024-03-01",
      ["2023-12", "2024-01", "2024-02", "2024-03"],
      true
    );
    const series = deriveNetWorth(
      a,
      history.chunks,
      ["2023-12", "2024-01", "2024-02", "2024-03"],
      history.referenceDays
    );
    expect(series.points).toEqual([
      { date: "2023-12-31", totalCents: 1000 },
      { date: "2024-02-29", totalCents: 1025 },
      { date: "2024-03-01", totalCents: 1025 }
    ]);
    expect(
      derive([account("bank", { source: "provider" })], [], {
        "bank:2026-10": { days: { "2026-10-01": 1000, "2026-10-31": 999999 } }
      }).headlineCents
    ).toBe(1000);
    expect(derive([account("future", { openingDate: "2026-11-01" })], []).coverage[0]?.reason).toBe(
      "not_open"
    );
  });
  it("does not backfill a reference day before any known balance", () => {
    const a = [account("new", { openingDate: "2026-10-10", openingBalanceCents: 50 })];
    const history = ledgerNetWorthInputs(a, {}, [], today, ["2026-10"], true);
    expect(deriveNetWorth(a, history.chunks, ["2026-10"], history.referenceDays).points).toEqual([
      { date: "2026-10-10", totalCents: 50 },
      { date: today, totalCents: 50 }
    ]);
  });
  it("keeps large internal movements and cancelling asset/debt totals exact", () => {
    const large = Number.MAX_SAFE_INTEGER;
    expect(
      derive(
        [account("wide", { openingBalanceCents: large })],
        [move("wide", "2026-10-01", String(BigInt(large) * 2n))]
      ).headlineCents
    ).toBe(-large);
    expect(
      derive(
        [
          account("a", { openingBalanceCents: large }),
          account("b", { openingBalanceCents: large }),
          account("c", { type: "loan", openingBalanceCents: large })
        ],
        []
      ).headlineCents
    ).toBe(large);
    expect(() =>
      derive(
        [
          account("a", { openingBalanceCents: large }),
          account("b", { openingBalanceCents: large })
        ],
        []
      )
    ).toThrow(/safe integer/);
  });
  it.each([
    move("cash", "2026-08-31", "1"),
    move("cash", "2026-09-10", "1", false),
    move("cash", "2026-09-10", "1.2"),
    move("cash", "2026-02-30", "1")
  ])("refuses invalid manual history without fabricating a balance: %j", (movement) => {
    expect(() => derive(accounts, [movement])).toThrow();
  });
  it("selects one currency, remains owner-only and uses the owner's local cutoff", async () => {
    const { ports, read } = scriptedPorts(
      [...accounts, account("eur", { isoCurrency: "EUR", openingBalanceCents: 999999 })],
      movements
    );
    const local = {
      ...ports,
      now: () => new Date("2026-11-01T02:00:00Z"),
      localTimezone: "America/Los_Angeles"
    };
    const result = await reportsNetWorthHandler(local)({
      actorUserId: "owner",
      currency: "USD",
      months: 1,
      through: "2099-01-01"
    });
    expect(result).toMatchObject({
      currency: "USD",
      window: ["2026-10"],
      headlineCents: 3500,
      asOf: "2026-10-31"
    });
    expect(read).toHaveBeenCalledWith("2026-10-31");
    expect((result.coverage as { accountId: string }[]).some((c) => c.accountId === "eur")).toBe(
      false
    );
    expect(await reportsNetWorthHandler(ports)({ actorUserId: "owner" })).toMatchObject({
      currencySelectionRequired: true,
      headlineCents: null
    });
  });
  it("returns an explicit unavailable result for invalid history and unsafe public totals", async () => {
    const invalid = scriptedPorts(accounts, [move("cash", "2026-10-01", "100", false)]);
    expect(
      await reportsNetWorthHandler(invalid.ports)({ actorUserId: "owner", currency: "USD" })
    ).toMatchObject({ headlineCents: null, points: [], unavailableReason: "invalid_history" });
    const large = Number.MAX_SAFE_INTEGER,
      unsafe = scriptedPorts([
        account("a", { openingBalanceCents: large }),
        account("b", { openingBalanceCents: large })
      ]);
    expect(
      await reportsNetWorthHandler(unsafe.ports)({ actorUserId: "owner", currency: "USD" })
    ).toMatchObject({ headlineCents: null, points: [], unavailableReason: "unsafe_money" });
  });
});
