import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const quietHoursAllowanceFeature: ModuleFeatureManifest = {
  id: "chat.reminder_quiet_hours_allowance",
  description:
    "Allow one reminder during quiet hours in Main chat; partial names need typed yes, duplicate names need an ID. Settings, Alerts & quiet hours lists saved choices and opens Main to change them. Delivery support is pending.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "reminder_allowance_target_unclear",
      class: "validation",
      description:
        "Name one owned reminder, or use its ID when titles match. Nothing is saved until the target and typed agreement are clear."
    },
    {
      code: "quiet_hours_allowances_load_failed",
      class: "transient",
      remediationRef: "chat.change_quiet_hours_allowance",
      description:
        "The saved allowance list could not load. Choose Try again; saved choices have not changed."
    }
  ],
  remediations: [
    {
      id: "chat.change_quiet_hours_allowance",
      description:
        "In Alerts & quiet hours, choose Change in chat, then name one reminder to allow or stop allowing. Retry a failed list with Try again.",
      path: "/settings?section=alerts"
    }
  ]
};
