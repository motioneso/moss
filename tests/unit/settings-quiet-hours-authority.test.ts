import { describe, expect, it } from "vitest";

import {
  alertsQuietPolicy,
  classifyQuietHours,
  localeFreezeMarker,
  nextQuietHoursMarker,
  notificationsQuietHoursValue,
  type QuietHoursAuthorityInput
} from "../../packages/settings/src/quiet-hours-authority.js";

const UPDATED = "2026-10-01T00:00:00.000Z";

function nested(quietHours?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    ...(quietHours === undefined ? {} : { quietHours }),
    ...extra,
    updatedAt: UPDATED
  };
}

function input(overrides: Partial<QuietHoursAuthorityInput> = {}): QuietHoursAuthorityInput {
  return { profile: undefined, proactive: undefined, locale: undefined, ...overrides };
}

const PROFILE_ON = { enabled: true, start: "22:00", end: "07:00", timezone: null };
const NESTED_ON = { enabled: true, startLocalTime: "22:00", endLocalTime: "07:00" };

describe("classifyQuietHours: migration table", () => {
  it("treats no records as the off default in the owner's zone", () => {
    const result = classifyQuietHours(input({ locale: { timezone: "Europe/London" } }));
    expect(result.status).toBe("default");
    expect(result.effective).toEqual({
      enabled: false,
      start: "22:00",
      end: "07:00",
      timezone: null
    });
    expect(notificationsQuietHoursValue(result)).toBeNull();
    expect(alertsQuietPolicy(result)).toEqual({
      enabled: false,
      startLocalTime: "22:00",
      endLocalTime: "07:00",
      timeZone: "Europe/London"
    });
  });

  it("does not count sparse email-only initialization as a saved quiet choice", () => {
    const sparse = { version: 1, automaticEmailAlerts: true, updatedAt: UPDATED };
    expect(classifyQuietHours(input({ proactive: sparse })).status).toBe("default");
  });

  it("does not count a whole record without a quietHours key as a saved quiet choice", () => {
    const record = nested(undefined, { enabled: true, dailyCardCap: 5 });
    expect(classifyQuietHours(input({ proactive: record })).status).toBe("default");
  });

  it("carries a sole Profile schedule forward", () => {
    const profile = { enabled: true, start: "21:00", end: "06:00", timezone: "Asia/Tokyo" };
    const result = classifyQuietHours(input({ profile }));
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual(profile);
    expect(notificationsQuietHoursValue(result)).toEqual(profile);
    expect(alertsQuietPolicy(result)).toEqual({
      enabled: true,
      startLocalTime: "21:00",
      endLocalTime: "06:00",
      timeZone: "Asia/Tokyo"
    });
  });

  it("carries a sole nested schedule forward without pinning the owner zone", () => {
    const result = classifyQuietHours(
      input({
        proactive: nested({ enabled: true, startLocalTime: "23:00", endLocalTime: "06:30" }),
        locale: { timezone: "Europe/London" }
      })
    );
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual({
      enabled: true,
      start: "23:00",
      end: "06:30",
      timezone: null
    });
    expect(alertsQuietPolicy(result)?.timeZone).toBe("Europe/London");
  });

  it("counts a saved whole legacy record with the old default nested schedule as saved", () => {
    const record = nested(
      { enabled: true, startLocalTime: "22:00", endLocalTime: "08:00" },
      { enabled: false, dailyCardCap: 8 }
    );
    const result = classifyQuietHours(input({ proactive: record }));
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
      timezone: null
    });
  });

  it("fills a partial nested schedule the way the alerts worker always read it", () => {
    const result = classifyQuietHours(input({ proactive: nested({ enabled: false }) }));
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual({
      enabled: false,
      start: "22:00",
      end: "08:00",
      timezone: null
    });
  });

  it("carries identical saved values", () => {
    const result = classifyQuietHours(input({ profile: PROFILE_ON, proactive: nested(NESTED_ON) }));
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual(PROFILE_ON);
  });

  it("compares meaning after resolving the unset owner zone", () => {
    const profile = { ...PROFILE_ON, timezone: "Europe/London" };
    const result = classifyQuietHours(
      input({ profile, proactive: nested(NESTED_ON), locale: { timezone: "Europe/London" } })
    );
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual(profile);
  });

  it("resolves an owner with no locale to UTC when comparing zones", () => {
    const profile = { ...PROFILE_ON, timezone: "UTC" };
    expect(classifyQuietHours(input({ profile, proactive: nested(NESTED_ON) })).status).toBe(
      "carried"
    );
  });

  it("keeps a different window unresolved and leaves each consumer its own policy", () => {
    const profile = PROFILE_ON;
    const result = classifyQuietHours(
      input({
        profile,
        proactive: nested({ ...NESTED_ON, endLocalTime: "08:00" }),
        locale: { timezone: "Europe/London" }
      })
    );
    expect(result.status).toBe("conflict");
    expect(result.effective).toBeNull();
    expect(notificationsQuietHoursValue(result)).toEqual(profile);
    expect(alertsQuietPolicy(result)).toBeNull();
    expect(result.alertsSchedule).toEqual({ enabled: true, start: "22:00", end: "08:00" });
  });

  it("keeps an enabled/off disagreement unresolved", () => {
    const result = classifyQuietHours(
      input({ profile: { ...PROFILE_ON, enabled: false }, proactive: nested(NESTED_ON) })
    );
    expect(result.status).toBe("conflict");
  });

  it("keeps meaningfully different zones unresolved", () => {
    const result = classifyQuietHours(
      input({
        profile: { ...PROFILE_ON, timezone: "America/New_York" },
        proactive: nested(NESTED_ON),
        locale: { timezone: "Europe/London" }
      })
    );
    expect(result.status).toBe("conflict");
  });

  it("carries a legacy equal-time schedule without rejecting it", () => {
    const profile = { enabled: true, start: "09:00", end: "09:00", timezone: null };
    const result = classifyQuietHours(input({ profile }));
    expect(result.status).toBe("carried");
    expect(result.effective).toEqual(profile);
  });

  it("resolves an invalid owner locale zone to UTC", () => {
    const result = classifyQuietHours(input({ locale: { timezone: "Not/AZone" } }));
    expect(result.ownerTimeZone).toBe("UTC");
  });
});

