import { recordingContext, recordingInterpretation } from "../fixtures/meeting-recording.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
import {
  createMeetingOutputRuntime,
  MEETING_OUTPUT_SCHEMA
} from "../../packages/module-registry/src/meeting-output-runtime.js";

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
const response = (value: unknown) =>
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
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  const runtime = createMeetingOutputRuntime({
    resolveActiveModules: modules,
    dataContext: {
      withDataContext: async <T>(_a: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work(db)
    }
  });
  return { ...runtime, fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const segments = Array.from({ length: 30 }, (_, i) => ({
  meetingId: "meeting-id",
  segmentId: `segment-${i}`,
  sourceId: "microphone",
  epoch: 1,
  startMs: i * 1000,
  endMs: i * 1000 + 1000,
  revision: 1,
  text:
    (i === 0 ? "Hello, I am Jamie. " : "") +
    `Segment ${i} covered the launch date and the plan. `.repeat(40),
  finality: "final" as const,
  provenance: "transcription" as const,
  speakerId: i % 2 === 0 ? "S1" : "S2"
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
const request = () => ({
  inputs: {
    meetingId: "meeting-id",
    transcript,
    personalNotes: "",
    recording: recordingContext("meeting-id"),
    notesRevision: 1
  },
  template: getMeetingOutputTemplate("general", 1)!,
  signal: new AbortController().signal
});
const summary = (speakers: unknown[]) => ({
  recording: recordingInterpretation(),
  overview: "{{speaker:S1}} introduced the plan.",
  decisions: [],
  openQuestions: [],
  actions: [],
  warnings: [],
  speakers
});
const jamie = {
  speakerId: "S1",
  name: "Jamie",
  basis: "introduced-in-talk",
  confidence: "high",
  evidence: ["segment-0"]
};

describe("speakers in the summary run", () => {
  it("describes every speaker field in the output schema", () => {
    const speakers = (MEETING_OUTPUT_SCHEMA as { properties: Record<string, any> }).properties
      .speakers;
    expect(speakers.maxItems).toBe(20);
    const props = speakers.items.properties;
    expect(Object.keys(props).sort()).toEqual(
      ["basis", "confidence", "evidence", "name", "speakerId"].sort()
    );
    for (const key of Object.keys(props)) expect(props[key].description).toBeTruthy();
    expect(speakers.items.required).toContain("name");
  });

  it("keeps a name from piece one when a later piece drops it", async () => {
    const h = setup();
    let calls = 0;
    h.fetch.mockImplementation(async () => {
      calls += 1;
      return response(summary(calls === 1 ? [jamie] : []));
    });
    const generated = await h.generator(actor, request());
    expect(calls).toBeGreaterThan(1);
    expect(generated.content.speakers).toEqual([jamie]);
  });

  it("stores the speaker guess and the token as the model wrote them", async () => {
    const h = setup();
    h.fetch.mockImplementation(async () => response(summary([jamie])));
    const generated = await h.generator(actor, request());
    expect(generated.content.overview).toContain("{{speaker:S1}}");
    expect(generated.content.speakers?.[0]?.name).toBe("Jamie");
  });

  it("drops an invented name without failing the run", async () => {
    const h = setup();
    h.fetch.mockImplementation(async () => response(summary([{ ...jamie, name: "Zed" }])));
    const generated = await h.generator(actor, request());
    expect(generated.content.speakers).toEqual([]);
    expect(generated.content.warnings).toContain(
      "Some speaker names could not be checked and were left out."
    );
  });

  it("names no provider or model in the speaker code", () => {
    const source = readFileSync("packages/meetings/src/output-validation.ts", "utf8");
    expect(source).not.toMatch(/gpt|claude|anthropic|openai|gemini/i);
  });
});
