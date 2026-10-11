import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { notificationReadPresentation } from "../../packages/notifications/src/approval-presentation.js";
import { pushDeviceTarget } from "../../packages/notifications/src/chat-targets.js";
import { sportsResolveTeamPresentation } from "../../packages/sports/src/approval-presentation.js";
import { checkinPresentation } from "../../packages/wellness/src/approval-presentation.js";
import { therapyNoteTarget } from "../../packages/wellness/src/chat-targets.js";

vi.mock("../../packages/sports/src/chat-tools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sportsApprovalTeams: async () => ({
    teams: [{ teamKey: "dal", name: "Dallas Cowboys", sourceTeamId: "team-1" }],
    degraded: false
  })
}));

const ID = "11111111-1111-4111-8111-111111111111";
const at = new Date("2026-10-01T14:30:00Z");

function losAngeles(dateFormat: "12" | "24"): ToolContext {
  return {
    actorUserId: "owner",
    requestId: "request",
    chatSessionId: "session",
    localTimezone: "America/Los_Angeles",
    locale: { timezone: "America/Los_Angeles", region: "en-US", dateFormat }
  };
}

function database(row: Record<string, unknown>): DataContextDb {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => row
  };
  return { [dataContextBrand]: true, db: { selectFrom: () => query } } as unknown as DataContextDb;
}

describe("approval card times use the person's locale", () => {
  it("dates a mood check-in in the person's zone and hour format", async () => {
    const present = checkinPresentation(true);
    const input = { params: { id: ID }, target: null, body: { feelingCore: "happy" } };
    const db = database({ id: ID, checked_in_at: at, created_at: at });
    expect((await present(db, input, losAngeles("24")))?.target).toBe(
      "Mood check-in from Oct 1, 2026, 07:30"
    );
    expect((await present(db, input, losAngeles("12")))?.target).toBe(
      "Mood check-in from Oct 1, 2026, 7:30 AM"
    );
  });

  it("dates a therapy note in the person's zone and hour format", async () => {
    const db = database({ created_at: at });
    expect(await therapyNoteTarget(db, { id: ID }, losAngeles("24"))).toBe(
      "Therapy note from Oct 1, 2026, 07:30"
    );
    expect(await therapyNoteTarget(db, { id: ID }, losAngeles("12"))).toBe(
      "Therapy note from Oct 1, 2026, 7:30 AM"
    );
  });

  it("dates an unlabelled device by the person's local day, not the UTC day", async () => {
    // 02:00 UTC on Oct 2 is still Oct 1 in Los Angeles.
    const db = database({ user_agent_label: null, created_at: new Date("2026-10-02T02:00:00Z") });
    expect(await pushDeviceTarget(db, { id: ID }, losAngeles("24"))).toBe(
      "Device added Oct 1, 2026"
    );
    expect(await pushDeviceTarget(db, { id: ID })).toBe("Device added Oct 1, 2026");
  });

  it("shows when a notification arrived in the person's zone and hour format", async () => {
    const db = database({ id: ID, title: "Launch ready", created_at: at });
    const input = { params: { id: ID }, target: null, body: {} };
    expect((await notificationReadPresentation(db, input, losAngeles("24")))?.fields).toEqual([
      { label: "Received", value: "Oct 1, 2026, 07:30" }
    ]);
    expect((await notificationReadPresentation(db, input, losAngeles("12")))?.fields).toEqual([
      { label: "Received", value: "Oct 1, 2026, 7:30 AM" }
    ]);
  });

  it("shows when a team choice was saved in the person's zone", async () => {
    const db = database({
      id: ID,
      competition_key: "nfl",
      team_key: "dal",
      source_team_id: null,
      created_at: at
    });
    const input = { params: { id: ID }, target: null, body: { sourceTeamId: "team-1" } };
    expect(
      (await sportsResolveTeamPresentation(db, input, losAngeles("24")))?.fields
    ).toContainEqual({ label: "Saved on", value: "Oct 1, 2026, 07:30" });
  });
});
