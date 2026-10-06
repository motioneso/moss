import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@moss/module-web-sdk";
import { Badge, Button, Divider, Note, SectionHead } from "@moss/ui";
import {
  getMeetingTranscript,
  isMeetingAccessDenied,
  meetingKeys,
  type MeetingTranscriptView
} from "./client.js";

import { transcriptTime } from "./transcript-time.js";

export function TranscriptTimeline({ snapshot, sources }: MeetingTranscriptView) {
  return (
    <>
      <p className="jds-hint">
        {snapshot.throughMs === null
          ? "No text in this selection"
          : `Through ${transcriptTime(snapshot.throughMs)}`}{" "}
      </p>
      <p className="jds-hint">
        Source labels only. Sources do not identify people. Timestamps do not establish continuous
        coverage.
      </p>
      {snapshot.containsProvisional ? (
        <Note variant="practical">Includes provisional text that may change.</Note>
      ) : null}
      {snapshot.omittedSegments > 0 ? (
        <Note variant="practical">
          {snapshot.omittedSegments} segments omitted by the display limits ({snapshot.maxSegments}{" "}
          segments, {snapshot.maxCharacters} characters). This is a partial view.
        </Note>
      ) : null}
      <div className="meetings-section" aria-label="Transcript timeline">
        {snapshot.segments.map((segment) => {
          const source = sources.find(
            (item) => item.sourceId === segment.sourceId && item.epoch === segment.epoch
          );
          return (
            <article
              className="meetings-transcript-turn"
              key={segment.segmentId}
              aria-label={`Transcript at ${transcriptTime(segment.startMs)}`}
            >
              <Divider />
              <div className="meetings-actions">
                <span className="jds-label">
                  {transcriptTime(segment.startMs)}–{transcriptTime(segment.endMs)}
                </span>
                <span className="jds-label">{source?.label ?? "Source unavailable"}</span>
                <Badge tone={segment.finality === "provisional" ? "amber" : "neutral"}>
                  {segment.finality === "provisional" ? "Provisional" : "Final"}
                </Badge>
                {segment.provenance === "correction" ? (
                  <span className="jds-hint">Corrected</span>
                ) : null}
              </div>
              <p className="meetings-transcript-text">{segment.text}</p>
            </article>
          );
        })}
      </div>
    </>
  );
}

export function transcriptQueryOptions(meetingId: string, revision?: number) {
  return {
    queryKey: meetingKeys.transcript(meetingId, revision),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getMeetingTranscript(meetingId, revision, signal),
    retry: false as const,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: "always" as const
  };
}

export function useMeetingTranscript(meetingId: string, revision?: number) {
  return useQuery(transcriptQueryOptions(meetingId, revision));
}

/** Read-only retained text. Refresh is explicit; this view does not start capture or generation. */
export function MeetingTranscript({
  meetingId,
  revision,
  onRevisionChange
}: {
  readonly meetingId: string;
  readonly revision: number | undefined;
  readonly onRevisionChange: (revision: number | undefined) => void;
}) {
  const transcript = useMeetingTranscript(meetingId, revision);
  const snapshot = transcript.data?.snapshot;
  return (
    <section className="meetings-section" aria-label="Retained transcript">
      <SectionHead number="01" title="Transcript" rule meta="Read only" />
      <div className="meetings-actions">
        <Button
          variant="secondary"
          disabled={transcript.isFetching}
          onClick={() => void transcript.refetch()}
        >
          Refresh transcript
        </Button>
        {snapshot && !transcript.isError ? (
          <Button
            variant="quiet"
            disabled={transcript.isFetching || snapshot.transcriptRevision <= 1}
            onClick={() => onRevisionChange(snapshot.transcriptRevision - 1)}
          >
            Previous revision
          </Button>
        ) : null}
        {revision !== undefined ? (
          <Button variant="quiet" onClick={() => onRevisionChange(undefined)}>
            Latest revision
          </Button>
        ) : null}
      </div>
      {transcript.isFetching && !transcript.data ? (
        <p role="status" className="jds-hint">
          Loading transcript…
        </p>
      ) : null}
      {transcript.isError && (!transcript.data || isMeetingAccessDenied(transcript.error)) ? (
        <p role="status" className="jds-hint">
          {transcript.error instanceof ApiError && transcript.error.status === 404
            ? "No retained transcript is available for this selection."
            : transcript.error instanceof ApiError && [401, 403].includes(transcript.error.status)
              ? "Transcript access is unavailable. Sign in again or return to meeting history."
              : "Couldn’t load the transcript. Refresh to try again."}
        </p>
      ) : transcript.data ? (
        <>
          {revision !== undefined ? (
            <Note variant="practical">
              Viewing an earlier transcript revision. Choose Latest revision to return to current
              text.
            </Note>
          ) : null}
          <TranscriptTimeline {...transcript.data} />
        </>
      ) : null}
    </section>
  );
}
