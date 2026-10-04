import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveMossEnv } from "@moss/db";
import { HttpError, handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import { parsePositiveIntEnv, transcribeAudioRouteSchema } from "@moss/shared";

import { HttpApiAdapter } from "./adapters/http-api.js";
import type { ProviderKind } from "./adapters/transcript-reader.js";
import { parseAiApiKeyCredential } from "./credentials.js";
import type { AiSecretCipher } from "./crypto.js";
import type { AiRepository } from "./repository.js";
import type { AiRoutesDependencies } from "./routes.js";

// Env-configurable so operators can raise/lower without a code change. Defaults mirror a
// common Whisper-API-compatible server cap (~25MB) and a generous but bounded call timeout —
// the spec calls for no arbitrary duration cap in the UI, with clear errors from normal
// server/proxy limits instead of a silent hang or truncation.
const MAX_AUDIO_BYTES = parsePositiveIntEnv(
  resolveMossEnv(process.env, "JARVIS_TRANSCRIPTION_MAX_BYTES"),
  25 * 1024 * 1024
);
const TIMEOUT_MS = parsePositiveIntEnv(
  resolveMossEnv(process.env, "JARVIS_TRANSCRIPTION_TIMEOUT_MS"),
  30000
);

const AUDIO_CONTENT_TYPE = /^audio\//;

/**
 * POST /api/ai/transcriptions — transient audio upload + transcription.
 *
 * The request body is a raw audio/* upload (no multipart wrapper needed: exactly one blob,
 * no other fields). Model resolution goes through `selectModelForCapability(scopedDb,
 * "transcription")`, which (via `resolveModelForCapability`) applies the #874 routing rules:
 *   - HIGH-3: an admin per-user pin WINS. A pinned user's transcription is attempted INSIDE the
 *     pinned provider only; a miss returns no model (mic unavailable) — it never escapes to the
 *     instance voice endpoint.
 *   - CRIT-1 / HIGH-2: an un-pinned user resolves via the dedicated `purpose='voice'` endpoint
 *     (a single instance-wide OpenAI-compatible STT provider), never via cross-provider worker
 *     routing and never via a service binding.
 * No model resolved -> 422 (pin-blocked, or no voice endpoint configured). The decoded audio
 * buffer lives only in this function's local scope: it is never logged, never written to a
 * table, and never placed on a pg-boss job payload. Only the resulting transcript text is
 * returned.
 */
export function registerAiTranscriptionRoutes(
  server: FastifyInstance,
  dependencies: AiRoutesDependencies,
  repository: AiRepository,
  secretCipher: AiSecretCipher
): void {
  // Scoped to audio/* content types only. Fastify has no per-route content-type parser hook,
  // so this is registered on the shared server instance — harmless, since no other route in
  // the app accepts an audio/* body. Avoids adding @fastify/multipart as a new dependency for
  // what is otherwise a single raw blob.
  server.addContentTypeParser(AUDIO_CONTENT_TYPE, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  server.post(
    "/api/ai/transcriptions",
    { schema: transcribeAudioRouteSchema, bodyLimit: MAX_AUDIO_BYTES },
    async (request, reply) => {
      try {
        const audio = requireAudioBody(request);
        const accessContext = await dependencies.resolveAccessContext(request);

        const model = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.selectModelForCapability(scopedDb, "transcription")
        );
        if (!model) {
          throw new HttpError(422, "No transcription-capable model is configured");
        }

        const provider = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.selectProviderWithCredential(scopedDb, model.provider_config_id)
        );
        if (!provider) {
          throw new HttpError(422, "Transcription provider is not configured");
        }

        const credential = parseAiApiKeyCredential(
          secretCipher.decryptJson(provider.encrypted_credential)
        );
        if (!credential) {
          throw new HttpError(422, "Transcription provider has no usable credential");
        }

        const adapter = new HttpApiAdapter(
          provider.provider_kind as ProviderKind,
          credential.apiKey,
          provider.base_url ? { baseUrl: provider.base_url } : {}
        );

        let text: string;
        try {
          // Raw audio bytes never leave this scope — not logged, not persisted, not put on
          // any pg-boss job payload. Only the transcript text crosses back to the caller.
          const result = await withTimeout(
            adapter.transcribeAudio({
              model: { provider_model_id: model.provider_model_id },
              // Copy into a plain Uint8Array<ArrayBuffer> — Buffer's underlying ArrayBufferLike
              // can type as SharedArrayBuffer, which BlobPart rejects.
              audio: new Blob([Uint8Array.from(audio)]),
              // #2956: the transcription line is owned by the requesting user.
              ownerUserId: accessContext.actorUserId
            }),
            TIMEOUT_MS
          );
          text = result.text;
        } catch (error) {
          if (error instanceof TranscriptionTimeoutError) {
            throw new HttpError(504, "Transcription request timed out");
          }
          // Scrub the upstream error (may embed provider host/error detail) before it
          // reaches the client; the real error is still visible server-side via the log.
          request.log.error({ err: error }, "Transcription provider request failed");
          throw new HttpError(502, "Transcription provider request failed");
        }

        return { text };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function requireAudioBody(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new HttpError(400, "Expected a non-empty audio/* request body");
  }
  return body;
}

class TranscriptionTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TranscriptionTimeoutError("transcription-timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    invalidRequestMessage: "Transcription request is invalid"
  });
}
