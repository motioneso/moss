import { useEffect } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Indicator } from "@moss/ui";
import type { MeetingCaptureState } from "@moss/shared";
import { effectiveCaptureChoice, useCaptureSession } from "./capture-session.js";
import {
  captureAcknowledged,
  captureStopped,
  captureSelection,
  captureStatusLabel
} from "./capture-presentation.js";
import { CaptureNotice } from "./capture-notice.js";
import { isRecordingNoticeAcknowledged, useRecordingNotice } from "./recording-notice.js";
import { useCaptureClock } from "./capture-clock.js";
import { transcriptTime } from "./transcript-time.js";

export function CaptureControls({
  id,
  capture,
  unavailable = false,
  updatedAt,
  processingReady = true,
  showNotice = true
}: {
  readonly id: string;
  readonly capture: MeetingCaptureState | null | undefined;
  readonly unavailable?: boolean;
  readonly updatedAt: number;
  readonly processingReady?: boolean;
  readonly showNotice?: boolean;
}) {
  const session = useCaptureSession(id);
  const client = useQueryClient();
  const notice = useRecordingNotice();
  useEffect(() => {
    if (capture) session.bindCapture(capture);
  }, [capture, session]);
  const { duration, connected } = useCaptureClock(capture, updatedAt, unavailable);
  const stopped = captureStopped(capture);
  const revoked = capture?.desired === "revoked";
  const selection = captureSelection(
    effectiveCaptureChoice(session.state, capture),
    capture?.inventory ?? null
  );
  const busy = session.state.operation?.phase === "sending";
  const pending = session.state.operation?.request;
  const retryNeedsNotice =
    pending?.kind === "start" ||
    (pending?.kind === "control" && pending.input.command === "record");
  const resumable =
    notice.acknowledged &&
    capture?.desired === "paused" &&
    captureAcknowledged(capture) &&
    connected &&
    !!selection &&
    processingReady &&
    !busy;
  const label = unavailable
    ? "Capture status unconfirmed"
    : capture
      ? captureStatusLabel(capture, connected)
      : session.state.operation
        ? "Starting…"
        : "No recording active";
  return (
    <>
      {capture?.desired === "paused" && showNotice ? <CaptureNotice disabled={busy} /> : null}
      {!showNotice &&
      !notice.acknowledged &&
      (capture?.desired === "paused" || retryNeedsNotice) ? (
        <p className="jds-hint">
          <Link to={`/meetings?id=${encodeURIComponent(id)}`}>
            Review the recording notice on the meeting page
          </Link>{" "}
          before resuming. Pause and Stop remain available.
        </p>
      ) : null}
      <div className="meetings-actions">
        <span role="status">
          <Indicator
            status={connected ? "ready" : "idle"}
            live={connected && capture?.observed?.phase === "recording"}
            label={label}
          />
        </span>
        <span className="jds-label" aria-label="Recorded duration">
          {transcriptTime(duration)}
        </span>
        {capture?.desired === "recording" ? (
          <Button
            variant="secondary"
            disabled={
              busy &&
              session.state.operation?.request.kind === "control" &&
              ["pause", "stop", "revoke"].includes(session.state.operation.request.input.command)
            }
            onClick={() =>
              void session.control({
                grantId: capture.grantId,
                command: "pause",
                expectedGeneration: capture.generation
              })
            }
          >
            Pause
          </Button>
        ) : null}
        {capture?.desired === "paused" ? (
          <Button
            disabled={!resumable}
            onClick={() => {
              if (resumable && isRecordingNoticeAcknowledged(client) && capture && selection)
                void session.control({
                  grantId: capture.grantId,
                  command: "record",
                  expectedGeneration: capture.generation,
                  selection
                });
            }}
          >
            Resume
          </Button>
        ) : null}
        {!stopped &&
        !revoked &&
        ((capture && capture.desired !== "idle") || session.state.operation) ? (
          <Button onClick={() => void session.stop()}>Stop and review</Button>
        ) : null}
        {capture?.processing?.status === "delayed" ? (
          <span role="status" className="jds-hint">
            Transcription delayed
          </span>
        ) : null}
        {capture?.finalization === "pending" ? (
          <span role="status" className="jds-hint">
            Finishing transcript…
          </span>
        ) : null}
      </div>
      {session.state.error ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {session.state.error}
        </p>
      ) : null}
      {session.state.operation?.phase === "retry" ? (
        <Button
          variant="link"
          disabled={
            (session.state.operation.retryAt ?? 0) > Date.now() ||
            (retryNeedsNotice && !notice.acknowledged)
          }
          onClick={session.retry}
        >
          Retry capture command
        </Button>
      ) : null}
    </>
  );
}
