import { useEffect } from "react";
import { Button, Indicator, ControlPill } from "@moss/ui";
import type { MeetingCaptureState } from "@moss/shared";
import { useCaptureSession } from "./capture-session.js";
import { captureAcknowledged, captureStopped, captureStatusLabel } from "./capture-presentation.js";
import { useCaptureClock } from "./capture-clock.js";
import { transcriptTime } from "./transcript-time.js";

export function CaptureControls({
  id,
  capture,
  unavailable = false,
  updatedAt,
  processingReady = true,
  onResume
}: {
  readonly id: string;
  readonly capture: MeetingCaptureState | null | undefined;
  readonly unavailable?: boolean;
  readonly updatedAt: number;
  readonly processingReady?: boolean;
  readonly onResume: () => void;
}) {
  const session = useCaptureSession(id);
  useEffect(() => {
    if (capture) session.bindCapture(capture);
  }, [capture, session]);
  const { duration, connected } = useCaptureClock(capture, updatedAt, unavailable);
  const stopped = captureStopped(capture),
    revoked = capture?.desired === "revoked";
  const busy = session.state.operation?.phase === "sending";
  if ((!capture || stopped || revoked) && !session.state.operation)
    return stopped ? <span className="jds-hint">Ended</span> : null;
  const label = unavailable
    ? "Recording status unconfirmed"
    : capture
      ? captureStatusLabel(capture, connected)
      : "Starting…";
  return (
    <ControlPill label="Recording controls">
      <span aria-label={label} title={label}>
        <Indicator
          status={capture?.desired === "recording" ? "error" : "idle"}
          live={connected && capture?.observed?.phase === "recording"}
        />
      </span>
      <span className="jds-label" aria-label="Recorded duration">
        {transcriptTime(duration)}
      </span>
      {capture?.desired === "recording" ? (
        <Button
          variant="quiet"
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
          variant="quiet"
          disabled={busy || !connected || !captureAcknowledged(capture) || !processingReady}
          onClick={onResume}
        >
          Resume
        </Button>
      ) : null}
      {!stopped && !revoked ? (
        <Button variant="quiet" onClick={() => void session.stop()}>
          Stop
        </Button>
      ) : null}
    </ControlPill>
  );
}
