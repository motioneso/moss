/** Stored-operation browser reads. Seeded rows are not provider-execution proof. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type pg from "pg";

type Reply = { status: number; body: string };
export async function checkOperationStatus(
  tab: Page,
  db: pg.Client,
  actor: string,
  foreign: (path: string, options: { method: string; body: unknown }) => Promise<Reply>
) {
  const own = (path: string, method = "GET", body?: unknown) =>
    tab.evaluate(
      async ({ path, method, body }) => {
        const reply = await fetch(path, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: reply.status, body: await reply.text() };
      },
      { path, method, body }
    );
  const created = await own("/api/m/calendar/day-plans", "POST", { date: "2030-05-23" });
  assert.equal(created.status, 200);
  const plan = JSON.parse(created.body).plan;
  const operation = randomUUID();
  const item = randomUUID();
  await db.query(
    "INSERT INTO app.day_plan_operations(id,plan_id,owner_user_id,kind,idempotency_key,expected_revision) VALUES($1,$2,$3,'apply',$4,1)",
    [operation, plan.id, actor, `browser-${operation}`]
  );
  await db.query(
    "INSERT INTO app.day_plan_operation_items(id,operation_id,plan_id,owner_user_id,kind,pending_change) VALUES($1,$2,$3,$4,'remove',$5)",
    [item, operation, plan.id, actor, { blockId: randomUUID(), kind: "remove" }]
  );
  for (const prefix of ["/api/calendar", "/api/m/calendar"]) {
    const path = `${prefix}/day-plans/${plan.id}/operations/${operation}`;
    const pending = await own(path);
    assert.equal(pending.status, 200);
    assert.deepEqual(JSON.parse(pending.body), {
      operationId: operation,
      planId: plan.id,
      status: "pending",
      items: [{ itemId: item, blockId: null, outcome: "pending", result: null }]
    });
    assert.equal((await foreign(path, { method: "GET", body: undefined })).status, 404);
    assert.equal(
      (await own(`${prefix}/day-plans/${randomUUID()}/operations/${operation}`)).status,
      404
    );
  }
  await db.query("UPDATE app.day_plan_operation_items SET outcome='failed',result=$2 WHERE id=$1", [
    item,
    {
      status: "failed",
      reason: "access-denied",
      internalDetail: "must not return"
    }
  ]);
  for (const prefix of ["/api/calendar", "/api/m/calendar"]) {
    const completed = await own(`${prefix}/day-plans/${plan.id}/operations/${operation}`);
    assert.equal(completed.status, 200);
    assert.deepEqual(JSON.parse(completed.body), {
      operationId: operation,
      planId: plan.id,
      status: "completed",
      items: [
        {
          itemId: item,
          blockId: null,
          outcome: "failed",
          result: { status: "failed", reason: "access-denied" }
        }
      ],
      denial: { code: "day_plan_denied", remediationRef: "calendar.automatic_planning_policy" }
    });
  }
  console.log(
    "PASS signed-in browser operation status across both URL prefixes: pending, completed, denial, hidden foreign and wrong-plan reads; synthetic stored rows, no provider execution"
  );
}
