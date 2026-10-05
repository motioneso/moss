import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { IngestMeetingTranscriptInput } from "@moss/shared";
import type { AccessContext, DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  applyMeetingTranscriptBatch,
  encodeMeetingTranscriptBatch,
  MeetingTranscriptInputError,
  MeetingTranscriptLimitError,
  registerMeetingTranscriptRoutes,
  type MeetingTranscriptRepository
} from "@moss/meetings";
const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const input = (): IngestMeetingTranscriptInput => ({
  meetingId: id,
  requestKey: key,
  expectedVersion: 0,
  sources: [
    { sourceId: "mic", epoch: 1, kind: "microphone", label: "Microphone", startMs: 0, endMs: 1000 }
  ],
  stopCutoffMs: null,
  events: [
    {
      cursor: 1,
      segment: {
        meetingId: id,
        segmentId: "one",
        sourceId: "mic",
        epoch: 1,
        startMs: 0,
        endMs: 900,
        revision: 1,
        text: "Synthetic statement",
        finality: "final",
        provenance: "transcription",
        speakerId: null
      }
    }
  ]
});

describe("persisted transcript input rules", () => {
  it("reports an oversized individual segment as a limit, not malformed input", () => {
    const batch = input();
    const oversized = {
      ...batch,
      events: [
        { ...batch.events[0]!, segment: { ...batch.events[0]!.segment, text: "x".repeat(100001) } }
      ]
    };
    expect(() => encodeMeetingTranscriptBatch(oversized)).toThrow(MeetingTranscriptLimitError);
    expect(() => applyMeetingTranscriptBatch(null, id, null, oversized)).toThrow(
      MeetingTranscriptLimitError
    );
  });

  it("canonicalizes keys without changing exact text or source identity", () => {
    const batch = input();
    expect(encodeMeetingTranscriptBatch(batch)).toBe(
      encodeMeetingTranscriptBatch({
        events: batch.events,
        sources: batch.sources,
        requestKey: key,
        meetingId: id,
        stopCutoffMs: null,
        expectedVersion: 0
      })
    );
    expect(encodeMeetingTranscriptBatch(batch)).not.toBe(
      encodeMeetingTranscriptBatch({
        ...batch,
        events: [
          { ...batch.events[0]!, segment: { ...batch.events[0]!.segment, text: "Different" } }
        ]
      })
    );
  });
  it("keeps immutable revisions while accepting exact duplicate events", () => {
    const batch = input();
    const first = applyMeetingTranscriptBatch(null, id, null, batch);
    const replay = applyMeetingTranscriptBatch(first, id, null, { ...batch, expectedVersion: 1 });
    expect(replay.transcriptRevision).toBe(1);
    const corrected = applyMeetingTranscriptBatch(first, id, null, {
      ...batch,
      expectedVersion: 1,
      events: [
        {
          cursor: 2,
          segment: {
            ...batch.events[0]!.segment,
            revision: 2,
            provenance: "correction",
            text: "Corrected"
          }
        }
      ]
    });
    expect(corrected.revisions.map((revision) => revision.segment.text)).toEqual([
      "Synthetic statement",
      "Corrected"
    ]);
    expect(first.revisions[0]!.segment.text).toBe("Synthetic statement");
  });
  it("rejects source rewriting, stale finality, and fixed-cutoff changes", () => {
    const batch = input();
    const first = applyMeetingTranscriptBatch(null, id, null, batch);
    for (const patch of [
      { sources: [{ ...batch.sources[0]!, label: "Another" }] },
      { sources: [{ ...batch.sources[0]!, endMs: 500 }] },
      { stopCutoffMs: 500 },
      {
        events: [
          {
            cursor: 2,
            segment: { ...batch.events[0]!.segment, revision: 2, finality: "provisional" as const }
          }
        ]
      }
    ]) {
      expect(() => applyMeetingTranscriptBatch(first, id, null, { ...batch, ...patch })).toThrow(
        MeetingTranscriptInputError
      );
    }
    expect(() =>
      applyMeetingTranscriptBatch(first, id, 1000, { ...batch, stopCutoffMs: null })
    ).toThrow(MeetingTranscriptInputError);
    expect(() =>
      applyMeetingTranscriptBatch(first, id, 1000, { ...batch, stopCutoffMs: 2000 })
    ).toThrow(MeetingTranscriptInputError);
    expect(
      applyMeetingTranscriptBatch(first, id, 1000, { ...batch, stopCutoffMs: 1000 })
        .transcriptRevision
    ).toBe(1);
  });
  it("bounds bytes, batches, and malformed runtime input", () => {
    expect(() => encodeMeetingTranscriptBatch({ ...input(), expectedVersion: 4096 })).toThrow(
      MeetingTranscriptLimitError
    );
    expect(() =>
      encodeMeetingTranscriptBatch({
        ...input(),
        events: Array.from({ length: 100 }, () => ({
          ...input().events[0]!,
          segment: { ...input().events[0]!.segment, text: "é".repeat(100000) }
        }))
      })
    ).toThrow(MeetingTranscriptLimitError);
    expect(() =>
      encodeMeetingTranscriptBatch({
        ...input(),
        sources: [{ ...input().sources[0]!, label: "bad\0label" }]
      })
    ).toThrow(MeetingTranscriptInputError);
  });
});

