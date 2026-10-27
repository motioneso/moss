import type { RecordingOutputContext, RecordingInterpretation } from "@moss/shared";
import { DEFAULT_RECORDING_TYPES } from "../../packages/meetings/src/recording-types.js";
export function recordingContext(
  meetingId: string,
  titleSource: "automatic" | "user" = "automatic"
): RecordingOutputContext {
  return {
    metadata: {
      meetingId,
      revision: 0,
      typeId: null,
      typeSource: "automatic",
      titleSource,
      side: null,
      confidence: null,
      reason: null,
      recordedAt: null,
      source: "recording",
      outputVersion: null
    },
    configuration: { revision: 0, types: DEFAULT_RECORDING_TYPES }
  };
}
export function recordingInterpretation(
  title = "Project notes and next steps."
): RecordingInterpretation {
  return {
    title,
    typeId: "work-meeting",
    side: "work",
    confidence: 0.95,
    reason: "Project work is explicitly discussed.",
    ideaGroups: []
  };
}
