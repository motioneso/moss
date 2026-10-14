import { describe, expect, it } from "vitest";

import type { GetQuietHoursSettingsResponse, QuietHoursSettingsDto } from "@moss/shared";
import { ApiError } from "../../apps/web/src/api/client.js";
import {
  QUIET_HOURS_STALE_SAVE_MESSAGE,
  quietHoursDraftDirty,
  quietHoursDraftProblem,
  quietHoursSavedLine,
  quietHoursSaveFailure
} from "../../apps/web/src/settings/settings-quiet-hours-draft.js";

const saved: QuietHoursSettingsDto = {
  enabled: true,
  start: "22:00",
  end: "07:00",
  timezone: "America/Chicago"
};

function response(
  quietHours: QuietHoursSettingsDto,
  authority: GetQuietHoursSettingsResponse["authority"] = { status: "canonical", alerts: null }
): GetQuietHoursSettingsResponse {
  return { quietHours, authority, version: "1:1" };
}

describe("quietHoursDraftDirty", () => {
  it("is clean when every field matches the saved schedule", () => {
    expect(quietHoursDraftDirty(saved, { ...saved })).toBe(false);
  });

  it("is dirty when any field differs, including a switch back to the profile zone", () => {
    expect(quietHoursDraftDirty(saved, { ...saved, enabled: false })).toBe(true);
    expect(quietHoursDraftDirty(saved, { ...saved, start: "23:00" })).toBe(true);
    expect(quietHoursDraftDirty(saved, { ...saved, end: "06:30" })).toBe(true);
    expect(quietHoursDraftDirty(saved, { ...saved, timezone: null })).toBe(true);
  });
});

describe("quietHoursDraftProblem", () => {
  it("accepts an overnight window", () => {
    expect(quietHoursDraftProblem({ ...saved, start: "22:00", end: "07:00" })).toBeNull();
  });

  it("accepts a same-day window", () => {
    expect(quietHoursDraftProblem({ ...saved, start: "13:00", end: "14:30" })).toBeNull();
  });

  // Times are local wall-clock times in the chosen zone; the release cutoff across a
  // daylight-saving change is converted by the server-side quiet-window helpers.
  it("accepts a window whose night contains a daylight-saving change", () => {
    expect(
      quietHoursDraftProblem({ ...saved, start: "01:30", end: "03:30", timezone: "Europe/London" })
    ).toBeNull();
  });

  it("refuses the same start and end time", () => {
    expect(quietHoursDraftProblem({ ...saved, start: "07:00", end: "07:00" })).toBe(
      "Choose different start and end times."
    );
  });

  it("refuses a missing or malformed time", () => {
    expect(quietHoursDraftProblem({ ...saved, start: "" })).toBe(
      "Enter a start and end time between 00:00 and 23:59."
    );
    expect(quietHoursDraftProblem({ ...saved, end: "24:00" })).toBe(
      "Enter a start and end time between 00:00 and 23:59."
    );
  });

  it("refuses an unknown time zone but allows following the profile zone", () => {
    expect(quietHoursDraftProblem({ ...saved, timezone: "Mars/Olympus_Mons" })).toBe(
      "Choose a time zone from the list."
    );
    expect(quietHoursDraftProblem({ ...saved, timezone: null })).toBeNull();
  });
});

describe("quietHoursSavedLine", () => {
  it("names the saved schedule and its zone", () => {
    expect(quietHoursSavedLine(response(saved), "America/Los_Angeles")).toBe(
      "Saved schedule: every day, 22:00 to 07:00, America/Chicago time."
    );
  });

  it("names the profile zone when the schedule follows it", () => {
    expect(quietHoursSavedLine(response({ ...saved, timezone: null }), "Europe/Paris")).toBe(
      "Saved schedule: every day, 22:00 to 07:00, your profile time zone (Europe/Paris)."
    );
  });

  it("says when saved quiet hours are off", () => {
    expect(quietHoursSavedLine(response({ ...saved, enabled: false }), "UTC")).toBe(
      "Saved schedule: quiet hours are off."
    );
  });

  it("says nothing is saved yet for the reviewed default", () => {
    expect(
      quietHoursSavedLine(
        response(
          { enabled: false, start: "22:00", end: "07:00", timezone: null },
          {
            status: "default",
            alerts: null
          }
        ),
        "UTC"
      )
    ).toBe("Nothing saved yet, so quiet hours are off.");
  });

  it("never presents a conflicting schedule as the one saved setting", () => {
    const conflict = response(saved, {
      status: "conflict",
      alerts: { enabled: true, start: "23:00", end: "08:00" }
    });
    const line = quietHoursSavedLine(conflict, "UTC");
    expect(line).toBe("Notifications follow: every day, 22:00 to 07:00, America/Chicago time.");
    expect(line).not.toContain("Saved schedule");
  });

  it("does not call an unreadable record the saved setting", () => {
    const malformed = response(saved, { status: "malformed", alerts: null });
    expect(quietHoursSavedLine(malformed, "UTC")).toBe(
      "Notifications follow: every day, 22:00 to 07:00, America/Chicago time."
    );
  });
});

describe("quietHoursSaveFailure", () => {
  it("explains a refused stale save", () => {
    expect(quietHoursSaveFailure(new ApiError(409, "conflict"))).toBe(
      QUIET_HOURS_STALE_SAVE_MESSAGE
    );
  });

  it("keeps the previous schedule in force for any other failure", () => {
    expect(
      quietHoursSaveFailure(new ApiError(400, "Quiet hours must start and end at different times"))
    ).toBe(
      "Quiet hours could not save: Quiet hours must start and end at different times. Your previous schedule still applies."
    );
    expect(quietHoursSaveFailure(new Error("Network down."))).toBe(
      "Quiet hours could not save: Network down. Your previous schedule still applies."
    );
  });
});
