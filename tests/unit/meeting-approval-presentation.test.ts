import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
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
  meetingTitlePresentation,
  meetingTranscriptPresentation
} from "../../packages/meetings/src/action-presentations.js";
import { meetingsModuleManifest } from "../../packages/meetings/src/manifest.js";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingOutputsRepository } from "../../packages/meetings/src/output-repository.js";
import {
  MeetingPreferencesRepository,
  MEETING_CAPTURE_DEFAULT_KEY,
  MEETING_CAPTURE_SOURCE_KEY
} from "../../packages/meetings/src/preferences.js";
import {
  MeetingCaptureConnectionRepository,
  type CaptureConnection
} from "../../packages/meetings/src/capture-connection-repository.js";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";

const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
const db = { [dataContextBrand]: true, db: {} } as unknown as DataContextDb;
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
const preferenceState = {
  defaultCaptureMode: "computer-audio" as const,
  rememberedSource: null,
  summarizeOnStop: true,
  summaryTemplateId: "general" as const
};
const recorder = (): CaptureConnection => ({
  owner_user_id: "owner",
  device_id: foreign,
  connection_id: key,
  device_name: "Office Mac",
  verifier_hash: "never disclose this recorder credential",
  capability_revision: 1,
  revision: 2,
  inventory_json: JSON.stringify({
    microphones: [
      { deviceId: "internal-mic", sourceId: "internal-source", label: "Studio microphone" }
    ],
    applications: [
      { applicationId: "internal-app", appProcessTreeId: "internal-process", label: "Meeting app" }
    ],
    computerAudio: { available: true, excludedProcessTreeIds: ["internal-self"] },
    microphonePermission: "granted",
    systemAudioPermission: "granted"
  }),
  last_seen_at: new Date("2026-10-08T01:00:00Z"),
  expires_at: new Date("2030-01-01T00:00:00Z")
});
let connection: MockInstance<MeetingCaptureConnectionRepository["connection"]>;
let persistedDefault: MockInstance<MeetingPreferencesRepository["getPersistedDefaultCaptureMode"]>;
let readPreferences: MockInstance<MeetingPreferencesRepository["get"]>;
let get: MockInstance<MeetingRecordsRepository["get"]>;
let getArtifact: MockInstance<MeetingOutputsRepository["getArtifact"]>;
let snapshot: MockInstance<MeetingTranscriptRepository["approvalSnapshot"]>;
beforeEach(() => {
  persistedDefault = vi
    .spyOn(MeetingPreferencesRepository.prototype, "getPersistedDefaultCaptureMode")
    .mockResolvedValue(null);
  connection = vi
    .spyOn(MeetingCaptureConnectionRepository.prototype, "connection")
    .mockResolvedValue(recorder());
  readPreferences = vi
    .spyOn(MeetingPreferencesRepository.prototype, "get")
    .mockResolvedValue(preferenceState);
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
  it("covers all seven callable mutations and preserves blocked routes", () => {
    const routes = meetingsModuleManifest.routes;
    const writable = routes.filter((route) => ["write", "destructive"].includes(route.chat.access));
    expect(writable).toHaveLength(7);
    for (const route of writable) {
      expect(route.chat).toHaveProperty("title", expect.any(String));
      expect(route.chat).toHaveProperty("presentation", expect.any(Function));
    }
    expect(
      routes.filter((route) => route.chat.access === "blocked").map((route) => route.path)
    ).toEqual([
      "/api/meetings/capture/connection",
      "/api/meetings/capture/commands",
      "/api/meetings/capture/claim",
      "/api/meetings/capture/devices",
      "/api/meetings/records/:id/capture/cancel-start",
      "/api/meetings/capture/status",
      "/api/meetings/capture/control",
      "/api/meetings/capture/audio",
      "/api/meetings/records/:id/capture",
      "/api/meetings/records/:id/capture/start",
      "/api/meetings/records/:id/capture/control",
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

  it("discloses the exact rename and revalidates the owner-scoped title", async () => {
    const body = { title: "Renamed planning", expectedTitle: meeting.title };
    const before = await meetingTitlePresentation(db, call(body), ctx);
    expect(before).toMatchObject({
      target: meeting.title,
      fields: [
        { label: "New title", value: body.title },
        { label: "Current title", value: meeting.title }
      ]
    });
    noInternalIds(before);
    get.mockResolvedValue({ ...meeting, title: "Changed elsewhere" });
    const after = await meetingTitlePresentation(db, call(body), ctx);
    expect(after?.version).not.toBe(before?.version);
    expect(after?.target).toBe("Changed elsewhere");
    for (const invalid of [
      { title: "x" },
      { expectedTitle: "x" },
      { title: " ", expectedTitle: "x" },
      { title: "x".repeat(241), expectedTitle: "x" },
      { title: "é".repeat(121), expectedTitle: "x" },
      { title: "x", expectedTitle: "é".repeat(121) },
      { title: "x\0", expectedTitle: "x" },
      { title: "x", expectedTitle: 1 }
    ])
      expect(await meetingTitlePresentation(db, call(invalid), ctx)).toBeNull();
  });

  it.each([true, false])(
    "discloses automatic Stop summary preference %s",
    async (summarizeOnStop) => {
      expect(
        await meetingPreferencesPresentation(db, call({ summarizeOnStop }, false), ctx)
      ).toMatchObject({
        fields: [
          { label: "Summarize automatically after Stop", value: summarizeOnStop ? "Yes" : "No" }
        ]
      });
    }
  );
  it.each([
    ["general", "General meeting"],
    ["one-to-one", "One-to-one"],
    ["project-review", "Project review"],
    ["interview", "Interview"]
  ])("names summary style %s", async (summaryTemplateId, value) => {
    expect(
      await meetingPreferencesPresentation(db, call({ summaryTemplateId }, false), ctx)
    ).toMatchObject({ fields: [{ label: "Summary style", value }] });
  });
  it("names the effective reset default and pins preference changes", async () => {
    const body = { defaultCaptureMode: null };
    const before = await meetingPreferencesPresentation(db, call(body, false), ctx);
    expect(before?.fields).toEqual([
      { label: "Default capture source", value: "Computer audio and microphone" }
    ]);
    readPreferences.mockResolvedValue({
      ...preferenceState,
      rememberedSource: { deviceId: foreign, microphoneId: "internal-mic", mode: "microphone-only" }
    });
    const after = await meetingPreferencesPresentation(db, call(body, false), ctx);
    expect(after?.fields).toEqual([{ label: "Default capture source", value: "Microphone only" }]);
    expect(after?.version).not.toBe(before?.version);
  });
  const rememberedSource = {
    deviceId: foreign,
    microphoneId: "internal-mic",
    mode: "selected-app",
    applicationId: "internal-app"
  };
  it("resolves every saved recorder reference to readable owner-scoped names", async () => {
    const result = await meetingPreferencesPresentation(
      db,
      call({ rememberedSource, summarizeOnStop: false, summaryTemplateId: "interview" }, false),
      ctx
    );
    expect(result?.fields).toEqual(
      expect.arrayContaining([
        { label: "Recording Mac", value: "Office Mac" },
        { label: "Microphone", value: "Studio microphone" },
        { label: "Application", value: "Meeting app" },
        { label: "Remembered audio source", value: "Selected app and microphone" }
      ])
    );
    expect(connection).toHaveBeenCalledWith(db, foreign);
    for (const token of [
      foreign,
      key,
      "internal-mic",
      "internal-app",
      "internal-process",
      "never disclose"
    ])
      expect(visible(result)).not.toContain(token);
    connection.mockResolvedValue({ ...recorder(), revision: 3 });
    expect(
      (
        await meetingPreferencesPresentation(
          db,
          call({ rememberedSource, summarizeOnStop: false, summaryTemplateId: "interview" }, false),
          ctx
        )
      )?.version
    ).not.toBe(result?.version);
  });
  it("discloses clearing remembered sources without a device lookup", async () => {
    const result = await meetingPreferencesPresentation(
      db,
      call({ rememberedSource: null }, false),
      ctx
    );
    expect(visible(result)).toContain("Clear the saved Mac, microphone and application");
    expect(connection).not.toHaveBeenCalled();
  });
  it.each([
    [{ summarizeOnStop: false }, "Turn off automatic summaries"],
    [{ summarizeOnStop: true }, "Turn on automatic summaries"],
    [{ summaryTemplateId: "interview" }, "Change the summary style"],
    [{ rememberedSource: null }, "Clear the saved recording source"],
    [{ defaultCaptureMode: "microphone-only" }, "Change the default recording audio"],
    [
      { summarizeOnStop: false, summaryTemplateId: "interview", rememberedSource: null },
      "Clear the saved recording source; Turn off automatic summaries; Change the summary style"
    ]
  ])("titles this exact preference change %j", async (body, title) => {
    expect(await meetingPreferencesPresentation(db, call(body, false), ctx)).toMatchObject({
      title
    });
  });
  it("discloses source clearing widening from an inherited microphone-only mode", async () => {
    readPreferences.mockResolvedValue({
      ...preferenceState,
      defaultCaptureMode: "microphone-only",
      rememberedSource: { deviceId: foreign, microphoneId: "internal-mic", mode: "microphone-only" }
    });
    const result = await meetingPreferencesPresentation(
      db,
      call({ rememberedSource: null }, false),
      ctx
    );
    expect(result?.fields).toContainEqual({
      label: "Next recording audio",
      value: "Computer audio and microphone"
    });
    persistedDefault.mockResolvedValue("microphone-only");
    const savedDefault = await meetingPreferencesPresentation(
      db,
      call({ rememberedSource: null }, false),
      ctx
    );
    expect(savedDefault?.fields).toContainEqual({
      label: "Next recording audio",
      value: "Microphone only"
    });
    expect(savedDefault?.version).not.toBe(result?.version);
  });
  it.each([
    [null, "computer-audio", "Computer audio and microphone"],
    ["microphone-only", "microphone-only", "Microphone only"]
  ] as const)(
    "matches the next persisted read after source clearing with saved default %s",
    async (savedMode, nextMode, nextLabel) => {
      readPreferences.mockRestore();
      persistedDefault.mockRestore();
      const stored = new Map<string, unknown>([
        [
          MEETING_CAPTURE_SOURCE_KEY,
          { deviceId: foreign, microphoneId: "internal-mic", mode: "microphone-only" }
        ],
        [MEETING_CAPTURE_DEFAULT_KEY, savedMode]
      ]);
      vi.spyOn(PreferencesRepository.prototype, "get").mockImplementation(
        async (_db, key) => stored.get(key) ?? null
      );
      const write = vi
        .spyOn(PreferencesRepository.prototype, "upsert")
        .mockImplementation(async (_db, key, value) => {
          stored.set(key, value);
        });
      const repository = new MeetingPreferencesRepository();
      expect((await repository.get(db)).defaultCaptureMode).toBe("microphone-only");
      const card = await meetingPreferencesPresentation(
        db,
        call({ rememberedSource: null }, false),
        ctx
      );
      expect(card?.fields).toContainEqual({ label: "Next recording audio", value: nextLabel });
      expect(write).not.toHaveBeenCalled();
      await repository.update(db, { rememberedSource: null });
      expect(write).toHaveBeenCalledExactlyOnceWith(db, MEETING_CAPTURE_SOURCE_KEY, null);
      expect((await repository.get(db)).defaultCaptureMode).toBe(nextMode);
      expect(await repository.getPersistedDefaultCaptureMode(db)).toBe(savedMode);
    }
  );
  it("discloses explicit source/default combinations and unavailable selected-app recovery", async () => {
    for (const [defaultCaptureMode, value] of [
      [null, "Computer audio and microphone"],
      ["microphone-only", "Microphone only"]
    ] as const) {
      const result = await meetingPreferencesPresentation(
        db,
        call({ rememberedSource: null, defaultCaptureMode }, false),
        ctx
      );
      expect(result?.fields).toContainEqual({ label: "Next recording audio", value });
    }
    persistedDefault.mockResolvedValue("selected-app");
    expect(
      (await meetingPreferencesPresentation(db, call({ rememberedSource: null }, false), ctx))
        ?.fields
    ).toContainEqual({
      label: "Next recording audio",
      value: "Selected app and microphone; choose an application before recording"
    });
  });
  it("accepts exactly 240 UTF-8 title bytes", async () => {
    expect(
      await meetingTitlePresentation(db, call({ title: "é".repeat(120), expectedTitle: "x" }), ctx)
    ).not.toBeNull();
  });
  it("refuses missing, foreign, ambiguous or malformed recorder references", async () => {
    const input = call({ rememberedSource }, false);
    connection.mockResolvedValue(null);
    expect(await meetingPreferencesPresentation(db, input, ctx)).toBeNull();
    connection.mockResolvedValue({ ...recorder(), device_id: id });
    expect(await meetingPreferencesPresentation(db, input, ctx)).toBeNull();
    connection.mockResolvedValue({ ...recorder(), owner_user_id: "someone-else" });
    expect(await meetingPreferencesPresentation(db, input, ctx)).toBeNull();
    connection.mockResolvedValue({ ...recorder(), expires_at: new Date("2000-01-01T00:00:00Z") });
    expect(await meetingPreferencesPresentation(db, input, ctx)).toBeNull();
    connection.mockResolvedValue({ ...recorder(), inventory_json: "not JSON" });
    expect(await meetingPreferencesPresentation(db, input, ctx)).toBeNull();
    for (const property of ["microphones", "applications"]) {
      const record = recorder();
      const inventory = JSON.parse(record.inventory_json);
      inventory[property].push(inventory[property][0]);
      connection.mockResolvedValue({ ...record, inventory_json: JSON.stringify(inventory) });
      expect(await meetingPreferencesPresentation(db, input, ctx)).toBeNull();
    }
    connection.mockResolvedValue(recorder());
    for (const patch of [
      { microphoneId: "missing" },
      { applicationId: "missing" },
      { applicationId: undefined },
      { unknown: true },
      { deviceId: "invalid" }
    ])
      expect(
        await meetingPreferencesPresentation(
          db,
          call({ rememberedSource: { ...rememberedSource, ...patch } }, false),
          ctx
        )
      ).toBeNull();
    for (const body of [
      { summarizeOnStop: "yes" },
      { summaryTemplateId: "unknown" },
      { rememberedSource: [] }
    ])
      expect(await meetingPreferencesPresentation(db, call(body, false), ctx)).toBeNull();
    expect(
      await meetingPreferencesPresentation(db, { ...input, query: { hidden: "value" } }, ctx)
    ).toBeNull();
    expect(await meetingPreferencesPresentation(db, { ...input, params: { id } }, ctx)).toBeNull();
  });

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
    [
      "title",
      meetingTitlePresentation,
      () => ({ title: "New title", expectedTitle: meeting.title })
    ],
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
