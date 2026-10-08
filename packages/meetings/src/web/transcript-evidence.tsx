import type { MeetingTranscriptEvidence } from "@moss/shared";
import { getMeetingTranscriptEvidence } from "./client.js";

const fields = ["segmentId", "segmentRevision", "startCharacter", "endCharacter"] as const;
export function parseTranscriptEvidence(
  meetingId: string,
  params: URLSearchParams
): MeetingTranscriptEvidence | null {
  const segmentId = params.get("segmentId");
  const numbers = fields.slice(1).map((key) => {
    const value = params.get(key);
    return value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  });
  const [segmentRevision, startCharacter, endCharacter] = numbers;
  if (
    !segmentId?.trim() ||
    segmentId.length > 256 ||
    numbers.some((n) => !Number.isSafeInteger(n)) ||
    segmentRevision! < 1 ||
    startCharacter! < 0 ||
    endCharacter! <= startCharacter!
  )
    return null;
  return {
    meetingId,
    segmentId,
    segmentRevision: segmentRevision!,
    startCharacter: startCharacter!,
    endCharacter: endCharacter!
  };
}

export function evidenceQueryOptions(
  meetingId: string,
  reference: MeetingTranscriptEvidence | null
) {
  return {
    queryKey: ["meetings", "evidence", meetingId, reference],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getMeetingTranscriptEvidence(reference!, signal),
    enabled: reference !== null,
    retry: false as const,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: "always" as const
  };
}
