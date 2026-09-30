import { afterEach, describe, expect, it, vi } from "vitest";

import { assertBuiltInSelfOperationManifests } from "@moss/ai";
import {
  briefingsGetRunStatusExecute,
  briefingsModuleManifest,
  briefingsRerunExecute,
  BriefingsRepository,
  type BriefingRunJobReadService,
  type BriefingRunQueueService,
  type ManualBriefingRunJob
} from "@moss/briefings";
import { dataContextBrand, type BriefingDefinition, type DataContextDb } from "@moss/db";

const userA = "10000000-0000-4000-8000-00000000000a";
const userB = "10000000-0000-4000-8000-00000000000b";
const ctx = { actorUserId: userA, requestId: "req-1", chatSessionId: "chat-1" };
const scopedDb = { [dataContextBrand]: true, db: {} } as DataContextDb;

const eveningA = definition("20000000-0000-4000-8000-000000000001", userA, "evening");
const morningA = definition("20000000-0000-4000-8000-000000000002", userA, "morning");
const eveningSharedFromB = definition("20000000-0000-4000-8000-000000000003", userB, "evening");

function definition(
  id: string,
  owner: string,
  type: BriefingDefinition["briefing_type"]
): BriefingDefinition {
  return {
    id,
    owner_user_id: owner,
    title: `${type} briefing`,
    briefing_type: type,
    cadence: "daily",
    schedule_metadata: {},
    enabled: true,
    selected_tool_names: [],
    last_run_at: null,
    created_at: new Date(),
    updated_at: new Date()
  } as unknown as BriefingDefinition;
}

function fakeQueue(inFlight: Array<{ jobId: string; runId: string | null } | null> = [null]) {
  const sent: ManualBriefingRunJob[] = [];
  let call = 0;
  const queue: BriefingRunQueueService = {
    findInFlight: vi.fn(async () => inFlight[Math.min(call++, inFlight.length - 1)] ?? null),
    send: vi.fn(async (job: ManualBriefingRunJob) => {
      sent.push(job);
      return "30000000-0000-4000-8000-000000000001";
    })
  };
  return { queue, sent };
}

