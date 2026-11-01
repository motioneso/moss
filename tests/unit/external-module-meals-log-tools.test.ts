// tests/unit/external-module-meals-log-tools.test.ts
//
// Meals phase 2 slice 6 (#3890): the log tools and the estimate job, over an in-memory store.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { computeDayTotals, occasionForEntry } from "../../external-modules/meals/src/log/domain.js";
import { runLogEstimate } from "../../external-modules/meals/src/log/job.js";
import {
  logAdd,
  logCorrect,
  logDelete,
  logList,
  logReestimate,
  logSummarize
} from "../../external-modules/meals/src/log/tools.js";
import { InputError } from "../../external-modules/meals/src/tools/validate.js";
import { fakeLogDeps } from "./helpers/meals-log-fake.js";
import { AiError, ESTIMATE_800, kitchenOf, member, ScriptedAi } from "./helpers/meals-plan-fake.js";

const you = member({
  memberId: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "You",
  isSelf: true,
  calorieTarget: 2000,
  macroTargets: { proteinG: 120, carbG: 200, fatG: 70 }
});
const kitchen = kitchenOf([you]);

const rig = (options: Parameters<typeof fakeLogDeps>[1] = {}) => fakeLogDeps(kitchen, options);

/** Adds a meal and runs the queued estimate, the way the worker would. */
async function addAndEstimate(
  r: ReturnType<typeof rig>,
  description: string,
  key: string,
  extra: Record<string, unknown> = {}
) {
  const { entry } = await logAdd(r.deps, { description, idempotencyKey: key, ...extra });
  await runLogEstimate(r.jobDeps, r.jobs.take()!);
  return entry.entryId;
}

describe("meals.log.add", () => {
  it("saves the entry as pending and queues one estimate", async () => {
    const r = rig();
    const { entry } = await logAdd(r.deps, { description: "oatmeal", idempotencyKey: "k1" });
    expect(entry).toMatchObject({
      description: "oatmeal",
      estimateState: "pending",
      estimateRevision: 1,
      nutrients: null,
      items: []
    });
    expect(r.jobs.calls).toHaveLength(1);
    expect(r.jobs.calls[0]).toMatchObject({
      queue: "meals.log-estimate",
      idempotencyKey: `log-estimate:${entry.entryId}:r1`,
      params: { entryId: entry.entryId, revision: 1 }
    });
    expect(r.ai.calls).toHaveLength(0);
  });

  it("returns the same entry and queues nothing on a retry with the same key", async () => {
    const r = rig();
    const first = await logAdd(r.deps, { description: "oatmeal", idempotencyKey: "k1" });
    const second = await logAdd(r.deps, { description: "oatmeal", idempotencyKey: "k1" });
    expect(second.entry.entryId).toBe(first.entry.entryId);
    expect(r.store.entries.size).toBe(1);
    expect(r.jobs.calls).toHaveLength(1);
  });

  it("keeps the entry pending when the queue is full", async () => {
    const r = rig();
    r.jobs.nextResult = "limited_pending";
    const { entry } = await logAdd(r.deps, { description: "oatmeal", idempotencyKey: "k1" });
    expect(entry.estimateState).toBe("pending");
    expect(r.store.entries.size).toBe(1);
  });

  it("keeps the saved entry when the queue throws, so the caller cannot log it twice", async () => {
    const r = rig();
    r.jobs.enqueue = async () => {
      throw new Error("queue down");
    };
    const { entry } = await logAdd(r.deps, { description: "oatmeal", idempotencyKey: "k1" });
    expect(entry.estimateState).toBe("pending");
    expect(r.store.entries.size).toBe(1);
  });

  it("files the entry under the day in the user's own zone, which outranks the model's", async () => {
    const r = rig({ localTimezone: "America/Los_Angeles" });
    const { entry } = await logAdd(r.deps, {
      description: "late snack",
      idempotencyKey: "k1",
      consumedAt: "2026-11-03T03:30:00Z",
      timeZone: "Asia/Tokyo"
    });
    expect(entry.localDate).toBe("2026-11-02");
    expect(entry.timezoneOffset).toBe(-480);
  });

  it("reads an offset-less time in the resolved zone", async () => {
    const r = rig({ localTimezone: "America/Los_Angeles" });
    const { entry } = await logAdd(r.deps, {
      description: "dinner",
      idempotencyKey: "k1",
      consumedAt: "2026-11-02T20:14:00"
    });
    expect(entry.consumedAt).toBe("2026-11-03T04:14:00.000Z");
    expect(entry.localDate).toBe("2026-11-02");
  });

  it("rejects a blank description, an unknown key and a bad time", async () => {
    const r = rig();
    await expect(logAdd(r.deps, { description: "  ", idempotencyKey: "k" })).rejects.toThrow(
      InputError
    );
    await expect(
      logAdd(r.deps, { description: "x", idempotencyKey: "k", color: 1 })
    ).rejects.toThrow("unknown key");
    await expect(
      logAdd(r.deps, { description: "x", idempotencyKey: "k", consumedAt: "yesterday" })
    ).rejects.toThrow("consumedAt");
  });
});

