import { describe, expect, it } from "vitest";

import { contributionFor } from "../../apps/web/src/today/briefing-contributions.js";

const metadata = {
  commitmentCount: 2,
  taskCount: 5,
  calendarCount: 3,
  calendarEventCount: 4,
  calendarSignals: [{ summary: "a" }, { summary: "b" }, { summary: "c" }],
  emailCount: 2,
  emailMessageCount: 7,
  emailSignals: [{ summary: "x" }, { summary: "y" }],
  vaultCount: 3,
  chatTurnCount: 6,
  goalsCount: 2,
  gaps: [],
  editorial: {
    news: {
      version: 1,
      capturedAt: "2026-09-10T16:00:00.000Z",
      degraded: false,
      stories: [
        {
          id: "n1",
          title: "One",
          sourceLabel: "Wire",
          sourceKey: "wire",
          url: "https://example.test/n1",
          publishedAt: "2026-09-10T15:00:00.000Z",
          summary: "First.",
          imageUrl: null
        },
        {
          id: "n2",
          title: "Two",
          sourceLabel: "Wire",
          sourceKey: "wire",
          url: "https://example.test/n2",
          publishedAt: "2026-09-10T15:00:00.000Z",
          summary: "Second.",
          imageUrl: null
        }
      ]
    },
    sports: {
      version: 1,
      capturedAt: "2026-09-10T16:00:00.000Z",
      degraded: false,
      state: "finals",
      ambiguousFollowCount: 0,
      games: [
        {
          id: "g1",
          competitionKey: "nfl",
          startsAt: "2026-09-09T17:00:00.000Z",
          phase: "final",
          statusDetail: "Final",
          headline: "Vikings beat Cowboys 21-14",
          homeShort: "MIN",
          awayShort: "DAL",
          homeScore: 21,
          awayScore: 14
        }
      ],
      stories: [
        {
          teamKey: "min",
          competitionKey: "nfl",
          title: "Vikings defense shines again",
          url: "https://example.test/s1",
          publishedAt: "2026-09-10T15:00:00.000Z",
          imageUrl: null,
          publisherLabel: "Test Sports",
          publisherDomain: "example.test"
        }
      ]
    }
  }
};

describe("contributionFor", () => {
  it("names the calendar event count behind the schedule", () => {
    expect(contributionFor("calendar", metadata)).toBe("4 events on today's schedule");
  });

  it("uses signal counts when the raw event count is missing", () => {
    const { calendarEventCount: _dropped, ...rest } = metadata;
    expect(contributionFor("calendar", rest)).toBe("3 events on today's schedule");
  });

  it("names singular quantities without inventing topics", () => {
    expect(contributionFor("calendar", { ...metadata, calendarEventCount: 1 })).toBe(
      "1 event on today's schedule"
    );
    expect(contributionFor("tasks", { ...metadata, taskCount: 1 })).toBe("1 open task");
  });

  it("names actionable email, task, commitment, chat, note and goal counts", () => {
    expect(contributionFor("email", metadata)).toBe("2 actionable messages");
    expect(contributionFor("tasks", metadata)).toBe("5 open tasks");
    expect(contributionFor("commitments", metadata)).toBe("2 open commitments");
    expect(contributionFor("chats", metadata)).toBe("6 turns from today's chats");
    expect(contributionFor("vault", metadata)).toBe("3 saved notes");
    expect(contributionFor("goals", metadata)).toBe("2 tracked goals");
  });

  it("names editorial story and game counts", () => {
    expect(contributionFor("news", metadata)).toBe("2 top stories");
    expect(contributionFor("sports", metadata)).toBe("1 game and 1 story");
  });

  it("names the saved evening blocks behind the day plan", () => {
    const withPlan = {
      ...metadata,
      planSnapshot: {
        version: 1,
        planId: "plan-1",
        revision: 2,
        localDay: "2026-09-10",
        timeZone: "America/Los_Angeles",
        sourceRunId: null,
        eveningIntent: { priorityTaskIds: [], capacity: "light" },
        blocks: [{ id: "b1" }, { id: "b2" }]
      }
    };
    expect(contributionFor("day_plan", withPlan)).toBe("2 time blocks from last evening");
  });

  it("shows no line for a source with nothing recorded", () => {
    expect(contributionFor("calendar", {})).toBeNull();
    expect(contributionFor("goals", {})).toBeNull();
    expect(contributionFor("news", {})).toBeNull();
    expect(contributionFor("mystery", metadata)).toBeNull();
  });

  it("shows no line when the count is zero", () => {
    expect(contributionFor("tasks", { ...metadata, taskCount: 0 })).toBeNull();
    expect(contributionFor("vault", { ...metadata, vaultCount: 0 })).toBeNull();
  });

  it("still names the count when lines were truncated for the prompt", () => {
    const gapped = { ...metadata, gaps: [{ source: "calendar", reason: "truncated" }] };
    expect(contributionFor("calendar", gapped)).toBe("4 events on today's schedule");
  });

  it("shows no line for a failed source even when stale counts exist", () => {
    const gapped = { ...metadata, gaps: [{ source: "calendar", reason: "tool_failed" }] };
    expect(contributionFor("calendar", gapped)).toBeNull();
  });
});