describe("classifyQuietHours: malformed records are preserved, not repaired", () => {
  it.each([
    ["non-boolean enabled", { ...PROFILE_ON, enabled: "yes" }],
    ["loose start time", { ...PROFILE_ON, start: "24:00" }],
    ["missing end", { enabled: true, start: "22:00", timezone: null }],
    ["invalid zone", { ...PROFILE_ON, timezone: "Not/AZone" }],
    ["unknown authority", { ...PROFILE_ON, authority: "maybe" }],
    ["canonical marker on invalid fields", { ...PROFILE_ON, start: "x", authority: "canonical" }],
    ["not an object", "22:00-07:00"]
  ])("Profile %s", (_label, profile) => {
    const result = classifyQuietHours(input({ profile, proactive: nested(NESTED_ON) }));
    expect(result.status).toBe("malformed");
    expect(result.effective).toBeNull();
    expect(notificationsQuietHoursValue(result)).toEqual(profile);
    expect(alertsQuietPolicy(result)).toBeNull();
  });

  it.each([
    ["non-object quietHours", nested(undefined, { quietHours: "off" })],
    ["wrong version", { version: 2, quietHours: NESTED_ON, updatedAt: UPDATED }],
    ["loose nested time", nested({ ...NESTED_ON, startLocalTime: "24:00" })],
    ["invalid cap", nested(NESTED_ON, { dailyCardCap: 99 })]
  ])("nested %s", (_label, proactive) => {
    const result = classifyQuietHours(input({ profile: PROFILE_ON, proactive }));
    expect(result.status).toBe("malformed");
    expect(result.effective).toBeNull();
    expect(notificationsQuietHoursValue(result)).toEqual(PROFILE_ON);
    expect(alertsQuietPolicy(result)).toBeNull();
  });
});

