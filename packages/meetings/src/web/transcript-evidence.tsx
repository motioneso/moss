import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Button, Note, Eyebrow } from "@moss/ui";
import type { MeetingTranscriptEvidence } from "@moss/shared";
import { getMeetingTranscriptEvidence } from "./client.js";
import { transcriptTime } from "./transcript-time.js";

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

export function TranscriptEvidence({ meetingId }: { readonly meetingId: string }) {
  const [params, setParams] = useSearchParams();
  const requested = fields.some((field) => params.has(field));
  const reference = parseTranscriptEvidence(meetingId, params);
  const evidence = useQuery(evidenceQueryOptions(meetingId, reference));
  if (!requested) return null;
  return (
    <section className="meetings-section" aria-label="Transcript evidence">
      <Eyebrow as="h2">Referenced transcript</Eyebrow>
      <Button
        variant="quiet"
        onClick={() => {
          const next = new URLSearchParams(params);
          fields.forEach((field) => next.delete(field));
          setParams(next);
        }}
      >
        Close evidence
      </Button>
      {!reference ? (
        <p role="status" className="jds-hint">
          This transcript reference is invalid.
        </p>
      ) : evidence.isError ? (
        <p role="status" className="jds-hint">
          This transcript reference is unavailable. It may have been deleted or access may have
          changed.
        </p>
      ) : evidence.isFetching ? (
        <p role="status" className="jds-hint">
          Loading referenced text…
        </p>
      ) : evidence.data ? (
        <>
          <p className="jds-hint">
            {transcriptTime(evidence.data.evidence.segment.startMs)}–
            {transcriptTime(evidence.data.evidence.segment.endMs)} ·{" "}
            {evidence.data.evidence.segment.finality === "provisional"
              ? "Provisional"
              : "Saved transcript"}
          </p>
          <Note variant="practical">
            <span className="meetings-transcript-text">{evidence.data.evidence.excerpt}</span>
          </Note>
          <details>
            <summary>Source details</summary>
            <p className="jds-hint">
              Transcript revision {reference.segmentRevision} · Characters{" "}
              {reference.startCharacter}–{reference.endCharacter}. Later corrections do not change
              this excerpt.
            </p>
          </details>
        </>
      ) : null}
    </section>
  );
}
