import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { AiRepository, createAiSecretCipher, type AiConfiguredModelSafeRow } from "@moss/ai";
import type { AiProviderWithSealedCredential } from "@moss/ai";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { CalendarRepository } from "@moss/calendar";
import {
  getMeetingOutputTemplate,
  meetingsModuleManifest,
  renderMeetingExport,
  validateMeetingOutput
} from "@moss/meetings";
import * as meetings from "@moss/meetings";
import type { Kysely } from "kysely";
import { createMeetingOutputRuntime } from "../../packages/module-registry/src/meeting-output-runtime.js";
import { createOwnerContextSources } from "../../packages/module-registry/src/owner-context-sources.js";
import { recordingContext, recordingInterpretation } from "../fixtures/meeting-recording.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file.
// Real reads for calendar, people and the owner's name. Only the model is stubbed.

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

describe("summary stores speaker guesses and exports them as guesses", () => {
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  const as = (actorUserId: string) => ({ actorUserId, requestId: `4020-${randomUUID()}` });

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(appDb);
  });
  afterAll(async () => {
    await appDb.destroy();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a calendar-only name as a low guess, stores tokens, and exports it as a guess", async () => {
    const cipher = createConnectorSecretCipher();
    const scopes = ["https://www.googleapis.com/auth/calendar"];
    const acct = (
      await runner.withDataContext(as(ids.userA), (db) =>
        new ConnectorsRepository().upsertGoogleAccount(db, {
          scopes,
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "c",
            clientSecret: "s",
            accessToken: "a",
            refreshToken: "r",
            tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
            grantedScopes: scopes
          })
        })
      )
    ).id;
    await runner.withDataContext(as(ids.userA), (db) =>
      new CalendarRepository().upsertCachedEvent(db, {
        connectorAccountId: acct,
        externalId: `launch-${randomUUID()}`,
        title: "Launch review",
        startsAt: new Date("2026-11-06T10:00:00Z"),
        endsAt: new Date("2026-11-06T10:30:00Z"),
        externalMetadata: { attendeeNames: ["Cara Dunn"] }
      })
    );

    vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(model);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue(provider);
    vi.spyOn(meetings, "readMeetingCaptureCompleteness").mockResolvedValue({
      hasGaps: false,
      gapLimitReached: false
    });
    const reply = {
      recording: recordingInterpretation(),
      overview: "{{speaker:S1}} proposed the plan and {{speaker:S2}} agreed.",
      decisions: [],
      openQuestions: [],
      actions: [],
      warnings: [],
      speakers: [
        {
          speakerId: "S1",
          name: "Cara Dunn",
          basis: "calendar",
          confidence: "high",
          evidence: ["s2"]
        },
        {
          speakerId: "S2",
          name: "Invented Person",
          basis: "inference",
          confidence: "low",
          evidence: ["s2"]
        }
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
            { headers: { "content-type": "application/json" } }
          )
      )
    );
    const runtime = createMeetingOutputRuntime({
      resolveActiveModules: async () => [meetingsModuleManifest],
      ownerContextSources: createOwnerContextSources(),
      dataContext: runner
    });
    const recording = recordingContext("meeting-id");
    const segment = (id: string, speakerId: string, text: string) => ({
      meetingId: "meeting-id",
      segmentId: id,
      sourceId: "microphone",
      epoch: 1,
      startMs: 0,
      endMs: 1000,
      revision: 1,
      text,
      finality: "final" as const,
      provenance: "transcription" as const,
      speakerId
    });
    const inputs = {
      meetingId: "meeting-id",
      recording: {
        ...recording,
        metadata: { ...recording.metadata, recordedAt: "2026-11-06T10:05:00Z" }
      },
      transcript: {
        meetingId: "meeting-id",
        ownerUserId: ids.userA,
        transcriptRevision: 1,
        cutoffMs: 1000,
        maxSegments: 10,
        maxCharacters: 10000,
        cursor: 2,
        throughMs: 1000,
        omittedSegments: 0,
        containsProvisional: false,
        segments: [
          segment("s1", "S1", "Let us ship the launch plan."),
          segment("s2", "S2", "Fine by me.")
        ]
      },
      personalNotes: "",
      notesRevision: 1
    };
    const generated = await runtime.generator(as(ids.userA), {
      inputs,
      template: getMeetingOutputTemplate("general", 1)!,
      signal: new AbortController().signal
    });
    // The service re-validates with the names the run learned from the owner's context.
    const stored = validateMeetingOutput(generated.content, inputs, {
      knownNames: generated.context?.knownNames ?? []
    });

    expect(stored.overview).toContain("{{speaker:S1}}");
    expect(stored.speakers).toEqual([
      {
        speakerId: "S1",
        name: "Cara Dunn",
        basis: "calendar",
        confidence: "low",
        evidence: ["s2"]
      }
    ]);
    expect(stored.warnings).toContain("Some speaker names could not be checked and were left out.");
    const exported = renderMeetingExport({
      id: "a",
      meetingId: "meeting-id",
      version: 1,
      inputs,
      templateId: "general",
      templateVersion: 1,
      modelRoute: "r",
      content: stored,
      origin: "generated",
      stale: false,
      createdAt: "2026-11-07T00:00:00.000Z"
    });
    expect(exported).toContain("Cara Dunn \\(guess\\) proposed the plan");
    expect(exported).toContain("Speaker 2 agreed");
    expect(exported).not.toContain("{{speaker");
    expect(exported).not.toContain("Invented Person");
  });
});
