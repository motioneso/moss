import Fastify from "fastify";
import { type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { registerRequestTimeZoneHook } from "../../apps/api/src/server.js";
import { registerWellnessRoutes } from "@moss/wellness";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000053";
const otherUserId = "00000000-0000-4000-8000-000000000054";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-med-edit@example.test', false), ($2, 'well-med-edit-other@example.test', false)`,
      [userId, otherUserId]
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

/**
 * Covers issue #1968: a start date on every schedule type, a reminder on/off flag, and editing
 * a saved schedule. Editing is all-or-nothing on purpose — a half-changed schedule would leave a
 * column from the previous type in place and trip a database CHECK as a 500 rather than a
 * friendly 400.
 */
describe("wellness medications: start dates, reminders, and editing a saved schedule", () => {
  async function buildApp(actorUserId: string) {
    const app = Fastify();
    registerRequestTimeZoneHook(app);
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "req:med-edit-test" }),
      dataContext
    });
    await app.ready();
    return app;
  }

  type App = Awaited<ReturnType<typeof buildApp>>;

  async function create(app: App, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/wellness/medications", payload });
  }

  async function patch(app: App, id: string, payload: Record<string, unknown>) {
    return app.inject({ method: "PATCH", url: `/api/wellness/medications/${id}`, payload });
  }

  async function reload(app: App, id: string) {
    const res = await app.inject({ method: "GET", url: "/api/wellness/medications" });
    expect(res.statusCode).toBe(200);
    const meds = res.json().medications as Array<Record<string, unknown>>;
    const found = meds.find((m) => m["id"] === id);
    expect(found).toBeDefined();
    return found!;
  }

  // The complete schedule for each frequency type, so a start date can be checked on all of
  // them and so an edit can be sent as the full all-or-nothing payload.
  const schedules: Record<string, Record<string, unknown>> = {
    once_daily: { frequencyType: "once_daily", scheduleTimes: ["08:00"] },
    times_per_day: {
      frequencyType: "times_per_day",
      timesPerDay: 2,
      scheduleTimes: ["08:00", "20:00"]
    },
    every_n_hours: { frequencyType: "every_n_hours", intervalHours: 6, scheduleTimes: ["08:00"] },
    specific_weekdays: {
      frequencyType: "specific_weekdays",
      weekdays: [1, 3, 5],
      scheduleTimes: ["09:00"]
    },
    cyclical: {
      frequencyType: "cyclical",
      cycleDaysOn: 21,
      cycleDaysOff: 7,
      cycleAnchorDate: "2026-01-01",
      scheduleTimes: ["09:00"]
    },
    as_needed: { frequencyType: "as_needed" },
    every_interval: {
      frequencyType: "every_interval",
      intervalUnit: "days",
      intervalCount: 2,
      scheduleTimes: ["08:00"]
    },
    monthly: {
      frequencyType: "monthly",
      monthKind: "date",
      monthDay: 15,
      scheduleTimes: ["08:00"]
    }
  };

  it("a start date saves and reloads for every schedule type", async () => {
    const app = await buildApp(userId);
    try {
      for (const [type, schedule] of Object.entries(schedules)) {
        const created = await create(app, {
          name: `Start date ${type}`,
          ...schedule,
          startDate: "2026-03-01"
        });
        expect(created.statusCode, `${type}: ${created.body}`).toBe(201);
        const medId = created.json().medication.id as string;
        const reloaded = await reload(app, medId);
        expect(reloaded["scheduleStartDate"], type).toBe("2026-03-01");
      }
    } finally {
      await app.close();
    }
  });

  it("the reminder flag round-trips, and defaults to off when it is left out", async () => {
    const app = await buildApp(userId);
    try {
      const on = await create(app, {
        name: "Reminders on",
        ...schedules["once_daily"],
        remindersEnabled: true
      });
      expect(on.statusCode, on.body).toBe(201);
      expect(on.json().medication.remindersEnabled).toBe(true);
      expect((await reload(app, on.json().medication.id))["remindersEnabled"]).toBe(true);

      const omitted = await create(app, { name: "Reminders unset", ...schedules["once_daily"] });
      expect(omitted.statusCode, omitted.body).toBe(201);
      expect(omitted.json().medication.remindersEnabled).toBe(false);

      // And it can be turned on later on its own, without resending the schedule.
      const turnedOn = await patch(app, omitted.json().medication.id as string, {
        remindersEnabled: true
      });
      expect(turnedOn.statusCode, turnedOn.body).toBe(200);
      expect(turnedOn.json().medication.remindersEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("turning reminders on for an as-needed medication is refused with a 400, not a 500", async () => {
    const app = await buildApp(userId);
    try {
      // On create.
      const onCreate = await create(app, {
        name: "PRN with reminders",
        ...schedules["as_needed"],
        remindersEnabled: true
      });
      expect(onCreate.statusCode, onCreate.body).toBe(400);
      expect(onCreate.body).toContain("remindersEnabled");

      // And on a later edit that does not resend the schedule, where the stored type is the
      // only way to know it is as-needed.
      const prn = await create(app, { name: "PRN plain", ...schedules["as_needed"] });
      expect(prn.statusCode, prn.body).toBe(201);
      const later = await patch(app, prn.json().medication.id as string, {
        remindersEnabled: true
      });
      expect(later.statusCode, later.body).toBe(400);
      expect(later.body).toContain("remindersEnabled");

      // And on an edit that switches to as-needed and asks for a reminder in the same breath.
      const daily = await create(app, {
        name: "Daily then PRN with reminders",
        ...schedules["once_daily"]
      });
      expect(daily.statusCode, daily.body).toBe(201);
      const both = await patch(app, daily.json().medication.id as string, {
        ...schedules["as_needed"],
        remindersEnabled: true
      });
      expect(both.statusCode, both.body).toBe(400);
      expect(both.body).toContain("remindersEnabled");
    } finally {
      await app.close();
    }
  });

  it("an every-interval medication edited into a monthly one clears the old type's columns", async () => {
    const app = await buildApp(userId);
    try {
      const created = await create(app, {
        name: "Switching to monthly",
        ...schedules["every_interval"],
        startDate: "2026-01-01"
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const edited = await patch(app, medId, {
        ...schedules["monthly"],
        monthDayIsLast: true,
        monthDay: null,
        startDate: "2026-02-01"
      });
      expect(edited.statusCode, edited.body).toBe(200);

      const reloaded = await reload(app, medId);
      expect(reloaded["frequencyType"]).toBe("monthly");
      expect(reloaded["monthKind"]).toBe("date");
      expect(reloaded["monthDayIsLast"]).toBe(true);
      expect(reloaded["scheduleStartDate"]).toBe("2026-02-01");
      // The columns that belonged to the previous type must be gone.
      expect(reloaded["intervalUnit"]).toBeNull();
      expect(reloaded["intervalCount"]).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("a monthly medication edited into as-needed and back clears and restores dose times", async () => {
    const app = await buildApp(userId);
    try {
      const created = await create(app, {
        name: "Monthly then PRN",
        ...schedules["monthly"],
        startDate: "2026-01-01"
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const toPrn = await patch(app, medId, { ...schedules["as_needed"] });
      expect(toPrn.statusCode, toPrn.body).toBe(200);
      const asPrn = await reload(app, medId);
      expect(asPrn["frequencyType"]).toBe("as_needed");
      expect(asPrn["scheduleTimes"]).toBeNull();
      expect(asPrn["monthKind"]).toBeNull();
      expect(asPrn["monthDay"]).toBeNull();

      const backToMonthly = await patch(app, medId, {
        ...schedules["monthly"],
        startDate: "2026-01-01"
      });
      expect(backToMonthly.statusCode, backToMonthly.body).toBe(200);
      const restored = await reload(app, medId);
      expect(restored["frequencyType"]).toBe("monthly");
      expect(restored["scheduleTimes"]).toEqual(["08:00:00"]);
      expect(restored["monthDay"]).toBe(15);
    } finally {
      await app.close();
    }
  });

  it("a medication with reminders on can be edited into as-needed, which turns the reminder off", async () => {
    const app = await buildApp(userId);
    try {
      const created = await create(app, {
        name: "Reminders then PRN",
        ...schedules["once_daily"],
        remindersEnabled: true
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;
      expect(created.json().medication.remindersEnabled).toBe(true);

      // The edit does not mention the reminder at all. Leaving the stored "on" value in place
      // would break the table's rule that an as-needed medication cannot have one, and come back
      // as a 500 instead of a saved medication.
      const toPrn = await patch(app, medId, { ...schedules["as_needed"] });
      expect(toPrn.statusCode, toPrn.body).toBe(200);
      expect(toPrn.json().medication.remindersEnabled).toBe(false);

      const asPrn = await reload(app, medId);
      expect(asPrn["frequencyType"]).toBe("as_needed");
      expect(asPrn["remindersEnabled"]).toBe(false);

      // Going back to a scheduled type leaves the reminder off until it is asked for again.
      const back = await patch(app, medId, { ...schedules["once_daily"] });
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json().medication.remindersEnabled).toBe(false);

      const turnedOn = await patch(app, medId, { remindersEnabled: true });
      expect(turnedOn.statusCode, turnedOn.body).toBe(200);
      expect(turnedOn.json().medication.remindersEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a schedule field sent without a frequency type is refused", async () => {
    const app = await buildApp(userId);
    try {
      const created = await create(app, { name: "No stray edits", ...schedules["once_daily"] });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const stray = await patch(app, medId, { scheduleTimes: ["07:00"] });
      expect(stray.statusCode, stray.body).toBe(400);
      expect(stray.body).toContain("frequencyType");

      const strayDate = await patch(app, medId, { startDate: "2026-05-01" });
      expect(strayDate.statusCode, strayDate.body).toBe(400);
      expect(strayDate.body).toContain("frequencyType");
    } finally {
      await app.close();
    }
  });

  it("a frequency type sent without the fields that type needs is refused", async () => {
    const app = await buildApp(userId);
    try {
      const created = await create(app, { name: "Incomplete edit", ...schedules["once_daily"] });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      // monthly with no start date and no day-of-month shape.
      const incomplete = await patch(app, medId, {
        frequencyType: "monthly",
        scheduleTimes: ["08:00"]
      });
      expect(incomplete.statusCode, incomplete.body).toBe(400);

      // every_interval with no interval count.
      const noCount = await patch(app, medId, {
        frequencyType: "every_interval",
        intervalUnit: "days",
        scheduleTimes: ["08:00"],
        startDate: "2026-01-01"
      });
      expect(noCount.statusCode, noCount.body).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("editing the name alone still works and leaves the schedule untouched", async () => {
    const app = await buildApp(userId);
    try {
      const created = await create(app, {
        name: "Old name",
        ...schedules["cyclical"],
        startDate: "2026-01-05"
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const renamed = await patch(app, medId, { name: "New name" });
      expect(renamed.statusCode, renamed.body).toBe(200);

      const reloaded = await reload(app, medId);
      expect(reloaded["name"]).toBe("New name");
      expect(reloaded["frequencyType"]).toBe("cyclical");
      expect(reloaded["cycleDaysOn"]).toBe(21);
      expect(reloaded["cycleDaysOff"]).toBe(7);
      expect(reloaded["scheduleTimes"]).toEqual(["09:00:00"]);
      expect(reloaded["scheduleStartDate"]).toBe("2026-01-05");
    } finally {
      await app.close();
    }
  });

  it("a second person cannot edit someone else's medication", async () => {
    const ownerApp = await buildApp(userId);
    const intruderApp = await buildApp(otherUserId);
    try {
      const created = await create(ownerApp, {
        name: "Private medication",
        ...schedules["once_daily"]
      });
      expect(created.statusCode, created.body).toBe(201);
      const medId = created.json().medication.id as string;

      const stolenEdit = await patch(intruderApp, medId, {
        ...schedules["monthly"],
        startDate: "2026-04-01"
      });
      expect(stolenEdit.statusCode, stolenEdit.body).toBe(404);

      // The owner's record is unchanged.
      const reloaded = await reload(ownerApp, medId);
      expect(reloaded["frequencyType"]).toBe("once_daily");
      expect(reloaded["name"]).toBe("Private medication");
    } finally {
      await ownerApp.close();
      await intruderApp.close();
    }
  });

  it("a start date that is not a real calendar date is refused with a 400, not a 500", async () => {
    const app = await buildApp(userId);
    try {
      const notADate = await create(app, {
        name: "Nonsense date",
        ...schedules["once_daily"],
        startDate: "not-a-date"
      });
      expect(notADate.statusCode, notADate.body).toBe(400);
      expect(notADate.body).toContain("startDate");

      // Right shape, impossible day.
      const impossible = await create(app, {
        name: "Impossible date",
        ...schedules["once_daily"],
        startDate: "2026-02-30"
      });
      expect(impossible.statusCode, impossible.body).toBe(400);

      const created = await create(app, { name: "Good med", ...schedules["once_daily"] });
      expect(created.statusCode, created.body).toBe(201);
      const badEdit = await patch(app, created.json().medication.id as string, {
        ...schedules["once_daily"],
        endDate: "2026-13-01"
      });
      expect(badEdit.statusCode, badEdit.body).toBe(400);
    } finally {
      await app.close();
    }
  });
});
