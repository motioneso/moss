import { recordingContext, recordingInterpretation } from "../fixtures/meeting-recording.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type AccessContext, type DataContextDb } from "@moss/db";
import {
  AiRepository,
  createAiSecretCipher,
  type ActiveModulesResolver,
  type AiConfiguredModelSafeRow,
  type AiProviderWithSealedCredential
} from "@moss/ai";
import { getMeetingOutputTemplate, meetingsModuleManifest } from "@moss/meetings";
import * as meetings from "@moss/meetings";
import { tasksModuleManifest } from "@moss/tasks";
import type { MeetingTranscriptSnapshot } from "@moss/shared";
import { createMeetingOutputRuntime } from "../../packages/module-registry/src/meeting-output-runtime.js";

const db = { [dataContextBrand]: true } as DataContextDb;
const actor = { actorUserId: "owner", requestId: "synthetic" };
const model = {
  id: "model-id",
  provider_config_id: "provider-id",
  provider_kind: "openai-compatible",
  provider_model_id: "selected-summary-model",
  provider_auth_method: "api_key",
  provider_status: "active",
  provider_purpose: "assistant",
  status: "active",
  capabilities: ["chat", "summarization", "json"],
  updated_at: new Date("2026-01-01")
} as AiConfiguredModelSafeRow;
const provider = {
  id: "provider-id",
  provider_kind: "openai-compatible",
  base_url: "https://synthetic.invalid",
  status: "active",
  auth_method: "api_key",
  purpose: "assistant",
  revoked_at: null,
  has_credential: true,
  updated_at: new Date("2026-01-01"),
  encrypted_credential: createAiSecretCipher().encryptJson({ apiKey: "synthetic-not-real-key" })
} as AiProviderWithSealedCredential;
const content = {
  recording: recordingInterpretation(),
  overview: "A synthetic meeting",
  decisions: [],
  openQuestions: [],
  actions: [],
  warnings: []
};
const response = (value: unknown = content) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    headers: { "content-type": "application/json" }
  });

function setup() {
  vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(model);
  vi.spyOn(meetings, "readMeetingCaptureCompleteness").mockResolvedValue({
    hasGaps: false,
    gapLimitReached: false
  });
  vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue(provider);
  const modules = vi
    .fn<ActiveModulesResolver>()
    .mockResolvedValue([meetingsModuleManifest, tasksModuleManifest]);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  vi.stubGlobal("fetch", fetch);
  const runtime = createMeetingOutputRuntime({
    resolveActiveModules: modules,
    dataContext: {
      withDataContext: async <T>(_actor: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work(db)
    }
  });
  return { ...runtime, fetch };
}

const baseInput = () => ({
  inputs: {
    meetingId: "meeting-id",
    recording: recordingContext("meeting-id"),
    transcript: null,
    personalNotes: "",
    notesRevision: 1
  },
  template: getMeetingOutputTemplate("general", 1)!,
  signal: new AbortController().signal
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("long meeting summaries in pieces", () => {
  it("folds a long transcript piece by piece and keeps early evidence citable", async () => {
    const h = setup();
    const segments = Array.from({ length: 30 }, (_, index) => ({
      meetingId: "meeting-id",
      segmentId: `segment-${index}`,
      sourceId: "microphone",
      epoch: 1,
      startMs: index * 1000,
      endMs: index * 1000 + 1000,
      revision: 1,
      text: `Segment ${index} decided the launch date and Alex will send the plan. `.repeat(40),
      finality: "final" as const,
      provenance: "transcription" as const,
      speakerId: null
    }));
    const transcript: MeetingTranscriptSnapshot = {
      meetingId: "meeting-id",
      ownerUserId: "owner",
      transcriptRevision: 1,
      cutoffMs: 30000,
      maxSegments: 500,
      maxCharacters: 100000,
      cursor: 30,
      throughMs: 30000,
      omittedSegments: 0,
      containsProvisional: false,
      segments
    };
    const request = baseInput();
    const longRequest = { ...request, inputs: { ...request.inputs, transcript } };
    let calls = 0;
    h.fetch.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return response(content);
      // Later pieces cite a segment from the first piece. This only checks when
      // validation runs against all evidence seen so far.
      return response({
        ...content,
        decisions: [
          {
            text: "Launch date decided",
            evidence: [
              {
                kind: "transcript",
                meetingId: "meeting-id",
                segmentId: "segment-0",
                segmentRevision: 1,
                startCharacter: 0,
                endCharacter: 20
              }
            ]
          }
        ]
      });
    });
    const generated = await h.generator(actor, longRequest);
    expect(calls).toBeGreaterThan(1);
    expect(generated.content).toMatchObject({ decisions: [{ text: "Launch date decided" }] });
  });

  it("does not shift an older notes citation again in a later piece", async () => {
    const h = setup();
    const request = baseInput();
    request.inputs.personalNotes = "Alpha decision words for the summary record. ".repeat(2800);
    const cited = {
      ...content,
      decisions: [
        {
          text: "Alpha decided",
          evidence: [
            {
              kind: "personal-note",
              meetingId: "meeting-id",
              notesRevision: 1,
              startCharacter: 0,
              endCharacter: 5
            }
          ]
        }
      ]
    };
    // Every piece returns the running citation. Later pieces must keep its
    // full-notes offsets instead of shifting it by their own slice start.
    h.fetch.mockImplementation(async () => response(cited));
    const generated = await h.generator(actor, request);
    const decisions = (
      generated.content as {
        decisions: { evidence: { startCharacter: number; endCharacter: number }[] }[];
      }
    ).decisions;
    expect(decisions[0]!.evidence[0]).toMatchObject({ startCharacter: 0, endCharacter: 5 });
  });

  it("retries only the failed piece and never resends a finished piece", async () => {
    const h = setup();
    const request = baseInput();
    request.inputs.personalNotes = "Note words for the summary. ".repeat(2800);
    const bodies: string[] = [];
    let calls = 0;
    h.fetch.mockImplementation(async (_url, init) => {
      calls += 1;
      bodies.push(String(init?.body ?? ""));
      // The second call is the first attempt at piece two. Return a bad shape once.
      if (calls === 2) return response({ unexpected: true });
      return response(content);
    });
    const generated = await h.generator(actor, request);
    expect(generated.content).toMatchObject({ overview: "A synthetic meeting" });
    expect(calls).toBeGreaterThan(2);
    // Exactly one prompt was sent twice, the retry of the failed piece.
    expect(bodies[1]).toBe(bodies[2]);
    expect(new Set(bodies).size).toBe(bodies.length - 1);
  });
});
