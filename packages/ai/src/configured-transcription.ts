import { createHash } from "node:crypto";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpApiAdapter } from "./adapters/http-api.js";
import {
  TranscriptionTransportError,
  type TranscriptionFailureDescription,
  type TranscriptionFailureReason,
  type TranscriptionFailureStage
} from "./transcription-errors.js";
import { parseAiApiKeyCredential } from "./credentials.js";
import { createAiSecretCipher, type AiSecretCipher } from "./crypto.js";
import {
  AiRepository,
  type AiConfiguredModelSafeRow,
  type AiProviderConfigSafeRow
} from "./repository.js";

export class ConfiguredTranscriptionError extends Error implements TranscriptionFailureDescription {
  readonly reason: TranscriptionFailureReason;
  readonly stage: TranscriptionFailureStage;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;

  constructor(
    readonly code: "unavailable" | "route-changed" | "failed" | "interrupted",
    failure?: TranscriptionFailureDescription
  ) {
    super(`Configured transcription ${code}`);
    this.name = "ConfiguredTranscriptionError";
    this.reason =
      failure?.reason ??
      (code === "unavailable"
        ? "configuration-unavailable"
        : code === "route-changed"
          ? "route-changed"
          : code === "interrupted"
            ? "cancelled"
            : "unknown");
    this.stage =
      failure?.stage ??
      (code === "unavailable" || code === "route-changed" ? "configuration" : "dispatch");
    this.retryable = failure?.retryable ?? false;
    if (failure?.retryAfterMs !== undefined) this.retryAfterMs = failure.retryAfterMs;
    if (failure?.httpStatus !== undefined) this.httpStatus = failure.httpStatus;
  }
}

