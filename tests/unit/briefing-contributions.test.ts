import { describe, expect, it } from "vitest";

import { contributionFor } from "../../apps/web/src/today/briefing-contributions.js";

const newsEvidence = {
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
};

const sportsEvidence = {
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
};

const planSnapshot = {
  version: 1,
  planId: "plan-1",
  revision: 2,
  localDay: "2026-09-10",
  timeZone: "America/Los_Angeles",
  sourceRunId: null,
  eveningIntent: { priorityTaskIds: [], capacity: "light" },
  blocks: [{ id: "b1" }, { id: "b2" }]
};

// A new run: lines the sections gave the prompt, plus larger raw holdings to
// prove the row measures what the report got.
const current = {
  sectionLines: {
    commitments: 2,
    tasks: 8,
    calendar: 3,
    email: 2,
    vault: 3,
    chats: 6,
    goals: 2,
    news: 2,
    sports: 1,
    day_plan: 5
  },
  commitmentCount: 2,
  taskCount: 13,
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
  editorial: { news: newsEvidence, sports: sportsEvidence },
  planSnapshot
};

describe("contributionFor on current runs", () => {
  it("names the calendar lines given, not the raw event holdings", () => {
    expect(contributionFor("calendar", current)).toBe("3 events on today's schedule");
  });

  it("names neutral task and commitment lines without claiming open", () => {
    expect(contributionFor("tasks", current)).toBe("8 tasks");
    expect(contributionFor("commitments", current)).toBe("2 commitments");
    expect(contributionFor("tasks", { ...current, sectionLines: { tasks: 1 } })).toBe("1 task");
  });

  it("names email, chat, note and goal lines given", () => {
    expect(contributionFor("email", current)).toBe("2 actionable messages");
    expect(contributionFor("chats", current)).toBe("6 turns from today's chats");
    expect(contributionFor("vault", current)).toBe("3 saved notes");
    expect(contributionFor("goals", current)).toBe("2 tracked goals");
  });

  it("names editorial lines given", () => {
    expect(contributionFor("news", current)).toBe("2 top stories");
    expect(contributionFor("sports", current)).toBe("1 sports update");
  });

  it("names the saved evening blocks behind the day plan", () => {
    expect(contributionFor("day_plan", current)).toBe("2 time blocks from last evening");
  });

  it("shows no line when a section gave nothing", () => {
    expect(contributionFor("vault", { ...current, sectionLines: { vault: 0 } })).toBeNull();
    expect(contributionFor("mystery", current)).toBeNull();
  });

  it("still names the lines given when the source was truncated", () => {
    const gapped = { ...current, gaps: [{ source: "tasks", reason: "truncated" }] };
    expect(contributionFor("tasks", gapped)).toBe("8 tasks");
  });

  it("shows no line for a failed source even when lines were saved", () => {
    const gapped = { ...current, gaps: [{ source: "calendar", reason: "tool_failed" }] };
    expect(contributionFor("calendar", gapped)).toBeNull();
  });

  it("shows no line for an empty source even with evidence stored", () => {
    const gapped = { ...current, gaps: [{ source: "news", reason: "empty" }] };
    expect(contributionFor("news", gapped)).toBeNull();
  });
});

describe("contributionFor on older runs without sectionLines", () => {
  const { sectionLines: _dropped, ...legacy } = current;

  it("prefers calendar signals over the raw event holdings", () => {
    expect(contributionFor("calendar", legacy)).toBe("3 events on today's schedule");
    expect(contributionFor("calendar", { gaps: [] })).toBeNull();
  });

  it("names neutral gathered counts without claiming open", () => {
    expect(contributionFor("tasks", legacy)).toBe("13 tasks");
    expect(contributionFor("email", legacy)).toBe("2 actionable messages");
  });

  it("shows no line for an empty source even with evidence stored", () => {
    const gapped = { ...legacy, gaps: [{ source: "news", reason: "empty" }] };
    expect(contributionFor("news", gapped)).toBeNull();
  });

  it("names the saved evening blocks", () => {
    expect(contributionFor("day_plan", legacy)).toBe("2 time blocks from last evening");
    expect(contributionFor("goals", {})).toBeNull();
  });
});
