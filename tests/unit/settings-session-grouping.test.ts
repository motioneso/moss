import { describe, expect, it } from "vitest";

import type { MeSessionDto } from "@moss/shared";
import { groupSessions } from "../../apps/web/src/settings/settings-profile-subviews.js";

function session(overrides: Partial<MeSessionDto>): MeSessionDto {
  return {
    id: "id",
    isCurrent: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    ipAddress: "10.0.0.1",
    userAgent: "ua",
    deviceLabel: "MacBook Pro",
    browser: "Chrome",
    os: "macOS",
    deviceKind: "laptop",
    source: "browser",
    companion: null,
    ...overrides
  };
}

describe("groupSessions", () => {
  it("keeps distinct devices as separate groups", () => {
    const groups = groupSessions([
      session({ id: "a", deviceLabel: "MacBook Pro" }),
      session({ id: "b", deviceLabel: "iPhone", deviceKind: "phone", browser: "Safari" })
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.count)).toEqual([1, 1]);
  });

  it("groups sessions with identical deviceLabel+browser+os+ipAddress", () => {
    const groups = groupSessions([
      session({ id: "a", lastSeenAt: "2026-07-01T00:00:00.000Z" }),
      session({ id: "b", lastSeenAt: "2026-07-02T00:00:00.000Z" })
    ]);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.count).toBe(2);
    expect(group.ids).toEqual(["a", "b"]);
  });

  it("marks a group current and picks the current session to display if any member is current", () => {
    const groups = groupSessions([
      session({ id: "a", isCurrent: false, lastSeenAt: "2026-07-03T00:00:00.000Z" }),
      session({ id: "b", isCurrent: true, lastSeenAt: "2026-07-01T00:00:00.000Z" })
    ]);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.isCurrent).toBe(true);
    expect(group.display.id).toBe("b");
  });

  it("does not treat sessions with different IPs as the same group", () => {
    const groups = groupSessions([
      session({ id: "a", ipAddress: "10.0.0.1" }),
      session({ id: "b", ipAddress: "10.0.0.2" })
    ]);
    expect(groups).toHaveLength(2);
  });

  it("returns an empty array for no sessions", () => {
    expect(groupSessions([])).toEqual([]);
  });
});