async function routeProbe(payload: object, authError?: Error) {
  const app = Fastify();
  const repository = {
    ingest: vi.fn<MeetingTranscriptRepository["ingest"]>().mockResolvedValue({
      status: "saved",
      replayed: false,
      receipt: { version: 1, transcriptRevision: 1, cursor: 1, stopCutoffMs: null }
    }),
    snapshotWithSources: vi
      .fn<MeetingTranscriptRepository["snapshotWithSources"]>()
      .mockResolvedValue(null),
    evidence: vi.fn<MeetingTranscriptRepository["evidence"]>().mockResolvedValue(null)
  };
  const scopedDb = {} as DataContextDb;
  const contexts: AccessContext[] = [];
  registerMeetingTranscriptRoutes(app, {
    transcriptRepository: repository,
    resolveAccessContext: async () => {
      if (authError) throw authError;
      return { actorUserId: id };
    },
    dataContext: {
      withDataContext: async <T>(actor: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
        contexts.push(actor);
        return work(scopedDb);
      }
    }
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/records/${id}/transcript`,
      payload
    });
    return { response, repository, contexts, scopedDb };
  } finally {
    await app.close();
  }
}
function body() {
  const { meetingId: _meetingId, ...result } = input();
  return result;
}
describe("transcript ingestion route", () => {
  it("uses the signed-in actor and URL meeting identity", async () => {
    const { response, repository, contexts, scopedDb } = await routeProbe(body());
    expect(response.statusCode).toBe(201);
    expect(contexts).toEqual([{ actorUserId: id }]);
    expect(repository.ingest).toHaveBeenCalledExactlyOnceWith(scopedDb, input());
  });
  it.each([false, true, "", "0", [], {}])(
    "rejects coerced cutoff %j before schema mutation",
    async (stopCutoffMs) => {
      const { response, repository } = await routeProbe({ ...body(), stopCutoffMs });
      expect(response.statusCode).toBe(400);
      expect(repository.ingest).not.toHaveBeenCalled();
    }
  );
  it.each([false, 0, {}])("rejects coerced speaker identity %j", async (speakerId) => {
    const { response } = await routeProbe({
      ...body(),
      events: [{ ...input().events[0]!, segment: { ...input().events[0]!.segment, speakerId } }]
    });
    expect(response.statusCode).toBe(400);
  });
  it("preserves a real zero cutoff instead of coercing it to null", async () => {
    const { response, repository } = await routeProbe({ ...body(), stopCutoffMs: 0 });
    expect(response.statusCode).toBe(201);
    expect(repository.ingest.mock.calls[0]![1].stopCutoffMs).toBe(0);
  });
  it("does not access storage without authentication", async () => {
    const { response, repository, contexts } = await routeProbe(
      body(),
      new HttpError(401, "Authentication required")
    );
    expect(response.statusCode).toBe(401);
    expect(contexts).toEqual([]);
    expect(repository.ingest).not.toHaveBeenCalled();
  });
  it("rejects additional credentials or ownership metadata", async () => {
    const { response, repository } = await routeProbe({
      ...body(),
      ownerUserId: key,
      apiKey: "synthetic"
    });
    expect(response.statusCode).toBe(400);
    expect(repository.ingest).not.toHaveBeenCalled();
  });
});

describe("bounded persisted replay", () => {
  it("reconstructs 20,000 retained revisions near the byte cap without quadratic folding", async () => {
    const { MeetingTranscriptRepository } = await import("@moss/meetings");
    const { dataContextBrand } = await import("@moss/db");
    const batches = Array.from({ length: 200 }, (_, batch) => {
      const request = {
        ...input(),
        expectedVersion: batch,
        sources: [{ ...input().sources[0]!, endMs: 7200000 }],
        events: Array.from({ length: 100 }, (_, index) => ({
          cursor: batch * 100 + index + 1,
          segment: {
            ...input().events[0]!.segment,
            segmentId: `segment-${batch * 100 + index}`,
            startMs: (batch * 100 + index) * 300,
            endMs: (batch * 100 + index) * 300 + 250,
            text: "x".repeat(1300)
          }
        }))
      };
      return {
        input_json: JSON.stringify(request),
        version: batch + 1,
        transcript_revision: (batch + 1) * 100,
        cursor: (batch + 1) * 100,
        stop_cutoff_ms: null
      };
    });
    const bytes = batches.reduce((total, batch) => total + Buffer.byteLength(batch.input_json), 0);
    expect(bytes).toBeGreaterThan(28 * 1024 * 1024);
    expect(bytes).toBeLessThan(32 * 1024 * 1024);
    const query = {
      select() {
        return this;
      },
      selectAll() {
        return this;
      },
      where() {
        return this;
      },
      forShare() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return this;
      },
      async executeTakeFirst() {
        return { id, owner_user_id: id };
      },
      async executeTakeFirstOrThrow() {
        return { bytes: String(bytes) };
      },
      async execute() {
        return batches;
      }
    };
    const scopedDb = {
      [dataContextBrand]: true,
      db: { selectFrom: () => query }
    } as unknown as DataContextDb;
    const start = performance.now();
    const snapshot = await new MeetingTranscriptRepository().snapshot(scopedDb, id, {
      maxSegments: 500,
      maxCharacters: 100000
    });
    const elapsedMs = performance.now() - start;
    expect(snapshot?.transcriptRevision).toBe(20000);
    expect(snapshot?.omittedSegments).toBeGreaterThan(19000);
    expect(elapsedMs).toBeLessThan(2000);
  });
  it("checks aggregate bytes before fetching or deserializing history", async () => {
    const { MeetingTranscriptRepository } = await import("@moss/meetings");
    const { dataContextBrand } = await import("@moss/db");
    const selectAll = vi.fn();
    const query = {
      select() {
        return this;
      },
      selectAll,
      where() {
        return this;
      },
      forShare() {
        return this;
      },
      async executeTakeFirst() {
        return { id, owner_user_id: id };
      },
      async executeTakeFirstOrThrow() {
        return { bytes: String(32 * 1024 * 1024 + 1) };
      }
    };
    const scopedDb = {
      [dataContextBrand]: true,
      db: { selectFrom: () => query }
    } as unknown as DataContextDb;
    await expect(
      new MeetingTranscriptRepository().snapshot(scopedDb, id, {
        maxSegments: 500,
        maxCharacters: 100000
      })
    ).rejects.toBeInstanceOf(MeetingTranscriptLimitError);
    expect(selectAll).not.toHaveBeenCalled();
  });
});

describe("transcript read routes", () => {
  it("serves bounded snapshots and exact evidence under the resolved actor", async () => {
    const app = Fastify();
    const snapshotWithSources = vi
      .fn<MeetingTranscriptRepository["snapshotWithSources"]>()
      .mockResolvedValue(null);
    const evidence = vi
      .fn<MeetingTranscriptRepository["evidence"]>()
      .mockResolvedValue({ segment: input().events[0]!.segment, excerpt: "Synthetic" });
    const scopedDb = {} as DataContextDb;
    const actors: AccessContext[] = [];
    registerMeetingTranscriptRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: id }),
      dataContext: {
        withDataContext: async <T>(
          actor: AccessContext,
          work: (db: DataContextDb) => Promise<T>
        ) => {
          actors.push(actor);
          return work(scopedDb);
        }
      },
      transcriptRepository: { ingest: vi.fn(), snapshotWithSources, evidence }
    });
    try {
      expect(
        (
          await app.inject(
            `/api/meetings/records/${id}/transcript?maxSegments=501&maxCharacters=1000`
          )
        ).statusCode
      ).toBe(400);
      expect(snapshotWithSources).not.toHaveBeenCalled();
      const absent = await app.inject(
        `/api/meetings/records/${id}/transcript?maxSegments=5&maxCharacters=1000&transcriptRevision=1`
      );
      expect(absent.statusCode).toBe(404);
      expect(absent.json()).toEqual({ code: "meeting_transcript_unavailable" });
      expect(snapshotWithSources).toHaveBeenCalledWith(scopedDb, id, {
        maxSegments: 5,
        maxCharacters: 1000,
        transcriptRevision: 1
      });
      const found = await app.inject(
        `/api/meetings/records/${id}/transcript/evidence?segmentId=one&segmentRevision=1&startCharacter=0&endCharacter=9`
      );
      expect(found.statusCode).toBe(200);
      expect(found.json()).toEqual({
        evidence: { segment: input().events[0]!.segment, excerpt: "Synthetic" }
      });
      expect(evidence).toHaveBeenCalledWith(scopedDb, {
        meetingId: id,
        segmentId: "one",
        segmentRevision: 1,
        startCharacter: 0,
        endCharacter: 9
      });
      expect(actors).toEqual([{ actorUserId: id }, { actorUserId: id }]);
    } finally {
      await app.close();
    }
  });
});
