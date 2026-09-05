import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";

import { DEFAULT_LOCALE_SETTINGS } from "@moss/shared";

import { createChatGetCurrentTimeExecute } from "../../packages/chat/src/current-time-tool.js";
import { resolveEffectiveTimezone } from "../../packages/chat/src/locale-utils.js";

const scopedDb = null as unknown as DataContextDb;

describe("chat.getCurrentTime execute (#1869 slice 2)", () => {
  const baseCtx = { actorUserId: randomUUID(), requestId: randomUUID(), chatSessionId: "" };

  it("samples the clock per invocation, not at tool creation", async () => {
    let current = new Date("2026-08-31T10:00:00.000Z");
    const execute = createChatGetCurrentTimeExecute(() => current);

    const first = await execute(scopedDb, {}, baseCtx);
    current = new Date("2026-08-31T10:00:05.000Z");
    const second = await execute(scopedDb, {}, baseCtx);

    expect(first.data.utcInstant).toBe("2026-08-31T10:00:00.000Z");
    expect(second.data.utcInstant).toBe("2026-08-31T10:00:05.000Z");
  });

  it("derives local date, time and offset from a valid ctx.localTimezone", async () => {
    const instant = new Date("2026-08-31T10:00:00.000Z");
    const execute = createChatGetCurrentTimeExecute(() => instant);

    const result = await execute(
      scopedDb,
      {},
      { ...baseCtx, localTimezone: "America/Los_Angeles" }
    );

    expect(result.data).toEqual({
      utcInstant: "2026-08-31T10:00:00.000Z",
      timezone: "America/Los_Angeles",
      localDate: "2026-08-31",
      localTime: "03:00:00",
      utcOffsetMinutes: -420
    });
  });

  it("falls back to UTC with zero offset when ctx.localTimezone is absent or invalid", async () => {
    const instant = new Date("2026-08-31T10:00:00.000Z");
    const execute = createChatGetCurrentTimeExecute(() => instant);

    const absent = await execute(scopedDb, {}, baseCtx);
    expect(absent.data.timezone).toBe("UTC");
    expect(absent.data.utcOffsetMinutes).toBe(0);
    expect(absent.data.localDate).toBe("2026-08-31");
    expect(absent.data.localTime).toBe("10:00:00");

    const invalid = await execute(scopedDb, {}, { ...baseCtx, localTimezone: "Not/AZone" });
    expect(invalid.data.timezone).toBe("UTC");
    expect(invalid.data.utcOffsetMinutes).toBe(0);
  });

  describe("with the actor's effective timezone resolved from the locale preference (#2157)", () => {
    const instant = new Date("2026-08-31T10:00:00.000Z");
    const execute = createChatGetCurrentTimeExecute(() => instant);

    it("user with a stored timezone gets that zone and its offset", async () => {
      const localTimezone = resolveEffectiveTimezone({
        timezone: "America/New_York",
        region: "en-US",
        dateFormat: "12"
      });
      const result = await execute(scopedDb, {}, { ...baseCtx, localTimezone });
      expect(result.data.timezone).toBe("America/New_York");
      expect(result.data.localTime).toBe("06:00:00");
      expect(result.data.utcOffsetMinutes).toBe(-240);
    });

    it("user with nothing stored gets the Settings default, not UTC", async () => {
      // The live defect: GET /api/me/locale reported America/Los_Angeles (its default for a user
      // who never saved a locale) while the tool answered UTC / offset 0.
      const localTimezone = resolveEffectiveTimezone(undefined);
      expect(localTimezone).toBe(DEFAULT_LOCALE_SETTINGS.timezone);
      const result = await execute(scopedDb, {}, { ...baseCtx, localTimezone });
      expect(result.data.timezone).toBe("America/Los_Angeles");
      expect(result.data.localTime).toBe("03:00:00");
      expect(result.data.utcOffsetMinutes).toBe(-420);
    });
  });
});
