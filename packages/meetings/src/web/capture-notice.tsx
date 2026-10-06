import { Switch } from "@moss/ui";

/** A checked notice belongs to this browser's meeting, never to a remembered source or device. */
export function CaptureNotice({
  acknowledged,
  onChange,
  disabled = false
}: {
  readonly acknowledged: boolean;
  readonly onChange: (acknowledged: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <Switch
      ariaLabel="Recording notice"
      label="Participants have been notified and recording is permitted."
      checked={acknowledged}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
