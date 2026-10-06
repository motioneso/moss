import { Button } from "@moss/ui";
import { MeetingSettingsForm } from "./meeting-settings-form.js";

/** Finishing setup stores defaults only. The caller decides whether to open a new meeting. */
export function MeetingSetup({
  onCompleted,
  onCancel,
  onNotesOnly
}: {
  readonly onCompleted: () => void;
  readonly onCancel?: () => void;
  readonly onNotesOnly?: () => void;
}) {
  return (
    <>
      <MeetingSettingsForm setup onCompleted={onCompleted} onCancel={onCancel} />
      {onNotesOnly ? (
        <div>
          <Button variant="link" onClick={onNotesOnly}>
            Continue with notes
          </Button>
          <p className="jds-hint">
            Set up recording later. Nothing records until you choose Start.
          </p>
        </div>
      ) : null}
    </>
  );
}
