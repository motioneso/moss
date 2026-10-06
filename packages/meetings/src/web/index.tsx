import type { ModuleWebContribution } from "@moss/module-web-sdk";
import { MeetingCaptureStrip } from "./capture-strip.js";
import { MeetingsPage } from "./meetings-page.js";

const meetingsWebContribution: ModuleWebContribution = {
  moduleId: "meetings",
  persistentControls: <MeetingCaptureStrip />,
  routes: [
    { path: "/meetings", title: "Meetings", icon: "mic", order: 36, element: <MeetingsPage /> }
  ]
};
export default meetingsWebContribution;
