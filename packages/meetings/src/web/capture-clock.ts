import { useEffect, useRef, useState } from "react";
import type { MeetingCaptureState } from "@moss/shared";
import { captureAcknowledged, captureConnected } from "./capture-presentation.js";

/** Only a fresh recording acknowledgement may advance the display between bounded snapshots. */
export function useCaptureClock(
  capture: MeetingCaptureState | null | undefined,
  updatedAt: number,
  unavailable: boolean
) {
  const [now, setNow] = useState(Date.now);
  const shown = useRef({ grantId: capture?.grantId, duration: capture?.recordedDurationMs ?? 0 });
  const serverNow = capture ? Date.parse(capture.serverTime) + Math.max(0, now - updatedAt) : now;
  const connected = !!capture && !unavailable && captureConnected(capture, serverNow);
  const recording =
    capture?.desired === "recording" &&
    captureAcknowledged(capture) &&
    capture.recordedDurationMs !== undefined;
  const advancing = recording && connected;
  const acknowledged = capture?.recordedDurationMs ?? 0;
  const waitingForCapture =
    !!capture && !captureAcknowledged(capture) && capture.observed?.phase === "recording";

  const duration =
    advancing && capture.lastSeenAt
      ? acknowledged + Math.max(0, serverNow - Date.parse(capture.lastSeenAt))
      : (recording || waitingForCapture) && shown.current.grantId === capture?.grantId
        ? Math.max(acknowledged, shown.current.duration)
        : acknowledged;
  useEffect(() => {
    shown.current = { grantId: capture?.grantId, duration };
  }, [capture?.grantId, duration]);
  useEffect(() => {
    setNow(Date.now());
    if (!advancing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [advancing, updatedAt]);
  return { duration, connected };
}
