import { describe, expect, it } from "vitest";

import type { CreateMedicationRequest, MedicationDto } from "@moss/shared";

import {
  buildCreateRequest,
  describeFormProblems,
  emptyMedForm,
  medFormFromMedication,
  previewMedication,
  SCHEDULE_CHOICES,
  startDateRequired,
  supportsReminders,
  withChoice,
  type MedFormState,
  type ScheduleChoice
} from "../../apps/web/src/wellness/medication-schedule-form.js";
import { parseCreateMedicationBody } from "../../packages/wellness/src/medication-request-parsing.js";
import { describeSchedule, nextDoses } from "../../packages/wellness/src/schedule-summary.js";

/**
 * #1970 — the add-a-medication form. These import the form's real functions, so a bug in the
 * shipped code fails here. (The older tests/unit/wellness-meds-payload.test.ts re-implements the
 * previous form's logic inside the test file, which can pass while the form itself is broken.)
 *
 * The strongest assertion in the file is that every request the form builds is accepted by the
 * server's own validator, imported directly rather than restated: the six schedule types each
 * have their own required and forbidden fields, and getting one wrong shows up as a 400 in front
 * of the user, not as a failing test.
 */

const TODAY = "2026-08-26";
const TZ = "UTC";

const ALL_CHOICES: ScheduleChoice[] = [
  "daily",
  "selected_days",
  "every_interval",
  "monthly",
  "cycle",
  "as_needed"
];

/** A filled-in form for `choice`, ready to save. */
function filled(choice: ScheduleChoice): MedFormState {
  const base = withChoice({ ...emptyMedForm(TODAY), name: "Bupropion" }, choice, TODAY);
  return choice === "selected_days" ? { ...base, weekdays: [1, 3, 5] } : base;
}

describe("the six schedule choices", () => {
  it("offers exactly the six the spec names", () => {
    expect(SCHEDULE_CHOICES.map((c) => c.value)).toEqual(ALL_CHOICES);
  });

  it("gives every choice a plain-English label with no underscores", () => {
    for (const choice of SCHEDULE_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.label).not.toContain("_");
    }
  });
});

describe("every choice builds a request the server accepts", () => {
  for (const choice of ALL_CHOICES) {
    it(`${choice} passes the server's own validator`, () => {
      const request = buildCreateRequest(filled(choice));
      expect(() => parseCreateMedicationBody(request)).not.toThrow();
    });
  }

  it("as needed sends no scheduling fields at all", () => {
    const request = buildCreateRequest(filled("as_needed")) as unknown as Record<string, unknown>;
    for (const banned of [
      "scheduleTimes",
      "timesPerDay",
      "weekdays",
      "cycleAnchorDate",
      "cycleDaysOn",
      "cycleDaysOff",
      "intervalUnit",
      "intervalCount",
      "monthKind",
      "monthDay",
      "monthWeekdayPosition",
      "monthWeekday",
      "remindersEnabled"
    ]) {
      expect(request[banned] ?? null).toBeNull();
    }
  });

  it("a cycle counts from the start date the person picked", () => {
    const state = { ...filled("cycle"), startDate: "2026-09-01" };
    const request = buildCreateRequest(state);
    expect(request.cycleAnchorDate).toBe("2026-09-01");
    expect(request.startDate).toBe("2026-09-01");
  });
});

