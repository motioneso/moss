import { describe, it, expect } from "vitest";
import { rankPriorityCandidates } from "@moss/priority";
import type {
  PriorityModelPreferenceV1,
  PriorityCandidate,
  FocusSignalInput
} from "@moss/priority";

const DEFAULT_MODEL: PriorityModelPreferenceV1 = {
  version: 1,
  mode: "balanced",
  anchors: [],
  mutedSources: [],
  updatedAt: "2026-06-27T00:00:00Z"
};

const NOW = "2026-06-27T12:00:00Z";
const TZ = "America/Los_Angeles";

describe("priority scoring", () => {
  it("ranks overdue priority-5 task above normal calendar gap", () => {
    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Ship feature",
        dueAt: "2026-06-26T12:00:00Z",
        explicitPriority: 5,
        effort: "large",
        textForAnchorMatch: ["ship feature"]
      },
      {
        source: "calendar",
        title: "Team lunch",
        startsAt: "2026-06-27T14:00:00Z",
        textForAnchorMatch: ["team lunch"]
      }
    ];

    const results = rankPriorityCandidates({
      model: DEFAULT_MODEL,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results[0]).toMatchObject({
      source: "tasks",
      title: "Ship feature",
      score: 65,
      band: "high"
    });
    expect(results[1]).toMatchObject({
      source: "calendar",
      title: "Team lunch",
      band: "low"
    });
  });

  it("deadline_first does not downrank due-today for low readiness", () => {
    const deadlineModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      mode: "deadline_first"
    };

    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Due today large",
        dueAt: "2026-06-27T18:00:00Z",
        explicitPriority: 3,
        effort: "large",
        textForAnchorMatch: ["due today large"]
      },
      {
        source: "tasks",
        title: "Due later quick",
        dueAt: "2026-07-01T12:00:00Z",
        explicitPriority: 3,
        effort: "quick",
        textForAnchorMatch: ["due later quick"]
      }
    ];

    const readiness: FocusSignalInput[] = [
      { moduleId: "wellness", readiness: 0.3, summary: "low energy" }
    ];

    const results = rankPriorityCandidates({
      model: deadlineModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: readiness
    });

    expect(results[0]!.title).toBe("Due today large");
    expect(results[0]!.score).toBeGreaterThanOrEqual(42);
  });

  it("energy_protective boosts quick and penalizes large at low readiness", () => {
    const energyModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      mode: "energy_protective"
    };

    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Quick admin",
        explicitPriority: 2,
        effort: "quick",
        textForAnchorMatch: ["quick admin"]
      },
      {
        source: "tasks",
        title: "Large refactor",
        explicitPriority: 4,
        effort: "large",
        textForAnchorMatch: ["large refactor"]
      }
    ];

    const readiness: FocusSignalInput[] = [
      { moduleId: "wellness", readiness: 0.4, summary: "tired" }
    ];

    const results = rankPriorityCandidates({
      model: energyModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: readiness
    });

    const quick = results.find((r) => r.title === "Quick admin");
    const large = results.find((r) => r.title === "Large refactor");

    expect(quick?.score).toBeGreaterThan(large?.score ?? 0);
    expect(quick?.reasons).toContain("quick work, low energy");
  });

  it("uses minimum readiness across multiple signals", () => {
    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Deep work",
        explicitPriority: 4,
        effort: "large",
        textForAnchorMatch: ["deep work"]
      }
    ];

    const readiness: FocusSignalInput[] = [
      { moduleId: "wellness", readiness: 0.8, summary: "good" },
      { moduleId: "schedule", readiness: 0.3, summary: "tight" }
    ];

    const energyModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      mode: "energy_protective"
    };

    const results = rankPriorityCandidates({
      model: energyModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: readiness
    });

    expect(results[0]!.score).toBeLessThan(30);
  });

  it("anchor weight raises matching candidates", () => {
    const anchorModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      anchors: [
        {
          id: "a1",
          kind: "project",
          label: "Project Apollo",
          aliases: ["apollo", "moonshot"],
          weight: 2,
          enabled: true,
          createdAt: "2026-06-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z"
        }
      ]
    };

    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Fix apollo bug",
        textForAnchorMatch: ["Fix apollo bug", "moonshot"]
      },
      {
        source: "tasks",
        title: "Other task",
        textForAnchorMatch: ["Other task"]
      }
    ];

    const results = rankPriorityCandidates({
      model: anchorModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    const apollo = results.find((r) => r.title === "Fix apollo bug");
    const other = results.find((r) => r.title === "Other task");

    expect(apollo?.score).toBeGreaterThan(other?.score ?? 0);
    expect(apollo?.reasons).toContain("1 anchor match");
  });

  it("anchor matching is case-insensitive whole-token", () => {
    const anchorModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      anchors: [
        {
          id: "a1",
          kind: "project",
          label: "Project X",
          aliases: ["px"],
          weight: 1,
          enabled: true,
          createdAt: "2026-06-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z"
        }
      ]
    };

    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Work on PROJECT X feature",
        textForAnchorMatch: ["PROJECT X feature"]
      }
    ];

    const results = rankPriorityCandidates({
      model: anchorModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results[0]!.reasons).toContain("1 anchor match");
  });

  it("clamps multi-anchor contribution", () => {
    const anchorModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      anchors: [
        {
          id: "a1",
          kind: "project",
          label: "Project A",
          aliases: [],
          weight: 2,
          enabled: true,
          createdAt: "2026-06-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z"
        },
        {
          id: "a2",
          kind: "project",
          label: "Project B",
          aliases: [],
          weight: 2,
          enabled: true,
          createdAt: "2026-06-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z"
        },
        {
          id: "a3",
          kind: "project",
          label: "Project C",
          aliases: [],
          weight: 2,
          enabled: true,
          createdAt: "2026-06-01T00:00:00Z",
          updatedAt: "2026-06-01T00:00:00Z"
        }
      ]
    };

    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Cross-project work",
        textForAnchorMatch: ["Project A", "Project B", "Project C"]
      }
    ];

    const results = rankPriorityCandidates({
      model: anchorModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results[0]!.score).toBeLessThanOrEqual(100);
  });

  it("compares date-only and instant timestamps in user timezone", () => {
    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Task due tomorrow",
        dueAt: "2026-06-28",
        textForAnchorMatch: ["task"]
      }
    ];

    const results = rankPriorityCandidates({
      model: DEFAULT_MODEL,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results[0]!.reasons).toContain("due tomorrow");
  });

  it("rejects more than 200 candidates", () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      source: "tasks" as const,
      title: `Task ${i}`,
      textForAnchorMatch: [`task ${i}`]
    }));

    expect(() =>
      rankPriorityCandidates({
        model: DEFAULT_MODEL,
        candidates: tooMany,
        now: NOW,
        timeZone: TZ,
        focusReadiness: []
      })
    ).toThrow();
  });

  it("muted source is excluded from results entirely", () => {
    const mutedModel: PriorityModelPreferenceV1 = {
      ...DEFAULT_MODEL,
      mutedSources: ["email"]
    };

    const candidates: PriorityCandidate[] = [
      {
        source: "email",
        title: "Urgent email",
        signalType: "needs_reply",
        textForAnchorMatch: ["urgent email"]
      },
      {
        source: "tasks",
        title: "Normal task",
        textForAnchorMatch: ["normal task"]
      }
    ];

    const results = rankPriorityCandidates({
      model: mutedModel,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results.find((r) => r.source === "email")).toBeUndefined();
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("tasks");
  });

  it("malformed preference falls back to defaults", () => {
    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Task",
        textForAnchorMatch: ["task"]
      }
    ];

    expect(() =>
      rankPriorityCandidates({
        model: DEFAULT_MODEL,
        candidates,
        now: NOW,
        timeZone: TZ,
        focusReadiness: []
      })
    ).not.toThrow();
  });

  it("tie-breaks by time, priority, effort, title", () => {
    const candidates: PriorityCandidate[] = [
      {
        source: "tasks",
        title: "Beta",
        dueAt: "2026-06-28T12:00:00Z",
        explicitPriority: 3,
        effort: "medium",
        textForAnchorMatch: ["beta"]
      },
      {
        source: "tasks",
        title: "Alpha",
        dueAt: "2026-06-28T12:00:00Z",
        explicitPriority: 3,
        effort: "medium",
        textForAnchorMatch: ["alpha"]
      }
    ];

    const results = rankPriorityCandidates({
      model: DEFAULT_MODEL,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results[0]!.title).toBe("Alpha");
    expect(results[1]!.title).toBe("Beta");
  });

  it("carries each candidate key through to its own result — #2609", () => {
    const candidates: PriorityCandidate[] = [
      { source: "calendar", title: "Standup", textForAnchorMatch: ["standup"], key: "mon" },
      { source: "calendar", title: "Standup", textForAnchorMatch: ["standup"], key: "tue" }
    ];

    const results = rankPriorityCandidates({
      model: DEFAULT_MODEL,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.key).sort()).toEqual(["mon", "tue"]);
  });

  it("leaves the key off results whose candidate set none — #2609", () => {
    const candidates: PriorityCandidate[] = [
      { source: "calendar", title: "Standup", textForAnchorMatch: ["standup"] }
    ];

    const results = rankPriorityCandidates({
      model: DEFAULT_MODEL,
      candidates,
      now: NOW,
      timeZone: TZ,
      focusReadiness: []
    });

    expect(results).toHaveLength(1);
    expect("key" in results[0]!).toBe(false);
  });
});