describe("the estimate job", () => {
  it("records an estimate at the economy tier and advances the revision", async () => {
    const r = rig({ ai: new ScriptedAi().always("estimate", ESTIMATE_800) });
    const id = await addAndEstimate(r, "stew", "k1");
    const entry = (await r.store.getEntry(id))!;
    expect(entry.estimateState).toBe("estimated");
    expect(entry.estimateRevision).toBe(2);
    expect(entry.nutrients?.caloriesKcal).toBe(800);
    expect(entry.items).toHaveLength(1);
    expect(r.ai.calls[0]?.tierHint).toBe("economy");
  });

  it("leaves an unknown nutrient null instead of zero", async () => {
    const r = rig({ ai: new ScriptedAi().always("estimate", ESTIMATE_800) });
    const id = await addAndEstimate(r, "stew", "k1");
    const entry = (await r.store.getEntry(id))!;
    expect(entry.nutrients?.proteinG).toBeNull();
    const totals = computeDayTotals(entry.localDate, [entry]);
    expect(totals.nutrients.caloriesKcal).toBe(800);
    expect(totals.nutrients.proteinG).toBeNull();
  });

  it("records a failed estimate when the model errors", async () => {
    const r = rig({ ai: new ScriptedAi().script("estimate", new AiError("provider_error")) });
    const id = await addAndEstimate(r, "stew", "k1");
    expect((await r.store.getEntry(id))!.estimateState).toBe("failed");
  });

  it("does nothing for a revision that has moved on", async () => {
    const r = rig({ ai: new ScriptedAi().always("estimate", ESTIMATE_800) });
    const { entry } = await logAdd(r.deps, { description: "stew", idempotencyKey: "k1" });
    const stale = r.jobs.take()!;
    await logCorrect(r.deps, { entryId: entry.entryId, expectedRevision: 1, description: "soup" });
    expect(await runLogEstimate(r.jobDeps, stale)).toEqual({
      status: "no-op",
      reason: "stale_revision"
    });
    expect(r.ai.calls).toHaveLength(0);
  });

  it("does nothing for an entry that was deleted", async () => {
    const r = rig();
    const { entry } = await logAdd(r.deps, { description: "stew", idempotencyKey: "k1" });
    await logDelete(r.deps, { entryId: entry.entryId });
    expect(await runLogEstimate(r.jobDeps, r.jobs.take()!)).toEqual({
      status: "no-op",
      reason: "entry_not_found"
    });
  });

  it("keeps the clarifying question when the model needs details", async () => {
    const r = rig({
      ai: new ScriptedAi().always("estimate", {
        outcome: "needs_details",
        items: [],
        missingDetails: "which kind of bread",
        clarificationQuestion: "What kind of bread was it?"
      })
    });
    const id = await addAndEstimate(r, "a sandwich", "k1");
    const entry = (await r.store.getEntry(id))!;
    expect(entry.estimateState).toBe("needs_details");
    expect(entry.clarificationQuestion).toBe("What kind of bread was it?");
    expect(entry.nutrients).toBeNull();
  });
});

describe("meals.log.reestimate", () => {
  it("puts a failed entry back to pending and queues a job at its current revision", async () => {
    const r = rig({ ai: new ScriptedAi().script("estimate", new AiError("provider_error")) });
    const id = await addAndEstimate(r, "stew", "k1");
    const { entry } = await logReestimate(r.deps, { entryId: id });
    expect(entry.estimateState).toBe("pending");
    expect(r.jobs.calls[0]?.idempotencyKey).toBe(`log-estimate:${id}:r2`);
    r.ai.always("estimate", ESTIMATE_800);
    await runLogEstimate(r.jobDeps, r.jobs.take()!);
    expect((await r.store.getEntry(id))!.estimateState).toBe("estimated");
  });

  it("leaves an estimated entry alone", async () => {
    const r = rig({ ai: new ScriptedAi().always("estimate", ESTIMATE_800) });
    const id = await addAndEstimate(r, "stew", "k1");
    const { entry } = await logReestimate(r.deps, { entryId: id });
    expect(entry.estimateRevision).toBe(2);
    expect(r.jobs.calls).toHaveLength(0);
  });

  it("says so when the queue is full", async () => {
    const r = rig({ ai: new ScriptedAi().script("estimate", new AiError("provider_error")) });
    const id = await addAndEstimate(r, "stew", "k1");
    r.jobs.nextResult = "limited_hourly";
    await expect(logReestimate(r.deps, { entryId: id })).rejects.toThrow("busy");
  });
});

