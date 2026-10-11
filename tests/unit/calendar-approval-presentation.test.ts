import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import {
  calendarCreatePresentation,
  calendarDeletePresentation,
  calendarReschedulePresentation
} from "../../packages/calendar/src/approval-presentation.js";
import { summarizeProposeFocusBlock } from "../../packages/calendar/src/tools.js";

const ctx = {
  actorUserId: "owner",
  requestId: "request",
  chatSessionId: "session",
  localTimezone: "UTC"
} as ToolContext;
const ID = "33333333-3333-4333-8333-333333333333";
const event = {
  id: ID,
  owner_user_id: "owner",
  title: "Actual server title",
  starts_at: "2026-10-08T09:00:00Z",
  ends_at: "2026-10-08T10:00:00Z",
  external_id: "provider-ref"
};
function database(rows: unknown[] = [event]) {
  const where = vi.fn().mockImplementation(() => query);
  const query = { selectAll: () => query, where, limit: () => query, execute: async () => rows };
  return {
    db: { [dataContextBrand]: true, db: { selectFrom: () => query } } as unknown as DataContextDb,
    where
  };
}
afterEach(() => vi.useRealTimers());

describe("calendar action disclosure", () => {
  it("resolves the deletion target independently of spoofed display hints", async () => {
    const { db, where } = database();
    const view = await calendarDeletePresentation(
      db,
      { eventId: ID, displayTitle: "Harmless fake", displayWhen: "Not the real time" },
      ctx
    );
    expect(view?.target).toBe(event.title);
    expect(view?.fields).toContainEqual({
      label: "Current start",
      value: "2026-10-08T09:00:00.000Z"
    });
    expect(view?.fields).toContainEqual({
      label: "Attendees",
      value: "Will be notified of the cancellation"
    });
    expect(JSON.stringify(view)).not.toContain(ID);
    expect(JSON.stringify(view)).not.toContain("Harmless fake");
    expect(where).toHaveBeenCalledWith("owner_user_id", "=", "owner");
    expect(where).toHaveBeenCalledWith("id", "=", ID);
  });
  it("discloses exact replacement times and versions target changes", async () => {
    const input = {
      eventRef: ID,
      newStart: "2026-10-08T11:00:00Z",
      newEnd: "2026-10-08T12:00:00Z"
    };
    const first = await calendarReschedulePresentation(database().db, input, ctx);
    expect(first?.fields).toContainEqual({ label: "New start", value: input.newStart });
    expect(first?.fields).toContainEqual({ label: "New end", value: input.newEnd });
    const changed = await calendarReschedulePresentation(
      database([{ ...event, title: "Changed" }]).db,
      input,
      ctx
    );
    expect(first?.version).not.toBe(changed?.version);
  });
  it("rejects missing, ambiguous or unrepresented destinations and fields", async () => {
    expect(await calendarDeletePresentation(database([]).db, { eventId: ID }, ctx)).toBeNull();
    expect(
      await calendarReschedulePresentation(
        database([event, event]).db,
        { eventRef: "provider-ref", newStart: "start", newEnd: "end" },
        ctx
      )
    ).toBeNull();
    expect(
      await calendarDeletePresentation(database().db, { eventId: ID, hiddenTarget: "other" }, ctx)
    ).toBeNull();
    expect(
      await calendarDeletePresentation(database().db, { eventId: ID, eventRef: "other" }, ctx)
    ).toBeNull();
  });
  it("keeps the normalized relative date stable across midnight while preserving duration disclosure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T23:59:00Z"));
    const input: Record<string, unknown> = {
      title: "Planning",
      partOfDay: "morning",
      durationMinutes: 1
    };
    summarizeProposeFocusBlock(input, ctx);
    Object.freeze(input);
    const before = await calendarCreatePresentation(undefined, input, ctx);
    expect(input.date).toBe("2026-10-08");
    expect(before?.fields).toContainEqual({ label: "Requested minutes", value: "1" });
    expect(before?.fields).toContainEqual({ label: "Event length", value: "15 minutes" });
    vi.setSystemTime(new Date("2026-10-08T00:01:00Z"));
    expect(await calendarCreatePresentation(undefined, input, ctx)).toEqual(before);
  });
  it("refuses undeclared create fields instead of omitting them", async () => {
    expect(
      await calendarCreatePresentation(
        undefined,
        { start: "2026-10-08T10:00:00Z", hiddenId: ID },
        ctx
      )
    ).toBeNull();
  });
});
