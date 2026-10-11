// tests/unit/external-module-finance-activity.test.ts
import { describe, expect, it } from "vitest";

import { kvStore } from "../../external-modules/finance/src/domain/index.js";
import type { FinanceKv } from "../../external-modules/finance/src/domain/index.js";
import type { ActivityRecord } from "../../external-modules/finance/src/domain/store-port.js";
import {
  activityListHandler,
  activityUndoHandler
} from "../../external-modules/finance/src/worker/handlers/activity.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// #3186: the Settings activity list and the undo queue handler.

const NOW = new Date("2026-07-18T12:00:00Z");

function fakeKv(): FinanceKv {
  const buckets = new Map<string, Map<string, Record<string, unknown>>>();
  const ns = (name: string) => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      buckets.set(name, bucket);
    }
    return bucket;
  };
  return {
    get: async (namespace, key) => structuredClone(ns(namespace).get(key) ?? null),
    set: async (namespace, key, value) => {
      ns(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => ns(namespace).delete(key),
    list: async (namespace) => [...ns(namespace).keys()]
  };
}

function setup(rows: ActivityRecord[]) {
  const kv = fakeKv();
  const base = kvStore(kv);
  const appended: unknown[] = [];
  const ports = {
    kv,
    ai: null,
    db: null,
    isAdmin: false,
    now: () => NOW,
    store: async () => ({
      ...base,
      appendActivity: async (entry: unknown) => {
        appended.push(entry);
      },
      listActivity: async (from: string, to: string, limit: number) =>
        rows.filter((r) => r.at >= from && r.at < to).slice(0, limit),
      getActivity: async (id: string) => rows.find((r) => r.id === id) ?? null,
      markActivityUndone: async (id: string, at: string) => {
        const found = rows.find((r) => r.id === id);
        if (!found || found.undoneAt) return false;
        found.undoneAt = at;
        return true;
      }
    })
  } as unknown as WorkerPorts;
  return { kv, base, ports, appended };
}

const row = (over: Partial<ActivityRecord>): ActivityRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  at: "2026-07-17T10:00:00.000Z",
  actor: "moss",
  kind: "budget.assign",
  params: {},
  undo: null,
  undoneAt: null,
  ...over
});

const undo = (ports: WorkerPorts, activityId: string) =>
  activityUndoHandler(ports)({ jobKind: "finance.activity-undo", params: { activityId } });

describe("activity list", () => {
  it("returns rows in the window with undoable flags", async () => {
    const { ports } = setup([
      row({
        params: { month: "2026-07", categoryId: "groceries", amountCents: 5000, previousCents: 0 },
        undo: { month: "2026-07", categoryId: "groceries", amountCents: 0 }
      }),
      row({ id: "22222222-2222-4222-8222-222222222222", kind: "transaction.confirm" }),
      row({ id: "33333333-3333-4333-8333-333333333333", at: "2026-06-01T00:00:00.000Z" })
    ]);
    const out = (await activityListHandler(ports)({
      from: "2026-07-11T12:00:00Z",
      to: "2026-07-18T12:00:00Z"
    })) as { activity: Array<{ id: string; undoable: boolean; undone: boolean }> };
    expect(out.activity.map((a) => [a.id.slice(0, 2), a.undoable])).toEqual([
      ["11", true],
      ["22", false]
    ]);
  });

  it("rejects a bad timestamp", async () => {
    const { ports } = setup([]);
    await expect(activityListHandler(ports)({ from: "nope", to: "2026-07-18" })).rejects.toThrow();
  });
});

describe("activity undo", () => {
  it("restores an earlier assignment and logs a new user row", async () => {
    const r = row({
      params: { month: "2026-07", categoryId: "groceries", amountCents: 5000, previousCents: 1000 },
      undo: { month: "2026-07", categoryId: "groceries", amountCents: 1000 }
    });
    const { ports, base, appended } = setup([r]);
    await base.setAssignment("2026-07", "groceries", 5000);
    await undo(ports, r.id);
    expect((await base.getLedger("2026-07"))?.assignments.groceries).toBe(1000);
    expect(r.undoneAt).not.toBeNull();
    expect(appended).toHaveLength(1);
  });

  it("refuses when the amount changed since", async () => {
    const r = row({
      params: { month: "2026-07", categoryId: "groceries", amountCents: 5000, previousCents: 0 },
      undo: { month: "2026-07", categoryId: "groceries", amountCents: 0 }
    });
    const { ports, base } = setup([r]);
    await base.setAssignment("2026-07", "groceries", 7000);
    await expect(undo(ports, r.id)).rejects.toThrow(/changed/);
    expect(r.undoneAt).toBeNull();
  });

  it("refuses a row with no undo data and reports an already-undone row", async () => {
    const plain = row({ kind: "transaction.confirm" });
    const done = row({
      id: "44444444-4444-4444-8444-444444444444",
      undo: { month: "2026-07", categoryId: "x", amountCents: 0 },
      undoneAt: "2026-07-18T00:00:00.000Z"
    });
    const { ports } = setup([plain, done]);
    await expect(undo(ports, plain.id)).rejects.toThrow();
    expect(await undo(ports, done.id)).toMatchObject({ undone: true, alreadyUndone: true });
  });
});
