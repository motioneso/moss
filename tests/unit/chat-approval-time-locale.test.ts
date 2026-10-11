import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCALE_SETTINGS, type LocaleSettingsDto } from "@moss/shared";
import { formatApprovalLine } from "../../packages/chat/src/live/acp-chat-engine.js";
import type { UserSession } from "../../packages/chat/src/live/chat-session-provider-identity.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import {
  routeLiveOriginRecord,
  routeOriginRecord
} from "../../packages/chat/src/live/origin-record-routing.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";

// 21:03 UTC is 14:03 in Los Angeles (PDT). The machine clock runs in UTC here, so a
// server-clock formatter would print 21:03.
const DECIDED_AT = new Date("2026-06-27T21:03:00.000Z");
const LA_24: LocaleSettingsDto = {
  ...DEFAULT_LOCALE_SETTINGS,
  timezone: "America/Los_Angeles",
  dateFormat: "24"
};
const LA_12: LocaleSettingsDto = { ...LA_24, dateFormat: "12" };

describe("approval line time (#3394)", () => {
  const machineZone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (machineZone === undefined) delete process.env.TZ;
    else process.env.TZ = machineZone;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats in the person's zone and 24-hour choice, not the server clock", () => {
    expect(DECIDED_AT.getHours()).toBe(21);
    expect(
      formatApprovalLine({
        toolName: "calendar.create",
        approved: true,
        at: DECIDED_AT,
        locale: LA_24
      })
    ).toBe("calendar.create, approved by you at 14:03");
  });

  it("follows a 12-hour choice", () => {
    expect(
      formatApprovalLine({
        toolName: "calendar.create",
        approved: true,
        at: DECIDED_AT,
        locale: LA_12
      })
    ).toBe("calendar.create, approved by you at 2:03 PM");
  });

  it("uses the Settings default when nothing is saved", () => {
    expect(
      formatApprovalLine({
        toolName: "calendar.create",
        approved: false,
        who: "you",
        at: DECIDED_AT
      })
    ).toBe("calendar.create, not approved by you at 14:03");
  });

  it("formats a live approval with the chat session's saved settings", () => {
    vi.useFakeTimers({ now: DECIDED_AT });
    const actorUserId = "user-1";
    const key = surfaceSessionKey(actorUserId, "drawer");
    const session = {
      actorUserId,
      surface: "drawer",
      threadId: "thread-1",
      locale: LA_12
    } as unknown as UserSession;
    const emitted: TranscriptRecord[] = [];

    const delivered = routeLiveOriginRecord({
      persistence: {} as never,
      sessions: new Map([[key, session]]),
      transitions: new Map(),
      turnsInFlight: new Set(),
      sequenceBySession: new Map(),
      pendingBySession: new Map(),
      turnRecords: new Map(),
      actionResults: new Map(),
      emit: (_surface, record) => emitted.push(record),
      actorUserId,
      originThreadId: "thread-1",
      surface: "drawer",
      record: {
        kind: "action_result",
        text: "done",
        actionRequestId: "request-1",
        toolName: "calendar.create",
        outcome: "executed",
        decidedBy: "person"
      }
    });

    expect(delivered).toBe(true);
    expect(emitted.find((record) => record.kind === "approved")?.text).toBe(
      "calendar.create, approved by you at 2:03 PM"
    );
  });

  it("reads the saved settings when no live session has loaded them", async () => {
    vi.useFakeTimers({ now: DECIDED_AT });
    const actorUserId = "user-1";
    const emitted: TranscriptRecord[] = [];
    const getThreadContext = vi.fn(async () => ({ locale: LA_12 }));

    await routeOriginRecord({
      persistence: {
        getOwnedThreadState: async () => ({ id: "thread-1", surface: "drawer", incognito: false }),
        getCurrentThreadState: async () => ({ id: "thread-1" }),
        getThreadContext,
        persistActionRecord: async () => true
      } as never,
      sessions: new Map(),
      transitions: new Map(),
      turnsInFlight: new Set(),
      sequenceBySession: new Map(),
      pendingBySession: new Map(),
      turnRecords: new Map(),
      actionResults: new Map(),
      emit: (_surface, record) => emitted.push(record),
      actorUserId,
      originThreadId: "thread-1",
      record: {
        kind: "action_result",
        text: "done",
        actionRequestId: "request-1",
        toolName: "calendar.create",
        outcome: "executed",
        decidedBy: "person"
      }
    });

    expect(getThreadContext).toHaveBeenCalledWith(actorUserId, "drawer", "thread-1");
    expect(emitted.find((record) => record.kind === "approved")?.text).toBe(
      "calendar.create, approved by you at 2:03 PM"
    );
  });
});