describe("switching choice replaces the previous choice's fields", () => {
  it("drops the monthly fields when the user switches to daily", () => {
    const monthly = filled("monthly");
    const daily = withChoice(monthly, "daily", TODAY);
    const request = buildCreateRequest(daily) as unknown as Record<string, unknown>;
    expect(request["monthKind"] ?? null).toBeNull();
    expect(request["monthDay"] ?? null).toBeNull();
    expect(() => parseCreateMedicationBody(request)).not.toThrow();
  });

  it("drops the weekday list when the user switches away from selected days", () => {
    const weekly = { ...filled("selected_days"), weekdays: [2, 4] };
    const request = buildCreateRequest(withChoice(weekly, "daily", TODAY)) as unknown as Record<
      string,
      unknown
    >;
    expect(request["weekdays"] ?? null).toBeNull();
  });

  it("resets every schedule field to its default, not the previous choice's value", () => {
    // The request builder only reads the fields belonging to the chosen type, so a stale value
    // cannot reach the server through it. This asserts the state contract itself: the form shows
    // these values back to the person, and a leftover "31st of the month" sitting behind a daily
    // schedule reappears the moment they switch back.
    const monthly: MedFormState = {
      ...filled("monthly"),
      monthDay: 31,
      monthKind: "weekdayPosition",
      monthWeekday: 6,
      cycleDaysOn: 3,
      cycleDaysOff: 11,
      intervalCount: 9,
      intervalUnit: "months",
      weekdays: [2, 4]
    };
    const daily = withChoice(monthly, "daily", TODAY);
    const fresh = emptyMedForm(TODAY);
    expect(daily.monthDay).toBe(fresh.monthDay);
    expect(daily.monthKind).toBe(fresh.monthKind);
    expect(daily.monthWeekday).toBe(fresh.monthWeekday);
    expect(daily.cycleDaysOn).toBe(fresh.cycleDaysOn);
    expect(daily.cycleDaysOff).toBe(fresh.cycleDaysOff);
    expect(daily.intervalCount).toBe(fresh.intervalCount);
    expect(daily.intervalUnit).toBe(fresh.intervalUnit);
    expect(daily.weekdays).toEqual(fresh.weekdays);
  });

  it("turns the reminder switch off when moving to a choice that cannot use it", () => {
    const reminded: MedFormState = { ...filled("daily"), remindersEnabled: true };
    expect(withChoice(reminded, "as_needed", TODAY).remindersEnabled).toBe(false);
    expect(withChoice(reminded, "monthly", TODAY).remindersEnabled).toBe(true);
  });

  it("keeps the name and dose across a switch", () => {
    const state = { ...filled("daily"), name: "Sertraline", dose: "50 mg" };
    const switched = withChoice(state, "monthly", TODAY);
    expect(switched.name).toBe("Sertraline");
    expect(switched.dose).toBe("50 mg");
  });

  it("keeps the dose times across a switch between scheduled choices", () => {
    const state = { ...filled("daily"), times: ["08:00", "14:00", "20:00"] };
    expect(withChoice(state, "selected_days", TODAY).times).toEqual(["08:00", "14:00", "20:00"]);
    expect(withChoice(state, "cycle", TODAY).times).toEqual(["08:00", "14:00", "20:00"]);
  });

  it("clears the dose times for as-needed and puts one back on the way out", () => {
    const asNeeded = withChoice(
      { ...filled("daily"), times: ["08:00", "20:00"] },
      "as_needed",
      TODAY
    );
    expect(asNeeded.times).toEqual([]);
    expect(withChoice(asNeeded, "daily", TODAY).times).toEqual(emptyMedForm(TODAY).times);
  });
});

describe("daily splits on how many times a day", () => {
  it("one time a day is stored as once daily", () => {
    const request = buildCreateRequest({ ...filled("daily"), times: ["08:00"] });
    expect(request.frequencyType).toBe("once_daily");
    expect(request.scheduleTimes).toEqual(["08:00"]);
  });

  it("three times a day is stored as times per day, with all three clock times", () => {
    const request = buildCreateRequest({
      ...filled("daily"),
      times: ["08:00", "14:00", "20:00"]
    });
    expect(request.frequencyType).toBe("times_per_day");
    expect(request.timesPerDay).toBe(3);
    expect(request.scheduleTimes).toEqual(["08:00", "14:00", "20:00"]);
    expect(() => parseCreateMedicationBody(request)).not.toThrow();
  });
});

