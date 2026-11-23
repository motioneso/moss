import { describe, expect, it, vi } from "vitest";
import {
  transactionsConfirmHandler,
  transactionsUnconfirmHandler
} from "../../external-modules/finance/src/worker/handlers/transaction-bulk.js";

const rev = (c: string) => c.repeat(32);
const portsWith = (bulk: Record<string, unknown>) =>
  ({ store: async () => ({ bulk }) }) as unknown as Parameters<
    typeof transactionsConfirmHandler
  >[0];

describe("confirm and unconfirm handlers", () => {
  it("returns each row's new revision and prior source for the undo", async () => {
    const undo = [
      { id: "a", writeRevision: rev("b"), categorizedBy: "ai" },
      { id: "c", writeRevision: rev("d"), categorizedBy: null }
    ];
    const confirmWithUndo = vi.fn(async () => undo);
    const out = await transactionsConfirmHandler(portsWith({ confirmWithUndo }))({
      rows: [
        { id: "a", writeRevision: rev("1") },
        { id: "c", writeRevision: rev("2") }
      ]
    });
    expect(out).toEqual({ status: "ok", confirmed: 2, undo: { rows: undo } });
  });

  it("refuses a confirm when any row changed", async () => {
    const handler = transactionsConfirmHandler(portsWith({ confirmWithUndo: async () => null }));
    await expect(handler({ rows: [{ id: "a", writeRevision: rev("1") }] })).rejects.toMatchObject({
      code: "stale_transactions"
    });
  });

  it("hands the prior source of every row back to the store", async () => {
    const unconfirm = vi.fn(async () => true);
    const rows = [
      { id: "a", writeRevision: rev("b"), categorizedBy: "ai" },
      { id: "c", writeRevision: rev("d"), categorizedBy: null }
    ];
    await transactionsUnconfirmHandler(portsWith({ unconfirm }))({ rows });
    expect(unconfirm).toHaveBeenCalledWith(rows);
  });

  it("rejects an unknown source and a stale undo", async () => {
    const bad = transactionsUnconfirmHandler(portsWith({ unconfirm: async () => true }));
    await expect(
      bad({ rows: [{ id: "a", writeRevision: rev("b"), categorizedBy: "bogus" }] })
    ).rejects.toThrow();
    const stale = transactionsUnconfirmHandler(portsWith({ unconfirm: async () => false }));
    await expect(
      stale({ rows: [{ id: "a", writeRevision: rev("b"), categorizedBy: "ai" }] })
    ).rejects.toMatchObject({ code: "stale_transactions" });
  });
});