describe("meals.log.correct", () => {
  async function estimated() {
    const r = rig({ ai: new ScriptedAi().always("estimate", ESTIMATE_800) });
    const id = await addAndEstimate(r, "stew", "k1");
    return { r, id };
  }

  it("refuses a stale revision and changes nothing", async () => {
    const { r, id } = await estimated();
    await expect(
      logCorrect(r.deps, {
        entryId: id,
        expectedRevision: 1,
        items: [{ nutrients: { caloriesKcal: 100 } }]
      })
    ).rejects.toThrow("changed since");
    expect((await r.store.getEntry(id))!.nutrients?.caloriesKcal).toBe(800);
  });

  it("changes one number and keeps the rest of the item", async () => {
    const { r, id } = await estimated();
    const { entry } = await logCorrect(r.deps, {
      entryId: id,
      expectedRevision: 2,
      items: [{ nutrients: { proteinG: 40 } }]
    });
    expect(entry.items[0]).toMatchObject({
      label: "dish",
      nutrients: { caloriesKcal: 800, proteinG: 40 }
    });
    expect(entry.nutrients).toMatchObject({ caloriesKcal: 800, proteinG: 40 });
    expect(entry.estimateRevision).toBe(3);
  });

  it("sums the corrected items and adds a new one", async () => {
    const { r, id } = await estimated();
    const { entry } = await logCorrect(r.deps, {
      entryId: id,
      expectedRevision: 2,
      items: [null, { label: "bread", nutrients: { caloriesKcal: 200 } }]
    });
    expect(entry.items.map((item) => item.label)).toEqual(["dish", "bread"]);
    expect(entry.nutrients?.caloriesKcal).toBe(1000);
  });

  it("rejects a new item with no label", async () => {
    const { r, id } = await estimated();
    await expect(
      logCorrect(r.deps, {
        entryId: id,
        expectedRevision: 2,
        items: [null, { nutrients: { caloriesKcal: 200 } }]
      })
    ).rejects.toThrow("needs a label");
  });

  it("carries the estimate forward when only the description changes", async () => {
    const { r, id } = await estimated();
    const { entry } = await logCorrect(r.deps, {
      entryId: id,
      expectedRevision: 2,
      description: "beef stew"
    });
    expect(entry).toMatchObject({ description: "beef stew", estimateState: "estimated" });
    expect(entry.nutrients?.caloriesKcal).toBe(800);
    expect(r.jobs.calls).toHaveLength(0);
  });

  it("queues a fresh estimate when a still-pending entry is edited", async () => {
    const r = rig();
    const { entry } = await logAdd(r.deps, { description: "stew", idempotencyKey: "k1" });
    r.jobs.take();
    await logCorrect(r.deps, { entryId: entry.entryId, expectedRevision: 1, description: "soup" });
    expect(r.jobs.calls[0]).toMatchObject({
      idempotencyKey: `log-estimate:${entry.entryId}:r2`,
      params: { entryId: entry.entryId, revision: 2 }
    });
  });

  it("moves an entry to the day of its new time", async () => {
    const r = rig({
      localTimezone: "America/Los_Angeles",
      ai: new ScriptedAi().always("estimate", ESTIMATE_800)
    });
    const id = await addAndEstimate(r, "stew", "k1");
    const { entry } = await logCorrect(r.deps, {
      entryId: id,
      expectedRevision: 2,
      consumedAt: "2026-11-01T12:00:00"
    });
    expect(entry.localDate).toBe("2026-11-01");
  });

  it("uses the stored offset when no zone is known", async () => {
    const r = rig({
      localTimezone: "America/Los_Angeles",
      ai: new ScriptedAi().always("estimate", ESTIMATE_800)
    });
    const id = await addAndEstimate(r, "stew", "k1");
    const noZone = { ...r.deps, localTimezone: undefined };
    const { entry } = await logCorrect(noZone, {
      entryId: id,
      expectedRevision: 2,
      consumedAt: "2026-11-01T23:30:00"
    });
    expect(entry.localDate).toBe("2026-11-01");
    expect(entry.consumedAt).toBe("2026-11-02T07:30:00.000Z");
  });
});

describe("meals.log.delete", () => {
  it("removes the entry and says so when it is missing", async () => {
    const r = rig();
    const { entry } = await logAdd(r.deps, { description: "stew", idempotencyKey: "k1" });
    expect(await logDelete(r.deps, { entryId: entry.entryId })).toEqual({
      entryId: entry.entryId,
      deleted: true
    });
    await expect(logDelete(r.deps, { entryId: entry.entryId })).rejects.toThrow("no log entry");
  });
});

