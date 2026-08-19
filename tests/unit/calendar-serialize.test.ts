import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "@moss/db";

import { serializeCalendarEvent } from "../../packages/calendar/src/serialize.js";

// Phase 1e — jarvisCreated (written at create time) becomes the sole authoritative signal for
// isMossBlock; the jfb-prefix regex is a fallback ONLY when jarvisCreated is absent (never
// overrides an explicit false).
function fixture(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    connector_account_id: "conn-1",
    owner_user_id: "user-1",
    title: "Test event",
    starts_at: new Date("2026-08-18T10:00:00.000Z"),
    ends_at: new Date("2026-08-18T11:00:00.000Z"),
    location: null,
    summary: null,
    body_excerpt: null,
    external_id: "jfb00000000000000000000000000000000",
    external_metadata: {},
    created_at: new Date("2026-08-18T09:00:00.000Z"),
    updated_at: new Date("2026-08-18T09:00:00.000Z"),
    ...overrides
  } as CalendarEvent;
}

describe("serializeCalendarEvent isMossBlock", () => {
  it("does not override an explicit jarvisCreated:false, even with a jfb-prefixed id", () => {
    const dto = serializeCalendarEvent(
      fixture({
        external_id: "jfb00000000000000000000000000000001",
        external_metadata: { jarvisCreated: false }
      })
    );
    expect(dto.isMossBlock).toBe(false);
  });

  it("is true when jarvisCreated is explicitly true, regardless of id shape", () => {
    const dto = serializeCalendarEvent(
      fixture({
        external_id: "google-event-abc123",
        external_metadata: { jarvisCreated: true }
      })
    );
    expect(dto.isMossBlock).toBe(true);
  });

  it("falls back to the jfb-prefix regex when jarvisCreated is absent (pre-existing cache rows)", () => {
    const dto = serializeCalendarEvent(
      fixture({
        external_id: "jfb00000000000000000000000000000002",
        external_metadata: {}
      })
    );
    expect(dto.isMossBlock).toBe(true);
  });

  it("falls back to false when jarvisCreated is absent and the id doesn't match", () => {
    const dto = serializeCalendarEvent(
      fixture({
        external_id: "google-event-xyz",
        external_metadata: {}
      })
    );
    expect(dto.isMossBlock).toBe(false);
  });
});
