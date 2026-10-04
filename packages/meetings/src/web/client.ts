import type { QueryClient } from "@tanstack/react-query";
import { ApiError, requestJson } from "@moss/module-web-sdk";
import type {
  CreateMeetingRecordInput,
  MeetingCapturePreferences,
  MeetingRecord,
  MeetingRecordCursor,
  MeetingTranscriptSnapshotResponse,
  MeetingTranscriptEvidence,
  MeetingTranscriptSegment,
  PutMeetingNotesInput
} from "@moss/shared";

export const meetingKeys = {
  preferences: ["meetings", "preferences"] as const,
  history: ["meetings", "history"] as const,
  record: (id: string) => ["meetings", "record", id] as const,
  transcript: (id: string, revision?: number) =>
    ["meetings", "transcript", id, revision ?? "latest"] as const,
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
export function getMeeting(id: string, signal?: AbortSignal): Promise<{ meeting: MeetingRecord }> {
  return requestJson(`/api/meetings/records/${encodeURIComponent(id)}`, { signal });
}
export function isMeetingAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}
export function meetingRecordQueryOptions(id: string) {
  return {
    queryKey: meetingKeys.record(id),
    queryFn: async ({ signal, client }: { signal: AbortSignal; client: QueryClient }) => {
      try {
        return await getMeeting(id, signal);
      } catch (error) {
        // Invalidate pending save identities before the denial reaches observers.
        // A later success from an earlier save must not restore inaccessible content.
        if (isMeetingAccessDenied(error))
          client.removeQueries({ queryKey: meetingKeys.editor(id), exact: true });
        throw error;
      }
    },
    enabled: !!id,
    retry: false as const,
    staleTime: 0,
    refetchOnWindowFocus: "always" as const
  };
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

export type MeetingTranscriptView = MeetingTranscriptSnapshotResponse;
export function getMeetingTranscript(
  id: string,
  revision?: number,
  signal?: AbortSignal
): Promise<MeetingTranscriptView> {
  const query = new URLSearchParams({ maxSegments: "500", maxCharacters: "100000" });
  if (revision !== undefined) query.set("transcriptRevision", String(revision));
  return requestJson(`/api/meetings/records/${encodeURIComponent(id)}/transcript?${query}`, {
    signal
  });
}

export function getMeetingTranscriptEvidence(
  reference: MeetingTranscriptEvidence,
  signal?: AbortSignal
): Promise<{ evidence: { segment: MeetingTranscriptSegment; excerpt: string } }> {
  const { meetingId, ...range } = reference;
  const query = new URLSearchParams(
    Object.entries(range).map(([key, value]) => [key, String(value)])
  );
  return requestJson(
    `/api/meetings/records/${encodeURIComponent(meetingId)}/transcript/evidence?${query}`,
    { signal }
  );
}
