import { useState } from "react";
import { Button, Note, Switch } from "@moss/ui";
import { useRecordingNotice } from "./recording-notice.js";
import { useMeetingDate } from "./locale.js";

/** Account acknowledgement is persisted by the server and renewed only for a changed policy. */
export function CaptureNotice({ disabled = false }: { readonly disabled?: boolean }) {
  const notice = useRecordingNotice();
  const date = useMeetingDate();
  const [reviewing, setReviewing] = useState(false);
  if (notice.query.isPending)
    return (
      <p role="status" className="jds-hint">
        Checking the recording notice…
      </p>
    );
  if (notice.query.isError || !notice.query.data)
    return (
      <p role="status" className="jds-hint">
        Couldn’t check the recording notice.{" "}
        <Button variant="link" onClick={() => void notice.query.refetch()}>
          Try again
        </Button>
      </p>
    );
  const { currentNotice, acknowledgement } = notice.query.data;
  return (
    <div className="meetings-section">
      {notice.acknowledged ? (
        <>
          <div className="meetings-actions">
            <span className="jds-hint">
              Recording notice acknowledged
              {acknowledgement ? ` on ${date(acknowledgement.acknowledgedAt)}` : ""}.
            </span>
            <Button variant="link" onClick={() => setReviewing((value) => !value)}>
              {reviewing ? "Close recording notice" : "Review recording notice"}
            </Button>
          </div>
          {reviewing ? <Note variant="practical">{currentNotice.text}</Note> : null}
        </>
      ) : (
        <>
          <Note variant="practical">{currentNotice.text}</Note>
          <Switch
            ariaLabel="Recording notice"
            label="I will tell people when I am recording"
            checked={false}
            disabled={disabled || notice.saving}
            onChange={(checked) => {
              if (checked) void notice.acknowledge(currentNotice.policyVersion);
            }}
          />
          <p className="jds-hint">
            {notice.saving
              ? "Saving your acknowledgement…"
              : "Asked once for your account, and again only when this recording notice changes."}
          </p>
        </>
      )}
      {notice.error ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {notice.error}
        </p>
      ) : null}
    </div>
  );
}
