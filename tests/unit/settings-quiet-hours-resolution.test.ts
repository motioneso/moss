import { describe, expect, it } from "vitest";

import {
  classifyQuietHours,
  type QuietHoursAuthorityInput,
  type QuietHoursAuthorityRead
} from "../../packages/settings/src/quiet-hours-authority.js";
import { planQuietHoursResolution } from "../../packages/settings/src/quiet-hours-resolution.js";

const UPDATED = new Date("2026-10-01T00:00:00.000Z");
const PROFILE_ON = { enabled: true, start: "22:00", end: "07:00", timezone: null };
const PROFILE_OFF = { enabled: false, start: "22:00", end: "07:00", timezone: null };
const ALERTS_LATE = { enabled: true, start: "22:00", end: "08:00", timezone: null };

function alertsRecord(enabled: boolean, start: string, end: string) {
  return {
    version: 1,
    quietHours: { enabled, startLocalTime: start, endLocalTime: end },
    updatedAt: UPDATED.toISOString()
  };
}

function read(profile: unknown, proactive: unknown, revision = 3): QuietHoursAuthorityRead {
  const input: QuietHoursAuthorityInput = {
    profile,
    proactive,
    locale: { timezone: "America/Los_Angeles" }
  };
  return {
    input,
    authority: classifyQuietHours(input),
    profileRow: profile === undefined ? null : { value: profile, revision, updatedAt: UPDATED }
  };
}

const VERSION = "v-current";

describe("planQuietHoursResolution", () => {
  const offVersusLate = read(PROFILE_OFF, alertsRecord(true, "22:00", "08:00"));

  it("writes the alert schedule into Profile as canonical when the owner picks it", () => {
    expect(
      planQuietHoursResolution(offVersusLate, VERSION, {
        choice: "alerts",
        quietHours: ALERTS_LATE,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "write", value: { ...ALERTS_LATE, authority: "canonical" } });
  });

  it("keeps Profile's own off schedule and marks it canonical when the owner picks it", () => {
    expect(
      planQuietHoursResolution(offVersusLate, VERSION, {
        choice: "profile",
        quietHours: PROFILE_OFF,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "write", value: { ...PROFILE_OFF, authority: "canonical" } });
  });

  it("settles a frozen unresolved conflict and keeps Profile's other stored fields", () => {
    const frozen = read(
      { ...PROFILE_ON, timezone: "Europe/London", authority: "unresolved", note: "kept" },
      alertsRecord(true, "22:00", "07:00")
    );
    expect(
      planQuietHoursResolution(frozen, VERSION, {
        choice: "profile",
        quietHours: { ...PROFILE_ON, timezone: "Europe/London" },
        expectedVersion: VERSION
      })
    ).toEqual({
      kind: "write",
      value: { ...PROFILE_ON, timezone: "Europe/London", authority: "canonical", note: "kept" }
    });
  });

  it("refuses a choice built from an older version", () => {
    expect(
      planQuietHoursResolution(offVersusLate, VERSION, {
        choice: "alerts",
        quietHours: ALERTS_LATE,
        expectedVersion: "v-older"
      })
    ).toEqual({ kind: "stale" });
  });

  it("refuses a choice whose schedule is not the named side's current schedule", () => {
    expect(
      planQuietHoursResolution(offVersusLate, VERSION, {
        choice: "alerts",
        quietHours: { ...ALERTS_LATE, end: "09:00" },
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "stale" });
    expect(
      planQuietHoursResolution(offVersusLate, VERSION, {
        choice: "profile",
        quietHours: ALERTS_LATE,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "stale" });
  });

  it("refuses to pick the alert side once the alert schedule is gone", () => {
    const frozenWithoutAlerts = read({ ...PROFILE_ON, authority: "unresolved" }, undefined);
    expect(frozenWithoutAlerts.authority.status).toBe("conflict");
    expect(
      planQuietHoursResolution(frozenWithoutAlerts, VERSION, {
        choice: "alerts",
        quietHours: ALERTS_LATE,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "stale" });
  });

  it("writes nothing for a repeated choice the canonical schedule already holds", () => {
    const resolved = read(
      { ...ALERTS_LATE, authority: "canonical" },
      alertsRecord(true, "22:00", "08:00"),
      4
    );
    expect(
      planQuietHoursResolution(resolved, "v-after", {
        choice: "alerts",
        quietHours: ALERTS_LATE,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "unchanged" });
  });

  it("refuses a different choice once the conflict is settled", () => {
    const resolved = read(
      { ...ALERTS_LATE, authority: "canonical" },
      alertsRecord(true, "22:00", "08:00"),
      4
    );
    expect(
      planQuietHoursResolution(resolved, "v-after", {
        choice: "profile",
        quietHours: PROFILE_OFF,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "stale" });
  });

  it.each([
    ["default", read(undefined, undefined)],
    ["carried", read(undefined, alertsRecord(true, "22:00", "08:00"))],
    ["malformed", read({ enabled: "yes" }, alertsRecord(true, "22:00", "08:00"))]
  ])("refuses to resolve a %s owner even with a matching version", (_status, state) => {
    expect(
      planQuietHoursResolution(state, VERSION, {
        choice: "alerts",
        quietHours: ALERTS_LATE,
        expectedVersion: VERSION
      })
    ).toEqual({ kind: "stale" });
  });
});
