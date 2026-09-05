import { describe, expect, it } from "vitest";

import {
  deriveNotWorking,
  type ConnectorCapabilityMap,
  type ConnectorNotWorkingFacts
} from "../../packages/shared/src/connector-sync-explain.js";

const NOW = new Date("2026-09-04T14:00:00.000Z");

const CAPABILITIES: ConnectorCapabilityMap = [
  {
    ability: "Calendar on the Calendar screen and Today is current",
    notWorkingLabel: "Calendar is out of date",
    dependsOn: "calendar",
    requiresAiStep: false,
    staleAfterMs: 60 * 60 * 1000,
    fix: { label: "Reconnect", path: "/settings?section=connectors" }
  },
  {
    ability: "Tasks and follow-ups are created from new email",
    notWorkingLabel: "Tasks are not being created from email",
    dependsOn: "email",
    requiresAiStep: true,
    staleAfterMs: 60 * 60 * 1000,
    fix: { label: "Reconnect", path: "/settings?section=connectors" }
  },
  {
    ability: "Moss can answer about recent email",
    notWorkingLabel: "Moss cannot see recent email",
    dependsOn: "email",
    requiresAiStep: false,
    staleAfterMs: 60 * 60 * 1000,
    fix: { label: "Reconnect", path: "/settings?section=connectors" }
  }
];

const freshFacts: ConnectorNotWorkingFacts = {
  providerType: "google",
  accountStatus: "active",
  signInExpired: false,
  failedKinds: [],
  lastSyncError: null,
  lastSyncCounts: null,
  calendarLastGoodAt: "2026-09-04T13:50:00.000Z",
  emailLastGoodAt: "2026-09-04T13:50:00.000Z",
  deferredAi: null
};

describe("deriveNotWorking", () => {
  it("a calendar phase that just failed is reported even though the last good run is still fresh", () => {
    const entries = deriveNotWorking(
      CAPABILITIES,
      { ...freshFacts, failedKinds: ["calendar"], lastSyncError: "calendar-error" },
      NOW
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ability).toBe("Calendar is out of date");
    expect(entries[0]?.reason).toBe("calendar could not be read");
  });

  it("an email phase that failed reports both email abilities, not calendar", () => {
    const entries = deriveNotWorking(
      CAPABILITIES,
      { ...freshFacts, failedKinds: ["email"], lastSyncError: "email-error" },
      NOW
    );
    expect(entries.map((entry) => entry.ability).sort()).toEqual(
      ["Moss cannot see recent email", "Tasks are not being created from email"].sort()
    );
  });

  it("a calendar phase that has been stale past its window is reported without a fresh failure", () => {
    const entries = deriveNotWorking(
      CAPABILITIES,
      { ...freshFacts, calendarLastGoodAt: "2026-09-04T12:00:00.000Z" },
      NOW
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ability).toBe("Calendar is out of date");
    expect(entries[0]?.since).toBe("2026-09-04T12:00:00.000Z");
    expect(entries[0]?.reason).toBe("the last good sync is too old");
  });

  it("an email phase that succeeded but the assistant's step was deferred only flags the AI-dependent ability", () => {
    const entries = deriveNotWorking(
      CAPABILITIES,
      { ...freshFacts, deferredAi: { count: 3, reason: "the assistant's login has expired" } },
      NOW
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ability).toBe("Tasks are not being created from email");
    expect(entries[0]?.reason).toBe("the assistant's login has expired");
    expect(entries[0]?.fix.path).toBe("/settings?section=assistant");
  });

  it("an expired sign-in flags every ability with the same reason", () => {
    const entries = deriveNotWorking(CAPABILITIES, { ...freshFacts, signInExpired: true }, NOW);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.reason).toBe("Google no longer accepts the saved sign-in.");
    }
  });

  it("a partial run inside the stale window with nothing failed reports nothing", () => {
    const entries = deriveNotWorking(
      CAPABILITIES,
      { ...freshFacts, lastSyncError: "email-message-error" },
      NOW
    );
    expect(entries).toEqual([]);
  });

  it("a revoked account reports nothing — the user chose this", () => {
    const entries = deriveNotWorking(
      CAPABILITIES,
      { ...freshFacts, accountStatus: "revoked", signInExpired: true, failedKinds: ["calendar", "email"] },
      NOW
    );
    expect(entries).toEqual([]);
  });

  it("an IMAP-style map with no calendar entry never mentions calendars", () => {
    const emailOnly = CAPABILITIES.filter((capability) => capability.dependsOn === "email");
    const entries = deriveNotWorking(
      emailOnly,
      { ...freshFacts, failedKinds: ["calendar", "email"], lastSyncError: "email-error" },
      NOW
    );
    expect(entries.every((entry) => !entry.ability.toLowerCase().includes("calendar"))).toBe(true);
  });
});
