import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const TASKS_HEARTBEAT_FEATURE: ModuleFeatureManifest = {
  id: "tasks.heartbeat_source",
  description:
    "Open tasks that are overdue or due within a day can appear in Moss check-ins. Check-ins read saved task data only and never change a task.",
  errors: [
    {
      code: "tasks_heartbeat_source_unavailable",
      class: "transient",
      description:
        "Tasks could not be read for a check-in. Settings > Alerts shows Tasks as unavailable and the next check tries again."
    }
  ]
};
