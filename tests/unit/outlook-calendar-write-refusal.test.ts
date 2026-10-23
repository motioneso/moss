import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import {
  buildCalendarWriteService,
  type CalendarWriteImplDeps
} from "../../packages/chat/src/calendar-write-impl.js";

const db = { [dataContextBrand]: true, db: {} } as unknown as DataContextDb;
const ctx: ToolContext = { actorUserId: "owner", requestId: "request", chatSessionId: "" };
const id = "00000000-0000-4000-8000-000000000001";

describe("Outlook calendar write refusal", () => {
  it.each([
    [false, "delete"],
    [true, "delete"],
    [false, "move"],
    [true, "move"]
  ] as const)(
    "refuses writes before Google work (staged=%s operation=%s)",
    async (staged, operation) => {
      const row = {
        id,
        external_id: "invented-source-id",
        external_metadata: { source: "outlook-browser-calendar" }
      };
      const scopeRead = vi.fn(() => {
        throw new Error("Google scope must not be consulted");
      });
      const providerWrite = vi.fn(() => {
        throw new Error("Google must not receive this event");
      });
      const deps = {
        calendarRepository: { getById: vi.fn(async () => row) },
        connectorsRepository: {
          getActiveGoogleAccountSecret: vi.fn(async () => undefined),
          getCalendarWriteScopeState: scopeRead
        },
        googleService: { getAccessToken: providerWrite, readActiveCredential: providerWrite },
        googleApiClient: { deleteEvent: providerWrite, patchEvent: providerWrite },
        dataContext: {
          withDataContext: async (
            _access: unknown,
            work: (value: DataContextDb) => Promise<unknown>
          ) => work(db)
        }
      } as unknown as CalendarWriteImplDeps;
      const service = buildCalendarWriteService(deps);
      if (operation === "delete") {
        const deleted = await service.deleteEvent(staged ? undefined : db, ctx, { eventId: id });
        expect(deleted.deleted).toBe(false);
        expect(deleted.message).toContain("read-only");
      } else {
        const moved = await service.rescheduleEvent(staged ? undefined : db, ctx, {
          eventRef: id,
          newStart: new Date("2026-10-21T18:00:00Z"),
          newEnd: new Date("2026-10-21T19:00:00Z")
        });
        expect(moved.ok).toBe(false);
      }
      expect(scopeRead).not.toHaveBeenCalled();
      expect(providerWrite).not.toHaveBeenCalled();
    }
  );
});
