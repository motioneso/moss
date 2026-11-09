/** Real browser requests to the signed-in installed package; no response substitution. */
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";

type Reply = { status: number; body: string };
type Request = (path: string, options: { method: string; body: unknown }) => Promise<Reply>;

export async function checkDayPlanWrites(tab: Page, foreign: Request) {
  const own = async (path: string, method: string, body?: unknown) =>
    tab.evaluate(
      async ({ path, method, body }) => {
        const response = await fetch(path, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.text() };
      },
      { path, method, body }
    );
  for (const [prefix, date] of [
    ["/api/calendar", "2030-05-21"],
    ["/api/m/calendar", "2030-05-22"]
  ] as const) {
    const created = await own(`${prefix}/day-plans`, "POST", { date });
    assert.equal(created.status, 200, "browser original create envelope");
    const plan = JSON.parse(created.body).plan;
    assert.equal(plan.localDay, date);
    assert.equal(plan.timeZone, "UTC", "saved fixture timezone");
    assert.equal(plan.revision, 1);
    const alternate = prefix === "/api/calendar" ? "/api/m/calendar" : "/api/calendar";
    const repeated = await own(`${alternate}/day-plans`, "POST", { date, timeZone: null });
    assert.equal(repeated.status, 200);
    assert.equal(
      JSON.parse(repeated.body).plan.id,
      plan.id,
      "create is idempotent across prefixes"
    );
    const body = {
      date,
      timeZone: "UTC",
      expectedRevision: 1,
      eveningIntent: { notes: "Browser draft check" },
      blocks: [{ kind: "focus", title: "Private browser draft", taskId: null }]
    };
    const path = `${prefix}/day-plans/${plan.id}/draft`;
    const saved = await own(path, "PATCH", body);
    assert.equal(saved.status, 200);
    const draft = JSON.parse(saved.body).plan;
    assert.equal(draft.id, plan.id);
    assert.equal(draft.revision, 2);
    assert.equal(draft.blocks[0].title, "Private browser draft");
    assert.equal((await own(path, "PATCH", body)).status, 409, "stale revision rejected");
    assert.equal(
      (await foreign(path, { method: "PATCH", body: { ...body, expectedRevision: 2 } })).status,
      404,
      "another signed-in account cannot change the draft"
    );
    const read = await own(`/api/m/calendar/day-plan?date=${date}&timeZone=UTC`, "GET");
    assert.equal(read.status, 200);
    assert.deepEqual(
      JSON.parse(read.body).plan,
      draft,
      "failed writes leave the saved draft unchanged"
    );
    assert.equal(
      (await own(`${prefix}/day-plans`, "POST", { date, sourceRunId: "unavailable" })).status,
      503,
      "source-run creation remains unavailable"
    );
  }
  console.log(
    "PASS browser day-plan create/save across both URL prefixes, timezone, repeated create, revision conflict and foreign-write refusal"
  );
}
