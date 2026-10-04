import { afterEach, describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { AccessContext, DataContextDb } from "@moss/db";
import type {
  GenerateMeetingOutputInput,
  MeetingOutputArtifact,
  MeetingOutputContent,
  MeetingOutputInputs
} from "@moss/shared";
import {
  MeetingOutputError,
  MeetingOutputsRepository
} from "../../packages/meetings/src/output-repository.js";
import {
  MeetingOutputService,
  type MeetingOutputGenerator
} from "../../packages/meetings/src/output-service.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR: AccessContext = { actorUserId: "owner", requestId: "request" };
const INPUT: GenerateMeetingOutputInput = {
  requestKey: "22222222-2222-4222-8222-222222222222",
  expectedOutputVersion: 0,
  expectedTranscriptRevision: 0,
  expectedNotesRevision: 1,
  templateId: "general",
  templateVersion: 1
};
const NOTES = "Alex will send the plan tomorrow.";
const CONTENT: MeetingOutputContent = {
  overview: "The meeting covered the plan.",
  decisions: [],
  openQuestions: [],
  actions: [
    {
      text: "Send the plan.",
      ownerPhrase: "Alex",
      duePhrase: "tomorrow",
      evidence: [
        {
          kind: "personal-note",
          meetingId: MEETING_ID,
          notesRevision: 1,
          startCharacter: 0,
          endCharacter: NOTES.length
        }
      ]
    }
  ],
  warnings: []
};

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const state: {
    inputs: MeetingOutputInputs;
    head: MeetingOutputArtifact | null;
    artifacts: MeetingOutputArtifact[];
    inTransaction: boolean;
  } = {
    inputs: { meetingId: MEETING_ID, transcript: null, personalNotes: NOTES, notesRevision: 1 },
    head: null,
    artifacts: [],
    inTransaction: false
  };
  const requests = new Map<
    string,
    NonNullable<Awaited<ReturnType<MeetingOutputsRepository["request"]>>>
  >();
  // Every database-facing method used by the service is replaced below. No database is created.
  const repository = new MeetingOutputsRepository();
  const lock = vi.spyOn(repository, "lock").mockImplementation(async () => ({
    id: MEETING_ID,
    title: "Meeting",
    personalNotes: state.inputs.personalNotes,
    notesRevision: state.inputs.notesRevision,
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z"
  }));
  const request = vi
    .spyOn(repository, "request")
    .mockImplementation(async (_db, meetingId, key, encoded) => {
      const previous = requests.get(key);
      if (
        previous &&
        (previous.meeting_id !== meetingId ||
          !isDeepStrictEqual(JSON.parse(previous.input_json), JSON.parse(encoded)))
      ) {
        throw new MeetingOutputError("meeting_output_request_conflict");
      }
      if (
        previous &&
        previous.result_json === null &&
        previous.expires_at.getTime() <= Date.now()
      ) {
        const expired = {
          ...previous,
          result_json: JSON.stringify({
            status: "failed",
            requestKey: key,
            code: "meeting_output_interrupted"
          })
        };
        requests.set(key, expired);
        return expired;
      }
      return previous;
    });
  vi.spyOn(repository, "pendingGeneration").mockImplementation(async (db, meetingId) => {
    for (const [key, receipt] of requests) {
      if (receipt.meeting_id !== meetingId || JSON.parse(receipt.input_json).kind !== "generate")
        continue;
      const reconciled = await repository.request(db, meetingId, key, receipt.input_json);
      if (reconciled?.result_json === null) return key;
    }
    return null;
  });
  const head = vi.spyOn(repository, "head").mockImplementation(async () => state.head);
  const inputs = vi
    .spyOn(repository, "inputs")
    .mockImplementation(async () => structuredClone(state.inputs));
  const reserve = vi
    .spyOn(repository, "reserve")
    .mockImplementation(async (_db, meetingId, key, encoded) => {
      if (requests.has(key)) throw new Error("Duplicate reservation");
      requests.set(key, {
        meeting_id: meetingId,
        owner_user_id: ACTOR.actorUserId,
        request_key: key,
        input_json: encoded,
        result_json: null,
        expires_at: new Date(Date.now() + 180_000)
      });
    });
  const finish = vi
    .spyOn(repository, "finish")
    .mockImplementation(async (_db, _meetingId, key, result) => {
      const previous = requests.get(key);
      if (!previous) throw new Error("Missing reservation");
      if (previous.result_json === null)
        requests.set(key, { ...previous, result_json: JSON.stringify(result) });
    });
  const save = vi.spyOn(repository, "save").mockImplementation(async (_db, value) => {
    const artifact: MeetingOutputArtifact = {
      ...value,
      id: `artifact-${state.artifacts.length + 1}`,
      version: state.artifacts.length + 1,
      createdAt: "2026-10-03T10:01:00.000Z"
    };
    state.artifacts.push(artifact);
    if (!value.stale) state.head = artifact;
    return artifact;
  });
  const scopedDb = {} as DataContextDb;
  const actors: AccessContext[] = [];
  let transactionQueue: Promise<unknown> = Promise.resolve();
  const dataContext = {
    withDataContext: <T>(
      actor: AccessContext,
      work: (db: DataContextDb) => Promise<T>
    ): Promise<T> => {
      const transaction = transactionQueue.then(async () => {
        actors.push(actor);
        state.inTransaction = true;
        try {
          return await work(scopedDb);
        } finally {
          state.inTransaction = false;
        }
      });
      transactionQueue = transaction.catch(() => undefined);
      return transaction;
    }
  };
  const generator = vi
    .fn<MeetingOutputGenerator>()
    .mockResolvedValue({ content: CONTENT, modelRoute: "configured-route" });
  const service = new MeetingOutputService(dataContext, generator, repository);
  return {
    service,
    generator,
    state,
    requests,
    actors,
    scopedDb,
    lock,
    request,
    head,
    inputs,
    reserve,
    finish,
    save
  };
}

