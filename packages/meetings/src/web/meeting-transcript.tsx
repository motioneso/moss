import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router";
import { ApiError } from "@moss/module-web-sdk";
import { Button, SectionHead, Field, FormLabel, Note, Highlight } from "@moss/ui";
import type { MeetingCaptureState, MeetingTranscriptSegment } from "@moss/shared";
import {
  getMeetingTranscript,
  isMeetingAccessDenied,
  meetingKeys,
  type MeetingTranscriptView
} from "./client.js";
import { captureKeys } from "./capture-client.js";
import { useCaptureClock } from "./capture-clock.js";
import { captureAcknowledged } from "./capture-presentation.js";
import { evidenceQueryOptions, parseTranscriptEvidence } from "./transcript-evidence.js";
import { transcriptTime } from "./transcript-time.js";

const MIN_TRANSCRIPT_GAP_MS = 250;

export function TranscriptTimeline({
  snapshot,
  sources,
  gaps = [],
  selectedId,
  search = ""
}: MeetingTranscriptView & {
  readonly gaps?: MeetingCaptureState["gaps"];
  readonly selectedId?: string;
  readonly search?: string;
}) {
  // Native and server reports can describe the same lost clip under different IDs.
  // Keep the retained diagnostics intact and collapse only exact coverage duplicates.
  // Hide sub-quarter-second interruptions in this view only, using precise duration
  // rather than rounded timestamp labels. Capture metadata and warnings stay intact.
  // This also hides processing-failed fragments under 250ms; their failure metadata is retained.
  const distinctGaps = new Map(
    gaps
      .filter((gap) => gap.endMs - gap.startMs >= MIN_TRANSCRIPT_GAP_MS)
      .map((gap) => [
        JSON.stringify([gap.sourceId, gap.epoch, gap.startMs, gap.endMs, gap.reason]),
        gap
      ])
  );
  const rows: (
    | { kind: "segment"; start: number; segment: MeetingTranscriptSegment }
    | { kind: "gap"; start: number; gap: MeetingCaptureState["gaps"][number] }
  )[] = [
    ...snapshot.segments
      .filter(
        (segment) =>
          !search || segment.text.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      )
      .map((segment) => ({ kind: "segment" as const, start: segment.startMs, segment })),
    ...Array.from(distinctGaps.values(), (gap) => ({
      kind: "gap" as const,
      start: gap.startMs,
      gap
    }))
  ].sort((a, b) => a.start - b.start);
  return (
    <>
      {snapshot.containsProvisional ? <p className="jds-hint">Still being finalised</p> : null}
      {snapshot.omittedSegments > 0 ? (
        <Note variant="practical">
          {snapshot.omittedSegments} lines are outside this view’s limits. Search or follow a cited
          timestamp to find the text.
        </Note>
      ) : null}
      <div className="meetings-transcript-timeline" aria-label="Transcript timeline">
        {rows.map((row) =>
          row.kind === "gap" ? (
            <p className="jds-hint meetings-transcript-gap" key={`gap:${row.gap.id}`}>
              {transcriptTime(row.gap.startMs) === transcriptTime(row.gap.endMs)
                ? `Under a second missing at ${transcriptTime(row.gap.startMs)}`
                : `${transcriptTime(row.gap.startMs)} to ${transcriptTime(row.gap.endMs)} missing`}
            </p>
          ) : (
            (() => {
              const segment = row.segment;
              const source = sources.find(
                (item) => item.sourceId === segment.sourceId && item.epoch === segment.epoch
              );
              return (
                <article
                  id={`meeting-line-${segment.segmentId}`}
                  tabIndex={-1}
                  className={`meetings-transcript-turn${segment.finality === "provisional" ? " meetings-transcript-turn--live" : ""}`}
                  key={segment.segmentId}
                  aria-label={`Transcript at ${transcriptTime(segment.startMs)}`}
                >
                  <span className="jds-hint">{transcriptTime(segment.startMs)}</span>
                  <div>
                    <span className="jds-label">
                      {source?.kind === "microphone"
                        ? "You"
                        : source?.kind === "output"
                          ? "Call audio"
                          : (source?.label ?? "Audio")}
                    </span>
                    <p
                      className={
                        segment.finality === "provisional"
                          ? "meetings-transcript-text jds-hint"
                          : "meetings-transcript-text"
                      }
                    >
                      {segment.segmentId === selectedId ? (
                        <Highlight>{segment.text}</Highlight>
                      ) : (
                        segment.text
                      )}
                    </p>
                  </div>
                </article>
              );
            })()
          )
        )}
        {search && !rows.some((row) => row.kind === "segment") ? (
          <p className="jds-hint">No transcript lines match.</p>
        ) : null}
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
export function MeetingTranscript({
  meetingId,
  search = null,
  onSearch,
  onReference
}: {
  readonly meetingId: string;
  readonly search?: string | null;
  readonly onSearch?: (value: string | null) => void;
  readonly onReference?: () => void;
}) {
  const transcript = useMeetingTranscript(meetingId);
  const [params] = useSearchParams();
  const navigation = useLocation().key;
  const reference = useMemo(() => parseTranscriptEvidence(meetingId, params), [meetingId, params]);
  const evidence = useQuery(evidenceQueryOptions(meetingId, reference));
  const capture = useQuery<{ capture: MeetingCaptureState | null }>({
    queryKey: captureKeys.status(meetingId),
    enabled: false
  });
  const { connected } = useCaptureClock(
    capture.data?.capture,
    capture.dataUpdatedAt,
    capture.isError
  );
  const emptyText =
    capture.data?.capture?.desired === "recording" &&
    connected &&
    captureAcknowledged(capture.data.capture)
      ? "Listening…"
      : "Start when you’re ready.";
  const snapshot = isMeetingAccessDenied(transcript.error) ? undefined : transcript.data?.snapshot;
  const exact = evidence.isError ? undefined : evidence.data?.evidence.segment;
  const selected =
    exact &&
    snapshot?.segments.find(
      (line) => line.segmentId === exact.segmentId && line.revision === exact.revision
    );
  const requested = ["segmentId", "segmentRevision", "startCharacter", "endCharacter"].some(
    (field) => params.has(field)
  );
  useEffect(() => {
    if (!requested || typeof document === "undefined") return;
    onReference?.();
    if (!exact) return;
    const timer = setTimeout(() => {
      const node = document.getElementById(
        selected ? `meeting-line-${exact.segmentId}` : `meeting-reference-${meetingId}`
      );
      node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      node?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [navigation, exact, selected?.segmentId, requested, meetingId]);
  const denied =
    isMeetingAccessDenied(transcript.error) &&
    !(transcript.error instanceof ApiError && transcript.error.status === 404);
  return (
    <section className="meetings-section" aria-label="Transcript">
      <SectionHead title="Transcript" rule />
      {search !== null ? (
        <Field>
          <FormLabel htmlFor="meeting-transcript-search">Search transcript</FormLabel>
          <input
            autoFocus
            id="meeting-transcript-search"
            type="search"
            className="jds-input meetings-input"
            value={search}
            onChange={(event) => onSearch?.(event.target.value)}
          />
          <Button variant="link" onClick={() => onSearch?.(null)}>
            Close search
          </Button>
        </Field>
      ) : null}
      {requested && (!reference || evidence.isError) ? (
        <p role="status" className="jds-hint">
          This transcript reference is unavailable. It may have changed or access was removed.
        </p>
      ) : null}
      {requested && evidence.isFetching && !exact ? (
        <p className="jds-hint">Loading referenced text…</p>
      ) : null}
      {exact && !selected && !denied ? (
        <article id={`meeting-reference-${meetingId}`} tabIndex={-1}>
          <span className="jds-hint">Earlier text at {transcriptTime(exact.startMs)}</span>
          <p className="meetings-transcript-text">
            <Highlight>{evidence.data?.evidence.excerpt}</Highlight>
          </p>
        </article>
      ) : null}
      {denied ? (
        <p role="status" className="jds-hint">
          Transcript access is unavailable. Return to Meetings or sign in again.
        </p>
      ) : snapshot ? (
        <>
          <TranscriptTimeline
            {...transcript.data!}
            gaps={capture.data?.capture?.gaps}
            selectedId={selected?.segmentId}
            search={search ?? ""}
          />
          {!snapshot.segments.length && search === null ? (
            <p className="jds-hint" role="status">
              {emptyText}
            </p>
          ) : null}
        </>
      ) : transcript.isFetching ? (
        <p className="jds-hint">Loading transcript…</p>
      ) : transcript.isError &&
        !(transcript.error instanceof ApiError && transcript.error.status === 404) ? (
        <p className="jds-hint">
          Couldn’t load the transcript.{" "}
          <Button variant="link" onClick={() => void transcript.refetch()}>
            Try again
          </Button>
        </p>
      ) : (
        <p className="jds-hint" role="status">
          {emptyText}
        </p>
      )}
      <p className="jds-sr-only" aria-live="polite" aria-atomic="true">
        {snapshot?.segments.length
          ? `${snapshot.segments.length} transcript lines available, through ${transcriptTime(snapshot.throughMs ?? 0)}.`
          : ""}
      </p>
      {capture.data?.capture?.gapLimitReached ? (
        <Note variant="practical">Some additional missing audio ranges could not be listed.</Note>
      ) : null}
    </section>
  );
}
