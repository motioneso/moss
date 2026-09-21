import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@moss/db";

import { pickCurrentMossBlock } from "./current-block.js";

const NOW = new Date("2026-09-21T10:00:00.000Z");

function event(
  overrides: Partial<CalendarEvent> & { metadata?: Record<string, unknown> } = {}
): CalendarEvent {
  const { metadata, ...rest } = overrides;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    connector_account_id: "00000000-0000-4000-8000-0000000000aa",
    owner_user_id: "00000000-0000-4000-8000-0000000000bb",
    title: "Study AI",
    starts_at: new Date("2026-09-21T09:00:00.000Z"),
    ends_at: new Date("2026-09-21T11:00:00.000Z"),
    location: null,
    summary: null,
    body_excerpt: null,
    external_id: "google-evt-1",
    external_metadata: { jarvisCreated: true, ...metadata },
    created_at: new Date("2026-09-20T00:00:00.000Z"),
    updated_at: new Date("2026-09-20T00:00:00.000Z"),
    ...rest
  } as unknown as CalendarEvent;
}

describe("pickCurrentMossBlock", () => {
  it("returns a Moss block covering now", () => {
    const block = pickCurrentMossBlock([event()], NOW);
    expect(block?.title).toBe("Study AI");
    expect(block?.endsAt.toISOString()).toBe("2026-09-21T11:00:00.000Z");
  });

  it("returns null for an event Moss did not create (fails if the Moss-block filter is missing)", () => {
    const other = event({ external_id: "google-evt-2", metadata: { jarvisCreated: false } });
    expect(pickCurrentMossBlock([other], NOW)).toBeNull();
  });

  it("ignores all-day and cancelled events", () => {
    expect(pickCurrentMossBlock([event({ metadata: { allDay: true } })], NOW)).toBeNull();
    expect(pickCurrentMossBlock([event({ metadata: { status: "cancelled" } })], NOW)).toBeNull();
  });

  it("does not return a block starting a second after now, or one that ended a second before", () => {
    const later = event({ starts_at: new Date("2026-09-21T10:00:01.000Z") });
    const earlier = event({ ends_at: new Date("2026-09-21T09:59:59.000Z") });
    expect(pickCurrentMossBlock([later], NOW)).toBeNull();
    expect(pickCurrentMossBlock([earlier], NOW)).toBeNull();
  });

  it("counts a start exactly at now but not an end exactly at now", () => {
    expect(pickCurrentMossBlock([event({ starts_at: NOW })], NOW)).not.toBeNull();
    expect(pickCurrentMossBlock([event({ ends_at: NOW })], NOW)).toBeNull();
  });

  it("with overlapping blocks returns the one ending first, ties broken by id", () => {
    const long = event({
      id: "00000000-0000-4000-8000-000000000009",
      title: "Long",
      ends_at: new Date("2026-09-21T12:00:00.000Z")
    });
    const short = event({
      id: "00000000-0000-4000-8000-000000000005",
      title: "Short",
      ends_at: new Date("2026-09-21T10:30:00.000Z")
    });
    expect(pickCurrentMossBlock([long, short], NOW)?.title).toBe("Short");

    const tieB = event({ id: "00000000-0000-4000-8000-00000000000b", title: "B" });
    const tieA = event({ id: "00000000-0000-4000-8000-00000000000a", title: "A" });
    expect(pickCurrentMossBlock([tieB, tieA], NOW)?.title).toBe("A");
    expect(pickCurrentMossBlock([tieA, tieB], NOW)?.title).toBe("A");
  });

  it("treats a row cached before the created-by-Moss flag existed as Moss-made only by the id pattern", () => {
    const legacy = event({ external_id: `jfb${"a".repeat(32)}`, external_metadata: {} as never });
    expect(pickCurrentMossBlock([legacy], NOW)).not.toBeNull();
    const plain = event({ external_id: "google-evt-3", external_metadata: {} as never });
    expect(pickCurrentMossBlock([plain], NOW)).toBeNull();
  });
});
