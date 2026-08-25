import Fastify from "fastify";
import { type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { registerRequestTimeZoneHook } from "../../apps/api/src/server.js";
import { registerWellnessRoutes } from "@moss/wellness";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000052";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-med-v2@example.test', false)`,
      [userId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

// Covers issue #1959: the two new schedule types (every_interval, monthly) and the real
// time zone every medication now records on save.
describe("wellness medications: every_interval and monthly schedule types", () => {
  async function buildApp(actorUserId: string) {
    const app = Fastify();
    registerRequestTimeZoneHook(app);
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "req:v2-route-test" }),
      dataContext
    });
    await app.ready();
    return app;
  }

  async function listMedications(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({ method: "GET", url: "/api/wellness/medications" });
    expect(res.statusCode).toBe(200);
    return res.json().medications as Array<Record<string, unknown>>;
  }

  it("every-interval, days unit, saves and reloads unchanged", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Painkiller",
          frequencyType: "every_interval",
          intervalUnit: "days",
          intervalCount: 2,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const meds = await listMedications(app);
      const reloaded = meds.find((m) => m["id"] === medId);
      expect(reloaded?.["intervalUnit"]).toBe("days");
      expect(reloaded?.["intervalCount"]).toBe(2);
      expect(reloaded?.["scheduleStartDate"]).toBe("2026-01-01");
    } finally {
      await app.close();
    }
  });

  it("every-interval, weeks unit, requires weekdays", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Weekly dose",
          frequencyType: "every_interval",
          intervalUnit: "weeks",
          intervalCount: 1,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("weekdays");
    } finally {
      await app.close();
    }
  });

  it("every-interval, months unit, no weekdays required", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Monthly shot",
          frequencyType: "every_interval",
          intervalUnit: "months",
          intervalCount: 1,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("monthly by date, numbered day", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Bone density pill",
          frequencyType: "monthly",
          monthKind: "date",
          monthDay: 15,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const meds = await listMedications(app);
      const reloaded = meds.find((m) => m["id"] === medId);
      expect(reloaded?.["monthKind"]).toBe("date");
      expect(reloaded?.["monthDay"]).toBe(15);
    } finally {
      await app.close();
    }
  });

  it("monthly by date, last day of month", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "End-of-month dose",
          frequencyType: "monthly",
          monthKind: "date",
          monthDayIsLast: true,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const meds = await listMedications(app);
      const reloaded = meds.find((m) => m["id"] === medId);
      expect(reloaded?.["monthDayIsLast"]).toBe(true);
      expect(reloaded?.["monthDay"]).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("monthly by date, both or neither day field is rejected", async () => {
    const app = await buildApp(userId);
    try {
      const both = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Both set",
          frequencyType: "monthly",
          monthKind: "date",
          monthDay: 15,
          monthDayIsLast: true,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(both.statusCode).toBe(400);

      const neither = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Neither set",
          frequencyType: "monthly",
          monthKind: "date",
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(neither.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("monthly by weekday position, third Tuesday", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Third Tuesday shot",
          frequencyType: "monthly",
          monthKind: "weekdayPosition",
          monthWeekdayPosition: "third",
          monthWeekday: 2,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const meds = await listMedications(app);
      const reloaded = meds.find((m) => m["id"] === medId);
      expect(reloaded?.["monthWeekdayPosition"]).toBe("third");
      expect(reloaded?.["monthWeekday"]).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("monthly by weekday position missing a field is rejected", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Incomplete weekday position",
          frequencyType: "monthly",
          monthKind: "weekdayPosition",
          monthWeekdayPosition: "third",
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("start date is required for both new types", async () => {
    const app = await buildApp(userId);
    try {
      const everyInterval = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "No start date",
          frequencyType: "every_interval",
          intervalUnit: "days",
          intervalCount: 1,
          scheduleTimes: ["08:00"]
        }
      });
      expect(everyInterval.statusCode).toBe(400);
      expect(everyInterval.body).toContain("startDate");

      const monthly = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "No start date monthly",
          frequencyType: "monthly",
          monthKind: "date",
          monthDay: 1,
          scheduleTimes: ["08:00"]
        }
      });
      expect(monthly.statusCode).toBe(400);
      expect(monthly.body).toContain("startDate");
    } finally {
      await app.close();
    }
  });

  it("end date before start date is rejected", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Backwards range",
          frequencyType: "every_interval",
          intervalUnit: "days",
          intervalCount: 1,
          scheduleTimes: ["08:00"],
          startDate: "2026-02-01",
          endDate: "2026-01-01"
        }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("as_needed still rejects the new fields", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "PRN with stray field",
          frequencyType: "as_needed",
          intervalUnit: "days"
        }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("a saved every_interval medication produces correct occurrences across a daylight-saving change", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "DST-spanning dose",
          frequencyType: "every_interval",
          intervalUnit: "days",
          intervalCount: 1,
          scheduleTimes: ["09:00"],
          startDate: "2026-03-01"
        },
        headers: { "x-timezone": "America/New_York" }
      });
      expect(created.statusCode, created.body).toBe(201);

      // 2026-03-08 is when US clocks spring forward in America/New_York. Fetch the day
      // before and the day after and confirm the local clock time stayed fixed at 09:00.
      const before = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/schedule?date=2026-03-07",
        headers: { "x-timezone": "America/New_York" }
      });
      const after = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/schedule?date=2026-03-09",
        headers: { "x-timezone": "America/New_York" }
      });
      expect(before.statusCode, before.body).toBe(200);
      expect(after.statusCode, after.body).toBe(200);

      const localTime = (iso: string) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(new Date(iso));

      const beforeSlot = (before.json().slots as Array<{ scheduledFor: string }>)[0];
      const afterSlot = (after.json().slots as Array<{ scheduledFor: string }>)[0];
      expect(beforeSlot).toBeDefined();
      expect(afterSlot).toBeDefined();
      expect(localTime(beforeSlot!.scheduledFor)).toBe("09:00");
      expect(localTime(afterSlot!.scheduledFor)).toBe("09:00");
    } finally {
      await app.close();
    }
  });

  it("regression: an old-picker medication still loads and computes identically", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Weekdays",
          frequencyType: "specific_weekdays",
          weekdays: [1, 3, 5],
          scheduleTimes: ["09:00"]
        }
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      // 2026-06-15 is a Monday (ISO weekday 1), one of the scheduled weekdays.
      const sched = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/schedule?date=2026-06-15"
      });
      expect(sched.statusCode, sched.body).toBe(200);
      const slot = (sched.json().slots as Array<{ medicationId: string; asNeeded: boolean }>).find(
        (s) => s.medicationId === medId && !s.asNeeded
      );
      expect(slot).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("every new save gets a real time zone recorded, for both an old-family and a new-family request", async () => {
    const app = await buildApp(userId);
    try {
      const oldFamily = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Old family med", frequencyType: "once_daily", scheduleTimes: ["08:00"] },
        headers: { "x-timezone": "America/Los_Angeles" }
      });
      expect(oldFamily.statusCode).toBe(201);
      const oldFamilyId = oldFamily.json().medication.id as string;

      const newFamily = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "New family med",
          frequencyType: "every_interval",
          intervalUnit: "days",
          intervalCount: 1,
          scheduleTimes: ["08:00"],
          startDate: "2026-01-01"
        },
        headers: { "x-timezone": "America/Los_Angeles" }
      });
      expect(newFamily.statusCode).toBe(201);
      const newFamilyId = newFamily.json().medication.id as string;

      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        const rows = await client.query<{ id: string; time_zone: string }>(
          `SELECT id, time_zone FROM app.medications WHERE id = ANY($1)`,
          [[oldFamilyId, newFamilyId]]
        );
        for (const row of rows.rows) {
          expect(row.time_zone).toBe("America/Los_Angeles");
        }
        expect(rows.rows).toHaveLength(2);
      } finally {
        await client.end();
      }
    } finally {
      await app.close();
    }
  });
});
