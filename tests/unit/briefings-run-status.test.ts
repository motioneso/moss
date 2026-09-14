import { describe, expect, it } from "vitest";
import type { BriefingRun } from "@moss/db";
import type { BriefingPlanContextV1 } from "@moss/shared";
import { getBriefingRunResponseSchema, listBriefingRunsResponseSchema } from "@moss/shared";

import {
  comparePlanState,
  resolveRunStatus,
  RUN_NOT_AVAILABLE_CODE,
  RUN_NOT_AVAILABLE_ERROR
} from "@moss/briefings";

function run(overrides: Partial<BriefingRun> = {}): BriefingRun {
  return {
    id: "run-1",
    definition_id: "def-1",
    owner_user_id: "user-a",
    status: "succeeded",
    run_kind: "manual",
    briefing_type: "morning",
    summary_text: "summary",
    source_metadata: {},
    created_at: new Date("2026-09-10T06:00:00.000Z"),
    ...overrides
  } as BriefingRun;
}

function context(overrides: Partial<BriefingPlanContextV1> = {}): BriefingPlanContextV1 {
  return {
    version: 1,
    planId: "plan-1",
    revision: 3,
    localDay: "2026-09-10",
    timeZone: "Pacific/Auckland",
    sourceRunId: null,
    eveningIntent: null,
    blocks: [],
    ...overrides
  } as BriefingPlanContextV1;
}

function job(state: string, actorUserId = "user-a", briefingRunId = "run-9") {
  return { state, data: { actorUserId, briefingRunId } };
}

describe("resolveRunStatus", () => {
  it("reports ready with latest true for the newest row", () => {
    expect(
      resolveRunStatus({
        run: run(),
        runDefinitionId: "def-1",
        definitionId: "def-1",
        firstRunId: "run-1",
        job: null,
        actorUserId: "user-a",
        runId: "run-1"
      })
    ).toEqual({ state: "ready", latest: true });
  });

  it("reports ready with latest false for an older row", () => {
    expect(
      resolveRunStatus({
        run: run(),
        runDefinitionId: "def-1",
        definitionId: "def-1",
        firstRunId: "run-2",
        job: null,
        actorUserId: "user-a",
        runId: "run-1"
      })
    ).toEqual({ state: "ready", latest: false });
  });

  it("hides a row filed under another definition", () => {
    expect(
      resolveRunStatus({
        run: run(),
        runDefinitionId: "def-other",
        definitionId: "def-1",
        firstRunId: "run-1",
        job: null,
        actorUserId: "user-a",
        runId: "run-1"
      })
    ).toEqual({ notFound: true });
  });

  it.each(["created", "retry", "active"])("reports pending for a %s job", (state) => {
    expect(
      resolveRunStatus({
        run: undefined,
        runDefinitionId: undefined,
        definitionId: "def-1",
        firstRunId: undefined,
        job: job(state),
        actorUserId: "user-a",
        runId: "run-9"
      })
    ).toEqual({ state: "pending", latest: false });
  });

  it.each(["failed", "cancelled"])("reports failed for a %s job without a row", (state) => {
    expect(
      resolveRunStatus({
        run: undefined,
        runDefinitionId: undefined,
        definitionId: "def-1",
        firstRunId: undefined,
        job: job(state),
        actorUserId: "user-a",
        runId: "run-9"
      })
    ).toEqual({ state: "failed", latest: false });
  });

  it("never reports pending for a completed job without a row", () => {
    expect(
      resolveRunStatus({
        run: undefined,
        runDefinitionId: undefined,
        definitionId: "def-1",
        firstRunId: undefined,
        job: job("completed"),
        actorUserId: "user-a",
        runId: "run-9"
      })
    ).toEqual({ notFound: true });
  });

  it("ignores a job owned by someone else", () => {
    expect(
      resolveRunStatus({
        run: undefined,
        runDefinitionId: undefined,
        definitionId: "def-1",
        firstRunId: undefined,
        job: job("active", "user-b", "run-9"),
        actorUserId: "user-a",
        runId: "run-9"
      })
    ).toEqual({ notFound: true });
  });

  it("ignores a job promised for another run", () => {
    expect(
      resolveRunStatus({
        run: undefined,
        runDefinitionId: undefined,
        definitionId: "def-1",
        firstRunId: undefined,
        job: job("active", "user-a", "run-other"),
        actorUserId: "user-a",
        runId: "run-9"
      })
    ).toEqual({ notFound: true });
  });

  it("returns not found with no row and no job", () => {
    expect(
      resolveRunStatus({
        run: undefined,
        runDefinitionId: undefined,
        definitionId: "def-1",
        firstRunId: undefined,
        job: null,
        actorUserId: "user-a",
        runId: "run-9"
      })
    ).toEqual({ notFound: true });
  });

  it("keeps one probing-proof 404 body", () => {
    expect(RUN_NOT_AVAILABLE_ERROR).toBe("Briefing run is missing or owned by someone else");
    expect(RUN_NOT_AVAILABLE_CODE).toBe("briefing_run_not_available");
  });
});

describe("comparePlanState", () => {
  it("reports current when plan and revision match", () => {
    expect(
      comparePlanState({ stored: context(), currentAvailable: true, current: context() })
    ).toEqual({ status: "current", storedRevision: 3, currentRevision: 3 });
  });

  it("reports changed on a revision bump", () => {
    expect(
      comparePlanState({
        stored: context(),
        currentAvailable: true,
        current: context({ revision: 4 })
      })
    ).toEqual({ status: "changed", storedRevision: 3, currentRevision: 4 });
  });

  it("reports changed on a different plan", () => {
    expect(
      comparePlanState({
        stored: context(),
        currentAvailable: true,
        current: context({ planId: "plan-2", revision: 1 })
      })
    ).toEqual({ status: "changed", storedRevision: 3, currentRevision: 1 });
  });

  it("reports changed when a plan appeared after the run", () => {
    expect(comparePlanState({ stored: null, currentAvailable: true, current: context() })).toEqual({
      status: "changed",
      storedRevision: null,
      currentRevision: 3
    });
  });

  it("reports changed when the plan disappeared after the run", () => {
    expect(comparePlanState({ stored: context(), currentAvailable: true, current: null })).toEqual({
      status: "changed",
      storedRevision: 3,
      currentRevision: null
    });
  });

  it("reports none when neither side has a plan", () => {
    expect(comparePlanState({ stored: null, currentAvailable: true, current: null })).toEqual({
      status: "none",
      storedRevision: null,
      currentRevision: null
    });
  });

  it("reports unavailable when the read is not wired or threw", () => {
    expect(comparePlanState({ stored: context(), currentAvailable: false, current: null })).toEqual(
      { status: "unavailable", storedRevision: 3, currentRevision: null }
    );
  });
});

describe("run-read response shape", () => {
  it("exposes no run field the list route does not already expose", () => {
    const listItem = (listBriefingRunsResponseSchema.properties.runs as { items: unknown }).items;
    const readRun = (getBriefingRunResponseSchema.properties.run as { anyOf: readonly unknown[] })
      .anyOf[0];
    expect(readRun).toEqual(listItem);
  });
});
