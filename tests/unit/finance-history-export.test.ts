import { describe, expect, it, vi } from "vitest";
import {
  MAX_HISTORY_ROWS,
  ownedHistoryCsv,
  type HistoryRow
} from "../../external-modules/finance/src/domain/history-export.js";
import { historyExportHandler } from "../../external-modules/finance/src/worker/handlers/history-export.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const row = (extra: Partial<HistoryRow> = {}): HistoryRow => ({
  id: "owned-row",
  accountId: "cash",
  accountName: "Cash",
  date: "2026-10-30",
  name: "Synthetic groceries",
  amountCents: 1501,
  isoCurrency: "USD",
  categoryId: "groceries",
  categoryName: "Groceries",
  pending: false,
  cleared: true,
  reconciledAt: null,
  splits: [],
  ...extra
});
function fixture(rows: HistoryRow[] = [row()], count = rows.length) {
  const read = vi.fn(async () => ({ rows, totalCount: count }));
  const ports = {
    store: async () => ({ historyExport: { read } }),
    now: () => new Date("2026-10-30T01:02:03Z")
  } as unknown as WorkerPorts;
  return { read, ports, handler: historyExportHandler(ports) };
}
describe("owned history export", () => {
  it("keeps signed cents, parent rows, currency and split allocations exact", () => {
    const csv = ownedHistoryCsv([
      row({
        splits: [
          { categoryId: "groceries", name: "Groceries", amountCents: 1601 },
          { categoryId: "income", name: "Income", amountCents: -100 }
        ]
      }),
      row({ id: "refund", amountCents: -301, isoCurrency: "EUR", pending: true, cleared: null })
    ]);
    expect(csv).toContain(',15.01,,"USD","Posted","Yes",');
    expect(csv).toContain(',,3.01,"EUR","Pending","Not tracked",');
    expect(csv).toContain(
      '"Groceries [groceries]: 16.01 USD; Income [income]: -1.00 USD","Balanced"'
    );
    expect(csv.split("\r\n")).toHaveLength(4);
    expect(ownedHistoryCsv([row({ amountCents: Number.MAX_SAFE_INTEGER })])).toContain(
      ",90071992547409.91,"
    );
    expect(
      ownedHistoryCsv([row({ splits: [{ categoryId: "g", name: "G", amountCents: 1 }] })])
    ).toContain('"Unbalanced"');
  });
  it("quotes delimiters/newlines and neutralizes formula and control prefixes in every text field", () => {
    const csv = ownedHistoryCsv([
      row({
        name: ' =HYPERLINK("x")\nnext',
        accountName: "\t+formula",
        accountId: "@account",
        categoryName: "-category",
        id: "\r=identity"
      })
    ]);
    expect(csv).toContain('"\' =HYPERLINK(""x"")\nnext"');
    expect(csv).toContain('"\'\t+formula"');
    expect(csv).toContain('"\'@account"');
    expect(csv).toContain('"\'-category"');
    expect(csv).toContain('"\'\r=identity"');
    expect(csv).not.toContain("notes");
  });
  it("prepares a fresh explicit scope with counts, provenance time and no hidden writes", async () => {
    const { handler, read } = fixture();
    const result = await handler({
      actorUserId: "owner",
      from: "2024-02-29",
      through: "2026-10-30",
      accountId: "cash"
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({
      from: "2024-02-29",
      through: "2026-10-30",
      accountId: "cash"
    });
    expect(result).toMatchObject({
      status: "ready",
      totalCount: 1,
      preparedAt: "2026-10-30T01:02:03.000Z"
    });
    expect(result.csv).toBe(ownedHistoryCsv([row()]));
  });
  it.each([
    { from: "2026-02-29" },
    { through: "2026-04-31" },
    { from: "" },
    { from: "2026-10-30", through: "2026-10-29" },
    { accountId: "" },
    { accountId: "a".repeat(257) }
  ])("rejects invalid scope before reading: %j", async (input) => {
    const { handler, read } = fixture();
    await expect(handler({ actorUserId: "owner", ...input })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses truncated or oversized files and discloses old storage", async () => {
    expect(await fixture([], MAX_HISTORY_ROWS + 1).handler({ actorUserId: "owner" })).toMatchObject(
      { status: "too_many", totalCount: 5001 }
    );
    await expect(fixture([], 1).handler({ actorUserId: "owner" })).rejects.toThrow(/incomplete/);
    expect(
      await fixture([row({ name: "é".repeat(1100000) })]).handler({ actorUserId: "owner" })
    ).toMatchObject({ status: "too_large" });
    expect(
      await historyExportHandler({ store: async () => ({}) } as unknown as WorkerPorts)({
        actorUserId: "owner"
      })
    ).toEqual({ status: "storage_update_required" });
    const empty = await fixture([]).handler({ actorUserId: "owner" });
    expect(empty).toMatchObject({ status: "ready", totalCount: 0 });
    expect(String(empty.csv).split("\r\n")).toHaveLength(2);
  });
});
