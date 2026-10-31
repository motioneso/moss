import { describe, it, expect, vi } from "vitest";
import {
  manualAccountCreateHandler,
  manualEntryCreateHandler,
  manualContextHandler
} from "../../external-modules/finance/src/worker/handlers/manual-ledger.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import {
  parseLedgerAmount,
  manualSaveMessage
} from "../../external-modules/finance/src/web/manual-entry.js";
const accountInput = {
  operationId: "10000000-0000-4000-8000-000000000001",
  name: "Synthetic savings",
  accountType: "savings",
  isoCurrency: "USD",
  openingDate: "2026-10-27",
  openingBalanceCents: 123456
};
const entryInput = {
  operationId: "10000000-0000-4000-8000-000000000002",
  accountId: "manual:10000000-0000-4000-8000-000000000001",
  name: "Synthetic groceries",
  date: "2026-10-27",
  amountCents: 8243,
  isoCurrency: "USD",
  categoryId: "groceries",
  cleared: false
};
function fixture(zone = "America/Los_Angeles") {
  const createAccount = vi.fn(async (input: unknown) => {
    void input;
    return "created" as const;
  });
  const createEntry = vi.fn(async (input: unknown) => {
    void input;
    return "created" as const;
  });
  const ports = {
    localTimezone: zone,
    now: () => new Date("2026-10-28T00:30:00Z"),
    kv: { get: async () => null },
    store: async () => ({ manual: { createAccount, createEntry } })
  } as unknown as WorkerPorts;
  return { ports, createAccount, createEntry };
}
describe("manual entry validation and exact inputs", () => {
  it("uses the host timezone at midnight and refuses future dates before writing", async () => {
    const f = fixture();
    expect(await manualContextHandler(f.ports)({})).toMatchObject({ today: "2026-10-27" });
    await expect(
      manualAccountCreateHandler(f.ports)({
        ...accountInput,
        openingDate: "2026-10-28",
        localTimezone: "Pacific/Kiritimati"
      })
    ).rejects.toMatchObject({ code: "future_date" });
    expect(f.createAccount).not.toHaveBeenCalled();
    expect(await manualContextHandler(fixture("Pacific/Kiritimati").ports)({})).toMatchObject({
      today: "2026-10-28"
    });
  });
  it("keeps replay fingerprints stable across clocks and changes them for different entries", async () => {
    const f = fixture();
    const run = manualAccountCreateHandler(f.ports);
    expect(await run(accountInput)).toMatchObject({
      status: "ok",
      id: `manual:${accountInput.operationId}`
    });
    await run({ ...accountInput, actorUserId: "ignored", localTimezone: "ignored" });
    expect(f.createAccount.mock.calls[0]?.[0]).toEqual(f.createAccount.mock.calls[1]?.[0]);
    await run({ ...accountInput, name: "Another synthetic account" });
    expect(f.createAccount.mock.calls[0]?.[0]).not.toEqual(f.createAccount.mock.calls[2]?.[0]);
  });
  it.each([
    { openingDate: "2026-02-30" },
    { openingDate: "0000-01-01" },
    { openingBalanceCents: Number.MAX_SAFE_INTEGER + 1 },
    { openingBalanceCents: 1.5 },
    { isoCurrency: "JPY" },
    { accountType: "bank" },
    { name: "  " },
    { operationId: "not-a-uuid" }
  ])("rejects invalid account fields atomically: %j", async (change) => {
    const f = fixture();
    await expect(
      manualAccountCreateHandler(f.ports)({ ...accountInput, ...change })
    ).rejects.toThrow();
    expect(f.createAccount).not.toHaveBeenCalled();
  });
  it.each([
    { amountCents: 0 },
    { amountCents: NaN },
    { amountCents: Infinity },
    { categoryId: "transfers" },
    { categoryId: "not-real" },
    { cleared: "yes" },
    { date: "2026-10-28" }
  ])("rejects invalid entry fields: %j", async (change) => {
    const f = fixture();
    await expect(manualEntryCreateHandler(f.ports)({ ...entryInput, ...change })).rejects.toThrow();
    expect(f.createEntry).not.toHaveBeenCalled();
  });
  it("preserves signed refunds, own notes and clearance for the atomic store", async () => {
    const f = fixture();
    await manualEntryCreateHandler(f.ports)({
      ...entryInput,
      amountCents: -101,
      notes: "Synthetic private note",
      cleared: true
    });
    expect(f.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: -101,
        notes: "Synthetic private note",
        cleared: true,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
  });
  it("fails explicitly when legacy storage or host timezone is missing", async () => {
    const f = fixture();
    await expect(
      manualAccountCreateHandler({ ...f.ports, store: async () => ({}) as never })(accountInput)
    ).rejects.toMatchObject({ code: "storage_upgrade_required" });
    await expect(
      manualAccountCreateHandler({ ...f.ports, localTimezone: undefined })(accountInput)
    ).rejects.toMatchObject({ code: "timezone_required" });
  });
  it("parses exact cents at the safe boundary and rejects ambiguous or sub-cent input", () => {
    expect(parseLedgerAmount("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseLedgerAmount("-0.01")).toBe(-1);
    for (const value of ["1,23", "1,234.56", "0.001", "1e3", "90071992547409.92", "", "NaN"])
      expect(parseLedgerAmount(value)).toBeNull();
  });
  it("never turns cancellation, rejection or an ambiguous response into saved state", () => {
    expect(manualSaveMessage({ status: "succeeded", result: { status: "ok" } })).toBeNull();
    for (const outcome of [
      { status: "failed" },
      { status: "cancelled" },
      { status: "invalid_input" },
      { status: "rejected", moduleCode: "manual_conflict" },
      { status: "succeeded", result: {} }
    ] as const)
      expect(manualSaveMessage(outcome)).not.toBeNull();
  });
});
