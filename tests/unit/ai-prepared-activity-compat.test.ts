import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAiSecretCipher,
  installModelActivityRecorder,
  prepareStructuredApiGeneration,
  prepareTextApiGeneration,
  type AiProviderWithSealedCredential
} from "@moss/ai";
import { makeRecordingDb } from "./helpers/recording-db.js";

const owner = "12345678-1234-4234-9234-123456789abc";
const otherOwner = "98765432-1234-4234-9234-123456789abc";
const cipher = createAiSecretCipher();
const provider = {
  auth_method: "api_key",
  base_url: "https://synthetic.invalid",
  encrypted_credential: cipher.encryptJson({ apiKey: "synthetic-key-only" })
} as AiProviderWithSealedCredential;
const model = {
  id: "model",
  provider_config_id: "provider",
  provider_kind: "openai-compatible",
  provider_model_id: "selected-meeting-model"
};
const PRIVATE_PROMPT = "PRIVATE_SYNTHETIC_MEETING_TRANSCRIPT";
const PRIVATE_ANSWER = "PRIVATE_SYNTHETIC_MEETING_ANSWER";
const deps = { cipher, repository: { selectProviderWithCredential: async () => provider } };

afterEach(() => {
  installModelActivityRecorder(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepared meeting activity across the activity-history integration", () => {
  it.each(["summary", "chat"] as const)(
    "records owned %s metadata without keeping evidence or answers",
    async (kind) => {
      const { scoped, queries } = makeRecordingDb({ rows: [{ actor: owner }] });
      const recorder = vi.fn();
      installModelActivityRecorder(recorder);
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      kind === "summary"
                        ? JSON.stringify({ overview: PRIVATE_ANSWER })
                        : PRIVATE_ANSWER
                  }
                }
              ],
              usage: { prompt_tokens: 7, completion_tokens: 4 }
            })
          )
      );
      vi.stubGlobal("fetch", fetch);
      const untrusted = {
        ownerUserId: otherOwner,
        actorUserId: otherOwner,
        detail: { quote: PRIVATE_PROMPT }
      };
      const run =
        kind === "summary"
          ? await prepareStructuredApiGeneration(
              scoped,
              {
                ...untrusted,
                service: "module.meetings",
                explicitModel: model,
                prompt: PRIVATE_PROMPT,
                schema: {
                  type: "object",
                  properties: { overview: { type: "string" } },
                  required: ["overview"],
                  additionalProperties: false
                }
              },
              deps
            )
          : await prepareTextApiGeneration(
              scoped,
              {
                ...untrusted,
                model,
                messages: [{ role: "user", content: PRIVATE_PROMPT }],
                maxOutputTokens: 512,
                actionCode: "chat.answer"
              },
              deps
            );
      const readsBeforeRun = queries.length;
      expect(fetch).not.toHaveBeenCalled();
      expect(recorder).not.toHaveBeenCalled();
      expect(await run()).toMatchObject({ ok: true });
      expect(await run()).toEqual({ ok: false, error: "provider_error" });
      expect(queries).toHaveLength(readsBeforeRun);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(recorder).toHaveBeenCalledTimes(1);
      expect(recorder.mock.calls[0]?.[0]).toMatchObject({
        ownerUserId: owner,
        actionCode: kind === "summary" ? "structured.meetings" : "chat.answer",
        modelName: model.provider_model_id,
        outcome: "ok",
        result: "completed"
      });
      expect(readsBeforeRun).toBeGreaterThan(0);
      expect(recorder.mock.calls[0]?.[0]).not.toHaveProperty("detail");
      const logged = JSON.stringify(recorder.mock.calls);
      expect(logged).not.toContain(PRIVATE_PROMPT);
      expect(logged).not.toContain(PRIVATE_ANSWER);
      expect(logged).not.toContain(otherOwner);
      const sent = String((fetch.mock.calls as unknown as [string, RequestInit][])[0]?.[1].body);
      expect(sent).not.toContain(owner);
      expect(sent).not.toContain("actionCode");
    }
  );
});