describe("classifyQuietHours: migration markers", () => {
  it("lets a canonical Profile govern even when an old nested snapshot differs", () => {
    const profile = { ...PROFILE_ON, end: "06:00", authority: "canonical" };
    const result = classifyQuietHours(
      input({ profile, proactive: nested({ ...NESTED_ON, endLocalTime: "09:00" }) })
    );
    expect(result.status).toBe("canonical");
    expect(result.effective).toEqual({ ...PROFILE_ON, end: "06:00" });
    expect(notificationsQuietHoursValue(result)).toEqual({ ...PROFILE_ON, end: "06:00" });
  });

  it("keeps an unresolved marker as a conflict even once the values agree", () => {
    const profile = { ...PROFILE_ON, authority: "unresolved" };
    const result = classifyQuietHours(input({ profile, proactive: nested(NESTED_ON) }));
    expect(result.status).toBe("conflict");
    expect(result.effective).toBeNull();
  });
});

describe("nextQuietHoursMarker", () => {
  it.each([
    ["default", input()],
    ["carried", input({ profile: PROFILE_ON })],
    ["canonical", input({ profile: { ...PROFILE_ON, authority: "canonical" } })]
  ])("makes a write on a %s owner canonical", (_label, pre) => {
    expect(nextQuietHoursMarker(pre, { ...PROFILE_ON, end: "05:00" })).toBe("canonical");
  });

  it("never resolves a conflict", () => {
    const pre = input({ profile: PROFILE_ON, proactive: nested({ ...NESTED_ON, enabled: false }) });
    expect(nextQuietHoursMarker(pre, { ...PROFILE_ON, enabled: false })).toBe("unresolved");
  });

  it("classifies a repaired malformed Profile by the state after the write", () => {
    const pre = input({ profile: { ...PROFILE_ON, start: "x" } });
    expect(nextQuietHoursMarker(pre, PROFILE_ON)).toBe("canonical");
    const conflicting = input({
      profile: { ...PROFILE_ON, start: "x" },
      proactive: nested({ ...NESTED_ON, endLocalTime: "09:00" })
    });
    expect(nextQuietHoursMarker(conflicting, PROFILE_ON)).toBe("unresolved");
  });

  it("leaves a malformed nested record unmarked", () => {
    const pre = input({ profile: PROFILE_ON, proactive: nested(undefined, { quietHours: 1 }) });
    expect(nextQuietHoursMarker(pre, { ...PROFILE_ON, end: "05:00" })).toBeUndefined();
  });
});

describe("localeFreezeMarker", () => {
  const london = { timezone: "Europe/London" };

  it("freezes an identical pair that depends on the old owner zone", () => {
    const pre = input({
      profile: { ...PROFILE_ON, timezone: "Europe/London" },
      proactive: nested(NESTED_ON),
      locale: london
    });
    expect(localeFreezeMarker(pre)).toBe("canonical");
  });

  it("freezes a zone conflict so a locale change cannot resolve it", () => {
    const pre = input({
      profile: { ...PROFILE_ON, timezone: "America/New_York" },
      proactive: nested(NESTED_ON),
      locale: london
    });
    expect(localeFreezeMarker(pre)).toBe("unresolved");
  });

  it.each([
    [
      "a Profile that follows the owner zone",
      input({ profile: PROFILE_ON, proactive: nested(NESTED_ON) })
    ],
    ["a sole Profile", input({ profile: { ...PROFILE_ON, timezone: "Asia/Tokyo" } })],
    [
      "an already marked Profile",
      input({
        profile: { ...PROFILE_ON, timezone: "Asia/Tokyo", authority: "canonical" },
        proactive: nested(NESTED_ON)
      })
    ],
    ["no records", input()]
  ])("leaves %s alone", (_label, pre) => {
    expect(localeFreezeMarker(pre)).toBeUndefined();
  });
});
