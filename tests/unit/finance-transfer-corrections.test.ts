import type {
  TransferReview,
  TransferCorrection
} from "../../external-modules/finance/src/domain/transfer-corrections.js";
import type { TransferResult } from "../../external-modules/finance/src/domain/manual-transfers.js";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  transferReviewHandler,
  transferReverseHandler
} from "../../external-modules/finance/src/worker/handlers/transfer-corrections.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const input = {
  operationId: "99000000-0000-4000-8000-000000000002",
  originalTransferId: "99000000-0000-4000-8000-000000000001",
  sourceRevision: "a".repeat(32),
  fromRevision: "b".repeat(32),
  toRevision: "c".repeat(32),
  date: "2026-10-29",
  cleared: false
};
function fixture() {
  const read = vi.fn<(id: string) => Promise<TransferReview | null>>(async (_id) => ({
    transferId: input.originalTransferId,
    fromAccountId: "cash",
    toAccountId: "card",
    fromName: "Owned cash",
    toName: "Owned card",
    date: "2026-10-28",
    amountCents: 1234,
    isoCurrency: "USD",
    sourceRevision: input.sourceRevision,
    intact: true,
    correctedBy: null,
    correctsTransferId: null
  }));
  const reverse = vi.fn<(change: TransferCorrection) => Promise<TransferResult>>(
    async () => "created"
  );
  const ports = {
    localTimezone: "America/Los_Angeles",
    now: () => new Date("2026-10-30T00:30:00Z"),
    store: async () => ({
      transferCorrections: { read, reverse },
      transfers: { accounts: async () => [] }
    })
  } as unknown as WorkerPorts;
  return { ports, read, reverse };
}
describe("audited transfer correction inputs", () => {
  it("derives the exact inverse from the owned original and uses stable financial replay identity", async () => {
    const f = fixture();
    expect(
      await transferReviewHandler(f.ports)({ originalTransferId: input.originalTransferId })
    ).toMatchObject({ today: "2026-10-29", supported: true });
    const run = transferReverseHandler(f.ports);
    expect(
      await run({ ...input, amountCents: 999999, isoCurrency: "EUR", fromAccountId: "foreign" })
    ).toMatchObject({ status: "ok" });
    const saved = f.reverse.mock.calls[0]![0];
    expect(saved).toMatchObject({
      fromAccountId: "card",
      toAccountId: "cash",
      amountCents: 1234,
      isoCurrency: "USD",
      today: "2026-10-29"
    });
    await run({ ...input, sourceRevision: "d".repeat(32), fromRevision: "e".repeat(32) });
    expect(f.reverse.mock.calls[1]![0].digest).toBe(saved.digest);
    await run({ ...input, cleared: true });
    expect(f.reverse.mock.calls[2]![0].digest).not.toBe(saved.digest);
  });
  it.each([
    { operationId: "bad" },
    { originalTransferId: "bad" },
    { operationId: input.originalTransferId },
    { sourceRevision: "stale" },
    { fromRevision: "stale" },
    { toRevision: "stale" },
    { date: "2026-10-30" },
    { date: "2026-02-30" },
    { cleared: "yes" }
  ])("refuses malformed reviews before writing: %j", async (patch) => {
    const f = fixture();
    await expect(transferReverseHandler(f.ports)({ ...input, ...patch })).rejects.toThrow();
    expect(f.reverse).not.toHaveBeenCalled();
  });
  it("requires an owned original and mapped native confirmation hook", async () => {
    const f = fixture();
    f.read.mockResolvedValue(null);
    await expect(transferReverseHandler(f.ports)(input)).rejects.toThrow(/owned/);
    expect(f.reverse).not.toHaveBeenCalled();
    const m = JSON.parse(readFileSync("external-modules/finance/jarvis.module.json", "utf8"));
    expect(
      m.assistantTools.find((t: { name: string }) => t.name === "finance.manual.transfer-reverse")
    ).toMatchObject({
      executionPolicy: "confirm",
      confirmWhenKeys: ["originalTransferId", "date"]
    });
  });
});
