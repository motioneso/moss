import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Indicator } from "@moss/ui";
import { captureKeys } from "./capture-client.js";
import { useCaptureStatus } from "./capture-status.js";
import { useCaptureClock } from "./capture-clock.js";
import { captureStopped, captureAcknowledged, captureStatusLabel } from "./capture-presentation.js";
import { isMeetingAccessDenied } from "./client.js";
import { transcriptTime } from "./transcript-time.js";
import type { ActiveCapture } from "./capture-session.js";
import "./capture-controls.css";

function ActiveCaptureStatus({
  active,
  navigation = false
}: {
  readonly active: ActiveCapture;
  readonly navigation?: boolean;
}) {
  const query = useCaptureStatus(active.meetingId);
  const location = useLocation();
  const capture = query.data?.capture;
  const live =
    !captureStopped(capture) &&
    capture?.desired !== "revoked" &&
    !isMeetingAccessDenied(query.error);
  const { duration, connected } = useCaptureClock(capture, query.dataUpdatedAt, query.isError);
  const recording =
    !!capture &&
    !query.isError &&
    connected &&
    capture.desired === "recording" &&
    captureAcknowledged(capture);
  const label =
    query.isError || !capture
      ? "Recording status unconfirmed"
      : captureStatusLabel(capture, connected);
  useEffect(() => {
    if (!live || navigation || typeof window === "undefined") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live, navigation]);
  if (!live) return null;
  if (navigation)
    return (
      <span className="meetings-recording-indicator" role="img" aria-label={label}>
        <Indicator status={recording ? "error" : "idle"} live={recording} />
      </span>
    );
  const onMeeting =
    location.pathname === "/meetings" &&
    new URLSearchParams(location.search).get("id") === active.meetingId;
  if (onMeeting) return null;
  return (
    <Link
      className="meetings-recording-strip"
      to={`/meetings?id=${encodeURIComponent(active.meetingId)}`}
      aria-label={`Return to meeting: ${active.title}, ${label}`}
    >
      <Indicator status={recording ? "error" : "idle"} live={recording} />
      <span>{transcriptTime(duration)}</span>
      {!recording ? <span className="jds-hint">{label}</span> : null}
    </Link>
  );
}
function useActiveCapture() {
  return useQuery<ActiveCapture | null>({
    queryKey: captureKeys.active,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity
  }).data;
}
export function MeetingCaptureStrip() {
  const active = useActiveCapture();
  return active ? <ActiveCaptureStatus key={active.meetingId} active={active} /> : null;
}
export function MeetingCaptureNavigationIndicator() {
  const active = useActiveCapture();
  return active ? <ActiveCaptureStatus key={active.meetingId} active={active} navigation /> : null;
}
