import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, randomUuid } from "@moss/module-web-sdk";
import { Button, Dialog } from "@moss/ui";
import type { MeetingRecord } from "@moss/shared";
import { captureKeys } from "./capture-client.js";
import { CAPTURE_MODES } from "./capture-modes.js";
import { captureRevocationLabel, captureStopped } from "./capture-presentation.js";
import { useCaptureSession, startMeetingCapture, type ActiveCapture } from "./capture-session.js";
import { getMeetingPreferences, isMeetingAccessDenied, meetingKeys } from "./client.js";
import { useCaptureStatus } from "./capture-status.js";
import { CaptureControls } from "./capture-controls.js";
import { CaptureNotice } from "./capture-notice.js";
import { useRecordingNotice, isRecordingNoticeAcknowledged } from "./recording-notice.js";
import { useSessionDraft } from "./session-draft.js";
export { captureQueryOptions } from "./capture-status.js";
const settingsPath = "/settings?section=modules&module=meetings";
export function CapturePanel({
  meeting,
  onLiveChange
}: {
  readonly meeting: MeetingRecord;
  readonly onLiveChange: (active: boolean) => void;
}) {
  const navigate = useNavigate();
  const query = useCaptureStatus(meeting.id),
    session = useCaptureSession(meeting.id),
    client = useQueryClient();
  const preferences = useQuery({
    queryKey: meetingKeys.preferences,
    queryFn: getMeetingPreferences,
    retry: false
  });
  const notice = useRecordingNotice();
  const pending = useSessionDraft<{ action: "start" | "resume" | null }>(
    ["meetings", "notice-action", meeting.id],
    () => ({ action: null })
  );
  const [noticeOpen, setNoticeOpen] = useState(false);
  const cancelNotice = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!noticeOpen || typeof document === "undefined") return;
    const previous = document.activeElement;
    cancelNotice.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        pending.update(() => ({ action: null }));
        setNoticeOpen(false);
      }
      if (event.key !== "Tab") return;
      const choices = cancelNotice.current
        ?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), a[href], textarea:not(:disabled)"
        );
      const first = choices?.[0],
        last = choices?.[choices.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [noticeOpen, pending.update]);
  const denied =
    isMeetingAccessDenied(query.error) &&
    !(query.error instanceof ApiError && query.error.status === 404);
  const capture = denied ? undefined : query.data?.capture;
  const stopped = captureStopped(capture),
    revoked = capture?.desired === "revoked";
  const live =
    !!session.state.operation || (!!capture && capture.desired !== "idle" && !stopped && !revoked);
  useEffect(() => onLiveChange(live), [live, onLiveChange]);
  useEffect(() => {
    if (live && !denied)
      client.setQueryData<ActiveCapture>(captureKeys.active, {
        meetingId: meeting.id,
        title: meeting.title
      });
  }, [client, meeting.id, meeting.title, live, denied]);
  const request = (action: "start" | "resume") => {
    if (!pending.currentSession() || denied) return;
    if (!isRecordingNoticeAcknowledged(client)) {
      pending.update(() => ({ action }));
      setNoticeOpen(true);
      return;
    }
    pending.update(() => ({ action: null }));
    setNoticeOpen(false);
    if (action === "start")
      void startMeetingCapture(client, meeting.id, meeting.title, { requestKey: randomUuid() });
    else if (capture?.desired === "paused")
      void session.control({
        grantId: capture.grantId,
        command: "record",
        expectedGeneration: capture.generation
      });
  };
  const source = preferences.data?.rememberedSource;
  const paused = capture?.desired === "paused";
  const savedMicrophone = capture?.inventory?.microphones.find(
    (item) => item.deviceId === source?.microphoneId
  )?.label;
  const savedApp = capture?.inventory?.applications.find(
    (item) => item.applicationId === source?.applicationId
  )?.label;
  const sourceSummary = source
    ? [
        CAPTURE_MODES.find((mode) => mode.value === source.mode)?.label,
        ...(paused && savedMicrophone ? [savedMicrophone] : []),
        ...(paused && source.mode === "selected-app" && savedApp ? [savedApp] : [])
      ]
        .filter(Boolean)
        .join(" · ")
    : "Complete your meeting setup";
  const status = denied
    ? "Recording access is unavailable. Use Trail Marker’s local Stop, then sign in again."
    : query.error instanceof ApiError && query.error.status === 404
      ? "Recording isn’t available on this server yet."
      : query.isError
        ? "Couldn’t confirm the recorder connection."
        : revoked && capture
          ? `${captureRevocationLabel(capture)}. Recording stopped. Review setup before starting a new meeting.`
          : (session.state.error ??
            (capture?.observed?.phase === "error"
              ? "Recording was interrupted. Check your Mac and sources."
              : query.data?.processingReady === false
                ? "Transcription isn’t available. Check AI providers."
                : capture?.processing?.status === "delayed"
                  ? "Transcription is delayed. Recording continues."
                  : capture?.finalization === "pending"
                    ? "Still being finalised"
                    : null));
  return (
    <section className="meetings-capture" aria-label="Meeting recording">
      {!capture && !session.state.operation ? (
        <Button
          disabled={
            denied ||
            query.isPending ||
            query.isError ||
            preferences.isPending ||
            preferences.isError ||
            notice.query.isPending
          }
          onClick={() =>
            source && preferences.data?.setupCompletedAt ? request("start") : navigate(settingsPath)
          }
        >
          Start
        </Button>
      ) : (
        <CaptureControls
          id={meeting.id}
          capture={capture}
          unavailable={query.isError}
          updatedAt={query.dataUpdatedAt}
          processingReady={query.data?.processingReady}
          onResume={() => request("resume")}
        />
      )}
      {(!live && !stopped && !revoked) || paused ? (
        <p className="jds-hint">
          {paused ? "Resume will use: " : ""}
          {sourceSummary}. <Link to={settingsPath}>Change</Link>
        </p>
      ) : null}
      {status ? (
        <p className="jds-hint" role="status">
          {status}{" "}
          {session.state.operation?.phase === "retry" ? (
            <Button
              variant="link"
              disabled={
                (session.state.operation.retryAt ?? 0) > Date.now() ||
                ((session.state.operation.request.kind === "start" ||
                  (session.state.operation.request.kind === "control" &&
                    session.state.operation.request.input.command === "record")) &&
                  !notice.acknowledged)
              }
              onClick={session.retry}
            >
              Try again
            </Button>
          ) : query.isError ? (
            <Button variant="link" onClick={query.refresh}>
              Check again
            </Button>
          ) : !stopped ? (
            <Link
              to={
                query.data?.processingReady === false
                  ? "/settings?section=aiproviders"
                  : settingsPath
              }
            >
              Review setup
            </Link>
          ) : null}
        </p>
      ) : null}
      {stopped || revoked ? <Link to="/meetings">New meeting</Link> : null}
      {noticeOpen ? (
        <Dialog
          title={<span id="meeting-recording-notice-title">Recording notice</span>}
          aria-labelledby="meeting-recording-notice-title"
          onClose={() => {
            pending.update(() => ({ action: null }));
            setNoticeOpen(false);
          }}
          footer={
            <>
              <Button
                ref={cancelNotice}
                variant="secondary"
                onClick={() => {
                  pending.update(() => ({ action: null }));
                  setNoticeOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={!notice.acknowledged || !pending.data.action}
                onClick={() => {
                  const action = pending.data.action;
                  if (action) request(action);
                }}
              >
                Continue
              </Button>
            </>
          }
        >
          <CaptureNotice />
        </Dialog>
      ) : null}
    </section>
  );
}
