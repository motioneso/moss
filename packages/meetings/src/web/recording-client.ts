import { requestJson } from "@moss/module-web-sdk";
import type {
  ManualTranscriptInput,
  RecordingMetadata,
  RecordingTypeConfiguration
} from "@moss/shared";
import { meetingKeys } from "./client.js";
export const recordingKeys = {
  types: ["meetings", "recording-types"] as const,
  record: (id: string) => [...meetingKeys.record(id), "recording"] as const
};
export const getRecordingTypes = (signal?: AbortSignal): Promise<RecordingTypeConfiguration> =>
  requestJson("/api/meetings/recording-types", { signal });
export const getRecording = (
  id: string,
  signal?: AbortSignal
): Promise<{ metadata: RecordingMetadata | null; configuration: RecordingTypeConfiguration }> =>
  requestJson(`/api/meetings/records/${encodeURIComponent(id)}/recording`, { signal });
export const putRecordingType = (
  id: string,
  input: { expectedRevision: number; typeId: string }
): Promise<{ metadata: RecordingMetadata }> =>
  requestJson(`/api/meetings/records/${encodeURIComponent(id)}/recording/type`, {
    method: "PUT",
    body: input
  });
export const addManualTranscript = (
  input: ManualTranscriptInput
): Promise<{ meetingId: string; replayed: boolean }> =>
  requestJson("/api/meetings/manual-transcripts", { method: "POST", body: input });
