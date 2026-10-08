import type { ModulePersistentControlsContribution } from "@moss/module-web-sdk";
import { MeetingCaptureStrip, MeetingCaptureNavigationIndicator } from "./capture-strip.js";

const meetingsPersistentControls: ModulePersistentControlsContribution = {
  moduleId: "meetings",
  element: <MeetingCaptureStrip />,
  navigationIndicator: <MeetingCaptureNavigationIndicator />
};
export default meetingsPersistentControls;