describe("meals.log.list and summarize", () => {
  async function twoMeals() {
    const r = rig({ ai: new ScriptedAi().always("estimate", ESTIMATE_800) });
    await addAndEstimate(r, "lunch", "k1", { consumedAt: "2026-11-02T12:00:00Z", timeZone: "UTC" });
    await addAndEstimate(r, "dinner", "k2", {
      consumedAt: "2026-11-02T19:00:00Z",
      timeZone: "UTC"
    });
    return r;
  }

  it("totals the day against the self member's targets", async () => {
    const r = await twoMeals();
    const result = await logList(r.deps, { localDate: "2026-11-02" });
    expect(result.entries).toHaveLength(2);
    expect(result.totals?.nutrients.caloriesKcal).toBe(1600);
    expect(result.targets).toEqual({ caloriesKcal: 2000, proteinG: 120, carbG: 200, fatG: 70 });
    expect(result.calorieFit).toMatchObject({ band: "under", differenceKcal: -400 });
  });

  it("counts a meal that is still pending and never adds zero for it", async () => {
    const r = await twoMeals();
    await logAdd(r.deps, {
      description: "snack",
      idempotencyKey: "k3",
      consumedAt: "2026-11-02T21:00:00Z",
      timeZone: "UTC"
    });
    const result = await logList(r.deps, { localDate: "2026-11-02" });
    expect(result.totals).toMatchObject({ incomplete: true, entriesWithoutEstimate: 1 });
    expect(result.totals?.nutrients.caloriesKcal).toBe(1600);
  });

  it("gives no fit and null targets without a target set", async () => {
    const bare = fakeLogDeps(kitchenOf([member({ memberId: you.memberId, isSelf: true })]), {
      ai: new ScriptedAi().always("estimate", ESTIMATE_800)
    });
    await addAndEstimate(bare, "lunch", "k1", {
      consumedAt: "2026-11-02T12:00:00Z",
      timeZone: "UTC"
    });
    const result = await logList(bare.deps, { localDate: "2026-11-02" });
    expect(result.calorieFit).toBeNull();
    expect(result.targets.caloriesKcal).toBeNull();
  });

  it("reads targets only from the Kitchen, never from a preference store", () => {
    for (const file of ["log/tools.ts", "log/deps.ts"]) {
      const source = readFileSync(
        new URL(`../../external-modules/meals/src/${file}`, import.meta.url),
        "utf8"
      );
      expect(source).not.toMatch(/preferences/i);
    }
    const registry = readFileSync(
      new URL("../../external-modules/meals/src/worker/registry.ts", import.meta.url),
      "utf8"
    );
    expect(registry).not.toMatch(/ctx\.preferences/);
  });

  it("validates the date shapes and the range ceiling", async () => {
    const r = rig();
    await expect(logList(r.deps, {})).rejects.toThrow("either localDate");
    await expect(
      logList(r.deps, {
        localDate: "2026-11-02",
        fromLocalDate: "2026-11-01",
        toLocalDate: "2026-11-02"
      })
    ).rejects.toThrow("cannot be combined");
    await expect(
      logList(r.deps, { fromLocalDate: "2026-10-01", toLocalDate: "2026-11-30" })
    ).rejects.toThrow("31 days");
    await expect(logList(r.deps, { localDate: "2026-13-45" })).rejects.toThrow("ISO calendar date");
    await expect(
      logSummarize(r.deps, { fromLocalDate: "2026-11-02", toLocalDate: "2026-11-01" })
    ).rejects.toThrow("before");
  });

  it("truncates a long list but totals the whole day", async () => {
    const r = await twoMeals();
    const result = await logList(r.deps, { localDate: "2026-11-02", limit: 1 });
    expect(result).toMatchObject({ truncated: true, totalCount: 2 });
    expect(result.entries).toHaveLength(1);
    expect(result.totals?.nutrients.caloriesKcal).toBe(1600);
  });

  it("summarises a range", async () => {
    const r = await twoMeals();
    const summary = await logSummarize(r.deps, {
      fromLocalDate: "2026-11-01",
      toLocalDate: "2026-11-03"
    });
    expect(summary).toMatchObject({ daysWithEntries: 1, incomplete: false });
    expect(summary.nutrients.caloriesKcal).toBe(1600);
  });
});

describe("occasions", () => {
  it.each([
    ["2026-11-02T08:00:00.000Z", 0, "breakfast"],
    ["2026-11-02T12:00:00.000Z", 0, "lunch"],
    ["2026-11-02T19:00:00.000Z", 0, "dinner"],
    ["2026-11-02T23:30:00.000Z", 0, "snack"],
    ["2026-11-03T03:30:00.000Z", -480, "dinner"]
  ])("puts %s at offset %i under %s", (at, offset, occasion) => {
    expect(occasionForEntry(at, offset)).toBe(occasion);
  });
});
