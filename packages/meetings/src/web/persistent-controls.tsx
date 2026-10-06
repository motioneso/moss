import type { ModulePersistentControlsContribution } from "@moss/module-web-sdk";
import { MeetingCaptureStrip } from "./capture-strip.js";

const meetingsPersistentControls: ModulePersistentControlsContribution = {
  moduleId: "meetings",
  element: <MeetingCaptureStrip />
};
export default meetingsPersistentControls;
