import { describe, expect, it } from "vitest";

import type { BriefingPlanContextV1 } from "@moss/shared";

import { buildEveningInterviewSeed } from "./live-routes.js";

function plan(): BriefingPlanContextV1 {
  return {
    version: 1,
    planId: "plan-tmo",
    revision: 4,
    localDay: "2026-09-11",
    timeZone: "America/Los_Angeles",
    sourceRunId: "run-evening",
    eveningIntent: {
      priorityTaskIds: ["t1"],
      capacity: "light",
      notes: "Leave by four",
      corrections: [{ taskId: "t3", note: "Follow-up not sent", source: "actor" }],
      commitments: [{ taskId: "t1", decision: "commit" }]
    },
    blocks: [
      {
        id: "b-cal",
        kind: "focus",
        taskId: "t-cal",
        title: null,
        position: 0,
        actualPlacement: {
          startsAt: "2026-09-11T14:00:00.000Z",
          durationMinutes: 60,
          calendarEventRef: "ev-0"
        },
        pendingChange: null
      }
    ]
  };
}

describe("buildEveningInterviewSeed", () => {
  it("carries plan id, revision, day and intent lines when a plan exists", () => {
    const seed = buildEveningInterviewSeed("Evening wrap-up prose.", plan());
    expect(seed.context).toContain("plan-tmo");
    expect(seed.context).toContain("revision 4");
    expect(seed.context).toContain("2026-09-11");
    expect(seed.context).toContain("priority: t1");
    expect(seed.context).toContain("capacity: light");
    expect(seed.context).toContain("Leave by four");
    expect(seed.context).toContain("Evening wrap-up prose.");
    expect(seed.context).toContain("saved for review");
    expect(seed.openingPrompt).not.toBe("Prep me for tomorrow.");
  });

  it("says no plan is saved and keeps the default opener otherwise", () => {
    const seed = buildEveningInterviewSeed("Evening wrap-up prose.");
    expect(seed.context).toContain("No plan is saved for tomorrow yet.");
    expect(seed.context).not.toContain("revision");
    expect(seed.openingPrompt).toBe("Prep me for tomorrow.");
  });

  it("keeps the no-records line and delimits both sources", () => {
    const seed = buildEveningInterviewSeed(null, plan());
    expect(seed.context).toContain("Do not create, move, or delete records directly");
    expect(seed.context).toContain('<external_source type="evening_review">');
    expect(seed.context).toContain('<external_source type="tomorrow_plan">');
  });
});
