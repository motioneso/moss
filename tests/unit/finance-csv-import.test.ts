import { describe, it, expect, vi } from "vitest";
import {
  parseCsv,
  mapCsv,
  importedBalance,
  type CsvMapping
} from "../../external-modules/finance/src/domain/csv-import.js";
import {
  importApplyHandler,
  importPreviewHandler
} from "../../external-modules/finance/src/worker/handlers/import.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const mapping: CsvMapping = {
  date: 0,
  name: 1,
  amount: 2,
  inflow: -1,
  outflow: -1,
  notes: -1,
  currency: -1,
  dateFormat: "iso",
  amountMode: "positive-out"
};
const row = {
  sourceRow: 1,
  date: "2026-10-02",
  name: "Synthetic market",
  amountCents: 123,
  notes: "",
  allowDuplicate: false
};
const input = {
  accountId: "cash",
  isoCurrency: "USD",
  rows: [row],
  operationId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 2,
  cleared: true
};
function fixture() {
  const preview = vi.fn(async () => ({
    accountId: "cash",
    isoCurrency: "USD",
    openingDate: "2026-10-01",
    lastReconciledDate: null,
    revision: 2,
    balanceCents: 1000,
    debt: false,
    duplicateRows: []
  }));
  const apply = vi.fn(async (_input: unknown) => "created" as const);
  const ports = {
    localTimezone: "America/Los_Angeles",
    now: () => new Date("2026-10-28T00:30:00Z"),
    store: async () => ({ imports: { preview, apply } })
  } as unknown as WorkerPorts;
  return { ports, preview, apply };
}
describe("bounded CSV mapping", () => {
  it("reads BOM, CRLF, escaped quotes, commas and quoted newlines without losing notes", () => {
    const table = parseCsv(
      '\uFEFFDate,Payee,Amount,Notes\r\n2026-10-02,"Synthetic, ""shop""",1.23,"Line one\nLine two"\r\n'
    );
    expect(mapCsv(table, { ...mapping, notes: 3 }, "USD")).toEqual([
      { ...row, name: 'Synthetic, "shop"', notes: "Line one\nLine two" }
    ]);
  });
  it.each(['a,b\n"bad,b', 'a,b\nx"x,y', 'a,b\n"x"oops,y', "a,b\nx,y,z", "a,b\n", ""])(
    "rejects malformed or empty CSV %j",
    (text) => expect(() => parseCsv(text)).toThrow()
  );
  it("bounds bytes, columns and rows, preserving source row indices", () => {
    expect(() => parseCsv("a\n" + "x".repeat(1024 * 1024))).toThrow(/1 MiB/);
    expect(() => parseCsv("a\n" + "x\n".repeat(201))).toThrow(/200/);
    expect(() =>
      parseCsv(Array(51).fill("h").join(",") + "\n" + Array(51).fill("v").join(","))
    ).toThrow(/50/);
    const table = parseCsv(
      "Date,Payee,Amount\n2026-10-02,Synthetic one,1.23\n2026-10-03,Synthetic two,-4.56"
    );
    expect(mapCsv(table, mapping, "USD").map((r) => [r.sourceRow, r.amountCents])).toEqual([
      [1, 123],
      [2, -456]
    ]);
    expect(
      mapCsv(table, { ...mapping, amountMode: "positive-in" }, "USD").map((r) => r.amountCents)
    ).toEqual([-123, 456]);
  });
  it("requires explicit date order and valid leap days", () => {
    const table = parseCsv("Date,Payee,Amount\n02/03/2024,Synthetic,1");
    expect(mapCsv(table, { ...mapping, dateFormat: "mdy" }, "USD")[0]?.date).toBe("2024-02-03");
    expect(mapCsv(table, { ...mapping, dateFormat: "dmy" }, "USD")[0]?.date).toBe("2024-03-02");
    expect(() => mapCsv(table, mapping, "USD")).toThrow(/row 1/);
    expect(() => mapCsv(parseCsv("D,P,A\n2025-02-29,Synthetic,1"), mapping, "USD")).toThrow();
  });
  it("handles separate inflow/outflow without subtracting two nonzero entries", () => {
    const table = parseCsv("D,P,In,Out\n2026-10-02,Synthetic,2.34,\n2026-10-03,Synthetic,,1.23");
    const split = { ...mapping, amountMode: "separate" as const, inflow: 2, outflow: 3 };
    expect(mapCsv(table, split, "USD").map((r) => r.amountCents)).toEqual([-234, 123]);
    expect(() => mapCsv(parseCsv("D,P,In,Out\n2026-10-02,Synthetic,2,1"), split, "USD")).toThrow(
      /one nonnegative/
    );
  });
  it.each(["0.001", "90071992547409.92", "1e3", "0", "$1", '"1,234.56"'])(
    "refuses ambiguous/unsafe/zero money %s",
    (amount) => {
      expect(() =>
        mapCsv(parseCsv(`D,P,A\n2026-10-02,Synthetic,${amount}`), mapping, "USD")
      ).toThrow();
    }
  );
  it("bounds mapped text before host transport and before a worker write", async () => {
    const table = parseCsv(
      "D,P,A,N\n" +
        Array.from(
          { length: 200 },
          (_, index) => `2026-10-02,Synthetic ${index},1,${"x".repeat(4000)}`
        ).join("\n")
    );
    expect(() => mapCsv(table, { ...mapping, notes: 3 }, "USD")).toThrow(/too much text/);
    const f = fixture();
    await expect(
      importApplyHandler(f.ports)({
        ...input,
        rows: Array.from({ length: 200 }, (_, index) => ({
          ...row,
          sourceRow: index + 1,
          notes: "x".repeat(4000)
        }))
      })
    ).rejects.toMatchObject({ code: "import_too_large" });
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("requires unique mapped columns and exact currency; aggregates with BigInt", () => {
    const table = parseCsv("D,P,A,C\n2026-10-02,Synthetic,90071992547409.91,EUR");
    expect(() => mapCsv(table, { ...mapping, currency: 3 }, "USD")).toThrow(/currency/);
    expect(() => mapCsv(table, { ...mapping, amount: 1 }, "USD")).toThrow(/different column/);
    expect(mapCsv(table, mapping, "USD")[0]?.amountCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      importedBalance({ balanceCents: Number.MAX_SAFE_INTEGER, debt: false }, [
        { ...row, amountCents: -1 }
      ])
    ).toBeNull();
    expect(importedBalance({ balanceCents: 1000, debt: true }, [row])).toBe(1123);
  });
});
describe("import handler validation and replay contract", () => {
  it.each([
    { rows: [] },
    { rows: [row, row] },
    { rows: [{ ...row, sourceRow: 201 }] },
    { rows: [{ ...row, amountCents: 1.5 }] },
    { rows: [{ ...row, name: " " }] },
    { rows: [{ ...row, date: "2026-10-28" }] },
    { rows: [{ ...row, allowDuplicate: "yes" }] },
    { expectedRevision: -1 },
    { cleared: "yes" }
  ])("refuses invalid batch before writing %j", async (over) => {
    const f = fixture();
    await expect(importApplyHandler(f.ports)({ ...input, ...over })).rejects.toThrow();
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("validates every row before a write, never leaking row content in the error", async () => {
    const f = fixture();
    await expect(
      importApplyHandler(f.ports)({
        ...input,
        rows: [row, { ...row, sourceRow: 2, amountCents: Infinity }]
      })
    ).rejects.toThrow("amountCents must be an integer");
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("sorts source identity for replay and changes the digest for changed decisions", async () => {
    const f = fixture();
    const run = importApplyHandler(f.ports);
    const two = { ...row, sourceRow: 2 };
    await run({ ...input, rows: [two, row] });
    await run({ ...input, rows: [row, two], actorUserId: "ignored" });
    expect(f.apply.mock.calls[0]?.[0]).toEqual(f.apply.mock.calls[1]?.[0]);
    await run({ ...input, rows: [{ ...row, allowDuplicate: true }, two] });
    expect(f.apply.mock.calls[2]?.[0]).not.toEqual(f.apply.mock.calls[0]?.[0]);
  });
  it("returns the owner preview and checks opening and statement boundaries", async () => {
    const f = fixture();
    expect(await importPreviewHandler(f.ports)(input)).toMatchObject({
      status: "ok",
      resultingBalanceCents: 877
    });
    await expect(
      importPreviewHandler(f.ports)({ ...input, rows: [{ ...row, date: "2026-09-30" }] })
    ).rejects.toMatchObject({ code: "manual_invalid_date" });
    await expect(
      importPreviewHandler(f.ports)({ ...input, isoCurrency: "EUR" })
    ).rejects.toMatchObject({ code: "manual_unavailable" });
  });
});
