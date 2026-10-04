import type { Ref } from "react";
import { useMeetingChat } from "@moss/module-web-sdk";
import { Button, Divider, Eyebrow, RowIndex, RowIndexItem } from "@moss/ui";
import type { MeetingHistoryItem } from "@moss/shared";
import { useMeetingDate } from "./locale.js";
import { indexingStatus, transcriptSpan, vaultStatus } from "./history-presentation.js";

export function MeetingHistoryRail({
  meeting,
  refreshing,
  offline,
  headingRef,
  onOpen
}: {
  readonly meeting: MeetingHistoryItem;
  readonly refreshing: boolean;
  readonly offline: boolean;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onOpen: (id: string) => void;
}) {
  const date = useMeetingDate({
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  const { openMeetingChat } = useMeetingChat();
  const transcript = meeting.transcript;
  const span = transcriptSpan(meeting);
  const index = indexingStatus(meeting);
  const canAsk = !refreshing && !offline && transcript.segmentCount > 0;
  const summary = meeting.summary;
  const generation = summary.generation;
  return (
    <>
      <div className="meetings-history-heading">
        <Eyebrow tone="accent">Selected meeting</Eyebrow>
        <h2 className="jds-brief__title" tabIndex={-1} ref={headingRef}>
          {meeting.title}
        </h2>
        <Divider weight="strong" />
        <p className="jds-hint">Created {date(meeting.createdAt)}</p>
        {span ? <p className="jds-hint">Transcript span {span}</p> : null}
      </div>
      <RowIndex variant="facts">
        <RowIndexItem title="Capture" meta="Unavailable" />
        <RowIndexItem
          title="Transcript"
          meta={
            transcript.segmentCount ? `${transcript.segmentCount} retained turns` : "None retained"
          }
        />
        {transcript.segmentCount ? (
          <RowIndexItem
            title="Transcript text"
            meta={`${transcript.finalSegmentCount} final · ${transcript.provisionalSegmentCount} provisional`}
          />
        ) : null}
        <RowIndexItem
          title="Summary"
          meta={
            summary.version === null
              ? "Not generated"
              : `Version ${summary.version}${summary.status === "stale" ? " · Needs review" : ""}`
          }
        />
        {generation && generation.status !== "saved" ? (
          <RowIndexItem
            title="Latest generation"
            meta={
              { pending: "Pending", failed: "Failed", interrupted: "Interrupted" }[
                generation.status
              ]
            }
          />
        ) : null}
        <RowIndexItem title="Suggested Tasks" meta={`${meeting.actions.pending} to review`} />
        <RowIndexItem title="Accepted suggestions" meta={String(meeting.actions.accepted)} />
        <RowIndexItem title="Latest vault write" meta={vaultStatus(meeting)} />
        {meeting.vault.savedVersionCount > 0 ? (
          <RowIndexItem title="Saved versions" meta={String(meeting.vault.savedVersionCount)} />
        ) : null}
      </RowIndex>
      {index ? <p className="jds-hint">{index}</p> : null}
      {meeting.vault.latest ? (
        <p className="jds-hint">Last acknowledgement {date(meeting.vault.latest.updatedAt)}</p>
      ) : null}
      <div className="meetings-history-rail-actions">
        <Button block onClick={() => onOpen(meeting.id)}>
          Open review
        </Button>
        <Button
          block
          variant="secondary"
          disabled={!canAsk}
          aria-describedby="meeting-history-chat-help"
          onClick={() => openMeetingChat({ meetingId: meeting.id, title: meeting.title })}
        >
          Ask Moss
        </Button>
        <p id="meeting-history-chat-help" className="jds-hint">
          {offline
            ? "Reconnect to ask about this meeting."
            : refreshing
              ? "Checking the selected meeting…"
              : canAsk
                ? "Ask about this meeting in Moss chat."
                : "Ask Moss needs an available transcript."}
        </p>
      </div>
      <div className="meetings-history-source-details">
        <Eyebrow tone="accent">Retained source details</Eyebrow>
        {transcript.sources.length ? (
          <>
            <ul className="meetings-history-source-list">
              {transcript.sources.map((source, index) => (
                <li key={`${source.kind}:${index}`} className="jds-hint">
                  {source.kind === "microphone" ? "Microphone" : "Output"}: {source.label}
                </li>
              ))}
            </ul>
            {transcript.omittedSourceCount ? (
              <p className="jds-hint">
                {transcript.omittedSourceCount} more source labels in review
              </p>
            ) : null}
            <p className="jds-hint">
              Source labels only. The span does not show continuous coverage.
            </p>
          </>
        ) : (
          <p className="jds-hint">No source labels retained.</p>
        )}
        <p className="jds-hint">
          Native capture is unavailable. Recording duration and completeness are unknown.
        </p>
      </div>
    </>
  );
}
