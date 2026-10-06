import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Note } from "@moss/ui";
import { captureKeys } from "./capture-client.js";
import { useCaptureStatus } from "./capture-status.js";
import { CaptureControls } from "./capture-controls.js";
import { captureStopped } from "./capture-presentation.js";
import { isMeetingAccessDenied } from "./client.js";
import type { ActiveCapture } from "./capture-session.js";
function ActiveCaptureStrip({ active }: { readonly active: ActiveCapture }) {
  const query = useCaptureStatus(active.meetingId);
  const client = useQueryClient();
  const location = useLocation();
  const capture = query.data?.capture;
  const stopped = captureStopped(capture);
  const live = !stopped && capture?.desired !== "revoked";
  useEffect(() => {
    if (!live || typeof window === "undefined") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);
  if (isMeetingAccessDenied(query.error)) return null;
  const onMeeting =
    location.pathname === "/meetings" &&
    new URLSearchParams(location.search).get("id") === active.meetingId;
  // The same subscription stays mounted while the detailed controls are on screen.
  if (onMeeting) return null;
  return (
    <aside className="meetings-recording-strip" aria-label="Active meeting recording">
      <Note variant="practical">
        <div className="meetings-section">
          <div className="meetings-actions">
            <Link to={`/meetings?id=${encodeURIComponent(active.meetingId)}`}>{active.title}</Link>
            <span className="jds-hint">{capture?.deviceName}</span>
          </div>
          <CaptureControls
            id={active.meetingId}
            capture={capture}
            unavailable={query.isError}
            updatedAt={query.dataUpdatedAt}
            processingReady={query.data?.processingReady}
          />
          {stopped ? (
            <Button variant="link" onClick={() => client.setQueryData(captureKeys.active, null)}>
              Dismiss recording controls
            </Button>
          ) : null}
        </div>
      </Note>
    </aside>
  );
}
export function MeetingCaptureStrip() {
  const active = useQuery<ActiveCapture | null>({
    queryKey: captureKeys.active,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity
  });
  return active.data ? (
    <ActiveCaptureStrip key={active.data.meetingId} active={active.data} />
  ) : null;
}
