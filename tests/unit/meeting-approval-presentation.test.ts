import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { dataContextBrand } from "@moss/db";
import type { RouteApprovalInput, RouteApprovalPresentation } from "@moss/module-sdk";
import type {
  IngestMeetingTranscriptInput,
  MeetingOutputArtifact,
  MeetingRecord,
  MeetingTranscriptLedger
} from "@moss/shared";
import {
  createMeetingPresentation,
  deleteMeetingPresentation,
  meetingNotesPresentation,
  meetingPreferencesPresentation,
  meetingSummaryPresentation,
  meetingTranscriptPresentation
} from "../../packages/meetings/src/action-presentations.js";
import { meetingsModuleManifest } from "../../packages/meetings/src/manifest.js";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingOutputsRepository } from "../../packages/meetings/src/output-repository.js";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";

const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
const db = { [dataContextBrand]: true, db: {} };
const ctx = { actorUserId: "owner", requestId: "request", chatSessionId: "session" };
const meeting: MeetingRecord = {
  id,
  title: "Full meeting title “Engineering / Planning” ".repeat(4),
  personalNotes: "Alice will ship Friday.",
  notesRevision: 3,
  createdAt: "2026-10-06T10:00:00.000Z",
  updatedAt: "2026-10-06T11:00:00.000Z"
};
const call = (body?: unknown, withMeeting = true): RouteApprovalInput => ({
  params: withMeeting ? { id } : {},
  target: "Untrusted shortened target",
  body
});
const batch = (): IngestMeetingTranscriptInput => ({
  meetingId: id,
  requestKey: key,
  expectedVersion: 1,
  stopCutoffMs: null,
  sources: [
    {
      sourceId: "internal-source",
      epoch: 1,
      kind: "microphone",
      label: "Exact microphone label",
      startMs: 0,
      endMs: 2000
    }
  ],
  events: [
    {
      cursor: 2,
      segment: {
        meetingId: id,
        segmentId: "internal-segment",
        sourceId: "internal-source",
        epoch: 1,
        startMs: 125,
        endMs: 1901,
        revision: 2,
        text: "Alice will ship Friday.",
        finality: "final",
        provenance: "correction",
        speakerId: "internal-speaker"
      }
    }
  ]
});
const ledger = (): MeetingTranscriptLedger => ({
  meetingId: id,
  ownerUserId: "owner",
  sources: batch().sources,
  transcriptRevision: 1,
  cursor: 1,
  revisions: [
    {
      transcriptRevision: 1,
      cursor: 1,
      segment: {
        ...batch().events[0]!.segment,
        revision: 1,
        text: "Previous exact passage.",
        provenance: "transcription"
      }
    }
  ]
});
const artifact = (): MeetingOutputArtifact => ({
  id: "artifact-private-id",
  meetingId: id,
  version: 2,
  inputs: {
    meetingId: id,
    personalNotes: meeting.personalNotes,
    notesRevision: 3,
    transcript: {
      meetingId: id,
      ownerUserId: "owner",
      transcriptRevision: 1,
      cursor: 1,
      cutoffMs: 2000,
      maxSegments: 500,
      maxCharacters: 100000,
      segments: [batch().events[0]!.segment],
      throughMs: 1901,
      omittedSegments: 0,
      containsProvisional: false
    }
  },
  templateId: "general",
  templateVersion: 1,
  modelRoute: "private-model-route",
  origin: "generated",
  stale: false,
  createdAt: meeting.createdAt,
  content: {
    overview: "Exact overview\n" + "Full content. ".repeat(100),
    decisions: [
      {
        text: "Ship it.",
        evidence: [
          {
            kind: "personal-note",
            meetingId: id,
            notesRevision: 3,
            startCharacter: 0,
            endCharacter: 22
          }
        ]
      }
    ],
    openQuestions: ["What remains?"],
    actions: [
      {
        text: "Ship on Friday.",
        evidence: [
          {
            kind: "transcript",
            meetingId: id,
            segmentId: "internal-segment",
            segmentRevision: 2,
            startCharacter: 0,
            endCharacter: 22
          }
        ],
        ownerPhrase: "Alice",
        duePhrase: "Friday"
      }
    ],
    warnings: ["Attribution is provisional."]
  }
});
type Mutable<T> = T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;
const transcriptBody = () => {
  const { meetingId: _meetingId, ...body } = batch();
  return body as Mutable<typeof body>;
};
const summaryBody = () => ({
  requestKey: key,
  expectedOutputVersion: 2,
  content: artifact().content as Mutable<MeetingOutputArtifact["content"]>
});
let get: MockInstance<MeetingRecordsRepository["get"]>;
let getArtifact: MockInstance<MeetingOutputsRepository["getArtifact"]>;
let snapshot: MockInstance<MeetingTranscriptRepository["approvalSnapshot"]>;
beforeEach(() => {
  get = vi.spyOn(MeetingRecordsRepository.prototype, "get").mockResolvedValue(meeting);
  getArtifact = vi
    .spyOn(MeetingOutputsRepository.prototype, "getArtifact")
    .mockResolvedValue(artifact());
  snapshot = vi.spyOn(MeetingTranscriptRepository.prototype, "approvalSnapshot").mockResolvedValue({
    ledger: ledger(),
    receipt: { version: 1, transcriptRevision: 1, cursor: 1, stopCutoffMs: null }
  });
});
afterEach(() => vi.restoreAllMocks());

