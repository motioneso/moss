// tests/unit/finance-store-sql-draft.test.ts
// #3180: the draft statements are the contract (owner written in SQL, never a param),
// and a draft only becomes visible (status open) after every line is written.
import { describe, expect, it } from "vitest";

import type { FinanceDb } from "../../external-modules/finance/src/domain/index.js";
import { sqlStore } from "../../external-modules/finance/src/domain/index.js";

type Call = { text: string; params: readonly unknown[] };

function fakeDb(queued: readonly Record<string, unknown>[][] = []): FinanceDb & { calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...queued];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: (queue.length > 0 ? queue.shift()! : []) as never[] };
    }
  };
}

describe("sqlStore draft methods (#3180)", () => {
  it("createDraft writes the draft hidden, then its lines, then flips it open last", async () => {
    const db = fakeDb([[], [{ id: "d1" }]]);
    const id = await sqlStore(db).createDraft(
      {
        basisFrom: "2026-07-01",
        basisTo: "2026-09-30",
        monthlyIncomeCents: 500000,
        lines: [
          {
            categoryKey: "groceries",
            groupName: "Everyday",
            categoryName: "Groceries",
            basisMonthlyCents: 30433,
            proposedCents: 30500
          },
          {
            categoryKey: "rent",
            groupName: "Bills",
            categoryName: "Rent",
            basisMonthlyCents: 100000,
            proposedCents: 100000
          }
        ]
      },
      "2026-10-09T12:00:00.000Z"
    );
    expect(id).toBe("d1");
    expect(db.calls.map((c) => c.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "UPDATE app.finance_budget_drafts SET",
      "INSERT INTO app.finance_budget_drafts",
      "INSERT INTO app.finance_budget_draft_lines",
      "INSERT INTO app.finance_budget_draft_lines",
      "UPDATE app.finance_budget_drafts SET"
    ]);
    expect(db.calls[1]!.text).toContain(
      "app.current_actor_user_id(), gen_random_uuid(), 'discarded'"
    );
    expect(db.calls[4]).toEqual({
      text: "UPDATE app.finance_budget_drafts SET status = 'open' WHERE id = $1",
      params: ["d1"]
    });
  });

  it("markDraftStarted only moves an open draft", async () => {
    const db = fakeDb();
    await sqlStore(db).markDraftStarted("d1", "2026-10-09T12:00:00.000Z");
    expect(db.calls).toEqual([
      {
        text:
          "UPDATE app.finance_budget_drafts SET status = 'started', started_at = $2 " +
          "WHERE id = $1 AND status = 'open'",
        params: ["d1", "2026-10-09T12:00:00.000Z"]
      }
    ]);
  });

  it("getLatestDraft returns null when no open or started draft exists", async () => {
    const db = fakeDb([[]]);
    expect(await sqlStore(db).getLatestDraft()).toBeNull();
    expect(db.calls[0]!.text).toContain("WHERE status IN ('open', 'started')");
  });

  it("saveDraftLine upserts one line of an open draft only, with the owner written in SQL", async () => {
    const db = fakeDb();
    await sqlStore(db).saveDraftLine("d1", {
      categoryKey: "groceries",
      groupName: "Everyday",
      categoryName: "Groceries",
      basisMonthlyCents: 30433,
      proposedCents: 30500,
      adjustedCents: 60000,
      adjustedBy: "moss",
      dropped: false
    });
    expect(db.calls).toHaveLength(1);
    const call = db.calls[0]!;
    expect(call.text).toContain("SELECT app.current_actor_user_id(), $1");
    expect(call.text).toContain("status = 'open'");
    expect(call.text).toContain("ON CONFLICT (owner_user_id, draft_id, category_key) DO UPDATE");
    expect(call.params).toEqual([
      "d1",
      "groceries",
      "Everyday",
      "Groceries",
      30433,
      30500,
      60000,
      "moss",
      false
    ]);
  });
});
