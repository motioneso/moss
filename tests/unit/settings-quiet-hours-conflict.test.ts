// #3131 - the conflict offer names each differing saved schedule once, and its wording says which
// schedule now applies or why nothing changed.
import { describe, expect, it } from "vitest";

import type { GetQuietHoursSettingsResponse, QuietHoursSettingsDto } from "@moss/shared";
import { ApiError } from "../../apps/web/src/api/client.js";
import {
  QUIET_HOURS_STALE_CHOICE_MESSAGE,
  quietHoursChoiceFailure,
  quietHoursChoiceRequest,
  quietHoursChoices,
  quietHoursChosenLine
} from "../../apps/web/src/settings/settings-quiet-hours-conflict.js";

const off: QuietHoursSettingsDto = { enabled: false, start: "22:00", end: "07:00", timezone: null };

function conflict(
  quietHours: QuietHoursSettingsDto,
  alerts: GetQuietHoursSettingsResponse["authority"]["alerts"]
): GetQuietHoursSettingsResponse {
  return { quietHours, authority: { status: "conflict", alerts }, version: "3:100:abc" };
}

describe("quietHoursChoices", () => {
  it("offers to keep Profile's off schedule or use the alert window", () => {
    const choices = quietHoursChoices(
      conflict(off, { enabled: true, start: "22:00", end: "08:00" })
    );
    expect(choices.map((c) => c.label)).toEqual(["Keep quiet hours off", "Use 22:00 to 08:00"]);
    expect(choices[1]!.quietHours).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
      timezone: null
    });
  });

  it("names Profile's own zone by its city and offers to turn quiet hours off", () => {
    const choices = quietHoursChoices(
      conflict(
        { enabled: true, start: "22:00", end: "07:00", timezone: "America/Argentina/Buenos_Aires" },
        { enabled: false, start: "22:00", end: "07:00" }
      )
    );
    expect(choices.map((c) => c.label)).toEqual([
      "Use 22:00 to 07:00 (Buenos Aires)",
      "Turn quiet hours off"
    ]);
  });

  it("says the alert window runs in the Profile time zone when Profile names its own", () => {
    const choices = quietHoursChoices(
      conflict(
        { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" },
        { enabled: true, start: "22:00", end: "07:00" }
      )
    );
    expect(choices.map((c) => c.label)).toEqual([
      "Use 22:00 to 07:00 (London)",
      "Use 22:00 to 07:00 (Profile time zone)"
    ]);
  });

  it("keeps every label short enough for one line on a phone", () => {
    const longestCity = Intl.supportedValuesOf("timeZone").reduce((longest, zone) =>
      zone.length > longest.length ? zone : longest
    );
    const cases = [
      conflict(
        { enabled: true, start: "22:00", end: "07:00", timezone: longestCity },
        { enabled: true, start: "23:00", end: "08:00" }
      ),
      conflict(
        { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" },
        { enabled: true, start: "22:00", end: "07:00" }
      ),
      conflict(off, { enabled: false, start: "23:00", end: "08:00" })
    ];
    for (const loaded of cases) {
      for (const choice of quietHoursChoices(loaded)) {
        expect(choice.label.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it("tells two off schedules apart by the window each keeps", () => {
    const choices = quietHoursChoices(
      conflict(off, { enabled: false, start: "23:00", end: "08:00" })
    );
    expect(choices.map((c) => c.label)).toEqual([
      "Keep off (saved 22:00 to 07:00)",
      "Keep off (saved 23:00 to 08:00)"
    ]);
  });

  it("offers one button when both schedules are the same", () => {
    const choices = quietHoursChoices(
      conflict(off, { enabled: false, start: "22:00", end: "07:00" })
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]!.choice).toBe("profile");
  });

  it("offers only Profile's schedule when the alert schedule is gone", () => {
    expect(quietHoursChoices(conflict(off, null)).map((c) => c.choice)).toEqual(["profile"]);
  });

  it.each(["default", "carried", "canonical", "malformed"] as const)(
    "offers nothing for a %s owner",
    (status) => {
      expect(
        quietHoursChoices({ quietHours: off, authority: { status, alerts: null }, version: null })
      ).toEqual([]);
    }
  );
});

describe("quietHoursChoiceRequest", () => {
  it("sends the chosen side, its schedule and the version the owner saw", () => {
    const [, alerts] = quietHoursChoices(
      conflict(off, { enabled: true, start: "22:00", end: "08:00" })
    );
    expect(quietHoursChoiceRequest(alerts!, "3:100:abc")).toEqual({
      choice: "alerts",
      quietHours: { enabled: true, start: "22:00", end: "08:00", timezone: null },
      expectedVersion: "3:100:abc"
    });
  });
});

describe("quietHoursChosenLine", () => {
  it("names the kept Profile schedule or the adopted alert schedule", () => {
    const [profile, alerts] = quietHoursChoices(
      conflict(
        { enabled: true, start: "21:00", end: "06:00", timezone: "Europe/London" },
        { enabled: true, start: "22:00", end: "08:00" }
      )
    );
    expect(quietHoursChosenLine(profile!)).toBe(
      "Kept your saved quiet hours: 21:00 to 06:00, Europe/London time."
    );
    expect(quietHoursChosenLine(alerts!)).toBe(
      "Using your saved email alert schedule: 22:00 to 08:00."
    );
    const [keptOff] = quietHoursChoices(
      conflict(off, { enabled: true, start: "22:00", end: "08:00" })
    );
    expect(quietHoursChosenLine(keptOff!)).toBe("Kept your saved quiet hours: off.");
  });
});

describe("quietHoursChoiceFailure", () => {
  it("says a lost race shows the latest schedules", () => {
    expect(quietHoursChoiceFailure(new ApiError(409, "changed"))).toBe(
      QUIET_HOURS_STALE_CHOICE_MESSAGE
    );
  });

  it("names any other failure and says the previous schedules still apply", () => {
    expect(quietHoursChoiceFailure(new ApiError(503, "Service unavailable."))).toBe(
      "Your choice could not save: Service unavailable. Your previous schedules still apply."
    );
  });
});