function visible(result: Awaited<ReturnType<RouteApprovalPresentation>>) {
  expect(result).not.toBeNull();
  return JSON.stringify({ target: result!.target, fields: result!.fields });
}
function noInternalIds(result: Awaited<ReturnType<RouteApprovalPresentation>>) {
  const text = visible(result);
  for (const token of [
    id,
    key,
    "internal-source",
    "internal-segment",
    "internal-speaker",
    "artifact-private-id",
    "private-model-route"
  ])
    expect(text).not.toContain(token);
}

describe("Meetings authored action disclosures", () => {
  it("covers exactly all six callable mutations and preserves blocked routes", () => {
    const routes = meetingsModuleManifest.routes;
    const writable = routes.filter((route) => ["write", "destructive"].includes(route.chat.access));
    expect(writable).toHaveLength(6);
    for (const route of writable) {
      expect(route.chat).toHaveProperty("title", expect.any(String));
      expect(route.chat).toHaveProperty("presentation", expect.any(Function));
    }
    expect(
      routes.filter((route) => route.chat.access === "blocked").map((route) => route.path)
    ).toEqual([
      "/api/meetings/records/:id/exports",
      "/api/meetings/records/:id/outputs",
      "/api/meetings/records/:id/actions/:candidateId/review"
    ]);
  });

  it("preserves full titles and notes including empty replacement, without raw tokens", async () => {
    const title = meeting.title;
    const create = await createMeetingPresentation(
      db,
      call({ requestKey: key, title }, false),
      ctx
    );
    expect(create?.target).toBe(title);
    expect(create?.fields).toContainEqual({ label: "Title", value: title });
    noInternalIds(create);
    for (const personalNotes of ["", "Exact\n" + "unabridged ".repeat(3000)]) {
      const body = { requestKey: key, expectedRevision: 3, personalNotes };
      const before = structuredClone(body);
      const result = await meetingNotesPresentation(db, call(body), ctx);
      expect(result?.target).toBe(title);
      expect(result?.fields).toContainEqual({ label: "Personal notes", value: personalNotes });
      expect(body).toEqual(before);
      noInternalIds(result);
    }
    expect(get).toHaveBeenCalledWith(db, id);
  });

  it.each([null, "microphone-only", "selected-app", "computer-audio"])(
    "accepts the existing capture preference %s without adding capture operations",
    async (defaultCaptureMode) => {
      const result = await meetingPreferencesPresentation(
        db,
        call({ defaultCaptureMode }, false),
        ctx
      );
      expect(result?.target).toBe("Meeting capture preferences");
      expect(result?.fields).toHaveLength(1);
    }
  );

  it("reads the actual deletion target instead of trusting caller text", async () => {
    const result = await deleteMeetingPresentation(db, call(), ctx);
    expect(result?.target).toBe(meeting.title);
    expect(result?.fields[0]?.value).toContain("linked Moss chats");
    expect(result?.version).toMatch(/^[a-f0-9]{64}$/);
    noInternalIds(result);
  });

  it("discloses every summary field and resolves exact pinned notes/transcript evidence", async () => {
    const body = summaryBody();
    const before = structuredClone(body);
    const result = await meetingSummaryPresentation(db, call(body), ctx);
    const fields = result!.fields;
    for (const value of [
      body.content.overview,
      "Ship it.",
      "Ship on Friday.",
      "What remains?",
      "Alice",
      "Friday",
      "Attribution is provisional."
    ])
      expect(fields.some((field) => field.value === value)).toBe(true);
    expect(fields.filter((field) => field.label.endsWith("Exact excerpt"))).toEqual([
      { label: "Decision 1 · Evidence 1 · Exact excerpt", value: "Alice will ship Friday" },
      { label: "Suggested action 1 · Evidence 1 · Exact excerpt", value: "Alice will ship Friday" }
    ]);
    expect(fields).toContainEqual({
      label: "Suggested action 1 · Evidence 1 · Passage",
      value: "125–1901 ms: Alice will ship Friday."
    });
    expect(getArtifact).toHaveBeenCalledWith(db, id, 2);
    expect(body).toEqual(before);
    noInternalIds(result);
  });

  it("supports empty lists and explicit null owner/due phrases", async () => {
    const body = summaryBody();
    body.content.decisions = [];
    body.content.openQuestions = [];
    body.content.warnings = [];
    body.content.actions[0]!.ownerPhrase = null;
    body.content.actions[0]!.duePhrase = null;
    const result = await meetingSummaryPresentation(db, call(body), ctx);
    expect(result?.fields).toContainEqual({ label: "Decision", value: "None" });
    expect(result?.fields).toContainEqual({
      label: "Suggested action 1 · Owner phrase",
      value: "Not specified"
    });
  });

  it("shows all transcript metadata and exact untruncated text, preserving the input", async () => {
    const body = transcriptBody();
    body.events[0]!.segment = {
      ...body.events[0]!.segment,
      text: "Long exact text\n" + "content ".repeat(10000)
    };
    const before = structuredClone(body);
    const result = await meetingTranscriptPresentation(db, call(body), ctx);
    expect(result?.fields).toContainEqual({
      label: "Transcript event 1 · Text",
      value: body.events[0]!.segment.text
    });
    expect(result?.fields).toContainEqual({
      label: "Transcript event 1 · Passage",
      value: "Existing passage at 125–1901 ms: Previous exact passage."
    });
    expect(result?.fields).toContainEqual({
      label: "Transcript event 1 · Source",
      value: "Source 1: Exact microphone label"
    });
    expect(result?.fields).toContainEqual({
      label: "Transcript event 1 · Speaker group",
      value: "Meeting-local speaker 1 (identity unverified)"
    });
    expect(snapshot).toHaveBeenCalledWith(db, id);
    expect(body).toEqual(before);
    noInternalIds(result);
  });

  it("keeps first transcript ingestion approvable and repeated new passage identities consistent", async () => {
    snapshot.mockResolvedValue({
      ledger: null,
      receipt: { version: 0, transcriptRevision: 0, cursor: 0, stopCutoffMs: null }
    });
    const body = transcriptBody();
    body.expectedVersion = 0;
    body.events = [
      body.events[0]!,
      { ...body.events[0]!, cursor: 3, segment: { ...body.events[0]!.segment, revision: 3 } }
    ];
    const result = await meetingTranscriptPresentation(db, call(body), ctx);
    expect(
      result?.fields
        .filter((field) => field.label.endsWith(" · Passage"))
        .map((field) => field.value)
    ).toEqual(["New passage 1", "New passage 1"]);
  });

  it("keeps identity/version changes private and invalidates same-label retargeting", async () => {
    const first = await meetingNotesPresentation(
      db,
      call({ requestKey: key, expectedRevision: 3, personalNotes: "Update" }),
      ctx
    );
    get.mockResolvedValue({ ...meeting, id: foreign });
    const second = await meetingNotesPresentation(
      db,
      {
        ...call({ requestKey: key, expectedRevision: 3, personalNotes: "Update" }),
        params: { id: foreign }
      },
      ctx
    );
    expect(second?.fields).toEqual(first?.fields);
    expect(second?.target).toBe(first?.target);
    expect(second?.version).not.toBe(first?.version);
    get.mockResolvedValue(meeting);
    const transcript = await meetingTranscriptPresentation(db, call(transcriptBody()), ctx);
    const changed = ledger();
    snapshot.mockResolvedValue({
      ledger: {
        ...changed,
        revisions: [
          {
            ...changed.revisions[0]!,
            segment: { ...changed.revisions[0]!.segment, speakerId: "changed-private-speaker" }
          }
        ]
      },
      receipt: { version: 1, transcriptRevision: 1, cursor: 1, stopCutoffMs: null }
    });
    expect(
      (await meetingTranscriptPresentation(db, call(transcriptBody()), ctx))?.version
    ).not.toBe(transcript?.version);
  });

  const existing: readonly [string, RouteApprovalPresentation, () => unknown][] = [
    ["delete", deleteMeetingPresentation, () => undefined],
    [
      "notes",
      meetingNotesPresentation,
      () => ({ requestKey: key, expectedRevision: 3, personalNotes: "" })
    ],
    ["summary", meetingSummaryPresentation, summaryBody],
    ["transcript", meetingTranscriptPresentation, transcriptBody]
  ];
  it.each(existing)(
    "fails closed for missing or foreign %s targets",
    async (_name, present, body) => {
      get.mockResolvedValue(null);
      expect(await present(db, call(body()), ctx)).toBeNull();
      expect(await present(db, { ...call(body()), params: { id: foreign } }, ctx)).toBeNull();
    }
  );
  it.each(existing)(
    "rejects unknown %s body, query and path data",
    async (_name, present, body) => {
      expect(await present(db, { ...call(body()), query: { hiddenId: foreign } }, ctx)).toBeNull();
      expect(
        await present(db, { ...call(body()), params: { id, hiddenId: foreign } }, ctx)
      ).toBeNull();
      expect(
        await present(db, call({ ...((body() as object) ?? {}), hiddenId: foreign }), ctx)
      ).toBeNull();
    }
  );

  it("rejects missing fields, malformed request keys and unknown preference values", async () => {
    for (const body of [
      { title: "Draft" },
      { requestKey: key },
      { requestKey: "not-a-token", title: "Draft" },
      { requestKey: key, title: "Draft", unknownId: foreign }
    ])
      expect(await createMeetingPresentation(db, call(body, false), ctx)).toBeNull();
    for (const body of [
      {},
      { defaultCaptureMode: "future-mode" },
      { defaultCaptureMode: null, unknown: true }
    ])
      expect(await meetingPreferencesPresentation(db, call(body, false), ctx)).toBeNull();
    for (const keyToRemove of ["requestKey", "expectedRevision", "personalNotes"]) {
      const body: Record<string, unknown> = {
        requestKey: key,
        expectedRevision: 3,
        personalNotes: ""
      };
      delete body[keyToRemove];
      expect(await meetingNotesPresentation(db, call(body), ctx)).toBeNull();
    }
  });

  it("rejects unknown summary fields at every nested level and foreign/missing evidence", async () => {
    const paths = [
      [],
      ["content"],
      ["content", "decisions", 0],
      ["content", "decisions", 0, "evidence", 0],
      ["content", "actions", 0],
      ["content", "actions", 0, "evidence", 0]
    ];
    for (const path of paths) {
      const body = summaryBody();
      let selected: unknown = body;
      for (const part of path) selected = (selected as Record<string | number, unknown>)[part];
      (selected as Record<string, unknown>).unknownId = foreign;
      expect(await meetingSummaryPresentation(db, call(body), ctx), String(path)).toBeNull();
    }
    for (const patch of [
      { meetingId: foreign },
      { segmentId: "missing-segment" },
      { segmentRevision: 999 },
      { endCharacter: 999 }
    ]) {
      const body = summaryBody();
      Object.assign(body.content.actions[0]!.evidence[0]!, patch);
      expect(await meetingSummaryPresentation(db, call(body), ctx)).toBeNull();
    }
    getArtifact.mockResolvedValue(null);
    expect(await meetingSummaryPresentation(db, call(summaryBody()), ctx)).toBeNull();
    getArtifact.mockResolvedValue({ ...artifact(), meetingId: foreign });
    expect(await meetingSummaryPresentation(db, call(summaryBody()), ctx)).toBeNull();
  });

  it("rejects unknown transcript keys, foreign meeting refs, missing source refs and missing fields", async () => {
    const paths = [[], ["sources", 0], ["events", 0], ["events", 0, "segment"]];
    for (const path of paths) {
      const body = transcriptBody();
      let selected: unknown = body;
      for (const part of path) selected = (selected as Record<string | number, unknown>)[part];
      (selected as Record<string, unknown>).unknownId = foreign;
      expect(await meetingTranscriptPresentation(db, call(body), ctx), String(path)).toBeNull();
    }
    for (const patch of [
      { meetingId: foreign },
      { sourceId: "unavailable-source" },
      { speakerId: { id: "nested" } },
      { finality: "unknown" }
    ]) {
      const body = transcriptBody();
      Object.assign(body.events[0]!.segment, patch);
      expect(await meetingTranscriptPresentation(db, call(body), ctx)).toBeNull();
    }
    for (const keyToRemove of [
      "requestKey",
      "expectedVersion",
      "sources",
      "events",
      "stopCutoffMs"
    ]) {
      const body: Record<string, unknown> = transcriptBody();
      delete body[keyToRemove];
      expect(await meetingTranscriptPresentation(db, call(body), ctx)).toBeNull();
    }
  });

  it("does not turn reader failures into an approvable disclosure", async () => {
    get.mockRejectedValue(new Error("unavailable"));
    await expect(deleteMeetingPresentation(db, call(), ctx)).rejects.toThrow("unavailable");
  });
});
