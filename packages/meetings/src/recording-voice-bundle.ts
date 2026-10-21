import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import type { VoiceRecordingImportInput } from "@moss/shared";
import { RecordingImportInputError, validateRecordingBundle } from "./recording-bundle.js";

/** Short transport v2: explicit intent, separate from legacy evidence-only imports. */
export function validateVoiceRecordingBundle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RecordingImportInputError();
  const input = value as Record<string, unknown>;
  const fields = ["version", "intent", "enablementId", "capturedAt", "recording"];
  if (
    Object.keys(input).length !== fields.length ||
    fields.some((field) => !(field in input)) ||
    input.version !== 2 ||
    input.intent !== "voice-request" ||
    typeof input.enablementId !== "string" ||
    !isUuid(input.enablementId) ||
    (input.capturedAt !== null &&
      (typeof input.capturedAt !== "string" ||
        !Number.isFinite(Date.parse(input.capturedAt)) ||
        new Date(input.capturedAt).toISOString() !== input.capturedAt))
  )
    throw new RecordingImportInputError();
  const bundle = validateRecordingBundle(input.recording);
  if (bundle.mode !== "voice-request") throw new RecordingImportInputError();
  const manifest: VoiceRecordingImportInput = {
    version: 2,
    intent: "voice-request",
    enablementId: input.enablementId.toLowerCase(),
    capturedAt: input.capturedAt as string | null,
    recording: bundle.manifest
  };
  const canonical = JSON.stringify(manifest);
  return {
    ...bundle,
    voice: manifest,
    canonical,
    fingerprint: createHash("sha256").update(canonical).digest("hex")
  };
}
