process.env.TZ = "UTC";

import { describe, expect, it, vi } from "vitest";

import type { ConnectorAccountSafeRow } from "../../packages/connectors/src/repository.js";
import {
  listCalendarContext,
  type CalendarSourceContextDeps
} from "../../packages/connectors/src/source-context/calendar.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

/**
 * #3395: early/late flags handed to chat and briefings follow the person's saved timezone, not
 * New York or the server clock. The machine runs in UTC here.
 */

const PACIFIC_24 = { timezone: "America/Los_Angeles", region: "en-GB", dateFormat: "24" };

const account = {
  id: "acc-google",
  provider_id: "google",
  provider_type: "google",
  provider_display_name: "Google",
  provider_status: "active",
  owner_user_id: "user-1",
  scopes: ["https://www.googleapis.com/auth/calendar"],
  status: "active",
  has_secret: true,
  revoked_at: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
  last_sync_started_at: null,
  last_sync_finished_at: null,
  last_sync_status: null,
  last_sync_error: null,
  last_sync_counts: null
} as unknown as ConnectorAccountSafeRow;

function deps(get: CalendarSourceContextDeps["preferencesRepository"]["get"]) {
  return {
    connectorsRepository: { listAccounts: async () => [account] },
    preferencesRepository: { get },
    resolveGoogleCredential: async () => "token-1",
    googleClient: {
      listCalendarEvents: async () => [
        // 06:00 Pacific; 09:00 in New York; 13:00 UTC.
        {
          id: "dawn",
          summary: "Dawn run",
          start: { dateTime: "2026-10-09T13:00:00.000Z" },
          end: { dateTime: "2026-10-09T13:30:00.000Z" }
        },
        // 16:00 Pacific; 19:00 in New York; 23:00 UTC.
        {
          id: "afternoon",
          summary: "Afternoon call",
          start: { dateTime: "2026-10-09T23:00:00.000Z" },
          end: { dateTime: "2026-10-09T23:30:00.000Z" }
        }
      ]
    },
    calendarRepository: { listVisible: async () => [] },
    now: () => new Date("2026-10-09T12:00:00.000Z")
  } satisfies CalendarSourceContextDeps;
}

describe("calendar context early/late flags", () => {
  it("uses the person's saved timezone when the caller passes none", async () => {
    const get = vi.fn(async (_db: unknown, key: string) => (key === "locale" ? PACIFIC_24 : null));

    const result = await listCalendarContext(makeRecordingDb().scoped, deps(get), {});

    const flags = Object.fromEntries(result.items.map((item) => [item.eventKey, item.flags]));
    expect(flags["dawn"]).toContain("early");
    expect(flags["afternoon"]).not.toContain("late");
    expect(flags["afternoon"]).not.toContain("early");
    expect(get).toHaveBeenCalledWith(expect.anything(), "locale");
  });
});
