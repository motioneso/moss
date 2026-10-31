import { describe, it, expect } from "vitest";
import {
  handoffRequest,
  hydrateHandoffs
} from "../../external-modules/finance/src/domain/provider-handoffs.js";
import {
  reduceSyncPage,
  toRecord,
  type PlaidTx,
  type SyncPage,
  type ChunkMap
} from "../../external-modules/finance/src/domain/reduce.js";
const raw: PlaidTx = {
  transaction_id: "posted",
  account_id: "cash",
  date: "2026-10-01",
  amount: 12,
  iso_currency_code: "USD",
  name: "Synthetic settled",
  merchant_name: null,
  personal_finance_category: null,
  pending: false,
  pending_transaction_id: "pending"
};
const archived = {
  ...toRecord({
    ...raw,
    transaction_id: "pending",
    date: "2026-07-31",
    pending: true,
    amount: 10,
    pending_transaction_id: null
  }),
  categoryId: "groceries",
  categorizedBy: "user" as const,
  notes: "Synthetic private context",
  reviewState: "confirmed" as const
};
const page: SyncPage = { added: [raw], modified: [], removed: [] };
describe("private handoff workspace", () => {
  it("hydrates an exact older predecessor and consumes it without resurrecting a register row", () => {
    const chunks: ChunkMap = {},
      before = structuredClone(chunks),
      snapshot = structuredClone(archived);
    const hydrated = hydrateHandoffs(chunks, page, [archived]);
    const result = reduceSyncPage(hydrated, page);
    expect(result.chunks["cash:2026-07"]!.transactions).toEqual([]);
    expect(result.chunks["cash:2026-10"]!.transactions).toEqual([
      expect.objectContaining({
        id: "posted",
        amountCents: 1200,
        categoryId: "groceries",
        notes: archived.notes,
        reviewState: "needs_look"
      })
    ]);
    expect(chunks).toEqual(before);
    expect(archived).toEqual(snapshot);
  });
  it("ignores cross-account, manual and posted snapshots", () => {
    for (const source of [
      { ...archived, accountId: "other" },
      { ...archived, source: "manual" as const },
      { ...archived, pending: false }
    ])
      expect(hydrateHandoffs({}, page, [source])).toEqual({});
  });
  it("prefers the current canonical pending row to an older private snapshot", () => {
    const current = { ...archived, notes: "Synthetic current context" };
    const result = reduceSyncPage(
      hydrateHandoffs({ "cash:2026-07": { transactions: [current] } }, page, [archived]),
      page
    );
    expect(result.chunks["cash:2026-10"]!.transactions[0]!.notes).toBe(current.notes);
  });
  it("makes a replayed removal touch its source month so the mirror can recover", () => {
    const removal = { added: [], modified: [], removed: [{ transaction_id: archived.id }] };
    const result = reduceSyncPage(hydrateHandoffs({}, removal, [archived]), removal);
    expect(result.touched).toEqual(["cash:2026-07"]);
    expect(result.chunks["cash:2026-07"]!.transactions).toEqual([]);
  });
  it("preserves user metadata if pagination reintroduces the original pending identity", () => {
    const pendingPage = {
      added: [{ ...raw, transaction_id: archived.id, pending: true, pending_transaction_id: null }],
      modified: [],
      removed: []
    };
    const result = reduceSyncPage(hydrateHandoffs({}, pendingPage, [archived]), pendingPage);
    expect(result.chunks["cash:2026-10"]!.transactions[0]).toMatchObject({
      id: archived.id,
      notes: archived.notes,
      categoryId: "groceries"
    });
    expect(handoffRequest(page)).toEqual({
      removedIds: [],
      posted: [{ id: "pending", accountId: "cash" }],
      ids: ["posted", "pending"]
    });
  });
});