function tool(name: string) {
  const found = briefingsModuleManifest.assistantTools?.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing from the manifest`);
  return found;
}

afterEach(() => vi.restoreAllMocks());

describe("briefings chat tools: manifest", () => {
  it("re-runs without an approval card once installed, and only through its own queue service", () => {
    const rerun = tool("briefings.rerun");
    expect(rerun.risk).toBe("write");
    expect(rerun.executionPolicy).toBe("auto");
    expect(rerun.selfOperationGrant).toBe("granted_at_install");
    expect(rerun.actionFamilyId).toBe("briefing_runs");
    expect(rerun.permissionId).toBe("briefings.run");
    expect(rerun.requiresServices).toEqual(["briefingRunQueue"]);
    expect(() => assertBuiltInSelfOperationManifests([briefingsModuleManifest])).not.toThrow();
  });

  it("reads run state as a read tool and frames the briefing text as external content", () => {
    const status = tool("briefings.getRunStatus");
    expect(status.risk).toBe("read");
    expect(status.permissionId).toBe("briefings.view");
    expect(status.externalContent).toBe(true);
    expect(status.requiresServices).toBeUndefined();
  });

  it("tells Moss's app map that briefings can be re-run from chat", () => {
    const feature = briefingsModuleManifest.features?.find(
      (entry) => entry.id === "briefings.chat_rerun"
    );
    expect(feature?.description).toMatch(/chat/i);
    expect(feature?.errors?.map((error) => error.code)).toContain("briefing_run_in_flight");
  });
});

describe("briefings.rerun", () => {
  it("queues one metadata-only manual run of the actor's own briefing of that type", async () => {
    vi.spyOn(BriefingsRepository.prototype, "listDefinitions").mockResolvedValue([
      eveningSharedFromB,
      eveningA,
      morningA
    ]);
    const { queue, sent } = fakeQueue();

    const result = await briefingsRerunExecute(scopedDb, { briefingType: "evening" }, ctx, {
      briefingRunQueue: queue
    });

    expect(result.data).toMatchObject({
      status: "queued",
      definitionId: eveningA.id,
      briefingType: "evening",
      jobId: "30000000-0000-4000-8000-000000000001"
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({
      actorUserId: userA,
      definitionId: eveningA.id,
      briefingRunId: result.data.runId,
      runKind: "manual",
      briefingType: "evening",
      idempotencyKey: "chat-rerun"
    });
    expect(sent[0]!.singletonKey).toBe(`${eveningA.id}:key:chat-rerun`);
  });

  it("never picks a briefing someone else shared with the actor", async () => {
    vi.spyOn(BriefingsRepository.prototype, "listDefinitions").mockResolvedValue([
      eveningSharedFromB
    ]);
    const { queue, sent } = fakeQueue();

    const result = await briefingsRerunExecute(scopedDb, { briefingType: "evening" }, ctx, {
      briefingRunQueue: queue
    });

    expect(result.data.status).toBe("no_briefing");
    expect(sent).toHaveLength(0);
  });

  it("returns the running job instead of starting a second run", async () => {
    vi.spyOn(BriefingsRepository.prototype, "getOwnedDefinitionById").mockResolvedValue(eveningA);
    const running = { jobId: "30000000-0000-4000-8000-000000000009", runId: "run-in-flight" };
    const { queue, sent } = fakeQueue([running]);

    const result = await briefingsRerunExecute(scopedDb, { definitionId: eveningA.id }, ctx, {
      briefingRunQueue: queue
    });

    expect(result.data).toMatchObject({
      status: "already_running",
      runId: "run-in-flight",
      jobId: running.jobId
    });
    expect(sent).toHaveLength(0);
  });

  it("reports the racing winner when the chat key is already held", async () => {
    vi.spyOn(BriefingsRepository.prototype, "getOwnedDefinitionById").mockResolvedValue(eveningA);
    const winner = { jobId: "30000000-0000-4000-8000-000000000008", runId: "run-winner" };
    const { queue } = fakeQueue([null, winner]);
    vi.mocked(queue.send).mockResolvedValue(null);

    const result = await briefingsRerunExecute(scopedDb, { definitionId: eveningA.id }, ctx, {
      briefingRunQueue: queue
    });

    expect(result.data).toMatchObject({ status: "already_running", runId: "run-winner" });
  });

  it("rejects both or neither selector, and fails closed without the queue service", async () => {
    const { queue } = fakeQueue();
    await expect(
      briefingsRerunExecute(scopedDb, {}, ctx, { briefingRunQueue: queue })
    ).rejects.toThrow(/exactly one/);
    await expect(
      briefingsRerunExecute(scopedDb, { briefingType: "evening", definitionId: eveningA.id }, ctx, {
        briefingRunQueue: queue
      })
    ).rejects.toThrow(/exactly one/);
    await expect(
      briefingsRerunExecute(scopedDb, { briefingType: "evening" }, ctx, {})
    ).rejects.toThrow(/not available/);
  });
});

describe("briefings.getRunStatus", () => {
  const runId = "40000000-0000-4000-8000-000000000001";
  const jobId = "30000000-0000-4000-8000-000000000001";

  function jobs(state: string, actorUserId = userA, briefingRunId = runId) {
    const service: BriefingRunJobReadService = {
      readJob: vi.fn(async () => ({ state, data: { actorUserId, briefingRunId } }))
    };
    return service;
  }

  it("is ready with the briefing text once the run is stored", async () => {
    vi.spyOn(BriefingsRepository.prototype, "getOwnedRunById").mockResolvedValue({
      id: runId,
      definition_id: eveningA.id,
      owner_user_id: userA,
      status: "succeeded",
      run_kind: "manual",
      briefing_type: "evening",
      summary_text: "Your evening review.",
      source_metadata: {},
      created_at: new Date("2026-09-29T20:00:00.000Z")
    } as never);

    const result = await briefingsGetRunStatusExecute(scopedDb, { runId, jobId }, ctx, {});

    expect(result.data).toMatchObject({
      state: "ready",
      briefingType: "evening",
      summaryText: "Your evening review."
    });
  });

  it.each([
    ["active", "pending"],
    ["created", "pending"],
    ["failed", "failed"]
  ])("maps the actor's own %s job to %s", async (jobState, expected) => {
    vi.spyOn(BriefingsRepository.prototype, "getOwnedRunById").mockResolvedValue(undefined);
    const result = await briefingsGetRunStatusExecute(scopedDb, { runId, jobId }, ctx, {
      briefingRunJobs: jobs(jobState)
    });
    expect(result.data.state).toBe(expected);
  });

  it("ignores a job that belongs to another user or another run", async () => {
    vi.spyOn(BriefingsRepository.prototype, "getOwnedRunById").mockResolvedValue(undefined);
    for (const service of [jobs("active", userB), jobs("active", userA, "other-run")]) {
      const result = await briefingsGetRunStatusExecute(scopedDb, { runId, jobId }, ctx, {
        briefingRunJobs: service
      });
      expect(result.data.state).toBe("not_found");
    }
  });

  it("treats a malformed id as not found without querying", async () => {
    const spy = vi.spyOn(BriefingsRepository.prototype, "getOwnedRunById");
    const result = await briefingsGetRunStatusExecute(scopedDb, { runId: "nope" }, ctx, {});
    expect(result.data.state).toBe("not_found");
    expect(spy).not.toHaveBeenCalled();
  });
});
