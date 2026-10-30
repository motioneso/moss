import { toSharedTransaction } from "../../external-modules/finance/src/domain/shared-pool.js";
import { effectiveTransferIds } from "../../external-modules/finance/src/domain/transfers.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
import { describe, it, expect, vi } from "vitest";
import {
  transferContextHandler,
  transferCreateHandler
} from "../../external-modules/finance/src/worker/handlers/manual-transfers.js";
import { transferBalance } from "../../external-modules/finance/src/web/manual-transfer.js";
import type { TransferAccount } from "../../external-modules/finance/src/domain/manual-transfers.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const input = {
  operationId: "88000000-0000-4000-8000-000000000001",
  fromAccountId: "manual:from",
  toAccountId: "manual:to",
  fromRevision: "a".repeat(32),
  toRevision: "b".repeat(32),
  date: "2026-10-29",
  amountCents: 1234,
  isoCurrency: "USD",
  cleared: true
};
function fixture() {
  const create = vi.fn(async (_input: unknown) => "created" as string),
    accounts = vi.fn(async () => []);
  const ports = {
    localTimezone: "America/Los_Angeles",
    now: () => new Date("2026-10-30T00:30:00Z"),
    store: async () => ({ transfers: { create, accounts } })
  } as unknown as WorkerPorts;
  return { ports, create, accounts };
}
describe("reviewed linked transfer inputs", () => {
  it("uses owner-local date and stable financial identity across refreshed versions", async () => {
    const f = fixture();
    expect(await transferContextHandler(f.ports)({})).toMatchObject({
      today: "2026-10-29",
      supported: true
    });
    expect(await transferCreateHandler(f.ports)(input)).toMatchObject({
      status: "ok",
      transferId: input.operationId
    });
    await transferCreateHandler(f.ports)({
      ...input,
      fromRevision: "c".repeat(32),
      today: "2099-01-01",
      actorUserId: "ignored"
    });
    const first = f.create.mock.calls[0]![0] as Record<string, unknown>,
      second = f.create.mock.calls[1]![0] as Record<string, unknown>;
    expect(first.today).toBe("2026-10-29");
    expect(first.digest).toBe(second.digest);
    await transferCreateHandler(f.ports)({ ...input, amountCents: 1235 });
    expect((f.create.mock.calls[2]![0] as Record<string, unknown>).digest).not.toBe(first.digest);
  });
  it.each([
    { operationId: "bad" },
    { fromAccountId: "" },
    { toAccountId: input.fromAccountId },
    { fromRevision: "stale" },
    { amountCents: 0 },
    { amountCents: -1 },
    { amountCents: 1.1 },
    { amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { isoCurrency: "JPY" },
    { date: "2026-10-30" },
    { date: "2026-02-30" },
    { cleared: "yes" }
  ])("rejects invalid financial inputs before mutation: %j", async (patch) => {
    const f = fixture();
    await expect(transferCreateHandler(f.ports)({ ...input, ...patch })).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("returns safe replay success and rejects changed/conflicting operations without retries", async () => {
    const f = fixture();
    f.create.mockResolvedValueOnce("unchanged");
    expect(await transferCreateHandler(f.ports)(input)).toMatchObject({
      status: "ok",
      unchanged: true
    });
    f.create.mockResolvedValueOnce("changed");
    await expect(transferCreateHandler(f.ports)(input)).rejects.toMatchObject({
      code: "transfer_changed"
    });
    f.create.mockResolvedValueOnce("conflict");
    await expect(transferCreateHandler(f.ports)(input)).rejects.toMatchObject({
      code: "transfer_conflict"
    });
    expect(f.create).toHaveBeenCalledTimes(3);
  });
  it("previews exact cash/card signs and refuses unsafe resulting money", () => {
    const account = { balanceCents: 10000, type: "depository" } as TransferAccount;
    expect(transferBalance(account, 1234)).toBe(8766);
    expect(transferBalance({ ...account, type: "credit" }, -1234)).toBe(8766);
    expect(transferBalance({ ...account, type: "credit" }, 1234)).toBe(11234);
    expect(
      transferBalance(
        { ...account, balanceCents: Number.MAX_SAFE_INTEGER },
        Number.MAX_SAFE_INTEGER
      )
    ).toBe(0);
    expect(() =>
      transferBalance({ ...account, balanceCents: Number.MAX_SAFE_INTEGER }, -1)
    ).toThrow();
  });
  it("never pairs an unrelated purchase with a leg that already has a durable transfer link", () => {
    const row = {
      date: "2026-10-29",
      name: "Synthetic movement",
      amountCents: 1234,
      isoCurrency: "USD",
      pending: false,
      pendingTransactionId: null,
      merchant: null,
      plaidCategory: null,
      categorizedBy: "user",
      reviewState: "confirmed"
    } as const;
    const rows: TransactionRecord[] = [
      { ...row, id: "a-unrelated", accountId: "another-account", categoryId: "groceries" },
      {
        ...row,
        id: "transfer:out",
        accountId: "cash",
        categoryId: "transfers",
        transferId: input.operationId
      },
      {
        ...row,
        id: "transfer:in",
        accountId: "savings",
        amountCents: -1234,
        categoryId: "transfers",
        transferId: input.operationId
      }
    ];
    expect([...effectiveTransferIds(rows)].sort()).toEqual(["transfer:in", "transfer:out"]);
    const mirrored = rows.map((r) =>
      toSharedTransaction({ ...r, notes: "Synthetic owner-only note" })
    );
    expect([...effectiveTransferIds(mirrored)].sort()).toEqual(["transfer:in", "transfer:out"]);
    expect(mirrored[1]?.transferId).toBe(input.operationId);
    expect(mirrored[1]).not.toHaveProperty("notes");
  });
});
