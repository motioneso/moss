import Fastify from "fastify";
import { type Kysely } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { registerWellnessRoutes } from "@moss/wellness";

import { saveLocaleTimeZone } from "./locale-preference.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000051";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-med@example.test', false)`,
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

// Covers the wellness REST surface AND the Phase-2 fixes: all six frequency types create
// without a 400, every_n_hours produces interval schedule slots (was invisible), and
// out-of-range numeric discriminator fields surface as friendly 400s (not DB-CHECK 500s).
describe("wellness REST routes", () => {
  async function buildApp(actorUserId: string, timeZone: string | null = "UTC") {
    await saveLocaleTimeZone(dataContext, actorUserId, timeZone);
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "req:route-test" }),
      dataContext
    });
    await app.ready();
    return app;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("POST /api/wellness/checkins creates; GET lists owner-scoped", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: { feelingCore: "happy", intensity: 5, sensations: ["warmth"] }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().checkin.feelingCore).toBe("happy");

      const listed = await app.inject({ method: "GET", url: "/api/wellness/checkins?limit=5" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().checkins.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("POST /api/wellness/checkins persists local_date from the saved timezone, not UTC (#326/#771)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 06:30 UTC is 23:30 the evening *before* in America/Los_Angeles (PDT, UTC-7 in June): the
    // UTC calendar day has already rolled over, but the caller's local calendar day has not.
    vi.setSystemTime(new Date("2026-06-09T06:30:00.000Z"));
    const app = await buildApp(userId, "America/Los_Angeles");
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: { feelingCore: "happy" }
      });
      expect(created.statusCode).toBe(201);
      const checkinId = created.json().checkin.id as string;

      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        const row = await client.query<{ local_date: string; timezone_offset: number }>(
          `SELECT local_date, timezone_offset FROM app.wellness_checkins WHERE id = $1`,
          [checkinId]
        );
        expect(row.rows[0]?.local_date).toBe("2026-06-08");
        expect(row.rows[0]?.timezone_offset).toBe(-420);
      } finally {
        await client.end();
      }
    } finally {
      await app.close();
    }
  });

  it("POST /api/wellness/checkins with no saved timezone uses the shared default zone, not UTC (#3395)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-09T06:30:00.000Z"));
    const app = await buildApp(userId, null);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: { feelingCore: "happy" }
      });
      expect(created.statusCode).toBe(201);
      const checkinId = created.json().checkin.id as string;

      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        const row = await client.query<{ local_date: string; timezone_offset: number }>(
          `SELECT local_date, timezone_offset FROM app.wellness_checkins WHERE id = $1`,
          [checkinId]
        );
        expect(row.rows[0]?.local_date).toBe("2026-06-08");
        expect(row.rows[0]?.timezone_offset).toBe(-420);
      } finally {
        await client.end();
      }
    } finally {
      await app.close();
    }
  });

  it("POST a check-in with a feeling path mismatch is rejected 400", async () => {
    const app = await buildApp(userId);
    try {
      // tertiary is not a leaf of the secondary under this core → invalid path.
      const bad = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: {
          feelingCore: "fear",
          feelingSecondary: "Anxious",
          feelingTertiary: "not-a-leaf"
        }
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("PRN dose log without prn_reason is accepted (201) and persists null", async () => {
    const app = await buildApp(userId);
    try {
      const med = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Ibuprofen", frequencyType: "as_needed" }
      });
      const medId = med.json().medication.id as string;

      const res = await app.inject({
        method: "POST",
        url: `/api/wellness/medications/${medId}/logs`,
        payload: { status: "prn" }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().log.prnReason).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("GET /api/wellness/medications/schedule returns slots for today", async () => {
    const app = await buildApp(userId);
    try {
      await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Vitamin D", frequencyType: "once_daily", scheduleTimes: ["09:00"] }
      });
      const today = new Date().toISOString().slice(0, 10);
      const sched = await app.inject({
        method: "GET",
        url: `/api/wellness/medications/schedule?date=${today}`
      });
      expect(sched.statusCode).toBe(200);
      expect(sched.json().date).toBe(today);
      expect(Array.isArray(sched.json().slots)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("logs multiple PRN doses in one day; prnCount reflects them and stores the entered reason", async () => {
    const app = await buildApp(userId);
    try {
      const med = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Afternoon booster", frequencyType: "as_needed" }
      });
      const medId = med.json().medication.id as string;

      // Two PRN doses the same day, each with the reason the user actually entered.
      const reasons = ["Afternoon booster", "Second booster"];
      for (const reason of reasons) {
        const log = await app.inject({
          method: "POST",
          url: `/api/wellness/medications/${medId}/logs`,
          payload: { status: "prn", prnReason: reason }
        });
        expect(log.statusCode).toBe(201);
        // The stored reason is exactly what the user entered — never a placeholder.
        expect(log.json().log.prnReason).toBe(reason);
      }

      const today = new Date().toISOString().slice(0, 10);
      const fetchSlot = async () => {
        const sched = await app.inject({
          method: "GET",
          url: `/api/wellness/medications/schedule?date=${today}`
        });
        expect(sched.statusCode).toBe(200);
        const slots = sched.json().slots as Array<{
          medicationId: string;
          asNeeded: boolean;
          prnCount?: number;
        }>;
        return slots.find((s) => s.medicationId === medId && s.asNeeded);
      };

      const slot = await fetchSlot();
      expect(slot).toBeDefined();
      expect(slot?.prnCount).toBe(2);

      // The count is server-derived from persisted logs, so it survives a fresh refetch.
      const again = await fetchSlot();
      expect(again?.prnCount).toBe(2);
    } finally {
      await app.close();
    }
  });

  // All six frequency types must create (no 400) AND, where scheduled, produce slots.
  it("POST creates all six frequency types without a 400", async () => {
    const app = await buildApp(userId);
    try {
      const monday = "2026-06-15"; // ISO weekday 1
      const payloads = [
        { name: "Daily", frequencyType: "once_daily", scheduleTimes: ["08:00"] },
        {
          name: "Thrice",
          frequencyType: "times_per_day",
          timesPerDay: 3,
          scheduleTimes: ["08:00", "13:00", "20:00"]
        },
        {
          name: "Weekdays",
          frequencyType: "specific_weekdays",
          weekdays: [1, 3, 5],
          scheduleTimes: ["09:00"]
        },
        { name: "Interval", frequencyType: "every_n_hours", intervalHours: 8 },
        { name: "Prn", frequencyType: "as_needed" },
        {
          name: "Cyclical",
          frequencyType: "cyclical",
          cycleAnchorDate: monday,
          cycleDaysOn: 21,
          cycleDaysOff: 7,
          scheduleTimes: ["08:00"]
        }
      ];
      for (const payload of payloads) {
        const res = await app.inject({
          method: "POST",
          url: "/api/wellness/medications",
          payload
        });
        expect(res.statusCode, `creating ${payload.frequencyType}`).toBe(201);
      }
    } finally {
      await app.close();
    }
  });

  it("POST every_n_hours med then GET schedule lists its interval slots (was invisible)", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Antibiotic", frequencyType: "every_n_hours", intervalHours: 6 }
      });
      expect(created.statusCode).toBe(201);
      const medId = created.json().medication.id as string;

      const today = new Date().toISOString().slice(0, 10);
      const sched = await app.inject({
        method: "GET",
        url: `/api/wellness/medications/schedule?date=${today}`
      });
      expect(sched.statusCode).toBe(200);
      const slotsForMed = (
        sched.json().slots as Array<{ medicationId: string; asNeeded: boolean }>
      ).filter((s) => s.medicationId === medId && !s.asNeeded);
      // 24h / 6h = 4 interval slots — proves every_n_hours is no longer invisible.
      expect(slotsForMed.length).toBe(4);
    } finally {
      await app.close();
    }
  });

  it("POST out-of-range intervalHours is a friendly 400, not a DB-CHECK 500", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "TooOften", frequencyType: "every_n_hours", intervalHours: 99 }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST out-of-range timesPerDay is a friendly 400, not a DB-CHECK 500", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "WayTooMuch",
          frequencyType: "times_per_day",
          timesPerDay: 99,
          scheduleTimes: Array.from({ length: 99 }, () => "08:00")
        }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("POST a PRN medication with no scheduling fields succeeds (B1)", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Ibuprofen PRN", frequencyType: "as_needed" }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { medication: { frequencyType: string; scheduleTimes: null } };
      expect(body.medication.frequencyType).toBe("as_needed");
      expect(body.medication.scheduleTimes).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("POST once_daily medication with a single schedule time succeeds", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "Once Med", frequencyType: "once_daily", scheduleTimes: ["08:00"] }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("POST times_per_day=2 with 2 schedule times succeeds", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "2x Med",
          frequencyType: "times_per_day",
          timesPerDay: 2,
          scheduleTimes: ["08:00", "20:00"]
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("POST out-of-range cycleDaysOn is a friendly 400, not a DB-CHECK 500", async () => {
    const app = await buildApp(userId);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "BadCycle",
          frequencyType: "cyclical",
          cycleAnchorDate: "2026-06-15",
          cycleDaysOn: 0,
          cycleDaysOff: 7,
          scheduleTimes: ["08:00"]
        }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("buckets adherence summary by saved timezone, not UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-20T01:00:00.000Z"));
    const app = await buildApp(userId, "America/New_York");
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Late dose",
          frequencyType: "once_daily",
          scheduleTimes: ["21:30"]
        }
      });
      expect(created.statusCode).toBe(201);
      const medId = created.json().medication.id as string;

      const logged = await app.inject({
        method: "POST",
        url: `/api/wellness/medications/${medId}/logs`,
        payload: {
          status: "taken",
          scheduledFor: "2026-06-19T21:30:00.000Z"
        }
      });
      expect(logged.statusCode).toBe(201);

      const summary = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/logs?sinceDays=1"
      });

      expect(summary.statusCode, summary.body).toBe(200);
      const days = summary.json().days as Array<{
        date: string;
        doses: Array<{ medicationId: string; status: string }>;
      }>;
      expect(days).toHaveLength(1);
      expect(days[0]?.date).toBe("2026-06-19");
      expect(days[0]?.doses).toContainEqual(
        expect.objectContaining({ medicationId: medId, status: "taken" })
      );
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("includes PRN logs from the saved timezone day in medication schedule", async () => {
    const app = await buildApp(userId, "America/New_York");
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: { name: "PRN boundary", frequencyType: "as_needed" }
      });
      expect(created.statusCode).toBe(201);
      const medId = created.json().medication.id as string;

      const logged = await app.inject({
        method: "POST",
        url: `/api/wellness/medications/${medId}/logs`,
        payload: { status: "prn" }
      });
      expect(logged.statusCode).toBe(201);
      const logId = logged.json().log.id as string;

      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query(`UPDATE app.medication_logs SET logged_at = $1 WHERE id = $2`, [
          "2026-06-20T01:00:00.000Z",
          logId
        ]);
      } finally {
        await client.end();
      }

      const sched = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/schedule?date=2026-06-19"
      });

      expect(sched.statusCode, sched.body).toBe(200);
      const slot = (
        sched.json().slots as Array<{ medicationId: string; asNeeded: boolean; prnCount?: number }>
      ).find((s) => s.medicationId === medId && s.asNeeded);
      expect(slot?.prnCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a PRN log that carries scheduledFor (400) — would otherwise clobber a scheduled-dose record (#770 / M3)", async () => {
    const app = await buildApp(userId);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/wellness/medications",
        payload: {
          name: "Clobber guard",
          frequencyType: "once_daily",
          scheduleTimes: ["08:00"]
        }
      });
      expect(created.statusCode).toBe(201);
      const medId = created.json().medication.id as string;
      const scheduledFor = "2026-06-22T08:00:00.000Z";

      // Establish a real scheduled-dose record for this slot.
      const taken = await app.inject({
        method: "POST",
        url: `/api/wellness/medications/${medId}/logs`,
        payload: { status: "taken", scheduledFor }
      });
      expect(taken.statusCode).toBe(201);

      // A PRN log carrying the same scheduledFor must be rejected — not silently upserted onto
      // the scheduled-dose partial unique index, which would overwrite the "taken" record above
      // (status -> "prn") and regress the slot to "pending" in the schedule view.
      const prnWithScheduledFor = await app.inject({
        method: "POST",
        url: `/api/wellness/medications/${medId}/logs`,
        payload: { status: "prn", scheduledFor }
      });
      expect(prnWithScheduledFor.statusCode).toBe(400);

      // The original scheduled-dose record must be untouched.
      const sched = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/schedule?date=2026-06-22"
      });
      expect(sched.statusCode, sched.body).toBe(200);
      const slot = (
        sched.json().slots as Array<{ medicationId: string; asNeeded: boolean; status: string }>
      ).find((s) => s.medicationId === medId && !s.asNeeded);
      expect(slot?.status).toBe("taken");
    } finally {
      await app.close();
    }
  });
});
