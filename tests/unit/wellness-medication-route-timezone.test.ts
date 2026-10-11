process.env.TZ = "UTC";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextRunner } from "@moss/db";
import type * as StructuredState from "@moss/structured-state";
import type { WellnessRepository } from "../../packages/wellness/src/repository.js";

let storedLocale: unknown = null;

vi.mock("@moss/structured-state", async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredState>()),
  PreferencesRepository: class {
    async get(_scopedDb: unknown, key: string): Promise<unknown> {
      return key === "locale" ? storedLocale : null;
    }
  }
}));

const { registerWellnessRoutes } = await import("../../packages/wellness/src/routes.js");

const ACCESS: AccessContext = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  requestId: "req:test"
};

const runner = {
  withDataContext: async (_access: AccessContext, work: (scopedDb: unknown) => unknown) => work({})
} as unknown as DataContextRunner;

function medicationRow(timeZone: string) {
  const at = new Date("2026-10-10T03:30:00Z");
  return {
    id: "22222222-2222-4222-8222-222222222222",
    owner_user_id: ACCESS.actorUserId,
    name: "Ibuprofen",
    dosage: null,
    form: null,
    frequency_type: "as_needed",
    times_per_day: null,
    interval_hours: null,
    weekdays: null,
    schedule_times: null,
    cycle_days_on: null,
    cycle_days_off: null,
    cycle_anchor_date: null,
    active: true,
    notes: null,
    created_at: at,
    updated_at: at,
    schedule_start_date: null,
    schedule_end_date: null,
    time_zone: timeZone,
    interval_unit: null,
    interval_count: null,
    month_kind: null,
    month_day: null,
    month_day_is_last: null,
    month_weekday_position: null,
    month_weekday: null,
    reminders_enabled: false
  };
}

/** Create a medication with a browser zone header and return the zone the repository saved. */
async function savedMedicationZone(): Promise<string | undefined> {
  let savedZone: string | undefined;
  const repository = {
    createMedication: async (_scopedDb: unknown, _input: unknown, timeZone: string) => {
      savedZone = timeZone;
      return medicationRow(timeZone);
    }
  } as unknown as WellnessRepository;

  const app = Fastify();
  registerWellnessRoutes(app, {
    resolveAccessContext: async () => ACCESS,
    dataContext: runner,
    repository
  });
  await app.ready();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/wellness/medications",
      headers: { "content-type": "application/json", "x-timezone": "America/New_York" },
      payload: { name: "Ibuprofen", frequencyType: "as_needed" }
    });
    expect(res.statusCode).toBe(201);
  } finally {
    await app.close();
  }
  return savedZone;
}

describe("medication schedule zone (#3395)", () => {
  afterEach(() => {
    storedLocale = null;
  });

  it("saves the person's saved zone, not the browser's", async () => {
    storedLocale = { timezone: "Europe/London", region: "en-GB", dateFormat: "24" };
    await expect(savedMedicationZone()).resolves.toBe("Europe/London");
  });

  it("saves the shared default zone, not UTC, when nothing is saved", async () => {
    await expect(savedMedicationZone()).resolves.toBe("America/Los_Angeles");
  });
});
