import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { buildCalendarFollowThroughPort } from "@moss/module-registry";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

describe("Calendar follow-through port", () => {
  it("does not auto-write calendar blocks while calendar_writeback is ask_each_time", async () => {
    let writes = 0;
    const port = buildCalendarFollowThroughPort({
      aiRepository: {
        listActionPolicies: async () => [
          { moduleId: "calendar", actionFamilyId: "calendar_writeback", tier: "ask_each_time" }
        ]
      },
      calendarWrite: {
        createEvent: async () => {
          writes += 1;
          return { created: true, calendarEventId: "calendar-event-1" };
        }
      }
    });

    const refs = await port.executeAutoActions({
      scopedDb,
      actorUserId: "00000000-0000-0000-0000-000000000001",
      requestId: "req",
      targetRef: "calendar:prep:1",
      signal: {
        summary: "Prep",
        suggestedActions: ["block_time"],
        startsAt: "2026-07-04T16:00:00.000Z",
        endsAt: "2026-07-04T17:00:00.000Z"
      }
    });

    expect(writes).toBe(0);
    expect(refs).toEqual({ targetRef: "calendar:prep:1" });
  });
});
