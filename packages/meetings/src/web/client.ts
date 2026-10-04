import { requestJson } from "@moss/module-web-sdk";
import type {
  CreateMeetingRecordInput,
  MeetingCapturePreferences,
  MeetingRecord,
  MeetingRecordCursor,
  PutMeetingNotesInput
} from "@moss/shared";

export const meetingKeys = {
  preferences: ["meetings", "preferences"] as const,
  history: ["meetings", "history"] as const,
  record: (id: string) => ["meetings", "record", id] as const,
  editor: (id: string) => ["meetings", "unsaved-notes", id] as const
};
export const PAGE_SIZE = 30;
export function listMeetings(before?: MeetingRecordCursor): Promise<{ meetings: MeetingRecord[] }> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (before) {
    query.set("beforeId", before.id);
    query.set("beforeCreatedAt", before.createdAt);
  }
  return requestJson(`/api/meetings/records?${query}`);
}
export function getMeeting(id: string): Promise<{ meeting: MeetingRecord }> {
  return requestJson(`/api/meetings/records/${encodeURIComponent(id)}`);
}
export function createMeeting(
  input: CreateMeetingRecordInput
): Promise<{ meeting: MeetingRecord; created: boolean }> {
  return requestJson("/api/meetings/records", { method: "POST", body: input });
}
export function saveMeetingNotes({
  meetingId,
  ...body
}: PutMeetingNotesInput): Promise<{ status: "saved"; replayed: boolean; meeting: MeetingRecord }> {
  return requestJson(`/api/meetings/records/${encodeURIComponent(meetingId)}/notes`, {
    method: "PUT",
    body
  });
}
export function deleteMeeting(id: string): Promise<void> {
  return requestJson(`/api/meetings/records/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getMeetingPreferences(): Promise<MeetingCapturePreferences> {
  return requestJson("/api/meetings/preferences");
}
export function putMeetingPreferences(
  body: MeetingCapturePreferences
): Promise<MeetingCapturePreferences> {
  return requestJson("/api/meetings/preferences", { method: "PUT", body });
}
