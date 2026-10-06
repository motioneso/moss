import { useState } from "react";
import { MeetingSettingsForm } from "./meeting-settings-form.js";

export default function MeetingSettings() {
  const [setup, setSetup] = useState(false);
  return (
    <MeetingSettingsForm
      setup={setup}
      onRunSetup={() => setSetup(true)}
      onCompleted={() => setSetup(false)}
      onCancel={setup ? () => setSetup(false) : undefined}
    />
  );
}
