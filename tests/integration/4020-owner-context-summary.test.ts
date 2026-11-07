import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { AiRepository, createAiSecretCipher, type AiConfiguredModelSafeRow } from "@moss/ai";
import type { AiProviderWithSealedCredential } from "@moss/ai";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { CalendarRepository } from "@moss/calendar";
import { PeopleRepository } from "@moss/people";
import { getMeetingOutputTemplate, meetingsModuleManifest } from "@moss/meetings";
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

describe("summary prompt carries the owner's own context", () => {
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

  it("includes the owner's event and people, and nothing of a second user", async () => {
    const cipher = createConnectorSecretCipher();
    const scopes = ["https://www.googleapis.com/auth/calendar"];
    const account = async (owner: string) =>
      (
        await runner.withDataContext(as(owner), (db) =>
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
    const event = (owner: string, acct: string, title: string, names: string[]) =>
      runner.withDataContext(as(owner), (db) =>
        new CalendarRepository().upsertCachedEvent(db, {
          connectorAccountId: acct,
          externalId: `${title}-${randomUUID()}`,
          title,
          startsAt: new Date("2026-11-06T10:00:00Z"),
          endsAt: new Date("2026-11-06T10:30:00Z"),
          externalMetadata: { attendeeNames: names }
        })
      );
    await event(ids.userA, await account(ids.userA), "Launch review", ["Cara Dunn"]);
    await event(ids.userB, await account(ids.userB), "Secret board", ["Bea Private"]);
    const people = new PeopleRepository();
    await runner.withDataContext(as(ids.userA), (db) =>
      people.upsertPersonProjection(db, {
        personId: randomUUID(),
        ownerUserId: ids.userA,
        displayName: "Cara Dunn",
        relationshipSummary: "Head of design"
      })
    );
    await runner.withDataContext(as(ids.userB), (db) =>
      people.upsertPersonProjection(db, {
        personId: randomUUID(),
        ownerUserId: ids.userB,
        displayName: "Bea Private",
        relationshipSummary: "Hidden role of user B"
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
      overview: "ok",
      decisions: [],
      openQuestions: [],
      actions: [],
      warnings: []
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
          {
            headers: { "content-type": "application/json" }
          }
        )
    );
    vi.stubGlobal("fetch", fetch);

    const runtime = createMeetingOutputRuntime({
      resolveActiveModules: async () => [meetingsModuleManifest],
      ownerContextSources: createOwnerContextSources(),
      dataContext: runner
    });
    const recording = recordingContext("meeting-id");
    await runtime.generator(as(ids.userA), {
      inputs: {
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
          cursor: 1,
          throughMs: 1000,
          omittedSegments: 0,
          containsProvisional: false,
          segments: [
            {
              meetingId: "meeting-id",
              segmentId: "s1",
              sourceId: "microphone",
              epoch: 1,
              startMs: 0,
              endMs: 1000,
              revision: 1,
              text: "We asked Cara Dunn and Bea Private about the launch.",
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          ]
        },
        personalNotes: "",
        notesRevision: 1
      },
      template: getMeetingOutputTemplate("general", 1)!,
      signal: new AbortController().signal
    });

    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as {
      messages: { content: string }[];
    };
    const prompt = body.messages.map((m) => m.content).join("\n");
    const block = prompt.slice(prompt.indexOf("ownerContext (escaped JSON):\n")).split("\n")[1]!;
    expect(block).toContain("Launch review");
    expect(block).toContain("Head of design");
    expect(block).not.toContain("Secret board");
    expect(block).not.toContain("Hidden role of user B");
  });
});