describe("what stops the form being saved", () => {
  it("a blank name is a problem for every choice", () => {
    for (const choice of ALL_CHOICES) {
      const problems = describeFormProblems({ ...filled(choice), name: "  " });
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it("a filled-in form of every choice has no problems", () => {
    for (const choice of ALL_CHOICES) {
      expect(describeFormProblems(filled(choice))).toEqual([]);
    }
  });

  it("every so often, monthly and a cycle need a start date, the other three do not", () => {
    for (const choice of ALL_CHOICES) {
      const required = choice === "every_interval" || choice === "monthly" || choice === "cycle";
      expect(startDateRequired(choice)).toBe(required);
      const problems = describeFormProblems({ ...filled(choice), startDate: "" });
      expect(problems.length > 0).toBe(required);
    }
  });

  it("never calls a form valid that the server would then reject", () => {
    // The form's whole job is to say what is missing before the request goes out. Anything it
    // reports as ready to save has to survive the server's own validator, or the person presses
    // the button and nothing happens.
    for (const choice of ALL_CHOICES) {
      for (const startDate of ["", TODAY]) {
        const state = { ...filled(choice), startDate };
        if (describeFormProblems(state).length > 0) continue;
        const request = buildCreateRequest(state) as unknown as Record<string, unknown>;
        expect(() => parseCreateMedicationBody(request)).not.toThrow();
      }
    }
  });

  it("reports a malformed clock time in plain English", () => {
    const problems = describeFormProblems({ ...filled("daily"), times: ["8am"] });
    expect(problems.join(" ")).toMatch(/time/i);
  });

  it("selected days needs at least one day ticked", () => {
    const problems = describeFormProblems({ ...filled("selected_days"), weekdays: [] });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("states problems without underscores or field names from the code", () => {
    const problems = describeFormProblems({ ...emptyMedForm(TODAY), name: "" });
    for (const problem of problems) {
      expect(problem).not.toContain("_");
      expect(problem).not.toMatch(/frequencyType|scheduleTimes|monthKind/);
    }
  });
});

describe("reminders", () => {
  it("are offered on the five scheduled choices and not on as needed", () => {
    for (const choice of ALL_CHOICES) {
      expect(supportsReminders(choice)).toBe(choice !== "as_needed");
    }
  });

  it("are sent when switched on and the choice has a schedule", () => {
    const request = buildCreateRequest({ ...filled("daily"), remindersEnabled: true });
    expect(request.remindersEnabled).toBe(true);
    expect(() => parseCreateMedicationBody(request)).not.toThrow();
  });
});

describe("the live preview", () => {
  it("describes every choice in a sentence", () => {
    for (const choice of ALL_CHOICES) {
      const sentence = describeSchedule(previewMedication(filled(choice), TZ));
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toContain("_");
    }
  });

  it("works out the next three doses for each scheduled choice", () => {
    const from = new Date("2026-08-26T00:00:00Z");
    for (const choice of ALL_CHOICES.filter((c) => c !== "as_needed")) {
      const doses = nextDoses(previewMedication(filled(choice), TZ), from, 3);
      expect(doses.length, `${choice} produced no doses`).toBe(3);
    }
  });

  it("has no doses to show for an as-needed medication", () => {
    const doses = nextDoses(
      previewMedication(filled("as_needed"), TZ),
      new Date("2026-08-26T00:00:00Z"),
      3
    );
    expect(doses).toEqual([]);
  });

  it("moves the preview when the clock time changes", () => {
    const from = new Date("2026-08-26T00:00:00Z");
    const early = nextDoses(
      previewMedication({ ...filled("daily"), times: ["08:00"] }, TZ),
      from,
      1
    );
    const late = nextDoses(
      previewMedication({ ...filled("daily"), times: ["20:00"] }, TZ),
      from,
      1
    );
    expect(early[0]?.toISOString()).not.toBe(late[0]?.toISOString());
  });
});

/**
 * Stands in for what the server would have saved and read back, built from the exact request
 * `buildCreateRequest` produced. Dose times come back with seconds, the way the database's time
 * column reports them (matches the trim in tests/uat/specs/1970-medication-builder.uat.spec.ts).
 */
function medicationDtoFromRequest(request: CreateMedicationRequest): MedicationDto {
  const r = request as CreateMedicationRequest & Record<string, unknown>;
  return {
    id: "m1",
    ownerUserId: "u1",
    name: r.name,
    dosage: r.dosage ?? null,
    form: null,
    frequencyType: r.frequencyType,
    timesPerDay: (r["timesPerDay"] as number | undefined) ?? null,
    intervalHours: null,
    weekdays: (r["weekdays"] as number[] | undefined) ?? null,
    scheduleTimes: r["scheduleTimes"]
      ? (r["scheduleTimes"] as string[]).map((t) => `${t}:00`)
      : null,
    cycleDaysOn: (r["cycleDaysOn"] as number | undefined) ?? null,
    cycleDaysOff: (r["cycleDaysOff"] as number | undefined) ?? null,
    cycleAnchorDate: (r["cycleAnchorDate"] as string | undefined) ?? null,
    active: true,
    notes: null,
    scheduleStartDate: r.startDate ?? null,
    scheduleEndDate: null,
    timeZone: TZ,
    intervalUnit: (r["intervalUnit"] as MedicationDto["intervalUnit"]) ?? null,
    intervalCount: (r["intervalCount"] as number | undefined) ?? null,
    monthKind: (r["monthKind"] as MedicationDto["monthKind"]) ?? null,
    monthDay: (r["monthDay"] as number | undefined) ?? null,
    monthDayIsLast: r["monthDayIsLast"] === true,
    monthWeekdayPosition:
      (r["monthWeekdayPosition"] as MedicationDto["monthWeekdayPosition"]) ?? null,
    monthWeekday: (r["monthWeekday"] as number | undefined) ?? null,
    remindersEnabled: r["remindersEnabled"] === true,
    createdAt: null,
    updatedAt: null
  };
}

describe("medFormFromMedication reads a saved medication back into the form", () => {
  for (const choice of ALL_CHOICES) {
    it(`round-trips ${choice} through save and reopen`, () => {
      const original = buildCreateRequest(filled(choice));
      const saved = medicationDtoFromRequest(original);
      const reopened = medFormFromMedication(saved);
      expect(buildCreateRequest(reopened)).toEqual(original);
    });
  }

  it("slices a stored HH:MM:SS dose time back to HH:MM", () => {
    const saved = medicationDtoFromRequest(buildCreateRequest(filled("daily")));
    expect(saved.scheduleTimes).toEqual(["08:00:00"]);
    expect(medFormFromMedication(saved).times).toEqual(["08:00"]);
  });

  it("carries the reminder flag and the dosage across", () => {
    const withReminders = { ...filled("monthly"), dose: "50 mg", remindersEnabled: true };
    const saved = medicationDtoFromRequest(buildCreateRequest(withReminders));
    const reopened = medFormFromMedication(saved);
    expect(reopened.remindersEnabled).toBe(true);
    expect(reopened.dose).toBe("50 mg");
  });
});