describe("meeting output generation service", () => {
  it("races distinct request keys while dispatching only the reserved winner", async () => {
    const harness = setup();
    const provider = deferred<Awaited<ReturnType<MeetingOutputGenerator>>>();
    const dispatched = deferred<void>();
    harness.generator.mockImplementation(async () => {
      dispatched.resolve();
      return provider.promise;
    });
    const winner = harness.service.generate(ACTOR, MEETING_ID, INPUT);
    const secondInput = { ...INPUT, requestKey: "33333333-3333-4333-8333-333333333333" };
    const loser = harness.service.generate(ACTOR, MEETING_ID, secondInput);
    await dispatched.promise;
    await expect(loser).rejects.toMatchObject({ code: "meeting_output_busy", statusCode: 409 });
    expect(harness.requests.has(secondInput.requestKey)).toBe(false);
    expect(harness.generator).toHaveBeenCalledOnce();
    expect(harness.reserve).toHaveBeenCalledOnce();
    provider.resolve({ content: CONTENT, modelRoute: "configured-route" });
    expect(await winner).toMatchObject({ status: "saved", replayed: false });
    expect(harness.save).toHaveBeenCalledOnce();
  });

  it("rejects a distinct key as busy rather than a false pending retry after the winner fails", async () => {
    const harness = setup();
    const provider = deferred<Awaited<ReturnType<MeetingOutputGenerator>>>();
    const dispatched = deferred<void>();
    harness.generator.mockImplementation(async () => {
      dispatched.resolve();
      return provider.promise;
    });
    const first = harness.service.generate(ACTOR, MEETING_ID, INPUT);
    await dispatched.promise;
    const secondInput = { ...INPUT, requestKey: "33333333-3333-4333-8333-333333333333" };
    await expect(harness.service.generate(ACTOR, MEETING_ID, secondInput)).rejects.toMatchObject({
      code: "meeting_output_busy",
      statusCode: 409
    });
    expect(harness.requests.has(secondInput.requestKey)).toBe(false);
    provider.reject(new Error("Provider failed"));
    const failed = await first;
    expect(failed).toMatchObject({ status: "failed", requestKey: INPUT.requestKey });
    // Only the actual reservation has a checkable terminal receipt. No losing key is
    // mislabeled pending, queued for redispatch, or retried automatically after failure.
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toEqual(failed);
    expect(harness.generator).toHaveBeenCalledOnce();
    expect(harness.reserve).toHaveBeenCalledOnce();
    expect(harness.requests.has(secondInput.requestKey)).toBe(false);
  });

  it("replays logically identical input regardless of object key order", async () => {
    const harness = setup();
    await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    const reordered = {
      templateVersion: INPUT.templateVersion,
      templateId: INPUT.templateId,
      expectedNotesRevision: INPUT.expectedNotesRevision,
      expectedTranscriptRevision: INPUT.expectedTranscriptRevision,
      expectedOutputVersion: INPUT.expectedOutputVersion,
      requestKey: INPUT.requestKey
    };
    expect(await harness.service.generate(ACTOR, MEETING_ID, reordered)).toMatchObject({
      status: "saved",
      replayed: true
    });
    expect(harness.generator).toHaveBeenCalledOnce();
  });

  it("pins authorized inputs and template before calling the generator outside a transaction", async () => {
    const harness = setup();
    harness.generator.mockImplementation(async (actor, input) => {
      expect(actor).toEqual(ACTOR);
      expect(harness.state.inTransaction).toBe(false);
      expect(harness.reserve).toHaveBeenCalledOnce();
      expect(input.inputs).toEqual(harness.state.inputs);
      expect(input.template).toMatchObject({ id: "general", version: 1 });
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.signal.aborted).toBe(false);
      return { content: CONTENT, modelRoute: "configured-route" };
    });
    const result = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(result).toMatchObject({
      status: "saved",
      replayed: false,
      artifact: {
        stale: false,
        origin: "generated",
        templateId: "general",
        templateVersion: 1,
        inputs: harness.state.inputs
      }
    });
    expect(harness.actors).toEqual([ACTOR, ACTOR]);
    expect(harness.finish).toHaveBeenCalledExactlyOnceWith(
      harness.scopedDb,
      MEETING_ID,
      INPUT.requestKey,
      result
    );
    expect(harness.state.head?.content.warnings).toContain(
      "Capture gaps and participant attribution have not been independently verified."
    );
  });

  it("replays a completed request without a second generator call or artifact", async () => {
    const harness = setup();
    const first = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    const second = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(second).toEqual({ ...first, replayed: true });
    expect(harness.generator).toHaveBeenCalledOnce();
    expect(harness.save).toHaveBeenCalledOnce();
    expect(harness.reserve).toHaveBeenCalledOnce();
  });

  it("returns pending during the same reserved request rather than dispatching twice", async () => {
    const harness = setup();
    const started = deferred<void>();
    const generated = deferred<Awaited<ReturnType<MeetingOutputGenerator>>>();
    harness.generator.mockImplementation(() => {
      started.resolve();
      return generated.promise;
    });
    const first = harness.service.generate(ACTOR, MEETING_ID, INPUT);
    await started.promise;
    const replay = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(replay).toEqual({ status: "pending", requestKey: INPUT.requestKey });
    expect(harness.generator).toHaveBeenCalledOnce();
    generated.resolve({ content: CONTENT, modelRoute: "configured-route" });
    expect(await first).toMatchObject({ status: "saved", replayed: false });
    expect(harness.save).toHaveBeenCalledOnce();
  });

  it("returns an interrupted expired reservation without invoking the generator again", async () => {
    const harness = setup();
    harness.requests.set(INPUT.requestKey, {
      meeting_id: MEETING_ID,
      owner_user_id: ACTOR.actorUserId,
      request_key: INPUT.requestKey,
      input_json: JSON.stringify({ kind: "generate", ...INPUT }),
      result_json: null,
      expires_at: new Date(0)
    });
    const result = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(result).toEqual({
      status: "failed",
      requestKey: INPUT.requestKey,
      code: "meeting_output_interrupted"
    });
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toEqual(result);
    expect(harness.generator).not.toHaveBeenCalled();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "preserves the terminal interruption receipt when a late provider call settles: %s",
    async (settlement) => {
      const harness = setup();
      const started = deferred<void>();
      const generated = deferred<Awaited<ReturnType<MeetingOutputGenerator>>>();
      harness.generator.mockImplementation(() => {
        started.resolve();
        return generated.promise;
      });
      const first = harness.service.generate(ACTOR, MEETING_ID, INPUT);
      await started.promise;
      const pending = harness.requests.get(INPUT.requestKey);
      if (!pending) throw new Error("Missing reservation");
      harness.requests.set(INPUT.requestKey, { ...pending, expires_at: new Date(0) });
      const expired = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
      expect(expired).toEqual({
        status: "failed",
        requestKey: INPUT.requestKey,
        code: "meeting_output_interrupted"
      });
      if (settlement === "resolve")
        generated.resolve({ content: CONTENT, modelRoute: "configured-route" });
      else generated.reject(new Error("Late private provider failure"));
      expect(await first).toEqual(expired);
      expect(harness.save).not.toHaveBeenCalled();
      expect(harness.generator).toHaveBeenCalledOnce();
      expect(harness.state.head).toBeNull();
    }
  );

  it("bounds an unresponsive provider and ignores its result after the timeout", async () => {
    const harness = setup();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const started = deferred<void>();
    const generated = deferred<Awaited<ReturnType<MeetingOutputGenerator>>>();
    harness.generator.mockImplementation(() => {
      started.resolve();
      return generated.promise;
    });
    const first = harness.service.generate(ACTOR, MEETING_ID, INPUT);
    await started.promise;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(110_000);
    controller.abort();
    const result = await first;
    expect(result).toEqual({
      status: "failed",
      requestKey: INPUT.requestKey,
      code: "meeting_output_interrupted"
    });
    generated.resolve({ content: CONTENT, modelRoute: "configured-route" });
    await generated.promise;
    expect(harness.save).not.toHaveBeenCalled();
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toEqual(result);
    expect(harness.generator).toHaveBeenCalledOnce();
  });

  it("rejects changed content under an existing request key without redispatch", async () => {
    const harness = setup();
    await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    await expect(
      harness.service.generate(ACTOR, MEETING_ID, { ...INPUT, templateId: "project-review" })
    ).rejects.toMatchObject({ code: "meeting_output_request_conflict" });
    expect(harness.generator).toHaveBeenCalledOnce();
  });

  it("keeps a completion pinned and inactive when notes change while generation runs", async () => {
    const harness = setup();
    harness.generator.mockImplementation(async () => {
      harness.state.inputs = {
        ...harness.state.inputs,
        notesRevision: 2,
        personalNotes: "New user notes."
      };
      return { content: CONTENT, modelRoute: "configured-route" };
    });
    const result = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(result).toMatchObject({
      status: "saved",
      artifact: { stale: true, inputs: { notesRevision: 1, personalNotes: NOTES } }
    });
    expect(harness.state.head).toBeNull();
    expect(harness.state.inputs.personalNotes).toBe("New user notes.");
    expect(harness.state.inputs.notesRevision).toBe(2);
  });

  it("preserves a concurrent manually edited head and stores the new completion as stale", async () => {
    const harness = setup();
    const manual: MeetingOutputArtifact = {
      id: "manual",
      meetingId: MEETING_ID,
      version: 1,
      inputs: harness.state.inputs,
      templateId: "general",
      templateVersion: 1,
      modelRoute: "configured-route",
      content: { ...CONTENT, overview: "User-edited summary" },
      origin: "manual",
      stale: false,
      createdAt: "2026-10-03T10:00:00.000Z"
    };
    harness.generator.mockImplementation(async () => {
      harness.state.head = manual;
      harness.state.artifacts.push(manual);
      return { content: CONTENT, modelRoute: "configured-route" };
    });
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toMatchObject({
      status: "saved",
      artifact: { version: 2, stale: true }
    });
    expect(harness.state.head).toBe(manual);
    expect(harness.state.head?.content.overview).toBe("User-edited summary");
  });

  it("marks completion stale when a newer transcript arrives", async () => {
    const harness = setup();
    harness.generator.mockImplementation(async () => {
      harness.state.inputs = {
        ...harness.state.inputs,
        transcript: {
          meetingId: MEETING_ID,
          ownerUserId: ACTOR.actorUserId,
          transcriptRevision: 1,
          cutoffMs: 1_000,
          maxSegments: 10,
          maxCharacters: 1_000,
          cursor: 1,
          segments: [],
          throughMs: null,
          omittedSegments: 0,
          containsProvisional: false
        }
      };
      return { content: CONTENT, modelRoute: "configured-route" };
    });
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toMatchObject({
      status: "saved",
      artifact: { stale: true, inputs: { transcript: null } }
    });
    expect(harness.state.head).toBeNull();
  });

  it("records a safe failed receipt for invalid model evidence without saving an artifact", async () => {
    const harness = setup();
    harness.generator.mockResolvedValue({
      content: {
        ...CONTENT,
        decisions: [
          {
            text: "Invented decision",
            evidence: [
              {
                kind: "personal-note",
                meetingId: MEETING_ID,
                notesRevision: 99,
                startCharacter: 0,
                endCharacter: NOTES.length
              }
            ]
          }
        ]
      },
      modelRoute: "configured-route"
    });
    const first = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(first).toEqual({
      status: "failed",
      requestKey: INPUT.requestKey,
      code: "meeting_output_generation_failed"
    });
    expect(harness.save).not.toHaveBeenCalled();
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toEqual(first);
    expect(harness.generator).toHaveBeenCalledOnce();
    expect(harness.finish).toHaveBeenCalledOnce();
  });

  it("persists a safe provider-failure receipt and does not retry a failed request", async () => {
    const harness = setup();
    harness.generator.mockRejectedValue(new Error("Private prompt and secret vendor message"));
    const first = await harness.service.generate(ACTOR, MEETING_ID, INPUT);
    expect(first).toEqual({
      status: "failed",
      requestKey: INPUT.requestKey,
      code: "meeting_output_generation_failed"
    });
    const receipt = harness.requests.get(INPUT.requestKey)?.result_json;
    expect(receipt).not.toContain("Private prompt");
    expect(receipt).not.toContain("secret vendor");
    expect(harness.save).not.toHaveBeenCalled();
    expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toEqual(first);
    expect(harness.generator).toHaveBeenCalledOnce();
  });

  it.each(["", "r".repeat(1025)])(
    "rejects an invalid route receipt without persisting content",
    async (modelRoute) => {
      const harness = setup();
      harness.generator.mockResolvedValue({ content: CONTENT, modelRoute });
      expect(await harness.service.generate(ACTOR, MEETING_ID, INPUT)).toMatchObject({
        status: "failed",
        code: "meeting_output_generation_failed"
      });
      expect(harness.save).not.toHaveBeenCalled();
    }
  );

  it.each([
    { templateVersion: 2 },
    { templateVersion: 0 },
    { expectedOutputVersion: -1 },
    { expectedNotesRevision: NaN },
    { expectedTranscriptRevision: 0.5 }
  ])(
    "rejects an unsupported template or malformed revision before reserving: %s",
    async (changes) => {
      const harness = setup();
      await expect(
        harness.service.generate(ACTOR, MEETING_ID, { ...INPUT, ...changes })
      ).rejects.toMatchObject({ code: "meeting_output_invalid_input", statusCode: 400 });
      expect(harness.lock).not.toHaveBeenCalled();
      expect(harness.reserve).not.toHaveBeenCalled();
      expect(harness.generator).not.toHaveBeenCalled();
    }
  );

  it.each([
    { expectedOutputVersion: 1 },
    { expectedNotesRevision: 2 },
    { expectedTranscriptRevision: 1 }
  ])("rejects a stale request version before invoking the provider: %s", async (changes) => {
    const harness = setup();
    await expect(
      harness.service.generate(ACTOR, MEETING_ID, { ...INPUT, ...changes })
    ).rejects.toMatchObject({ code: "meeting_output_version_conflict" });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.generator).not.toHaveBeenCalled();
  });

  it("does not generate when no source evidence remains", async () => {
    const harness = setup();
    harness.state.inputs = { ...harness.state.inputs, personalNotes: " \n " };
    await expect(harness.service.generate(ACTOR, MEETING_ID, INPUT)).rejects.toMatchObject({
      code: "meeting_output_evidence_unavailable",
      statusCode: 400
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.generator).not.toHaveBeenCalled();
  });

  it("does not dispatch when owner-authorized lookup fails", async () => {
    const harness = setup();
    harness.lock.mockRejectedValue(new MeetingOutputError("meeting_not_found", 404));
    await expect(harness.service.generate(ACTOR, MEETING_ID, INPUT)).rejects.toMatchObject({
      code: "meeting_not_found",
      statusCode: 404
    });
    expect(harness.inputs).not.toHaveBeenCalled();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.generator).not.toHaveBeenCalled();
  });
});
