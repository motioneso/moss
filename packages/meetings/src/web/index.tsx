import type { ModuleWebContribution } from "@moss/module-web-sdk";
import { MeetingsPage } from "./meetings-page.js";

const meetingsWebContribution: ModuleWebContribution = {
  moduleId: "meetings",
  routes: [
    { path: "/meetings", title: "Meetings", icon: "mic", order: 36, element: <MeetingsPage /> }
  ]
};
export default meetingsWebContribution;