export interface ConfiguredTranscriptionInput {
  /** A bounded, self-describing audio clip, not raw PCM. */
  readonly audio: Uint8Array;
  readonly signal: AbortSignal;
  /** Safe configuration identity selected before capture; a changed route fails closed. */
  readonly expectedModelRoute: string;
  /** Serialize this actual fetch initiation against the capture control admission boundary. */
  readonly dispatch: <T>(
    send: () => Promise<T>,
    validate?: (db: DataContextDb) => Promise<void>
  ) => Promise<T>;
}
export interface ConfiguredTranscriptionResult {
  readonly segments: readonly { startMs: number; endMs: number; text: string }[];
  readonly modelRoute: string;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireUsable(model: AiConfiguredModelSafeRow | null, provider?: AiProviderConfigSafeRow) {
  if (
    !model ||
    !provider ||
    model.provider_config_id !== provider.id ||
    model.status !== "active" ||
    model.provider_status !== "active" ||
    model.provider_auth_method !== "api_key" ||
    model.provider_kind !== "openai-compatible" ||
    !model.capabilities.includes("transcription") ||
    provider.provider_kind !== model.provider_kind ||
    provider.status !== "active" ||
    provider.auth_method !== "api_key" ||
    provider.revoked_at ||
    !provider.has_credential
  )
    throw new ConfiguredTranscriptionError("unavailable");
  return { model, provider };
}
function modelRoute(model: AiConfiguredModelSafeRow, provider: AiProviderConfigSafeRow) {
  // Metadata only. Neither the plaintext nor sealed credential contributes to this stored identity.
  return digest([
    model.id,
    model.provider_config_id,
    model.provider_model_id,
    model.updated_at,
    provider.provider_kind,
    provider.base_url,
    provider.updated_at,
    provider.purpose
  ]);
}

/**
 * Public AI-owned timestamped clip port. Uses the existing pin/voice capability resolver;
 * it does not select a provider, launch a CLI, retry, or fall back on the caller's behalf.
 */
export function createConfiguredTranscription(deps: {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly repository?: AiRepository;
  readonly cipher?: AiSecretCipher;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const repository = deps.repository ?? new AiRepository();
  const cipher = deps.cipher ?? createAiSecretCipher();
  const resolveSafe = async (db: DataContextDb) => {
    const { model } = await repository.resolveModelForCapability(
      db,
      "transcription",
      "interactive",
      {
        logNeedsConfig: false
      }
    );
    if (!model) throw new ConfiguredTranscriptionError("unavailable");
    const provider = await repository.selectProviderConfiguration(db, model.provider_config_id);
    const selected = requireUsable(model, provider);
    return { ...selected, modelRoute: modelRoute(selected.model, selected.provider) };
  };
  const resolveSealed = async (db: DataContextDb) => {
    const safe = await resolveSafe(db);
    const provider = await repository.selectProviderWithCredential(
      db,
      safe.model.provider_config_id
    );
    requireUsable(safe.model, provider);
    if (!provider || modelRoute(safe.model, provider) !== safe.modelRoute)
      throw new ConfiguredTranscriptionError("route-changed");
    return {
      ...safe,
      provider,
      fingerprint: digest([safe.modelRoute, provider.encrypted_credential])
    };
  };
  return {
    async availability(
      actor: AccessContext
    ): Promise<{ ready: boolean; modelRoute: string | null }> {
      try {
        const route = await deps.dataContext.withDataContext(actor, resolveSafe);
        return { ready: true, modelRoute: route.modelRoute };
      } catch (error) {
        if (error instanceof ConfiguredTranscriptionError)
          return { ready: false, modelRoute: null };
        throw new ConfiguredTranscriptionError("unavailable");
      }
    },
    async transcribe(
      actor: AccessContext,
      input: ConfiguredTranscriptionInput
    ): Promise<ConfiguredTranscriptionResult> {
      const deadline = AbortSignal.timeout(30000);
      const signal = AbortSignal.any([input.signal, deadline]);
      const abortFailure = () =>
        input.signal.aborted
          ? new ConfiguredTranscriptionError("interrupted")
          : new ConfiguredTranscriptionError(
              "failed",
              new TranscriptionTransportError("provider-timeout", "dispatch")
            );
      let removeAbort: () => void = () => undefined;
      try {
        signal.throwIfAborted();
        if (input.audio.byteLength === 0 || input.audio.byteLength > 3840044)
          throw new ConfiguredTranscriptionError(
            "failed",
            new TranscriptionTransportError("invalid-audio", "validation")
          );
        const selected = await deps.dataContext.withDataContext(actor, resolveSealed);
        if (selected.modelRoute !== input.expectedModelRoute)
          throw new ConfiguredTranscriptionError("route-changed");
        const credential = parseAiApiKeyCredential(
          cipher.decryptJson(selected.provider.encrypted_credential)
        );
        if (!credential) throw new ConfiguredTranscriptionError("unavailable");
        const adapter = new HttpApiAdapter("openai-compatible", credential.apiKey, {
          ...(selected.provider.base_url ? { baseUrl: selected.provider.base_url } : {}),
          // Audio and Authorization are sent only to the configured destination, never a redirect.
          fetch: (url, options) =>
            input.dispatch(
              () => {
                signal.throwIfAborted();
                return (deps.fetch ?? globalThis.fetch)(url, {
                  ...options,
                  redirect: "error"
                }).catch(() => {
                  if (signal.aborted) throw signal.reason;
                  throw new TranscriptionTransportError("provider-network", "dispatch");
                });
              },
              async (db) => {
                signal.throwIfAborted();
                const current = await resolveSealed(db);
                if (current.fingerprint !== selected.fingerprint)
                  throw new ConfiguredTranscriptionError("route-changed");
                signal.throwIfAborted();
              }
            )
        });
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(abortFailure());
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
        });
        signal.throwIfAborted();
        const result = await Promise.race([
          adapter.transcribeAudio({
            model: selected.model,
            audio: new Blob([Uint8Array.from(input.audio)], { type: "audio/wav" }),
            signal,
            timestamps: "segment",
            ownerUserId: actor.actorUserId,
            actionCode: "transcribe.meeting"
          }),
          aborted
        ]);
        signal.throwIfAborted();
        const current = await deps.dataContext.withDataContext(actor, resolveSealed);
        if (current.fingerprint !== selected.fingerprint)
          throw new ConfiguredTranscriptionError("route-changed");
        signal.throwIfAborted();
        if (!result.segments)
          throw new ConfiguredTranscriptionError(
            "failed",
            new TranscriptionTransportError("provider-response-invalid", "validation")
          );
        return {
          modelRoute: selected.modelRoute,
          segments: result.segments.map((segment) => ({
            startMs: Math.round(segment.start * 1000),
            endMs: Math.round(segment.end * 1000),
            text: segment.text
          }))
        };
      } catch (error) {
        if (signal.aborted) throw abortFailure();
        if (error instanceof ConfiguredTranscriptionError) throw error;
        if (error instanceof TranscriptionTransportError)
          throw new ConfiguredTranscriptionError("failed", error);
        // Do not release raw provider/credential/parser errors to the caller or logs.
        throw new ConfiguredTranscriptionError("failed");
      } finally {
        removeAbort();
      }
    }
  };
}
