import type { ChatVoiceRequestStatus } from "@moss/shared";
import type { VoiceRequest } from "./voice-requests.js";

const messages: Record<VoiceRequest["state"], string> = {
  "no-speech": "No speech detected.",
  "ready-to-send": "Review this transcript and choose Send to send it to Main chat.",
  queued: "Waiting until Main chat is available.",
  dispatching: "Moss is responding in Main chat.",
  replied: "Moss replied in Main chat.",
  interrupted: "Moss was interrupted before replying. Anything it started may not be done."
};

/** Explicit public projection: dispatch boot identity and internal fingerprints stay internal. */
export function voiceRequestStatus(row: VoiceRequest): ChatVoiceRequestStatus {
  return {
    id: row.id,
    sourceDeviceId: row.source_device_id,
    recordingId: row.recording_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    createdAt: row.created_at.toISOString(),
    transcript: row.transcript,
    state: row.state,
    capturedAt: row.captured_at?.toISOString() ?? null,
    userMessageId: row.state === "replied" ? row.user_message_id : null,
    assistantMessageId: row.state === "replied" ? row.assistant_message_id : null,
    statusMessage: messages[row.state]
  };
}
